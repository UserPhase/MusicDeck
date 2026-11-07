//! # Jellyfin Media Backend Client (`providers::jellyfin`)
//!
//! Complete Rust port of `server/src/backends/jellyfin/jellyfin-backend.ts`
//! and `server/src/backends/jellyfin/jellyfin-mapper.ts`.
//!
//! ## Authentication & Protocol Invariants
//! - **Header-Only API Key (`X-Emby-Token`)**: Jellyfin authentication is transmitted
//!   exclusively via the `X-Emby-Token` HTTP request header. The API key is never
//!   placed in query parameters, URLs, or error messages.
//! - **Tick Conversion**: Jellyfin `RunTimeTicks` ($100\text{ ns}$ units) are converted
//!   to seconds via `(ticks as f64 / 10_000_000.0).round() as u32`.
//! - **Catalog + Stream Only**: Jellyfin implements catalog browsing and direct/transcoded
//!   streaming; `supports_user_data_sync()` returns `false` so [`crate::providers::with_local_user_data_sync`]
//!   keeps favorites and playlists in MusicDeck's local SQLite database.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use async_trait::async_trait;
use http::header::RANGE;
use serde_json::Value;
use url::Url;

use crate::config::JellyfinConfig;
use crate::providers::models::{
    Album, Artist, AudioMetadataSummary, AudioStreamInfo, IdentityHints, LibraryScanResult,
    ReplayGainMetadata, SearchPagination, SearchResult, StreamResult, Track, TrackArtistCredit,
    format_artwork_url, format_stream_url,
};
use crate::providers::traits::{MusicBackend, ProviderError};

/// Control-plane HTTP timeout (`15,000` ms) matching `JELLYFIN_REQUEST_TIMEOUT_MS`.
pub const JELLYFIN_REQUEST_TIMEOUT_MS: u64 = 15_000;

/// Canonical Jellyfin token header name.
pub const HEADER_X_EMBY_TOKEN: &str = "X-Emby-Token";

/// Asynchronous Jellyfin media backend client backed by a pooled `reqwest::Client`.
#[derive(Debug, Clone)]
pub struct JellyfinClient {
    base_url: String,
    api_key: String,
    http: reqwest::Client,
}

/// Alias matching the legacy TypeScript class name `JellyfinBackend`.
pub type JellyfinBackend = JellyfinClient;

impl JellyfinClient {
    /// Constructs a new [`JellyfinClient`] from [`JellyfinConfig`].
    pub fn new(config: JellyfinConfig) -> Result<Self, ProviderError> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_millis(5_000))
            .pool_max_idle_per_host(16)
            .build()
            .map_err(|err| ProviderError::Configuration(format!("HTTP client init failed: {err}")))?;

        Ok(Self::with_client(config, http))
    }

    /// Constructs a [`JellyfinClient`] using an existing pooled [`reqwest::Client`].
    #[must_use]
    pub fn with_client(config: JellyfinConfig, http: reqwest::Client) -> Self {
        Self {
            base_url: config.url.trim_end_matches('/').to_owned(),
            api_key: config.api_key,
            http,
        }
    }

    /// Builds a Jellyfin endpoint URL with non-empty query parameters.
    pub fn build_url(
        &self,
        path: &str,
        params: &[(&str, String)],
    ) -> Result<Url, ProviderError> {
        let clean_path = path.trim_start_matches('/');
        let raw = format!("{}/{clean_path}", self.base_url);
        let mut url = Url::parse(&raw).map_err(|err| ProviderError::Configuration(err.to_string()))?;

        if !params.is_empty() {
            let mut qp = url.query_pairs_mut();
            for (key, value) in params {
                if !value.is_empty() {
                    qp.append_pair(key, value);
                }
            }
        }

        Ok(url)
    }

    async fn request_json(
        &self,
        path: &str,
        params: &[(&str, String)],
    ) -> Result<Value, ProviderError> {
        let url = self.build_url(path, params)?;
        let response = self
            .http
            .get(url)
            .header(HEADER_X_EMBY_TOKEN, &self.api_key)
            .timeout(Duration::from_millis(JELLYFIN_REQUEST_TIMEOUT_MS))
            .send()
            .await
            .map_err(|err| {
                if err.is_timeout() {
                    ProviderError::Timeout {
                        provider: "Jellyfin",
                    }
                } else {
                    ProviderError::Upstream {
                        provider: "Jellyfin",
                        message: String::from("Jellyfin connection failed"),
                    }
                }
            })?;

        let status = response.status();
        if !status.is_success() {
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err(ProviderError::Authentication {
                    provider: "Jellyfin",
                    message: String::from("Jellyfin authentication failed"),
                });
            }
            if status.as_u16() == 404 {
                return Err(ProviderError::NotFound {
                    provider: "Jellyfin",
                });
            }
            return Err(ProviderError::Upstream {
                provider: "Jellyfin",
                message: format!("Jellyfin returned {}", status.as_u16()),
            });
        }

        response.json::<Value>().await.map_err(|_| ProviderError::Upstream {
            provider: "Jellyfin",
            message: String::from("Jellyfin returned invalid JSON"),
        })
    }

    async fn list_items<T, F>(
        &self,
        params: &[(&str, String)],
        map_fn: F,
    ) -> Result<Vec<T>, ProviderError>
    where
        F: Fn(&Value) -> T,
    {
        let res = self.request_json("Items", params).await?;
        Ok(res
            .get("Items")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(map_fn).collect())
            .unwrap_or_default())
    }
}

