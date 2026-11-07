//! # External Metadata Adapters & Artwork Token Store (`external::adapters`)
//!
//! Complete Rust port of:
//! - `server/src/domain/external-catalog.ts` (`ExternalArtworkTokenStore`)
//! - `server/src/services/adapters/MetadataAdapter.ts`
//! - `server/src/services/adapters/DeezerAdapter.ts`
//! - `server/src/services/adapters/iTunesAdapter.ts`
//! - `server/src/services/adapters/SubsonicAdapter.ts`
//!
//! ## Security & SSRF Prevention (`ExternalArtworkTokenStore`)
//! Raw provider CDN URLs (`dzcdn.net`, `mzstatic.com`, `scdn.co`) are never exposed directly
//! to the browser. Instead, [`ExternalArtworkTokenStore::mint_token`] verifies that a URL uses
//! `https:` and ends with an allowlisted domain suffix, then mints a short-lived (`10` minute)
//! opaque token `extart_<nanoid>` served through `/api/artwork/external/:artworkId`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use url::Url;

use crate::catalog::{CatalogEntityType, CatalogService};
use crate::db::create_id;
use crate::providers::IdentityHints;

/// Timeout (`4,500` ms) applied to external Deezer and iTunes search queries.
pub const EXTERNAL_ADAPTER_TIMEOUT_MS: u64 = 4_500;

/// Lifetime (`10` minutes in milliseconds) of a minted `extart_<nanoid>` artwork token.
pub const EXTERNAL_ARTWORK_TOKEN_TTL_MS: u64 = 10 * 60 * 1_000;

/// Tokenized external artwork descriptor (`{ id, url }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalArtworkRef {
    /// Opaque token (`extart_<nanoid>`).
    pub id: String,
    /// Relative MusicDeck proxy URL (`/api/artwork/external/<id>`).
    pub url: String,
}

/// Source descriptor attached to [`ExternalSearchItem`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSourceBadge {
    /// `"external"` or `"library"`.
    pub kind: String,
    /// Available local source count (`0` for external items).
    pub count: usize,
    /// Optional flag indicating an external preview/download is available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_available: Option<bool>,
}

/// Provider-neutral search result item (`UnifiedSearchResult` / `ExternalTrack` / `ExternalAlbum` / `ExternalArtist`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSearchItem {
    /// Item ID (`external_deezer_track_<id>`, `external_itunes_<id>`, or `md_<id>`).
    pub id: String,
    /// Entity kind (`track`, `album`, `artist`).
    #[serde(rename = "type")]
    pub item_type: CatalogEntityType,
    /// Primary title.
    pub title: String,
    /// Subtitle (artist name or `"Artist"`).
    pub subtitle: Option<String>,
    /// Artist name.
    pub artist: Option<String>,
    /// Album title.
    pub album: Option<String>,
    /// Tokenized artwork reference.
    pub artwork: Option<ExternalArtworkRef>,
    /// Optional 30-second audio preview URL (`https://...`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
    /// Provider kind (`"external"` or `"library"`).
    pub provider: String,
    /// Source availability summary.
    pub source: ExternalSourceBadge,
    /// Optional local library availability object.
    pub availability: Option<Value>,
    /// Provider-specific metadata (`durationSeconds`, `artistId`, `albumId`, etc.).
    pub metadata: Value,
    /// Optional cross-provider identity hints (`isrc`, `musicBrainzId`, `upc`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_hints: Option<IdentityHints>,
    /// Annotated by `CompositeMetadataService` when matched against the local library.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_library: Option<bool>,
    /// Local `md_...` track ID when matched in the user's library.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_track_id: Option<String>,
    /// Local `md_...` album ID when matched in the user's library.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_album_id: Option<String>,
}

/// Grouped search results across tracks, albums, and artists (`SearchGroups`).
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchGroups {
    /// Matching tracks.
    pub tracks: Vec<ExternalSearchItem>,
    /// Matching albums.
    pub albums: Vec<ExternalSearchItem>,
    /// Matching artists.
    pub artists: Vec<ExternalSearchItem>,
}

/// Error taxonomy for external metadata providers, discovery, and lyrics services.
#[derive(Debug, Error)]
pub enum ExternalError {
    /// Upstream HTTP request failed or timed out.
    #[error("{provider} request failed: {message}")]
    Upstream {
        /// Provider name (`"Deezer"`, `"iTunes"`, `"LRCLIB"`, etc.).
        provider: &'static str,
        /// Error detail.
        message: String,
    },

    /// Upstream payload failed validation or schema parsing.
    #[error("{provider} returned invalid payload: {message}")]
    InvalidPayload {
        /// Provider name.
        provider: &'static str,
        /// Error detail.
        message: String,
    },

    /// Request blocked by [`crate::services::privacy::PrivacyManager`].
    #[error("{0}")]
    PrivacyBlocked(String),
}

// ============================================================================
// `ExternalArtworkTokenStore`
// ============================================================================

#[derive(Debug, Clone)]
struct ArtworkTokenEntry {
    url: String,
    expires_at_ms: u64,
}

/// Shared, in-memory token store that exchanges validated `https://` provider CDN URLs
/// for opaque `extart_<nanoid>` tokens served by `/api/artwork/external/:artworkId`.
#[derive(Debug, Clone, Default)]
pub struct ExternalArtworkTokenStore {
    tokens: Arc<Mutex<HashMap<String, ArtworkTokenEntry>>>,
}

