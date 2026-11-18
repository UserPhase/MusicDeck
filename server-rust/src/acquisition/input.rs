use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::AcquisitionCreateOptions;
use super::spotdl::{
    canonical_manual_acquisition_url, canonical_spotify_url, validate_search_query,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AcquisitionKind {
    Track,
    Album,
    Artist,
    Playlist,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionResult {
    #[serde(rename = "type")]
    pub kind: AcquisitionKind,
    pub id: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub spotify_url: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Operand {
    Spotify {
        url: String,
    },
    Manual {
        url: String,
        spotify_track: Option<String>,
    },
    TrackSearch {
        text: String,
    },
    AlbumSearch {
        text: String,
    },
}

impl Operand {
    pub(crate) fn cli_value(&self) -> Result<String, String> {
        let invalid = || "Invalid or unsupported acquisition target".to_owned();
        match self {
            Self::Spotify { url } => canonical_spotify_url(url).map_err(|_| invalid()),
            Self::Manual { url, spotify_track } => {
                let url = canonical_manual_acquisition_url(url).map_err(|_| invalid())?;
                if let Some(track) = spotify_track {
                    let track = canonical_spotify_url(track).map_err(|_| invalid())?;
                    if spotify_kind(&track) != AcquisitionKind::Track
                        || manual_kind(&url) != Some(AcquisitionKind::Track)
                    {
                        return Err(
                            "Manual matching requires one audio track and one Spotify track".into(),
                        );
                    }
                    Ok(format!("{url}|{track}"))
                } else if supports_direct_manual(&url) {
                    Ok(url)
                } else {
                    Err("Use a YouTube Music track or playlist URL, or provide a matching Spotify track URL".into())
                }
            }
            Self::TrackSearch { text } | Self::AlbumSearch { text } => {
                validate_search_query(text).map_err(|_| invalid())?;
                if matches!(self, Self::AlbumSearch { .. }) {
                    Ok(format!("album: {text}"))
                } else {
                    Ok(text.clone())
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ValidatedTarget {
    pub kind: AcquisitionKind,
    pub operands: Vec<Operand>,
    pub expected_count: Option<usize>,
}

impl AcquisitionResult {
    fn spotify_url(&self) -> Option<&str> {
        let key = match self.kind {
            AcquisitionKind::Track => "spotifyTrackUrl",
            AcquisitionKind::Album => "spotifyAlbumUrl",
            AcquisitionKind::Artist => "spotifyArtistUrl",
            AcquisitionKind::Playlist => "spotifyPlaylistUrl",
        };
        self.spotify_url
            .as_deref()
            .or_else(|| self.metadata[key].as_str())
            .or_else(|| self.metadata["spotifyUrl"].as_str())
    }

    fn song_count(&self) -> Option<usize> {
        self.metadata["songCount"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n > 0 && *n <= i32::MAX as usize)
    }
}

fn spotify_kind(url: &str) -> AcquisitionKind {
    match url.split('/').nth(3) {
        Some("album") => AcquisitionKind::Album,
        Some("artist") => AcquisitionKind::Artist,
        Some("playlist") => AcquisitionKind::Playlist,
        _ => AcquisitionKind::Track,
    }
}

fn manual_kind(url: &str) -> Option<AcquisitionKind> {
    let url = url::Url::parse(url).ok()?;
    if url.path() == "/playlist"
        || url.path().starts_with("/sets/")
        || url.path().contains("/sets/")
        || url.path().starts_with("/album/")
    {
        Some(AcquisitionKind::Playlist)
    } else {
        Some(AcquisitionKind::Track)
    }
}

pub(super) fn supports_direct_manual(url: &str) -> bool {
    url.starts_with("https://music.youtube.com/watch?v=")
        || url.starts_with("https://www.youtube.com/playlist?list=PL")
        || url.starts_with("https://www.youtube.com/playlist?list=OLAK5uy_")
        || url.starts_with("https://music.youtube.com/playlist?list=PL")
        || url.starts_with("https://music.youtube.com/playlist?list=OLAK5uy_")
}

fn search_operand(
    kind: AcquisitionKind,
    artist: Option<&str>,
    title: Option<&str>,
) -> Result<Operand, String> {
    let title = title
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("A track or album title is required")?;
    let artist = artist.map(str::trim).filter(|s| !s.is_empty());
    let text = artist.map_or_else(|| title.to_owned(), |artist| format!("{artist} - {title}"));
    match kind {
        AcquisitionKind::Track => Ok(Operand::TrackSearch { text }),
        AcquisitionKind::Album => Ok(Operand::AlbumSearch { text }),
        _ => Err("Provide a Spotify artist or playlist link, or select albums to import".into()),
    }
}

impl ValidatedTarget {
    pub fn decode_saved(input: &str) -> Option<Self> {
        if let Ok(target) = serde_json::from_str::<Self>(input) {
            return (!target.operands.is_empty()
                && target
                    .operands
                    .iter()
                    .all(|operand| operand.cli_value().is_ok()))
            .then_some(target);
        }
        let options: AcquisitionCreateOptions = serde_json::from_str(input).ok()?;
        Self::resolve(&options).ok()
    }

    pub fn resolve(options: &AcquisitionCreateOptions) -> Result<Self, String> {
        let result = options.result.as_ref();
        let kind_hint = result
            .map(|item| item.kind)
            .or_else(|| options.album_id.as_ref().map(|_| AcquisitionKind::Album));
        let spotify = options
            .spotify_url
            .as_deref()
            .or(options.spotify_track_url.as_deref())
            .or_else(|| result.and_then(AcquisitionResult::spotify_url));
        let explicit_manual = options.source_url.as_deref();
        // Older clients sometimes sent a link as the identifier. Accept it only if the URL itself validates.
        let legacy_url = options
            .track_id
            .as_deref()
            .or(options.album_id.as_deref())
            .or(options.candidate_id.as_deref());
        let spotify = spotify
            .map(|url| canonical_spotify_url(url.trim()).map_err(|err| err.to_string()))
            .transpose()?
            .or_else(|| legacy_url.and_then(|url| canonical_spotify_url(url).ok()));
        let manual = explicit_manual
            .map(|url| canonical_manual_acquisition_url(url.trim()).map_err(|err| err.to_string()))
            .transpose()?
            .or_else(|| {
                options
                    .candidate
                    .as_ref()
                    .and_then(|item| item.detail_url.as_deref())
                    .and_then(|url| canonical_manual_acquisition_url(url).ok())
                    .filter(|url| spotify.is_some() || supports_direct_manual(url))
            })
            .or_else(|| legacy_url.and_then(|url| canonical_manual_acquisition_url(url).ok()));
        let kind = spotify
            .as_deref()
            .map(spotify_kind)
            .or_else(|| manual.as_deref().and_then(manual_kind))
            .or(kind_hint)
            .unwrap_or(AcquisitionKind::Track);
        if kind_hint.is_some_and(|hint| {
            hint != kind
                && !(hint == AcquisitionKind::Album
                    && kind == AcquisitionKind::Playlist
                    && manual.is_some())
        }) {
            return Err("The download link does not match the requested media type".into());
        }
        let mut expected_count = result.and_then(AcquisitionResult::song_count);
        let operands = match (manual, spotify) {
            (Some(url), spotify_track) => vec![Operand::Manual { url, spotify_track }],
            (None, Some(url)) => vec![Operand::Spotify { url }],
            (None, None) if kind == AcquisitionKind::Artist && !options.albums.is_empty() => {
                let mut resolved = Vec::new();
                let mut seen = std::collections::HashSet::new();
                let mut counts = Vec::new();
                for album in &options.albums {
                    if album.kind != AcquisitionKind::Album {
                        return Err("Discography entries must be albums".into());
                    }
                    let operand = match album.spotify_url() {
                        Some(url) => {
                            let url =
                                canonical_spotify_url(url.trim()).map_err(|err| err.to_string())?;
                            if spotify_kind(&url) != AcquisitionKind::Album {
                                return Err("Discography links must be Spotify albums".into());
                            }
                            Operand::Spotify { url }
                        }
                        None => search_operand(
                            AcquisitionKind::Album,
                            album.artist.as_deref(),
                            album.title.as_deref(),
                        )?,
                    };
                    if seen.insert(operand.cli_value()?) {
                        counts.push(album.song_count());
                        resolved.push(operand);
                    }
                }
                expected_count = counts
                    .into_iter()
                    .try_fold(0usize, |total, count| total.checked_add(count?));
                resolved
            }
            (None, None) => {
                let artist = result.and_then(|item| item.artist.as_deref()).or_else(|| {
                    options
                        .candidate
                        .as_ref()
                        .and_then(|item| item.artist.as_deref())
                });
                let title = options
                    .query
                    .as_deref()
                    .or_else(|| result.and_then(|item| item.title.as_deref()))
                    .or_else(|| {
                        options
                            .candidate
                            .as_ref()
                            .and_then(|item| item.title.as_deref())
                    });
                vec![search_operand(kind, artist, title)?]
            }
        };
        for operand in &operands {
            operand.cli_value()?;
        }
        Ok(Self {
            kind,
            operands,
            expected_count,
        })
    }
}