#[async_trait]
impl MusicBackend for JellyfinClient {
    fn provider_kind(&self) -> &'static str {
        "jellyfin"
    }

    async fn list_albums(&self, limit: Option<u32>) -> Result<Vec<Album>, ProviderError> {
        let size = limit.unwrap_or(500);
        self.list_items(
            &[
                ("IncludeItemTypes", String::from("MusicAlbum")),
                ("Recursive", String::from("true")),
                ("SortBy", String::from("SortName")),
                ("Limit", size.to_string()),
            ],
            map_jellyfin_album,
        )
        .await
    }

    async fn list_all_albums(&self) -> Result<Vec<Album>, ProviderError> {
        let mut albums_by_id: HashMap<String, Album> = HashMap::new();
        let mut ordered_ids: Vec<String> = Vec::new();
        let mut offset = 0usize;

        loop {
            let res = self
                .request_json(
                    "Items",
                    &[
                        ("IncludeItemTypes", String::from("MusicAlbum")),
                        ("Recursive", String::from("true")),
                        ("SortBy", String::from("SortName")),
                        ("Limit", String::from("500")),
                        ("StartIndex", offset.to_string()),
                    ],
                )
                .await?;

            let page = res
                .get("Items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let total_record_count = res
                .get("TotalRecordCount")
                .and_then(Value::as_u64)
                .and_then(|c| usize::try_from(c).ok());

            let before_count = albums_by_id.len();
            let page_len = page.len();
            for item in &page {
                let album = map_jellyfin_album(item);
                if !albums_by_id.contains_key(&album.id) {
                    ordered_ids.push(album.id.clone());
                }
                albums_by_id.insert(album.id.clone(), album);
            }

            if page_len > 0 && albums_by_id.len() == before_count {
                return Err(ProviderError::PaginationStalled {
                    provider: "Jellyfin",
                    entity: "album",
                });
            }

            if page_len < 500
                || total_record_count.is_some_and(|total| offset + page_len >= total)
            {
                break;
            }
            offset += 500;
        }

        Ok(ordered_ids
            .into_iter()
            .filter_map(|id| albums_by_id.remove(&id))
            .collect())
    }

    async fn get_album(&self, album_id: &str) -> Result<Option<Album>, ProviderError> {
        let items = self
            .list_items(
                &[
                    ("Ids", album_id.to_owned()),
                    ("IncludeItemTypes", String::from("MusicAlbum")),
                ],
                map_jellyfin_album,
            )
            .await?;
        Ok(items.into_iter().next())
    }

    async fn get_album_tracks(&self, album_id: &str) -> Result<Vec<Track>, ProviderError> {
        self.list_items(
            &[
                ("ParentId", album_id.to_owned()),
                ("IncludeItemTypes", String::from("Audio")),
                ("SortBy", String::from("ParentIndexNumber,IndexNumber")),
            ],
            map_jellyfin_track,
        )
        .await
    }

    async fn get_artists(&self) -> Result<Vec<Artist>, ProviderError> {
        let res = self
            .request_json("Artists", &[("SortBy", String::from("SortName"))])
            .await?;

        Ok(res
            .get("Items")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(map_jellyfin_artist).collect())
            .unwrap_or_default())
    }

    async fn get_artist(
        &self,
        artist_id: &str,
        _include_artist_info: bool,
    ) -> Result<Option<Artist>, ProviderError> {
        let items = self
            .list_items(
                &[
                    ("Ids", artist_id.to_owned()),
                    ("IncludeItemTypes", String::from("MusicArtist")),
                ],
                map_jellyfin_artist,
            )
            .await?;
        Ok(items.into_iter().next())
    }

    async fn get_artist_albums(&self, artist_id: &str) -> Result<Vec<Album>, ProviderError> {
        self.list_items(
            &[
                ("ArtistIds", artist_id.to_owned()),
                ("IncludeItemTypes", String::from("MusicAlbum")),
                ("Recursive", String::from("true")),
            ],
            map_jellyfin_album,
        )
        .await
    }

    async fn get_artist_tracks(&self, artist_id: &str) -> Result<Vec<Track>, ProviderError> {
        self.list_items(
            &[
                ("ArtistIds", artist_id.to_owned()),
                ("IncludeItemTypes", String::from("Audio")),
                ("Recursive", String::from("true")),
            ],
            map_jellyfin_track,
        )
        .await
    }

    async fn get_artist_top_tracks(
        &self,
        artist_id: &str,
        limit: usize,
    ) -> Result<Vec<Track>, ProviderError> {
        let count = limit.clamp(1, 10);
        self.list_items(
            &[
                ("ArtistIds", artist_id.to_owned()),
                ("IncludeItemTypes", String::from("Audio")),
                ("Recursive", String::from("true")),
                ("SortBy", String::from("PlayCount")),
                ("SortOrder", String::from("Descending")),
                ("StartIndex", String::from("0")),
                ("Limit", count.to_string()),
            ],
            map_jellyfin_track,
        )
        .await
    }

    async fn list_tracks(&self) -> Result<Vec<Track>, ProviderError> {
        let mut tracks_by_id: HashMap<String, Track> = HashMap::new();
        let mut ordered_ids: Vec<String> = Vec::new();
        let mut offset = 0usize;

        loop {
            let res = self
                .request_json(
                    "Items",
                    &[
                        ("IncludeItemTypes", String::from("Audio")),
                        ("Recursive", String::from("true")),
                        ("SortBy", String::from("SortName")),
                        ("Limit", String::from("500")),
                        ("StartIndex", offset.to_string()),
                        (
                            "Fields",
                            String::from(
                                "Genres,ArtistItems,AlbumArtists,ProductionYear,MediaSources,Path",
                            ),
                        ),
                    ],
                )
                .await?;

            let page = res
                .get("Items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let total_record_count = res
                .get("TotalRecordCount")
                .and_then(Value::as_u64)
                .and_then(|c| usize::try_from(c).ok());

            let before_count = tracks_by_id.len();
            let page_len = page.len();
            for item in &page {
                let track = map_jellyfin_track(item);
                if !tracks_by_id.contains_key(&track.id) {
                    ordered_ids.push(track.id.clone());
                }
                tracks_by_id.insert(track.id.clone(), track);
            }

            if page_len > 0 && tracks_by_id.len() == before_count {
                return Err(ProviderError::PaginationStalled {
                    provider: "Jellyfin",
                    entity: "track",
                });
            }

            if page_len < 500
                || total_record_count.is_some_and(|total| offset + page_len >= total)
            {
                break;
            }
            offset += 500;
        }

        Ok(ordered_ids
            .into_iter()
            .filter_map(|id| tracks_by_id.remove(&id))
            .collect())
    }

    async fn get_track(&self, track_id: &str) -> Result<Option<Track>, ProviderError> {
        let items = self
            .list_items(
                &[
                    ("Ids", track_id.to_owned()),
                    ("IncludeItemTypes", String::from("Audio")),
                    ("Fields", String::from("MediaStreams,MediaSources,Path")),
                ],
                map_jellyfin_track,
            )
            .await?;
        Ok(items.into_iter().next())
    }

    async fn get_track_file_path(&self, track_id: &str) -> Result<Option<String>, ProviderError> {
        let res = self
            .request_json(
                "Items",
                &[
                    ("Ids", track_id.to_owned()),
                    ("IncludeItemTypes", String::from("Audio")),
                    ("Fields", String::from("Path")),
                ],
            )
            .await?;

        let path_opt = res
            .get("Items")
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(|item| item.get("Path"))
            .and_then(Value::as_str)
            .map(str::to_owned);

        Ok(path_opt)
    }

    async fn get_lyrics(&self, track_id: &str) -> Result<Option<String>, ProviderError> {
        let path = format!("Audio/{}/Lyrics", urlencoding::encode(track_id));
        let Ok(res) = self.request_json(&path, &[]).await else {
            return Ok(None);
        };

        let Some(lines) = res
            .get("Lyrics")
            .or_else(|| res.get("lyrics"))
            .and_then(Value::as_array)
        else {
            return Ok(None);
        };

        let mut formatted = Vec::new();
        for line in lines {
            let text = line
                .as_str()
                .or_else(|| line.get("Text").and_then(Value::as_str))
                .or_else(|| line.get("text").and_then(Value::as_str))
                .unwrap_or_default()
                .trim();
            if !text.is_empty() {
                formatted.push(text.to_owned());
            }
        }

        if formatted.is_empty() {
            Ok(None)
        } else {
            Ok(Some(formatted.join("\n")))
        }
    }

    async fn get_artist_biography_for_track(
        &self,
        track_id: &str,
    ) -> Result<Option<String>, ProviderError> {
        let Ok(track_res) = self
            .request_json(
                "Items",
                &[
                    ("Ids", track_id.to_owned()),
                    ("IncludeItemTypes", String::from("Audio")),
                    ("Fields", String::from("ArtistItems,AlbumArtists")),
                ],
            )
            .await
        else {
            return Ok(None);
        };

        let artist_id = track_res
            .get("Items")
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(|item| {
                first_array_id(item.get("ArtistItems"))
                    .or_else(|| first_array_id(item.get("AlbumArtists")))
            });

        let Some(artist_id) = artist_id else {
            return Ok(None);
        };

        let Ok(artist_res) = self
            .request_json(
                "Items",
                &[
                    ("Ids", artist_id),
                    ("IncludeItemTypes", String::from("MusicArtist")),
                    ("Fields", String::from("Overview")),
                ],
            )
            .await
        else {
            return Ok(None);
        };

        let bio = artist_res
            .get("Items")
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(|item| item.get("Overview"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);

        Ok(bio)
    }

    async fn search(
        &self,
        query: &str,
        types: &[&str],
        pagination: Option<SearchPagination>,
    ) -> Result<SearchResult, ProviderError> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(SearchResult::default());
        }

        let wants: HashSet<&str> = if types.is_empty() {
            HashSet::from(["artists", "albums", "tracks"])
        } else {
            types.iter().copied().collect()
        };

        let mut include_types = Vec::new();
        if wants.contains("artists") {
            include_types.push("MusicArtist");
        }
        if wants.contains("albums") {
            include_types.push("MusicAlbum");
        }
        if wants.contains("tracks") || wants.contains("songs") {
            include_types.push("Audio");
        }

        if include_types.is_empty() {
            return Ok(SearchResult::default());
        }

        let limit = pagination.map_or(100, |p| p.limit.clamp(1, 500));
        let mut params = vec![
            ("searchTerm", trimmed.to_owned()),
            ("IncludeItemTypes", include_types.join(",")),
            ("Recursive", String::from("true")),
            ("Limit", limit.to_string()),
        ];
        if let Some(p) = pagination {
            params.push(("StartIndex", p.offset.to_string()));
        }

        let items = self.list_items(&params, Clone::clone).await?;
        let mut out = SearchResult::default();
        for item in &items {
            match item.get("Type").and_then(Value::as_str) {
                Some("MusicArtist") => out.artists.push(map_jellyfin_artist(item)),
                Some("MusicAlbum") => out.albums.push(map_jellyfin_album(item)),
                Some("Audio") => out.tracks.push(map_jellyfin_track(item)),
                _ => {}
            }
        }
        Ok(out)
    }

    async fn get_random_tracks(&self, limit: u32) -> Result<Vec<Track>, ProviderError> {
        self.list_items(
            &[
                ("IncludeItemTypes", String::from("Audio")),
                ("Recursive", String::from("true")),
                ("SortBy", String::from("Random")),
                ("Limit", limit.to_string()),
            ],
            map_jellyfin_track,
        )
        .await
    }

    async fn get_random_albums(&self, limit: u32) -> Result<Vec<Album>, ProviderError> {
        self.list_items(
            &[
                ("IncludeItemTypes", String::from("MusicAlbum")),
                ("Recursive", String::from("true")),
                ("SortBy", String::from("Random")),
                ("Limit", limit.to_string()),
            ],
            map_jellyfin_album,
        )
        .await
    }

    async fn request_library_rescan(&self) -> Result<(), ProviderError> {
        let url = self.build_url("Library/Refresh", &[])?;
        let response = self
            .http
            .post(url)
            .header(HEADER_X_EMBY_TOKEN, &self.api_key)
            .timeout(Duration::from_millis(JELLYFIN_REQUEST_TIMEOUT_MS))
            .send()
            .await
            .map_err(|err| ProviderError::Upstream {
                provider: "Jellyfin",
                message: err.to_string(),
            })?;

        if !response.status().is_success() {
            return Err(ProviderError::Upstream {
                provider: "Jellyfin",
                message: format!(
                    "Jellyfin library refresh failed ({})",
                    response.status().as_u16()
                ),
            });
        }
        Ok(())
    }

    async fn scan_library(&self) -> Result<LibraryScanResult, ProviderError> {
        self.request_library_rescan().await?;
        Ok(LibraryScanResult {
            scanning: true,
            count: None,
        })
    }

    async fn fetch_stream(
        &self,
        track_id: &str,
        range: Option<&str>,
        max_bit_rate: Option<u32>,
    ) -> Result<StreamResult, ProviderError> {
        let path = format!("Audio/{}/stream", urlencoding::encode(track_id));
        let mut params = Vec::new();
        if let Some(kbps) = max_bit_rate {
            params.push(("MaxStreamingBitrate", (u64::from(kbps) * 1000).to_string()));
            params.push(("AudioCodec", String::from("mp3")));
            params.push(("Container", String::from("mp3")));
        } else {
            params.push(("static", String::from("true")));
        }

        let url = self.build_url(&path, &params)?;
        let mut req = self.http.get(url).header(HEADER_X_EMBY_TOKEN, &self.api_key);
        if let Some(range_val) = range {
            req = req.header(RANGE, range_val);
        }

        let response = req.send().await.map_err(|err| ProviderError::Upstream {
            provider: "Jellyfin",
            message: err.to_string(),
        })?;

        Ok(StreamResult {
            status: response.status(),
            headers: response.headers().clone(),
            response,
            audio_stream: Some(AudioStreamInfo {
                direct: max_bit_rate.is_none(),
                requested_bitrate_kbps: max_bit_rate,
                source_connection_id: None,
            }),
        })
    }

    async fn fetch_artwork(
        &self,
        artwork_id: &str,
        size: Option<u32>,
    ) -> Result<StreamResult, ProviderError> {
        let path = format!("Items/{}/Images/Primary", urlencoding::encode(artwork_id));
        let mut params = Vec::new();
        if let Some(px) = size {
            params.push(("fillWidth", px.to_string()));
            params.push(("fillHeight", px.to_string()));
        }

        let url = self.build_url(&path, &params)?;
        let response = self
            .http
            .get(url)
            .header(HEADER_X_EMBY_TOKEN, &self.api_key)
            .send()
            .await
            .map_err(|err| ProviderError::Upstream {
                provider: "Jellyfin",
                message: err.to_string(),
            })?;

        Ok(StreamResult {
            status: response.status(),
            headers: response.headers().clone(),
            response,
            audio_stream: None,
        })
    }
}