impl ExternalArtworkTokenStore {
    /// Creates a new empty [`ExternalArtworkTokenStore`].
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Validates that `raw_url` is an `https:` URL whose hostname ends with one of
    /// `allowed_host_suffixes` (e.g., `["dzcdn.net"]` or `["mzstatic.com"]`), then mints
    /// a 10-minute `extart_<nanoid>` token.
    #[must_use]
    pub fn mint_token(&self, raw_url: Option<&str>, allowed_host_suffixes: &[&str]) -> Option<String> {
        let url_str = raw_url?.trim();
        if url_str.is_empty() {
            return None;
        }

        let parsed = Url::parse(url_str).ok()?;
        if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
            return None;
        }

        let host = parsed.host_str()?.to_ascii_lowercase();
        let allowed = allowed_host_suffixes.iter().any(|suffix| {
            let clean = suffix.trim_start_matches('.').to_ascii_lowercase();
            host == clean || host.ends_with(&format!(".{clean}"))
        });
        if !allowed {
            return None;
        }

        let id = create_id("extart");
        let now_ms = current_epoch_ms();
        let mut guard = self
            .tokens
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if guard.len() >= 4096 {
            guard.retain(|_, v| v.expires_at_ms > now_ms);
        }
        guard.insert(
            id.clone(),
            ArtworkTokenEntry {
                url: parsed.into(),
                expires_at_ms: now_ms + EXTERNAL_ARTWORK_TOKEN_TTL_MS,
            },
        );
        Some(id)
    }

    /// Resolves a previously minted `extart_...` token back to its validated CDN URL,
    /// returning `None` if expired or unknown.
    #[must_use]
    pub fn resolve(&self, id: &str) -> Option<String> {
        let now_ms = current_epoch_ms();
        let mut guard = self
            .tokens
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = guard.get(id)?.clone();
        if entry.expires_at_ms <= now_ms {
            guard.remove(id);
            return None;
        }
        Some(entry.url)
    }

    /// Helper that mints a token and wraps it in an [`ExternalArtworkRef`].
    #[must_use]
    pub fn artwork_ref(
        &self,
        raw_url: Option<&str>,
        allowed_host_suffixes: &[&str],
    ) -> Option<ExternalArtworkRef> {
        let id = self.mint_token(raw_url, allowed_host_suffixes)?;
        Some(ExternalArtworkRef {
            url: format!("/api/artwork/external/{}", urlencoding::encode(&id)),
            id,
        })
    }
}

// ============================================================================
// `ExternalProvider` (`MetadataAdapter`) Trait
// ============================================================================

/// Polymorphic interface implemented by [`DeezerAdapter`], [`ItunesAdapter`], and [`SubsonicAdapter`].
#[async_trait]
pub trait ExternalProvider: Send + Sync + std::fmt::Debug {
    /// Human-readable adapter name (`"Deezer"`, `"iTunes"`, `"Subsonic"`).
    fn name(&self) -> &'static str;

    /// Searches tracks matching `query`.
    async fn search_tracks(&self, query: &str) -> Result<Vec<ExternalSearchItem>, ExternalError>;

    /// Searches albums matching `query`.
    async fn search_albums(&self, query: &str) -> Result<Vec<ExternalSearchItem>, ExternalError>;

    /// Searches artists matching `query`.
    async fn search_artists(&self, query: &str) -> Result<Vec<ExternalSearchItem>, ExternalError>;

    /// Looks up exact case-insensitive artist details for `artist_name`.
    async fn get_artist_details(
        &self,
        artist_name: &str,
    ) -> Result<Option<ExternalSearchItem>, ExternalError> {
        let target = artist_name.trim().to_lowercase();
        let artists = self.search_artists(artist_name).await?;
        Ok(artists
            .into_iter()
            .find(|a| a.title.trim().to_lowercase() == target))
    }
}

/// Alias matching the legacy TypeScript interface name `MetadataAdapter`.
pub type MetadataAdapter = dyn ExternalProvider;

// ============================================================================
// 1. `DeezerAdapter` (`server/src/services/adapters/DeezerAdapter.ts`)
// ============================================================================

/// Keyless Deezer catalog search adapter (`https://api.deezer.com/search/*`).
#[derive(Debug, Clone)]
pub struct DeezerAdapter {
    http: reqwest::Client,
    artwork_tokens: ExternalArtworkTokenStore,
    limit: usize,
}

