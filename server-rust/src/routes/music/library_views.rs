use std::collections::HashMap;
use std::cmp::{Ordering, Reverse};

use crate::error::ApiJson;
use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{build_catalog_and_resolver, require_db};
use crate::AppState;
use crate::auth::AuthenticatedUser;
use crate::catalog::merge::{strong_recording_ids, title_key};
use crate::catalog::snapshot::{LibraryTrackSort, catalog_revision, library_search_text};
use crate::catalog::track_dedup::TrackDedup;
use crate::catalog::{
    Available, CatalogEntityType, UnifiedCatalogItem, normalize_music_text, recordings_match,
};
use crate::db::{DbError, DbPool};
use crate::error::ServerError;
use crate::profile::LibraryFilter;
use crate::providers::{Album, IdentityHints, Track, TrackArtistCredit};

#[derive(Debug, Deserialize)]
pub(super) struct FilterTracksBody {
    #[serde(default)]
    filters: Vec<LibraryFilter>,
    #[serde(default)]
    offset: usize,
    limit: Option<usize>,
    #[serde(default)]
    query: String,
    #[serde(default)]
    sort: LibraryTrackSort,
}

#[derive(Serialize)]
pub(super) struct TrackPage<'a, T> {
    pub tracks: Vec<T>,
    pub total: usize,
    pub offset: usize,
    pub revision: &'a str,
    pub degraded: bool,
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum SortPart<'a> {
    Number(usize, &'a str),
    Text(&'a str),
}

struct NaturalText(String);

impl Ord for NaturalText {
    fn cmp(&self, other: &Self) -> Ordering {
        fn parts(text: &str) -> impl Iterator<Item = SortPart<'_>> {
            text.as_bytes().chunk_by(|left, right| left.is_ascii_digit() == right.is_ascii_digit()).map(|part| {
                // ASCII digit boundaries never split multi-byte UTF-8 characters.
                let text = std::str::from_utf8(part).expect("sort key is UTF-8");
                if part[0].is_ascii_digit() {
                    let digits = text.trim_start_matches('0');
                    SortPart::Number(digits.len(), digits)
                } else {
                    SortPart::Text(text)
                }
            })
        }
        parts(&self.0).cmp(parts(&other.0))
    }
}

impl PartialOrd for NaturalText {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> { Some(self.cmp(other)) }
}

impl PartialEq for NaturalText {
    fn eq(&self, other: &Self) -> bool { self.cmp(other).is_eq() }
}

impl Eq for NaturalText {}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum AlbumSort {
    #[default]
    Library,
    Az,
    Za,
    Newest,
    Oldest,
    Artist,
    ArtistReverse,
}

impl AlbumSort {
    pub(super) fn arrange(self, albums: &mut Vec<&Available<Album>>, query: &str) {
        let query = library_search_text(query);
        let tokens: Vec<_> = query.split_whitespace().collect();
        if !tokens.is_empty() {
            albums.retain(|album| {
                let text = library_search_text(&format!("{} {}", album.item.name, album.item.artist_name));
                tokens.iter().all(|token| text.contains(token))
            });
        }
        let title = |album: &&Available<Album>| NaturalText(library_search_text(&album.item.name));
        let artist = |album: &&Available<Album>| NaturalText(library_search_text(&album.item.artist_name));
        let year = |album: &&Available<Album>| album.item.year.filter(|year| *year > 0);
        match self {
            Self::Library => {},
            Self::Az => albums.sort_by_cached_key(title),
            Self::Za => albums.sort_by_cached_key(|album| Reverse(title(album))),
            Self::Newest => albums.sort_by_cached_key(|album| (year(album).is_none(), Reverse(year(album)), title(album))),
            Self::Oldest => albums.sort_by_cached_key(|album| (year(album).is_none(), year(album), title(album))),
            Self::Artist => albums.sort_by_cached_key(|album| (artist(album), title(album))),
            Self::ArtistReverse => albums.sort_by_cached_key(|album| (Reverse(artist(album)), title(album))),
        }
    }
}

#[derive(Serialize)]
pub(super) struct AlbumPage<'a> {
    pub albums: Vec<&'a Available<Album>>,
    pub total: usize,
    pub revision: &'a str,
    pub degraded: bool,
}