// ============================================================================
// Jellyfin -> MusicDeck Mappers (`server/src/backends/jellyfin/jellyfin-mapper.ts`)
// ============================================================================

fn jf_id(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn first_array_id(v: Option<&Value>) -> Option<String> {
    v?.as_array()?
        .first()
        .and_then(|item| jf_id(item.get("Id")))
}

fn first_array_name(v: Option<&Value>) -> Option<String> {
    v?.as_array()?
        .first()
        .and_then(|item| item.get("Name")?.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn join_array_names(v: Option<&Value>) -> Option<String> {
    let arr = v?.as_array()?;
    let names: Vec<&str> = arr
        .iter()
        .filter_map(|entry| {
            entry
                .as_str()
                .or_else(|| entry.get("Name").and_then(Value::as_str))
        })
        .filter(|s| !s.is_empty())
        .collect();
    if names.is_empty() {
        None
    } else {
        Some(names.join(", "))
    }
}

fn ticks_to_seconds(v: Option<&Value>) -> Option<u32> {
    let ticks = v?.as_f64()?;
    if !ticks.is_finite() || ticks < 0.0 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some((ticks / 10_000_000.0).round() as u32)
}

fn jf_identity_hints(item: &Value, mb_key: &str) -> IdentityHints {
    let pids = item.get("ProviderIds");
    IdentityHints {
        music_brainz_id: jf_id(
            pids.and_then(|p| p.get(mb_key).or_else(|| p.get("MusicBrainz"))),
        ),
        isrc: jf_id(pids.and_then(|p| p.get("Isrc")).or_else(|| item.get("Isrc"))),
        upc: jf_id(pids.and_then(|p| p.get("Upc").or_else(|| p.get("UPC")))),
    }
}

/// Maps a raw Jellyfin `Audio` item into a MusicDeck [`Track`].
#[must_use]
pub fn map_jellyfin_track(item: &Value) -> Track {
    let track_id = jf_id(item.get("Id")).unwrap_or_default();
    let audio_stream = item
        .get("MediaStreams")
        .and_then(Value::as_array)
        .and_then(|streams| {
            streams
                .iter()
                .find(|s| s.get("Type").and_then(Value::as_str) == Some("Audio"))
        });

    let artist_items: Vec<TrackArtistCredit> = item
        .get("ArtistItems")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    let name = a.get("Name")?.as_str()?.trim();
                    if name.is_empty() {
                        return None;
                    }
                    Some(TrackArtistCredit {
                        id: jf_id(a.get("Id")),
                        name: name.to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let artist_credits = if !artist_items.is_empty() {
        artist_items.clone()
    } else if let Some(artists_arr) = item.get("Artists").and_then(Value::as_array)
        && artists_arr.len() > 1
    {
        artists_arr
            .iter()
            .filter_map(|v| {
                let s = v.as_str()?.trim();
                (!s.is_empty()).then(|| TrackArtistCredit {
                    id: None,
                    name: s.to_owned(),
                })
            })
            .collect()
    } else {
        Vec::new()
    };

    let artist_id = first_array_id(item.get("ArtistItems"))
        .or_else(|| first_array_id(item.get("AlbumArtists")));

    let artist_name = join_array_names(item.get("Artists"))
        .or_else(|| {
            (!artist_items.is_empty()).then(|| {
                artist_items
                    .iter()
                    .map(|c| c.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
        })
        .or_else(|| first_array_name(item.get("AlbumArtists")))
        .unwrap_or_else(|| String::from("Unknown artist"));

    let has_primary_image = item
        .get("ImageTags")
        .and_then(|t| t.get("Primary"))
        .is_some_and(|v| !v.is_null());

    let artwork_id = has_primary_image.then(|| track_id.clone());
    let artwork_url = format_artwork_url(artwork_id.as_deref());
    let stream_url = format_stream_url(&track_id);

    let genres = item
        .get("Genres")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();

    let moods = item
        .get("Moods")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();

    Track {
        id: track_id.clone(),
        provider_id: track_id,
        title: item
            .get("Name")
            .and_then(Value::as_str)
            .unwrap_or("Unknown title")
            .to_owned(),
        artist_id,
        artist_name,
        artist_credits: (!artist_credits.is_empty()).then_some(artist_credits),
        album_id: jf_id(item.get("AlbumId")),
        album_name: item
            .get("Album")
            .and_then(Value::as_str)
            .unwrap_or("Unknown album")
            .to_owned(),
        duration_seconds: ticks_to_seconds(item.get("RunTimeTicks")),
        genres: Some(genres),
        moods: Some(moods),
        year: item
            .get("ProductionYear")
            .and_then(Value::as_i64)
            .and_then(|y| i32::try_from(y).ok()),
        original_release_year: None,
        bpm: item.get("Bpm").and_then(Value::as_f64).filter(|f| f.is_finite()),
        play_count: None,
        last_played_at: None,
        added_at: None,
        track_number: item
            .get("IndexNumber")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok()),
        disc_number: item
            .get("ParentIndexNumber")
            .and_then(Value::as_u64)
            .and_then(|d| u32::try_from(d).ok()),
        artwork_id,
        artwork_url,
        stream_url,
        source_server: Some(String::from("jellyfin")),
        audio_metadata: Some(AudioMetadataSummary {
            codec: audio_stream
                .and_then(|s| s.get("Codec"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            container: item
                .get("Container")
                .and_then(Value::as_str)
                .map(str::to_owned),
            bitrate_kbps: audio_stream
                .and_then(|s| s.get("BitRate"))
                .and_then(Value::as_u64)
                .map(|bps| u32::try_from(bps / 1000).unwrap_or(0))
                .filter(|&kbps| kbps > 0),
            sample_rate_hz: audio_stream
                .and_then(|s| s.get("SampleRate"))
                .and_then(Value::as_u64)
                .and_then(|hz| u32::try_from(hz).ok()),
            bit_depth: audio_stream
                .and_then(|s| s.get("BitDepth"))
                .and_then(Value::as_u64)
                .and_then(|bd| u32::try_from(bd).ok()),
            channels: audio_stream
                .and_then(|s| s.get("Channels"))
                .and_then(Value::as_u64)
                .and_then(|ch| u32::try_from(ch).ok()),
        }),
        replay_gain: Some(ReplayGainMetadata::default()),
        normalization_gain_db: None,
        loudness: None,
        related_artist_ids: None,
        identity_hints: Some(jf_identity_hints(item, "MusicBrainzTrack")),
    }
}

/// Maps a raw Jellyfin `MusicAlbum` item into a MusicDeck [`Album`].
#[must_use]
pub fn map_jellyfin_album(item: &Value) -> Album {
    let album_id = jf_id(item.get("Id")).unwrap_or_default();
    let has_primary_image = item
        .get("ImageTags")
        .and_then(|t| t.get("Primary"))
        .is_some_and(|v| !v.is_null());
    let artwork_id = has_primary_image.then(|| album_id.clone());
    let artwork_url = format_artwork_url(artwork_id.as_deref());

    let artist_id = first_array_id(item.get("AlbumArtists"))
        .or_else(|| first_array_id(item.get("ArtistItems")));
    let artist_name = join_array_names(item.get("AlbumArtists"))
        .or_else(|| first_array_name(item.get("Artists")))
        .unwrap_or_else(|| String::from("Unknown artist"));

    Album {
        id: album_id.clone(),
        provider_id: album_id,
        name: item
            .get("Name")
            .and_then(Value::as_str)
            .unwrap_or("Unknown album")
            .to_owned(),
        artist_id,
        artist_name,
        year: item
            .get("ProductionYear")
            .and_then(Value::as_i64)
            .and_then(|y| i32::try_from(y).ok()),
        artwork_id,
        artwork_url,
        song_count: item
            .get("ChildCount")
            .and_then(Value::as_u64)
            .and_then(|c| u32::try_from(c).ok())
            .unwrap_or(0),
        source_server: Some(String::from("jellyfin")),
        identity_hints: Some(jf_identity_hints(item, "MusicBrainzAlbum")),
    }
}

/// Maps a raw Jellyfin `MusicArtist` item into a MusicDeck [`Artist`].
#[must_use]
pub fn map_jellyfin_artist(item: &Value) -> Artist {
    let artist_id = jf_id(item.get("Id")).unwrap_or_default();
    let has_primary_image = item
        .get("ImageTags")
        .and_then(|t| t.get("Primary"))
        .is_some_and(|v| !v.is_null());
    let artwork_id = has_primary_image.then(|| artist_id.clone());
    let artwork_url = format_artwork_url(artwork_id.as_deref());

    Artist {
        id: artist_id.clone(),
        provider_id: artist_id,
        name: item
            .get("Name")
            .and_then(Value::as_str)
            .unwrap_or("Unknown artist")
            .to_owned(),
        artwork_id,
        image_url: artwork_url.clone(),
        artwork_url,
        album_count: item
            .get("ChildCount")
            .and_then(Value::as_u64)
            .and_then(|c| u32::try_from(c).ok())
            .unwrap_or(0),
        song_count: None,
        identity_hints: Some(jf_identity_hints(item, "MusicBrainzArtist")),
    }
}