impl DeezerAdapter {
    /// Creates a new [`DeezerAdapter`].
    #[must_use]
    pub fn new(artwork_tokens: ExternalArtworkTokenStore, limit: usize) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_millis(EXTERNAL_ADAPTER_TIMEOUT_MS))
            .build()
            .unwrap_or_default();
        Self {
            http,
            artwork_tokens,
            limit: limit.clamp(1, 50),
        }
    }

    async fn query_entity(&self, entity: &str, query: &str) -> Result<Vec<Value>, ExternalError> {
        let mut url = Url::parse(&format!("https://api.deezer.com/search/{entity}"))
            .expect("valid deezer url");
        url.query_pairs_mut()
            .append_pair("q", query)
            .append_pair("limit", &self.limit.to_string());

        let res = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|err| ExternalError::Upstream {
                provider: "Deezer",
                message: err.to_string(),
            })?;

        if !res.status().is_success() {
            return Err(ExternalError::Upstream {
                provider: "Deezer",
                message: format!("Deezer search failed (HTTP {})", res.status().as_u16()),
            });
        }

        let payload: Value = res.json().await.map_err(|_| ExternalError::InvalidPayload {
            provider: "Deezer",
            message: String::from("Invalid JSON from Deezer"),
        })?;

        if let Some(err_obj) = payload.get("error") {
            let msg = err_obj
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Deezer search failed");
            return Err(ExternalError::Upstream {
                provider: "Deezer",
                message: msg.to_owned(),
            });
        }

        let Some(data_val) = payload.get("data") else {
            return Ok(Vec::new());
        };
        let Some(arr) = data_val.as_array() else {
            return Err(ExternalError::InvalidPayload {
                provider: "Deezer",
                message: String::from("Deezer returned invalid search data"),
            });
        };

        Ok(arr.clone())
    }

    /// Fetches a full Deezer album detail object (`external_deezer_album_<id>`).
    pub async fn get_album(&self, external_id: &str) -> Option<Value> {
        let deezer_id = external_id.strip_prefix("external_deezer_album_")?;
        if deezer_id.is_empty() || !deezer_id.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let url = format!("https://api.deezer.com/album/{deezer_id}");
        let res = self.http.get(&url).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        let payload: Value = res.json().await.ok()?;
        payload.get("id")?;

        let title = payload
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Unknown album")
            .to_owned();
        let artist_name = payload
            .get("artist")
            .and_then(|a| a.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Unknown artist")
            .to_owned();
        let artist_id = payload
            .get("artist")
            .and_then(|a| a.get("id"))
            .and_then(Value::as_i64)
            .map(|id| format!("external_deezer_artist_{id}"));
        let release_date = payload
            .get("release_date")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let year = release_date
            .as_deref()
            .and_then(|s| s.get(0..4))
            .and_then(|y| y.parse::<i32>().ok());
        let genre = payload
            .get("genres")
            .and_then(|g| g.get("data"))
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(|g| g.get("name"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let label = payload
            .get("label")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let cover_raw = payload
            .get("cover_xl")
            .or_else(|| payload.get("cover_big"))
            .or_else(|| payload.get("cover_medium"))
            .and_then(Value::as_str);
        let artwork = self.artwork_tokens.artwork_ref(cover_raw, &["dzcdn.net"]);

        let mut tracks = Vec::new();
        if let Some(track_arr) = payload
            .get("tracks")
            .and_then(|t| t.get("data"))
            .and_then(Value::as_array)
        {
            for item in track_arr {
                let Some(tid) = item.get("id").and_then(Value::as_i64) else {
                    continue;
                };
                let tr_title = item
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown title");
                let tr_artist = item
                    .get("artist")
                    .and_then(|a| a.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or(&artist_name);
                let tr_artist_id = item
                    .get("artist")
                    .and_then(|a| a.get("id"))
                    .and_then(Value::as_i64)
                    .map(|id| format!("external_deezer_artist_{id}"))
                    .or_else(|| artist_id.clone());
                let duration = item.get("duration").and_then(Value::as_u64);
                let preview_url = item
                    .get("preview")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());

                tracks.push(json!({
                    "type": "track",
                    "id": format!("external_deezer_track_{tid}"),
                    "title": tr_title,
                    "subtitle": tr_artist,
                    "artist": tr_artist,
                    "artistName": tr_artist,
                    "artistId": tr_artist_id,
                    "album": title,
                    "albumName": title,
                    "albumId": external_id,
                    "artwork": artwork,
                    "artworkId": artwork.as_ref().map(|a| &a.id),
                    "artworkUrl": artwork.as_ref().map(|a| &a.url),
                    "previewUrl": preview_url,
                    "durationSeconds": duration,
                    "provider": "external",
                    "source": { "kind": "external", "count": 0 },
                    "availability": null,
                    "metadata": {
                        "durationSeconds": duration,
                        "artistId": tr_artist_id,
                        "albumId": external_id,
                        "deezerTrackId": tid,
                    }
                }));
            }
        }

        let track_count = tracks.len();
        Some(json!({
            "id": external_id,
            "title": title,
            "name": title,
            "artist": artist_name,
            "artistName": artist_name,
            "artistId": artist_id,
            "year": year,
            "releaseDate": release_date,
            "genre": genre,
            "label": label,
            "artwork": artwork,
            "artworkId": artwork.as_ref().map(|a| &a.id),
            "artworkUrl": artwork.as_ref().map(|a| &a.url),
            "coverUrl": artwork.as_ref().map(|a| &a.url),
            "tracks": tracks,
            "songCount": track_count,
            "trackCount": track_count,
            "localTrackCount": 0,
        }))
    }

    /// Fetches a full Deezer artist detail object (`external_deezer_artist_<id>`).
    pub async fn get_artist(&self, external_id: &str) -> Option<Value> {
        let deezer_id = external_id.strip_prefix("external_deezer_artist_")?;
        if deezer_id.is_empty() || !deezer_id.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let artist_url = format!("https://api.deezer.com/artist/{deezer_id}");
        let albums_url = format!("https://api.deezer.com/artist/{deezer_id}/albums?limit=50");
        let top_url = format!("https://api.deezer.com/artist/{deezer_id}/top?limit=25");

        let (artist_res, albums_res, top_res) = tokio::join!(
            self.http.get(&artist_url).send(),
            self.http.get(&albums_url).send(),
            self.http.get(&top_url).send()
        );

        let artist_payload: Value = artist_res.ok()?.json().await.ok()?;
        let name = artist_payload.get("name").and_then(Value::as_str)?.to_owned();
        let pic_raw = artist_payload
            .get("picture_xl")
            .or_else(|| artist_payload.get("picture_big"))
            .or_else(|| artist_payload.get("picture_medium"))
            .and_then(Value::as_str);
        let artwork = self.artwork_tokens.artwork_ref(pic_raw, &["dzcdn.net"]);

        let mut albums = Vec::new();
        if let Some(res) = albums_res.ok() {
            if let Ok(alb_payload) = res.json::<Value>().await {
                if let Some(arr) = alb_payload.get("data").and_then(Value::as_array) {
                    for item in arr {
                        let Some(aid) = item.get("id").and_then(Value::as_i64) else {
                            continue;
                        };
                        let alb_title = item
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("Unknown album");
                        let year = item
                            .get("release_date")
                            .and_then(Value::as_str)
                            .and_then(|s| s.get(0..4))
                            .and_then(|y| y.parse::<i32>().ok());
                        let cov = item
                            .get("cover_xl")
                            .or_else(|| item.get("cover_big"))
                            .or_else(|| item.get("cover_medium"))
                            .and_then(Value::as_str);
                        let alb_art = self.artwork_tokens.artwork_ref(cov, &["dzcdn.net"]);
                        albums.push(json!({
                            "id": format!("external_deezer_album_{aid}"),
                            "title": alb_title,
                            "artist": name,
                            "artistId": external_id,
                            "year": year,
                            "artwork": alb_art,
                            "artworkId": alb_art.as_ref().map(|a| &a.id),
                            "artworkUrl": alb_art.as_ref().map(|a| &a.url),
                            "identity": {
                                "id": format!("external:album:{}:{}", alb_title.to_lowercase(), name.to_lowercase()),
                                "strength": "normalized"
                            }
                        }));
                    }
                }
            }
        }

        let mut tracks = Vec::new();
        if let Some(res) = top_res.ok() {
            if let Ok(top_payload) = res.json::<Value>().await {
                if let Some(arr) = top_payload.get("data").and_then(Value::as_array) {
                    for item in arr {
                        let Some(tid) = item.get("id").and_then(Value::as_i64) else {
                            continue;
                        };
                        let tr_title = item
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("Unknown title");
                        let alb_title = item
                            .get("album")
                            .and_then(|a| a.get("title"))
                            .and_then(Value::as_str);
                        let alb_id = item
                            .get("album")
                            .and_then(|a| a.get("id"))
                            .and_then(Value::as_i64)
                            .map(|id| format!("external_deezer_album_{id}"));
                        let cov = item
                            .get("album")
                            .and_then(|a| a.get("cover_xl").or_else(|| a.get("cover_big")))
                            .and_then(Value::as_str);
                        let tr_art = self.artwork_tokens.artwork_ref(cov, &["dzcdn.net"]);
                        let duration = item.get("duration").and_then(Value::as_u64);
                        let preview_url = item
                            .get("preview")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty());

                        tracks.push(json!({
                            "type": "track",
                            "id": format!("external_deezer_track_{tid}"),
                            "title": tr_title,
                            "subtitle": name,
                            "artist": name,
                            "artistName": name,
                            "artistId": external_id,
                            "album": alb_title,
                            "albumName": alb_title,
                            "albumId": alb_id,
                            "artwork": tr_art,
                            "artworkId": tr_art.as_ref().map(|a| &a.id),
                            "artworkUrl": tr_art.as_ref().map(|a| &a.url),
                            "previewUrl": preview_url,
                            "durationSeconds": duration,
                            "provider": "external",
                            "source": { "kind": "external", "count": 0 },
                            "availability": null,
                            "metadata": {
                                "durationSeconds": duration,
                                "artistId": external_id,
                                "albumId": alb_id,
                                "deezerTrackId": tid,
                            }
                        }));
                    }
                }
            }
        }

        Some(json!({
            "id": external_id,
            "name": name,
            "artwork": artwork,
            "artworkId": artwork.as_ref().map(|a| &a.id),
            "imageUrl": artwork.as_ref().map(|a| &a.url),
            "albums": albums,
            "tracks": tracks,
        }))
    }
}

#[async_trait]
impl ExternalProvider for DeezerAdapter {
    fn name(&self) -> &'static str {
        "Deezer"
    }

    async fn search_tracks(&self, query: &str) -> Result<Vec<ExternalSearchItem>, ExternalError> {
        let items = self.query_entity("track", query).await?;
        let mut out = Vec::with_capacity(items.len());

        for item in items {
            let Some(id_num) = item.get("id").and_then(Value::as_i64) else {
                continue;
            };
            let title = item
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Unknown title")
                .to_owned();
            let artist_obj = item.get("artist");
            let artist_name = artist_obj
                .and_then(|a| a.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let artist_id = artist_obj
                .and_then(|a| a.get("id"))
                .and_then(Value::as_i64)
                .map(|id| format!("external_deezer_artist_{id}"));

            let album_obj = item.get("album");
            let album_title = album_obj
                .and_then(|a| a.get("title"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let album_id = album_obj
                .and_then(|a| a.get("id"))
                .and_then(Value::as_i64)
                .map(|id| format!("external_deezer_album_{id}"));
            let cover_url = album_obj.and_then(|a| {
                a.get("cover_xl")
                    .or_else(|| a.get("cover_big"))
                    .and_then(Value::as_str)
            });

            let duration = item.get("duration").and_then(Value::as_u64);
            let isrc = item
                .get("isrc")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);

            out.push(ExternalSearchItem {
                id: format!("external_deezer_track_{id_num}"),
                item_type: CatalogEntityType::Track,
                title,
                subtitle: artist_name.clone(),
                artist: artist_name,
                album: album_title,
                artwork: self.artwork_tokens.artwork_ref(cover_url, &["dzcdn.net"]),
                preview_url: item
                    .get("preview")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
                provider: String::from("external"),
                source: ExternalSourceBadge {
                    kind: String::from("external"),
                    count: 0,
                    external_available: None,
                },
                availability: None,
                metadata: json!({
                    "durationSeconds": duration,
                    "artistId": artist_id,
                    "albumId": album_id,
                }),
                identity_hints: isrc.map(|code| IdentityHints {
                    music_brainz_id: None,
                    isrc: Some(code),
                    upc: None,
                }),
                in_library: None,
                local_track_id: None,
                local_album_id: None,
            });
        }
        Ok(out)
    }

    async fn search_albums(&self, query: &str) -> Result<Vec<ExternalSearchItem>, ExternalError> {
        let items = self.query_entity("album", query).await?;
        let mut out = Vec::with_capacity(items.len());

        for item in items {
            let Some(id_num) = item.get("id").and_then(Value::as_i64) else {
                continue;
            };
            let title = item
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Unknown album")
                .to_owned();
            let artist_obj = item.get("artist");
            let artist_name = artist_obj
                .and_then(|a| a.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let artist_id = artist_obj
                .and_then(|a| a.get("id"))
                .and_then(Value::as_i64)
                .map(|id| format!("external_deezer_artist_{id}"));
            let cover_url = item
                .get("cover_xl")
                .or_else(|| item.get("cover_big"))
                .and_then(Value::as_str);

            out.push(ExternalSearchItem {
                id: format!("external_deezer_album_{id_num}"),
                item_type: CatalogEntityType::Album,
                title,
                subtitle: artist_name.clone(),
                artist: artist_name,
                album: None,
                artwork: self.artwork_tokens.artwork_ref(cover_url, &["dzcdn.net"]),
                preview_url: None,
                provider: String::from("external"),
                source: ExternalSourceBadge {
                    kind: String::from("external"),
                    count: 0,
                    external_available: None,
                },
                availability: None,
                metadata: json!({
                    "artistId": artist_id,
                }),
                identity_hints: None,
                in_library: None,
                local_track_id: None,
                local_album_id: None,
            });
        }
        Ok(out)
    }

    async fn search_artists(&self, query: &str) -> Result<Vec<ExternalSearchItem>, ExternalError> {
        let items = self.query_entity("artist", query).await?;
        let mut out = Vec::with_capacity(items.len());

        for item in items {
            let Some(id_num) = item.get("id").and_then(Value::as_i64) else {
                continue;
            };
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(query)
                .to_owned();
            let pic_url = item
                .get("picture_xl")
                .or_else(|| item.get("picture_big"))
                .and_then(Value::as_str);

            out.push(ExternalSearchItem {
                id: format!("external_deezer_artist_{id_num}"),
                item_type: CatalogEntityType::Artist,
                title: name.clone(),
                subtitle: Some(String::from("Artist")),
                artist: Some(name),
                album: None,
                artwork: self.artwork_tokens.artwork_ref(pic_url, &["dzcdn.net"]),
                preview_url: None,
                provider: String::from("external"),
                source: ExternalSourceBadge {
                    kind: String::from("external"),
                    count: 0,
                    external_available: None,
                },
                availability: None,
                metadata: json!({}),
                identity_hints: None,
                in_library: None,
                local_track_id: None,
                local_album_id: None,
            });
        }
        Ok(out)
    }
}

// ============================================================================
// 2. `ItunesAdapter` (`server/src/services/adapters/iTunesAdapter.ts`)
// ============================================================================

/// Keyless Apple iTunes Search API adapter (`https://itunes.apple.com/search`).
#[derive(Debug, Clone)]
pub struct ItunesAdapter {
    http: reqwest::Client,
    artwork_tokens: ExternalArtworkTokenStore,
    limit: usize,
}

impl ItunesAdapter {
    /// Creates a new [`ItunesAdapter`].
    #[must_use]
    pub fn new(artwork_tokens: ExternalArtworkTokenStore, limit: usize) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_millis(EXTERNAL_ADAPTER_TIMEOUT_MS))
            .build()
            .unwrap_or_default();
        Self {
            http,
            artwork_tokens,
            limit: limit.clamp(1, 50),
        }
    }

    fn upgrade_artwork_url(&self, raw_url: Option<&str>) -> Option<ExternalArtworkRef> {
        let u = raw_url?;
        let large = u
            .replace("100x100bb.jpg", "1000x1000bb.jpg")
            .replace("100x100bb.png", "1000x1000bb.png");
        self.artwork_tokens.artwork_ref(Some(&large), &["mzstatic.com"])
    }

    async fn query_entity(&self, entity: &str, query: &str) -> Result<Vec<Value>, ExternalError> {
        let mut url = Url::parse("https://itunes.apple.com/search").expect("valid itunes url");
        url.query_pairs_mut()
            .append_pair("term", query)
            .append_pair("entity", entity)
            .append_pair("limit", &self.limit.to_string());

        let res = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|err| ExternalError::Upstream {
                provider: "iTunes",
                message: err.to_string(),
            })?;

        if !res.status().is_success() {
            return Err(ExternalError::Upstream {
                provider: "iTunes",
                message: format!("iTunes search failed (HTTP {})", res.status().as_u16()),
            });
        }

        let payload: Value = res.json().await.map_err(|_| ExternalError::InvalidPayload {
            provider: "iTunes",
            message: String::from("Invalid JSON from iTunes"),
        })?;

        let Some(results) = payload.get("results").and_then(Value::as_array) else {
            return Err(ExternalError::InvalidPayload {
                provider: "iTunes",
                message: String::from("iTunes returned invalid search data"),
            });
        };

        Ok(results.clone())
    }

    /// Fetches a full iTunes album detail object (`external_itunes_album_<id>`).
    pub async fn get_album(&self, external_id: &str) -> Option<Value> {
        let itunes_id = external_id.strip_prefix("external_itunes_album_")?;
        if itunes_id.is_empty() || !itunes_id.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let mut url = Url::parse("https://itunes.apple.com/lookup").expect("valid itunes lookup url");
        url.query_pairs_mut()
            .append_pair("id", itunes_id)
            .append_pair("entity", "song")
            .append_pair("limit", "200");

        let res = self.http.get(url).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        let payload: Value = res.json().await.ok()?;
        let results = payload.get("results")?.as_array()?;
        let collection = results.iter().find(|r| {
            r.get("wrapperType").and_then(Value::as_str) == Some("collection")
        })?;

        let title = collection
            .get("collectionName")
            .and_then(Value::as_str)
            .unwrap_or("Unknown album")
            .to_owned();
        let artist_name = collection
            .get("artistName")
            .and_then(Value::as_str)
            .unwrap_or("Unknown artist")
            .to_owned();
        let artist_id = collection
            .get("artistId")
            .and_then(Value::as_i64)
            .map(|id| format!("external_itunes_artist_{id}"));
        let release_date = collection
            .get("releaseDate")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let year = release_date
            .as_deref()
            .and_then(|s| s.get(0..4))
            .and_then(|y| y.parse::<i32>().ok());
        let genre = collection
            .get("primaryGenreName")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let artwork = self.upgrade_artwork_url(collection.get("artworkUrl100").and_then(Value::as_str));

        let mut tracks = Vec::new();
        for item in results {
            if item.get("wrapperType").and_then(Value::as_str) != Some("track") {
                continue;
            }
            let Some(tid) = item.get("trackId").and_then(Value::as_i64) else {
                continue;
            };
            let tr_title = item
                .get("trackName")
                .and_then(Value::as_str)
                .unwrap_or("Unknown title");
            let tr_artist = item
                .get("artistName")
                .and_then(Value::as_str)
                .unwrap_or(&artist_name);
            let tr_artist_id = item
                .get("artistId")
                .and_then(Value::as_i64)
                .map(|id| format!("external_itunes_artist_{id}"))
                .or_else(|| artist_id.clone());
            let duration = item
                .get("trackTimeMillis")
                .and_then(Value::as_f64)
                .map(|ms| (ms / 1000.0).round() as u64);
            let preview_url = item
                .get("previewUrl")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());

            tracks.push(json!({
                "type": "track",
                "id": format!("external_itunes_{tid}"),
                "title": tr_title,
                "subtitle": tr_artist,
                "artist": tr_artist,
                "artistName": tr_artist,
                "artistId": tr_artist_id,
                "album": title,
                "albumName": title,
                "albumId": external_id,
                "artwork": artwork,
                "artworkId": artwork.as_ref().map(|a| &a.id),
                "artworkUrl": artwork.as_ref().map(|a| &a.url),
                "previewUrl": preview_url,
                "durationSeconds": duration,
                "provider": "external",
                "source": { "kind": "external", "count": 0 },
                "availability": null,
                "metadata": {
                    "durationSeconds": duration,
                    "artistId": tr_artist_id,
                    "albumId": external_id,
                    "itunesTrackId": tid,
                }
            }));
        }

        let track_count = tracks.len();
        Some(json!({
            "id": external_id,
            "title": title,
            "name": title,
            "artist": artist_name,
            "artistName": artist_name,
            "artistId": artist_id,
            "year": year,
            "releaseDate": release_date,
            "genre": genre,
            "label": null,
            "artwork": artwork,
            "artworkId": artwork.as_ref().map(|a| &a.id),
            "artworkUrl": artwork.as_ref().map(|a| &a.url),
            "coverUrl": artwork.as_ref().map(|a| &a.url),
            "tracks": tracks,
            "songCount": track_count,
            "trackCount": track_count,
            "localTrackCount": 0,
        }))
    }

    /// Fetches a full iTunes artist detail object (`external_itunes_artist_<id>`).
    pub async fn get_artist(&self, external_id: &str) -> Option<Value> {
        let itunes_id = external_id.strip_prefix("external_itunes_artist_")?;
        if itunes_id.is_empty() || !itunes_id.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let mut alb_url = Url::parse("https://itunes.apple.com/lookup").expect("valid itunes lookup url");
        alb_url
            .query_pairs_mut()
            .append_pair("id", itunes_id)
            .append_pair("entity", "album")
            .append_pair("limit", "50");

        let mut song_url = Url::parse("https://itunes.apple.com/lookup").expect("valid itunes lookup url");
        song_url
            .query_pairs_mut()
            .append_pair("id", itunes_id)
            .append_pair("entity", "song")
            .append_pair("limit", "25");

        let (alb_res, song_res) = tokio::join!(self.http.get(alb_url).send(), self.http.get(song_url).send());

        let alb_payload: Value = alb_res.ok()?.json().await.ok()?;
        let alb_results = alb_payload.get("results")?.as_array()?;
        let artist_entry = alb_results.iter().find(|r| {
            r.get("wrapperType").and_then(Value::as_str) == Some("artist")
        })?;
        let name = artist_entry.get("artistName").and_then(Value::as_str)?.to_owned();

        let mut albums = Vec::new();
        for item in alb_results {
            if item.get("wrapperType").and_then(Value::as_str) != Some("collection") {
                continue;
            }
            let Some(cid) = item.get("collectionId").and_then(Value::as_i64) else {
                continue;
            };
            let alb_title = item
                .get("collectionName")
                .and_then(Value::as_str)
                .unwrap_or("Unknown album");
            let year = item
                .get("releaseDate")
                .and_then(Value::as_str)
                .and_then(|s| s.get(0..4))
                .and_then(|y| y.parse::<i32>().ok());
            let alb_art = self.upgrade_artwork_url(item.get("artworkUrl100").and_then(Value::as_str));
            albums.push(json!({
                "id": format!("external_itunes_album_{cid}"),
                "title": alb_title,
                "artist": name,
                "artistId": external_id,
                "year": year,
                "artwork": alb_art,
                "artworkId": alb_art.as_ref().map(|a| &a.id),
                "artworkUrl": alb_art.as_ref().map(|a| &a.url),
                "identity": {
                    "id": format!("external:album:{}:{}", alb_title.to_lowercase(), name.to_lowercase()),
                    "strength": "normalized"
                }
            }));
        }

        let mut tracks = Vec::new();
        if let Some(res) = song_res.ok() {
            if let Ok(song_payload) = res.json::<Value>().await {
                if let Some(song_results) = song_payload.get("results").and_then(Value::as_array) {
                    for item in song_results {
                        if item.get("wrapperType").and_then(Value::as_str) != Some("track") {
                            continue;
                        }
                        let Some(tid) = item.get("trackId").and_then(Value::as_i64) else {
                            continue;
                        };
                        let tr_title = item
                            .get("trackName")
                            .and_then(Value::as_str)
                            .unwrap_or("Unknown title");
                        let alb_title = item.get("collectionName").and_then(Value::as_str);
                        let alb_id = item
                            .get("collectionId")
                            .and_then(Value::as_i64)
                            .map(|id| format!("external_itunes_album_{id}"));
                        let tr_art = self.upgrade_artwork_url(item.get("artworkUrl100").and_then(Value::as_str));
                        let duration = item
                            .get("trackTimeMillis")
                            .and_then(Value::as_f64)
                            .map(|ms| (ms / 1000.0).round() as u64);
                        let preview_url = item
                            .get("previewUrl")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty());

                        tracks.push(json!({
                            "type": "track",
                            "id": format!("external_itunes_{tid}"),
                            "title": tr_title,
                            "subtitle": name,
                            "artist": name,
                            "artistName": name,
                            "artistId": external_id,
                            "album": alb_title,
                            "albumName": alb_title,
                            "albumId": alb_id,
                            "artwork": tr_art,
                            "artworkId": tr_art.as_ref().map(|a| &a.id),
                            "artworkUrl": tr_art.as_ref().map(|a| &a.url),
                            "previewUrl": preview_url,
                            "durationSeconds": duration,
                            "provider": "external",
                            "source": { "kind": "external", "count": 0 },
                            "availability": null,
                            "metadata": {
                                "durationSeconds": duration,
                                "artistId": external_id,
                                "albumId": alb_id,
                                "itunesTrackId": tid,
                            }
                        }));
                    }
                }
            }
        }

        Some(json!({
            "id": external_id,
            "name": name,
            "artwork": null,
            "artworkId": null,
            "imageUrl": null,
            "albums": albums,
            "tracks": tracks,
        }))
    }
}