fn filter_matches(filter: &LibraryFilter, value: &Value) -> bool {
    let expected = &filter.value;
    match filter.op.as_deref() {
        None | Some("eq") => filter_text(value) == filter_text(expected),
        Some("contains") => filter_text(value)
            .to_lowercase()
            .contains(&filter_text(expected).to_lowercase()),
        Some("boolean") => filter_bool(value) == filter_bool(expected),
        Some("gte") => filter_number(value)
            .zip(filter_number(expected))
            .is_some_and(|(actual, expected)| actual >= expected),
        Some("lte") => filter_number(value)
            .zip(filter_number(expected))
            .is_some_and(|(actual, expected)| actual <= expected),
        _ => false,
    }
}

fn filter_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(filter_text).collect::<Vec<_>>().join(","),
        _ => value.to_string(),
    }
}

fn filter_bool(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

fn filter_number(value: &Value) -> Option<f64> {
    match value {
        Value::Bool(value) => Some(f64::from(u8::from(*value))),
        Value::String(text) if text.trim().is_empty() => Some(0.0),
        Value::String(text) => text.trim().parse().ok(),
        _ => value.as_f64(),
    }
}

type TrackActivity = (bool, i64, Option<String>);

async fn user_track_activity(
    db: &DbPool,
    user_id: &str,
) -> Result<HashMap<String, TrackActivity>, DbError> {
    let rows = sqlx::query_as::<_, (String, bool, i64, Option<String>)>(
        r"
        WITH starred(track_id) AS (
            SELECT track_id FROM favorites WHERE user_id = ?1
            UNION
            SELECT item_id FROM media_favorites WHERE user_id = ?1 AND item_type = 'track'
        ), plays AS (
            SELECT track_id, COUNT(*) AS play_count, MAX(played_at) AS last_played_at
            FROM recently_played WHERE user_id = ?1 GROUP BY track_id
        ), activity(track_id) AS (
            SELECT track_id FROM starred UNION SELECT track_id FROM plays
        )
        SELECT activity.track_id, starred.track_id IS NOT NULL, COALESCE(plays.play_count, 0),
               plays.last_played_at
        FROM activity LEFT JOIN starred USING (track_id) LEFT JOIN plays USING (track_id)
        ",
    )
    .bind(user_id)
    .fetch_all(db.inner())
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, favorite, count, last)| (id, (favorite, count, last)))
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnnotatedTrack<'a> {
    #[serde(flatten)]
    track: &'a Available<Track>,
    favorite: bool,
    played: bool,
    play_count: i64,
    last_played_at: Option<&'a str>,
    library_state: &'static str,
    external_state: &'static str,
}

