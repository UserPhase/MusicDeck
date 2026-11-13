use std::{sync::LazyLock, time::Duration};

use reqwest::Client;
use serde_json::Value;
use tokio::{sync::Mutex, time::Instant};
use url::Url;

use crate::{catalog::normalize_music_text, providers::Artist};

static HTTP: LazyLock<Option<Client>> = LazyLock::new(|| {
    Client::builder()
        .user_agent("MusicDeck/0.1.0 (https://github.com/UserPhase/MusicDeck)")
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()
});
static NEXT_MUSICBRAINZ_REQUEST: Mutex<Option<Instant>> = Mutex::const_new(None);

async fn get_json(url: Url) -> Option<Value> {
    HTTP.as_ref()?
        .get(url)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()
}

async fn musicbrainz(url: Url) -> Option<Value> {
    let mut next = NEXT_MUSICBRAINZ_REQUEST.lock().await;
    if let Some(deadline) = *next {
        tokio::time::sleep_until(deadline).await;
    }
    *next = Some(Instant::now() + Duration::from_millis(1100));
    drop(next);
    get_json(url).await
}

pub(crate) fn valid_commons_image(raw: &str) -> bool {
    Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("upload.wikimedia.org")
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path().starts_with("/wikipedia/commons/")
    })
}

async fn wikidata_image(id: &str) -> Option<String> {
    let mut url = Url::parse("https://www.wikidata.org/w/api.php").ok()?;
    url.query_pairs_mut().extend_pairs([
        ("action", "wbgetentities"),
        ("ids", id),
        ("props", "claims"),
        ("format", "json"),
    ]);
    let body = get_json(url).await?;
    body["entities"][id]["claims"]["P18"][0]["mainsnak"]["datavalue"]["value"]
        .as_str()
        .map(str::to_owned)
}

pub(crate) async fn resolve_musicbrainz_portrait(artist: &Artist) -> Option<String> {
    let base = Url::parse("https://musicbrainz.org/ws/2/artist/").ok()?;
    let name = normalize_music_text(Some(&artist.name));
    if name.is_empty() || artist.name.len() > 300 {
        return None;
    }
    let matches_artist = |entry: &Value| normalize_music_text(entry["name"].as_str()) == name;
    let id = match artist
        .identity_hints
        .as_ref()
        .and_then(|hints| hints.music_brainz_id.as_deref())
        .and_then(|raw| uuid::Uuid::parse_str(raw).ok())
    {
        Some(id) => id,
        None => {
            let mut url = base.clone();
            let query = format!(
                r#"artist:"{}""#,
                artist.name.replace('\\', "\\\\").replace('"', "\\\"")
            );
            url.query_pairs_mut().extend_pairs([
                ("query", query.as_str()),
                ("fmt", "json"),
                ("limit", "10"),
            ]);
            let response = musicbrainz(url).await?;
            let mut matches = response["artists"]
                .as_array()?
                .iter()
                .filter(|entry| matches_artist(entry));
            let found = matches.next()?["id"].as_str()?;
            if matches.next().is_some() {
                return None;
            }
            uuid::Uuid::parse_str(found).ok()?
        }
    };
    let mut detail_url = base.join(&id.to_string()).ok()?;
    detail_url
        .query_pairs_mut()
        .extend_pairs([("inc", "url-rels"), ("fmt", "json")]);
    let detail = musicbrainz(detail_url).await?;
    if !matches_artist(&detail) {
        return None;
    }

    let mut file = None;
    let mut wikidata = None;
    for relation in detail["relations"].as_array()? {
        let Some(resource) = relation["url"]["resource"]
            .as_str()
            .and_then(|raw| Url::parse(raw).ok())
        else {
            continue;
        };
        match (relation["type"].as_str(), resource.host_str()) {
            (Some("wikimedia commons"), Some("commons.wikimedia.org")) => {
                file = resource
                    .path()
                    .strip_prefix("/wiki/File:")
                    .or_else(|| resource.path().strip_prefix("/wiki/Special:FilePath/"))
                    .and_then(|title| urlencoding::decode(title).ok())
                    .map(|title| title.into_owned());
                if file.is_some() {
                    break;
                }
            }
            (Some("wikidata"), Some("www.wikidata.org" | "wikidata.org")) => {
                wikidata = resource
                    .path()
                    .trim_end_matches('/')
                    .rsplit('/')
                    .next()
                    .filter(|id| {
                        id.strip_prefix('Q').is_some_and(|digits| {
                            !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
                        })
                    })
                    .map(str::to_owned);
            }
            _ => {}
        }
    }
    let file = match file {
        Some(file) => file,
        None => wikidata_image(wikidata.as_deref()?).await?,
    };
    if file.is_empty() || file.len() > 300 || file.contains('|') {
        return None;
    }
    let mut url = Url::parse("https://commons.wikimedia.org/w/api.php").ok()?;
    let title = format!("File:{file}");
    url.query_pairs_mut().extend_pairs([
        ("action", "query"),
        ("titles", title.as_str()),
        ("prop", "imageinfo"),
        ("iiprop", "url"),
        ("iiurlwidth", "500"),
        ("format", "json"),
        ("formatversion", "2"),
    ]);
    let body = get_json(url).await?;
    let info = &body["query"]["pages"][0]["imageinfo"][0];
    ["thumburl", "url"].iter().find_map(|field| {
        info[*field]
            .as_str()
            .filter(|url| valid_commons_image(url))
            .map(str::to_owned)
    })
}