#[async_trait]
impl ExternalProvider for ItunesAdapter {
    fn name(&self) -> &'static str {
        "iTunes"
    }

    async fn search_tracks(&self, query: &str) -> Result<Vec<ExternalSearchItem>, ExternalError> {
        let items = self.query_entity("song", query).await?;
        let mut out = Vec::with_capacity(items.len());

        for item in items {
            let Some(track_id) = item.get("trackId").and_then(Value::as_i64) else {
                continue;
            };
            let Some(track_name) = item
                .get("trackName")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };

            let artist_name = item
                .get("artistName")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let album_name = item
                .get("collectionName")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let duration_secs = item
                .get("trackTimeMillis")
                .and_then(Value::as_f64)
                .map(|ms| (ms / 1000.0).round() as u64);
            let artist_id = item
                .get("artistId")
                .and_then(Value::as_i64)
                .map(|id| format!("external_itunes_artist_{id}"));
            let album_id = item
                .get("collectionId")
                .and_then(Value::as_i64)
                .map(|id| format!("external_itunes_album_{id}"));

            out.push(ExternalSearchItem {
                id: format!("external_itunes_{track_id}"),
                item_type: CatalogEntityType::Track,
                title: track_name.to_owned(),
                subtitle: artist_name.clone(),
                artist: artist_name,
                album: album_name,
                artwork: self
                    .upgrade_artwork_url(item.get("artworkUrl100").and_then(Value::as_str)),
                preview_url: item
                    .get("previewUrl")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                provider: String::from("external"),
                source: ExternalSourceBadge {
                    kind: String::from("external"),
                    count: 0,
                    external_available: Some(true),
                },
                availability: None,
                metadata: json!({
                    "durationSeconds": duration_secs,
                    "itunesTrackId": track_id,
                    "artistId": artist_id,
                    "albumId": album_id,
                }),
                identity_hints: None,
                in_library: None,
                local_track_id: None,
                local_album_id: None,
            });
        }
        Ok(out)
    }

    async fn search_albums(&self, query: &str) -> Result<Vec<ExternalSearchItem>, ExternalError> {
        let items = self.query_entity("album", query).await?;
        let mut out = Vec::with_capacity(items.len());

        for item in items {
            let Some(collection_id) = item.get("collectionId").and_then(Value::as_i64) else {
                continue;
            };
            let Some(collection_name) = item
                .get("collectionName")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let artist_name = item
                .get("artistName")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let artist_id = item
                .get("artistId")
                .and_then(Value::as_i64)
                .map(|id| format!("external_itunes_artist_{id}"));

            out.push(ExternalSearchItem {
                id: format!("external_itunes_album_{collection_id}"),
                item_type: CatalogEntityType::Album,
                title: collection_name.to_owned(),
                subtitle: artist_name.clone(),
                artist: artist_name,
                album: None,
                artwork: self
                    .upgrade_artwork_url(item.get("artworkUrl100").and_then(Value::as_str)),
                preview_url: None,
                provider: String::from("external"),
                source: ExternalSourceBadge {
                    kind: String::from("external"),
                    count: 0,
                    external_available: None,
                },
                availability: None,
                metadata: json!({
                    "artistId": artist_id,
                }),
                identity_hints: None,
                in_library: None,
                local_track_id: None,
                local_album_id: None,
            });
        }
        Ok(out)
    }

    async fn search_artists(&self, query: &str) -> Result<Vec<ExternalSearchItem>, ExternalError> {
        let items = self.query_entity("musicArtist", query).await?;
        let mut out = Vec::with_capacity(items.len());

        for item in items {
            let Some(artist_id) = item.get("artistId").and_then(Value::as_i64) else {
                continue;
            };
            let name = item
                .get("artistName")
                .and_then(Value::as_str)
                .unwrap_or(query)
                .to_owned();

            out.push(ExternalSearchItem {
                id: format!("external_itunes_artist_{artist_id}"),
                item_type: CatalogEntityType::Artist,
                title: name.clone(),
                subtitle: Some(String::from("Artist")),
                artist: Some(name),
                album: None,
                artwork: None,
                preview_url: None,
                provider: String::from("external"),
                source: ExternalSourceBadge {
                    kind: String::from("external"),
                    count: 0,
                    external_available: None,
                },
                availability: None,
                metadata: json!({}),
                identity_hints: None,
                in_library: None,
                local_track_id: None,
                local_album_id: None,
            });
        }
        Ok(out)
    }
}