impl AnnotatedTrack<'_> {
    fn matches(&self, filters: &[LibraryFilter]) -> Result<bool, serde_json::Error> {
        let mut metadata: Option<Value> = None;
        for filter in filters {
            let annotation = match filter.field.as_str() {
                "favorite" => json!(self.favorite),
                "played" => json!(self.played),
                "playCount" => json!(self.play_count),
                "lastPlayedAt" => json!(self.last_played_at),
                "libraryState" => json!(self.library_state),
                "externalState" => json!(self.external_state),
                field => {
                    let metadata = match &metadata {
                        Some(metadata) => metadata,
                        None => metadata.insert(serde_json::to_value(self.track)?),
                    };
                    if !filter_matches(filter, &metadata[field]) {
                        return Ok(false);
                    }
                    continue;
                }
            };
            if !filter_matches(filter, &annotation) {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

pub(super) async fn post_filter_tracks_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    body: Result<ApiJson<FilterTracksBody>, crate::error::ApiJsonRejection>,
) -> Result<Response, ServerError> {
    let ApiJson(body) = match body {
        Ok(body) => body,
        Err(rejection) => return Ok(rejection.into_response()),
    };
    let limit = body.limit.unwrap_or(100);
    if !(1..=500).contains(&limit) || body.query.chars().count() > 200
        || body.filters.iter().any(|filter| {
            filter.field.is_empty()
                || !matches!(
                    filter.op.as_deref(),
                    None | Some("eq" | "contains" | "boolean" | "gte" | "lte")
                )
        })
    {
        return Err(ServerError::BadRequest("Invalid library filter".into()));
    }

    let catalog = match build_catalog_and_resolver(&state) {
        Ok((catalog, _, _)) => catalog,
        Err(response) => return Ok(response),
    };
    let snapshot = state.catalog_snapshots().tracks(&catalog).await;
    let annotations = !body.filters.is_empty() || (body.query.is_empty() && matches!(body.sort, LibraryTrackSort::Custom));
    let activity = if annotations {
        user_track_activity(require_db(&state)?, &auth.user.id).await?
    } else {
        HashMap::new()
    };
    let query = library_search_text(&body.query);
    let tokens: Vec<_> = query.split_whitespace().collect();
    let search = (!tokens.is_empty()).then(|| snapshot.track_search());
    let mut matches = Vec::new();
    let mut seen = TrackDedup::default();

    for (index, track) in snapshot.items.iter().enumerate() {
        if search.is_some_and(|text| !tokens.iter().all(|token| text[index].contains(token))) {
            continue;
        }
        let (favorite, play_count, last_played_at) = activity
            .get(&track.item.id)
            .map_or((false, 0, None), |(favorite, count, last)| {
                (*favorite, *count, last.as_deref())
            });
        let annotated = AnnotatedTrack {
            track,
            favorite,
            played: play_count > 0,
            play_count,
            last_played_at,
            library_state: "owned",
            external_state: if track
                .sources
                .iter()
                .flatten()
                .any(|source| source.id.starts_with("external"))
            {
                "external"
            } else {
                "none"
            },
        };
        if annotated
            .matches(&body.filters)
            .map_err(|error| ServerError::Internal(error.to_string()))?
            && seen.insert_track(&track.item)
        {
            matches.push(annotated);
        }
    }

    match body.sort {
        LibraryTrackSort::Custom => {}
        LibraryTrackSort::TitleAsc => matches.sort_by_cached_key(|row| NaturalText(library_search_text(&row.track.item.title))),
        LibraryTrackSort::TitleDesc => matches.sort_by_cached_key(|row| Reverse(NaturalText(library_search_text(&row.track.item.title)))),
        LibraryTrackSort::AlbumAsc => matches.sort_by_cached_key(|row| NaturalText(library_search_text(&row.track.item.album_name))),
        LibraryTrackSort::AlbumDesc => matches.sort_by_cached_key(|row| Reverse(NaturalText(library_search_text(&row.track.item.album_name)))),
        LibraryTrackSort::DurationAsc => matches.sort_by_key(|row| row.track.item.duration_seconds.filter(|&value| value > 0).unwrap_or(u32::MAX)),
        LibraryTrackSort::DurationDesc => matches.sort_by_key(|row| Reverse(row.track.item.duration_seconds.unwrap_or(0))),
    }
    let revision = catalog_revision(matches.iter().map(|row| row.track.item.id.as_str()), snapshot.degraded);
    let total = matches.len();
    let page = matches.into_iter().skip(body.offset).take(limit);
    let response = if annotations {
        Json(TrackPage { tracks: page.collect::<Vec<_>>(), total, offset: body.offset, revision: &revision, degraded: snapshot.degraded }).into_response()
    } else {
        Json(TrackPage { tracks: page.map(|row| row.track).collect(), total, offset: body.offset, revision: &revision, degraded: snapshot.degraded }).into_response()
    };
    Ok(response)
}

const MAX_MATCH_ITEMS: usize = 100;

#[derive(Debug, Deserialize)]
pub(super) struct LibraryMatchesBody {
    items: Vec<LibraryMatchItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryMatchItem {
    id: String,
    #[serde(rename = "type")]
    kind: MatchKind,
    title: String,
    artist: String,
    isrc: Option<String>,
    music_brainz_id: Option<String>,
    duration_seconds: Option<u32>,
    artist_credits: Option<Vec<TrackArtistCredit>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum MatchKind {
    Track,
    Album,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryMatch<'a> {
    id: &'a str,
    in_library: bool,
    local_track_id: Option<&'a str>,
    local_album_id: Option<&'a str>,
}

fn album_key(title: &str, artist: &str) -> Option<(String, String)> {
    let artist = normalize_music_text(Some(artist));
    if artist.is_empty() || normalize_music_text(Some(title)).is_empty() {
        return None;
    }
    Some((title_key(title), artist))
}

fn local_recording(track: &Track) -> UnifiedCatalogItem {
    UnifiedCatalogItem {
        id: track.id.clone(),
        item_type: CatalogEntityType::Track,
        provider: "library".into(),
        title: track.title.clone(),
        artist: Some(track.artist_name.clone()),
        artist_credits: track.artist_credits.clone(),
        album: None,
        duration_seconds: track.duration_seconds,
        artwork: None,
        identity_hints: track.identity_hints.clone(),
        identity: None,
    }
}

pub(super) async fn post_library_matches_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    body: Result<ApiJson<LibraryMatchesBody>, crate::error::ApiJsonRejection>,
) -> Result<Response, ServerError> {
    let ApiJson(body) = match body {
        Ok(body) => body,
        Err(rejection) => return Ok(rejection.into_response()),
    };
    if body.items.len() > MAX_MATCH_ITEMS
        || body.items.iter().any(|item| {
            item.id.is_empty()
                || item.id.chars().count() > 200
                || item.title.chars().count() > 300
                || item.artist.chars().count() > 300
                || item
                    .isrc
                    .as_ref()
                    .is_some_and(|code| code.chars().count() > 32)
        })
    {
        return Err(ServerError::BadRequest(
            "Invalid library match request".into(),
        ));
    }
    if body.items.is_empty() {
        return Ok(Json(json!({ "matches": [] })).into_response());
    }

    let catalog = match build_catalog_and_resolver(&state) {
        Ok((catalog, _, _)) => catalog,
        Err(response) => return Ok(response),
    };
    let tracks = async {
        if body.items.iter().any(|item| item.kind == MatchKind::Track) {
            Some(state.catalog_snapshots().tracks(&catalog).await)
        } else {
            None
        }
    };
    let albums = async {
        if body.items.iter().any(|item| item.kind == MatchKind::Album) {
            state.catalog_snapshots().albums(&catalog).await.map(Some)
        } else {
            Ok(None)
        }
    };
    let (tracks, albums) = tokio::join!(tracks, albums);
    let albums = albums.map_err(|err| ServerError::BadGateway(err.to_string()))?;

    let recordings: Vec<_> = tracks
        .iter()
        .flat_map(|snapshot| snapshot.items.iter())
        .map(|track| local_recording(&track.item))
        .collect();
    let mut by_strong_id = HashMap::new();
    let mut by_title: HashMap<_, Vec<_>> = HashMap::new();
    for (index, recording) in recordings.iter().enumerate() {
        for id in strong_recording_ids(recording) {
            by_strong_id.entry(id).or_insert(index);
        }
        by_title
            .entry(title_key(&recording.title))
            .or_default()
            .push(recording);
    }
    let mut by_album = HashMap::new();
    for album in albums.iter().flat_map(|snapshot| snapshot.items.iter()) {
        if let Some(key) = album_key(&album.item.name, &album.item.artist_name) {
            by_album.entry(key).or_insert(album.item.id.as_str());
        }
    }

    let matches: Vec<_> = body
        .items
        .iter()
        .map(|item| {
            let (local_track_id, local_album_id) = match item.kind {
                MatchKind::Track => {
                    let candidate = UnifiedCatalogItem {
                        id: item.id.clone(),
                        item_type: CatalogEntityType::Track,
                        provider: "external".into(),
                        title: item.title.clone(),
                        artist: Some(item.artist.clone()),
                        artist_credits: item.artist_credits.clone(),
                        album: None,
                        duration_seconds: item.duration_seconds,
                        artwork: None,
                        identity_hints: Some(IdentityHints {
                            isrc: item.isrc.clone(),
                            music_brainz_id: item.music_brainz_id.clone(),
                            upc: None,
                        }),
                        identity: None,
                    };
                    let matched = strong_recording_ids(&candidate)
                        .iter()
                        .filter_map(|id| by_strong_id.get(id))
                        .min()
                        .map(|&index| &recordings[index])
                        .or_else(|| {
                            if normalize_music_text(Some(&candidate.title)).is_empty() {
                                return None;
                            }
                            by_title
                                .get(&title_key(&candidate.title))?
                                .iter()
                                .copied()
                                .find(|track| recordings_match(track, &candidate))
                        });
                    (matched.map(|track| track.id.as_str()), None)
                }
                MatchKind::Album => {
                    let matched = album_key(&item.title, &item.artist)
                        .and_then(|key| by_album.get(&key).copied());
                    (None, matched)
                }
            };
            LibraryMatch {
                id: &item.id,
                in_library: local_track_id.is_some() || local_album_id.is_some(),
                local_track_id,
                local_album_id,
            }
        })
        .collect();

    Ok(Json(json!({ "matches": matches })).into_response())
}