// ============================================================================
// 3. `SubsonicAdapter` (`server/src/services/adapters/SubsonicAdapter.ts`)
// ============================================================================

/// Local library search adapter wrapping [`CatalogService`] so local Navidrome/Jellyfin
/// entities share the [`ExternalProvider`] read model.
#[derive(Debug, Clone)]
pub struct SubsonicAdapter {
    catalog: CatalogService,
}

impl SubsonicAdapter {
    /// Creates a new [`SubsonicAdapter`] backed by `catalog`.
    #[must_use]
    pub const fn new(catalog: CatalogService) -> Self {
        Self { catalog }
    }
}

#[async_trait]
impl ExternalProvider for SubsonicAdapter {
    fn name(&self) -> &'static str {
        "Subsonic"
    }

    async fn search_tracks(&self, query: &str) -> Result<Vec<ExternalSearchItem>, ExternalError> {
        let found = self
            .catalog
            .search(query, &["tracks"], None)
            .await
            .map_err(|err| ExternalError::Upstream {
                provider: "Subsonic",
                message: err.to_string(),
            })?;

        Ok(found
            .tracks
            .into_iter()
            .map(|av| {
                let t = av.item;
                ExternalSearchItem {
                    id: t.id,
                    item_type: CatalogEntityType::Track,
                    title: t.title,
                    subtitle: Some(t.artist_name.clone()),
                    artist: Some(t.artist_name),
                    album: Some(t.album_name),
                    artwork: t.artwork_id.zip(t.artwork_url).map(|(id, url)| {
                        ExternalArtworkRef { id, url }
                    }),
                    preview_url: None,
                    provider: String::from("library"),
                    source: ExternalSourceBadge {
                        kind: String::from("library"),
                        count: av.availability.available_source_count,
                        external_available: None,
                    },
                    availability: serde_json::to_value(av.availability).ok(),
                    metadata: json!({
                        "durationSeconds": t.duration_seconds,
                        "artistId": t.artist_id,
                        "albumId": t.album_id,
                    }),
                    identity_hints: t.identity_hints,
                    in_library: Some(true),
                    local_track_id: None,
                    local_album_id: None,
                }
            })
            .collect())
    }

    async fn search_albums(&self, query: &str) -> Result<Vec<ExternalSearchItem>, ExternalError> {
        let found = self
            .catalog
            .search(query, &["albums"], None)
            .await
            .map_err(|err| ExternalError::Upstream {
                provider: "Subsonic",
                message: err.to_string(),
            })?;

        Ok(found
            .albums
            .into_iter()
            .map(|av| {
                let a = av.item;
                ExternalSearchItem {
                    id: a.id,
                    item_type: CatalogEntityType::Album,
                    title: a.name,
                    subtitle: Some(a.artist_name.clone()),
                    artist: Some(a.artist_name),
                    album: None,
                    artwork: a.artwork_id.zip(a.artwork_url).map(|(id, url)| {
                        ExternalArtworkRef { id, url }
                    }),
                    preview_url: None,
                    provider: String::from("library"),
                    source: ExternalSourceBadge {
                        kind: String::from("library"),
                        count: av.availability.available_source_count,
                        external_available: None,
                    },
                    availability: serde_json::to_value(av.availability).ok(),
                    metadata: json!({
                        "artistId": a.artist_id,
                        "year": a.year,
                        "songCount": a.song_count,
                    }),
                    identity_hints: a.identity_hints,
                    in_library: Some(true),
                    local_track_id: None,
                    local_album_id: None,
                }
            })
            .collect())
    }

    async fn search_artists(&self, query: &str) -> Result<Vec<ExternalSearchItem>, ExternalError> {
        let found = self
            .catalog
            .search(query, &["artists"], None)
            .await
            .map_err(|err| ExternalError::Upstream {
                provider: "Subsonic",
                message: err.to_string(),
            })?;

        Ok(found
            .artists
            .into_iter()
            .map(|av| {
                let ar = av.item;
                ExternalSearchItem {
                    id: ar.id,
                    item_type: CatalogEntityType::Artist,
                    title: ar.name.clone(),
                    subtitle: Some(String::from("Artist")),
                    artist: Some(ar.name),
                    album: None,
                    artwork: ar.artwork_id.zip(ar.artwork_url).map(|(id, url)| {
                        ExternalArtworkRef { id, url }
                    }),
                    preview_url: None,
                    provider: String::from("library"),
                    source: ExternalSourceBadge {
                        kind: String::from("library"),
                        count: av.availability.available_source_count,
                        external_available: None,
                    },
                    availability: serde_json::to_value(av.availability).ok(),
                    metadata: json!({
                        "albumCount": ar.album_count,
                    }),
                    identity_hints: ar.identity_hints,
                    in_library: Some(true),
                    local_track_id: None,
                    local_album_id: None,
                }
            })
            .collect())
    }
}

fn current_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}
