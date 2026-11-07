//! # Navidrome / Subsonic Backend Client (`providers::navidrome`)
//!
//! Complete Rust port of `server/src/backends/navidrome/navidrome-backend.ts`
//! and `server/src/backends/navidrome/mappers.ts`.
//!
//! ## Subsonic Protocol & Security Details
//! - **Salted MD5 Token Authentication**: Every request generates a fresh UUIDv4 `salt` (`s`)
//!   and computes `t = hex(md5(password + s))` along with `v = "1.16.1"`, `c = "MusicDeck"`,
//!   and `f = "json"`. Plaintext passwords are never sent over the wire.
//! - **Control Request Timeouts**: JSON control requests enforce a `15,000` ms timeout
//!   (`NAVIDROME_REQUEST_TIMEOUT_MS`), while `getTopSongs` uses a `1,200` ms timeout
//!   before falling back to `search3`.
//! - **Paginated Enumeration & Stall Detection**: `list_all_albums` and `list_tracks`
//!   fetch 500-item pages and abort with [`ProviderError::PaginationStalled`] if a non-empty
//!   page yields zero unseen album IDs.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;
use http::header::RANGE;
use md5::{Digest, Md5};
use serde_json::Value;
use url::Url;
use uuid::Uuid;

use crate::config::NavidromeConfig;
use crate::providers::models::{
    Album, Artist, AudioMetadataSummary, AudioStreamInfo, IdentityHints, LibraryScanResult,
    Playlist, PlaylistUpdateInput, ReplayGainMetadata, SearchPagination, SearchResult,
    StreamResult, Track, TrackArtistCredit, format_artwork_url, format_stream_url,
};
use crate::providers::traits::{MusicBackend, ProviderError};

/// Control-plane HTTP timeout (`15,000` ms) matching `NAVIDROME_REQUEST_TIMEOUT_MS`.
pub const NAVIDROME_REQUEST_TIMEOUT_MS: u64 = 15_000;

/// Subsonic API version advertised by MusicDeck.
pub const SUBSONIC_API_VERSION: &str = "1.16.1";

/// Subsonic client identifier advertised by MusicDeck.
pub const SUBSONIC_CLIENT_NAME: &str = "MusicDeck";

/// Asynchronous Navidrome (Subsonic API) client backed by a pooled `reqwest::Client`.
#[derive(Debug, Clone)]
pub struct NavidromeClient {
    base_url: String,
    username: String,
    password: String,
    http: reqwest::Client,
}

/// Alias matching the legacy TypeScript class name `NavidromeBackend`.
pub type NavidromeBackend = NavidromeClient;

impl NavidromeClient {
    /// Constructs a new [`NavidromeClient`] from [`NavidromeConfig`].
    pub fn new(config: NavidromeConfig) -> Result<Self, ProviderError> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_millis(5_000))
            .pool_max_idle_per_host(16)
            .build()
            .map_err(|err| ProviderError::Configuration(format!("HTTP client init failed: {err}")))?;

        Ok(Self::with_client(config, http))
    }

    /// Constructs a [`NavidromeClient`] using an existing pooled [`reqwest::Client`].
    #[must_use]
    pub fn with_client(config: NavidromeConfig, http: reqwest::Client) -> Self {
        Self {
            base_url: config.url.trim_end_matches('/').to_owned(),
            username: config.username,
            password: config.password,
            http,
        }
    }

    /// Computes a fresh `(token, salt)` pair where `token = hex(md5(password + salt))`.
    #[must_use]
    pub fn compute_subsonic_auth(&self) -> (String, String) {
        let salt = Uuid::new_v4().to_string();
        let mut hasher = Md5::new();
        hasher.update(self.password.as_bytes());
        hasher.update(salt.as_bytes());
        let digest = hasher.finalize();
        let mut token = String::with_capacity(32);
        for byte in digest {
            use std::fmt::Write;
            let _ = write!(&mut token, "{byte:02x}");
        }
        (token, salt)
    }

    /// Builds a full `/rest/<endpoint>.view` URL with Subsonic authentication parameters
    /// and caller query pairs.
    pub fn build_url(
        &self,
        endpoint: &str,
        extra_params: &[(&str, String)],
    ) -> Result<Url, ProviderError> {
        let raw = format!("{}/rest/{endpoint}.view", self.base_url);
        let mut url = Url::parse(&raw).map_err(|err| ProviderError::Configuration(err.to_string()))?;
        let (token, salt) = self.compute_subsonic_auth();

        let has_custom_client = extra_params.iter().any(|(k, _)| *k == "c");
        {
            let mut qp = url.query_pairs_mut();
            qp.append_pair("u", &self.username);
            qp.append_pair("t", &token);
            qp.append_pair("s", &salt);
            qp.append_pair("v", SUBSONIC_API_VERSION);
            if !has_custom_client {
                qp.append_pair("c", SUBSONIC_CLIENT_NAME);
            }
            qp.append_pair("f", "json");

            for (key, value) in extra_params {
                qp.append_pair(key, value);
            }
        }
        Ok(url)
    }

    async fn request_json(
        &self,
        endpoint: &str,
        params: &[(&str, String)],
        timeout_ms: u64,
    ) -> Result<Value, ProviderError> {
        let url = self.build_url(endpoint, params)?;
        let response = self
            .http
            .get(url)
            .timeout(Duration::from_millis(timeout_ms))
            .send()
            .await
            .map_err(|err| {
                if err.is_timeout() {
                    ProviderError::Timeout {
                        provider: "Navidrome",
                    }
                } else {
                    ProviderError::Upstream {
                        provider: "Navidrome",
                        message: err.to_string(),
                    }
                }
            })?;

        if !response.status().is_success() {
            return Err(ProviderError::Upstream {
                provider: "Navidrome",
                message: format!("Navidrome returned {}", response.status().as_u16()),
            });
        }

        let root: Value = response.json().await.map_err(|_| ProviderError::Upstream {
            provider: "Navidrome",
            message: String::from("Navidrome returned invalid JSON"),
        })?;

        let Some(subsonic) = root.get("subsonic-response") else {
            return Err(ProviderError::Upstream {
                provider: "Navidrome",
                message: String::from("Navidrome API error"),
            });
        };

        if subsonic.get("status").and_then(Value::as_str) != Some("ok") {
            let code = subsonic
                .get("error")
                .and_then(|e| e.get("code"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let message = subsonic
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Navidrome API error")
                .to_owned();

            return match code {
                40 | 41 | 50 => Err(ProviderError::Authentication {
                    provider: "Navidrome",
                    message,
                }),
                70 => Err(ProviderError::NotFound {
                    provider: "Navidrome",
                }),
                _ => Err(ProviderError::Upstream {
                    provider: "Navidrome",
                    message,
                }),
            };
        }

        Ok(subsonic.clone())
    }

    async fn get_album_raw(&self, album_id: &str) -> Result<Option<Value>, ProviderError> {
        match self
            .request_json(
                "getAlbum",
                &[("id", album_id.to_owned())],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await
        {
            Ok(res) => Ok(res.get("album").cloned()),
            Err(ProviderError::NotFound { .. }) => Ok(None),
            Err(err) => Err(err),
        }
    }
}

#[async_trait]
impl MusicBackend for NavidromeClient {
    fn provider_kind(&self) -> &'static str {
        "navidrome"
    }

    async fn list_albums(&self, limit: Option<u32>) -> Result<Vec<Album>, ProviderError> {
        let size = limit.unwrap_or(500);
        let res = self
            .request_json(
                "getAlbumList2",
                &[
                    ("type", String::from("alphabeticalByName")),
                    ("size", size.to_string()),
                ],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await?;

        Ok(res
            .get("albumList2")
            .and_then(|l| l.get("album"))
            .and_then(Value::as_array)
            .map(|arr| arr.iter().map(map_subsonic_album).collect())
            .unwrap_or_default())
    }

    async fn list_all_albums(&self) -> Result<Vec<Album>, ProviderError> {
        let mut albums_by_id: HashMap<String, Album> = HashMap::new();
        let mut ordered_ids: Vec<String> = Vec::new();
        let mut offset = 0usize;

        loop {
            let res = self
                .request_json(
                    "getAlbumList2",
                    &[
                        ("type", String::from("alphabeticalByName")),
                        ("size", String::from("500")),
                        ("offset", offset.to_string()),
                    ],
                    NAVIDROME_REQUEST_TIMEOUT_MS,
                )
                .await?;

            let page: Vec<Album> = res
                .get("albumList2")
                .and_then(|l| l.get("album"))
                .and_then(Value::as_array)
                .map(|arr| arr.iter().map(map_subsonic_album).collect())
                .unwrap_or_default();

            let before_count = albums_by_id.len();
            let page_len = page.len();
            for album in page {
                if !albums_by_id.contains_key(&album.id) {
                    ordered_ids.push(album.id.clone());
                }
                albums_by_id.insert(album.id.clone(), album);
            }

            if page_len > 0 && albums_by_id.len() == before_count {
                return Err(ProviderError::PaginationStalled {
                    provider: "Navidrome",
                    entity: "album",
                });
            }

            if page_len < 500 {
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
        Ok(self
            .get_album_raw(album_id)
            .await?
            .as_ref()
            .map(map_subsonic_album))
    }

    async fn get_album_tracks(&self, album_id: &str) -> Result<Vec<Track>, ProviderError> {
        let Some(album) = self.get_album_raw(album_id).await? else {
            return Ok(Vec::new());
        };
        let album_orig_year = album
            .get("originalReleaseDate")
            .and_then(|d| d.get("year"))
            .and_then(Value::as_i64)
            .and_then(|y| i32::try_from(y).ok());

        let tracks = album
            .get("song")
            .and_then(Value::as_array)
            .map(|songs| {
                songs
                    .iter()
                    .map(|song| {
                        let mut track = map_subsonic_track(song);
                        if track.original_release_year.is_none() {
                            track.original_release_year = album_orig_year;
                        }
                        track
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(tracks)
    }

    async fn get_artists(&self) -> Result<Vec<Artist>, ProviderError> {
        let res = self
            .request_json("getArtists", &[], NAVIDROME_REQUEST_TIMEOUT_MS)
            .await?;

        let mut artists = Vec::new();
        if let Some(indices) = res
            .get("artists")
            .and_then(|a| a.get("index"))
            .and_then(Value::as_array)
        {
            for index_entry in indices {
                if let Some(group) = index_entry.get("artist").and_then(Value::as_array) {
                    for raw_artist in group {
                        artists.push(map_subsonic_artist(raw_artist));
                    }
                }
            }
        }
        Ok(artists)
    }

    async fn get_artist(
        &self,
        artist_id: &str,
        include_artist_info: bool,
    ) -> Result<Option<Artist>, ProviderError> {
        let artist_res = match self
            .request_json(
                "getArtist",
                &[("id", artist_id.to_owned())],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await
        {
            Ok(v) => v,
            Err(ProviderError::NotFound { .. }) => return Ok(None),
            Err(err) => return Err(err),
        };

        let Some(raw_artist) = artist_res.get("artist") else {
            return Ok(None);
        };

        let mut artist = map_subsonic_artist(raw_artist);

        if include_artist_info {
            let info_opt = self
                .request_json(
                    "getArtistInfo2",
                    &[
                        ("id", artist_id.to_owned()),
                        ("count", String::from("0")),
                        ("includeNotPresent", String::from("false")),
                    ],
                    NAVIDROME_REQUEST_TIMEOUT_MS,
                )
                .await
                .ok();

            let candidates = [
                raw_artist.get("artistImageUrl").and_then(Value::as_str),
                info_opt
                    .as_ref()
                    .and_then(|i| i.get("artistInfo2"))
                    .and_then(|i| i.get("mediumImageUrl"))
                    .and_then(Value::as_str),
                info_opt
                    .as_ref()
                    .and_then(|i| i.get("artistInfo2"))
                    .and_then(|i| i.get("largeImageUrl"))
                    .and_then(Value::as_str),
                info_opt
                    .as_ref()
                    .and_then(|i| i.get("artistInfo2"))
                    .and_then(|i| i.get("smallImageUrl"))
                    .and_then(Value::as_str),
            ];

            artist.image_url = candidates
                .into_iter()
                .flatten()
                .map(str::trim)
                .find(|url| !url.is_empty() && !url.contains("2a96cbd8b46e442fc41c2b86b821562f"))
                .map(str::to_owned);
        }

        Ok(Some(artist))
    }

    async fn get_artist_albums(&self, artist_id: &str) -> Result<Vec<Album>, ProviderError> {
        let res = self
            .request_json(
                "getArtist",
                &[("id", artist_id.to_owned())],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await?;

        let albums = res
            .get("artist")
            .and_then(|a| a.get("album"))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter(|alb| {
                        alb.get("artistId")
                            .and_then(value_to_string)
                            .is_none_or(|aid| aid == artist_id)
                    })
                    .map(map_subsonic_album)
                    .collect()
            })
            .unwrap_or_default();

        Ok(albums)
    }

    async fn get_artist_tracks(&self, artist_id: &str) -> Result<Vec<Track>, ProviderError> {
        let albums = self.get_artist_albums(artist_id).await?;
        let mut tracks = Vec::new();
        for album in albums {
            for track in self.get_album_tracks(&album.id).await? {
                if is_track_credited_to(&track, artist_id) {
                    tracks.push(track);
                }
            }
        }
        Ok(tracks)
    }

    async fn get_artist_top_tracks(
        &self,
        artist_id: &str,
        limit: usize,
    ) -> Result<Vec<Track>, ProviderError> {
        let count = limit.clamp(1, 10);
        if let Ok(res) = self
            .request_json(
                "getTopSongs",
                &[("id", artist_id.to_owned()), ("count", count.to_string())],
                1_200,
            )
            .await
            && let Some(songs) = res
                .get("topSongs")
                .and_then(|t| t.get("song"))
                .and_then(Value::as_array)
        {
            let matched: Vec<Track> = songs
                .iter()
                .map(map_subsonic_track)
                .filter(|t| is_track_credited_to(t, artist_id))
                .take(count)
                .collect();
            if !matched.is_empty() {
                return Ok(matched);
            }
        }

        let Some(artist) = self.get_artist(artist_id, false).await? else {
            return Ok(Vec::new());
        };

        let Ok(search_res) = self
            .request_json(
                "search3",
                &[
                    ("query", artist.name),
                    ("artistCount", String::from("0")),
                    ("albumCount", String::from("0")),
                    ("songCount", count.to_string()),
                ],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await
        else {
            return Ok(Vec::new());
        };

        Ok(search_res
            .get("searchResult3")
            .and_then(|s| s.get("song"))
            .and_then(Value::as_array)
            .map(|songs| {
                songs
                    .iter()
                    .map(map_subsonic_track)
                    .filter(|t| is_track_credited_to(t, artist_id))
                    .take(count)
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn list_tracks(&self) -> Result<Vec<Track>, ProviderError> {
        let albums = self.list_all_albums().await?;
        let mut tracks_by_id: HashMap<String, Track> = HashMap::new();
        let mut ordered_ids: Vec<String> = Vec::new();

        for album in albums {
            for track in self.get_album_tracks(&album.id).await? {
                if !tracks_by_id.contains_key(&track.id) {
                    ordered_ids.push(track.id.clone());
                }
                tracks_by_id.insert(track.id.clone(), track);
            }
        }

        Ok(ordered_ids
            .into_iter()
            .filter_map(|id| tracks_by_id.remove(&id))
            .collect())
    }

    async fn get_track(&self, track_id: &str) -> Result<Option<Track>, ProviderError> {
        match self
            .request_json(
                "getSong",
                &[("id", track_id.to_owned())],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await
        {
            Ok(res) => Ok(res.get("song").map(map_subsonic_track)),
            Err(ProviderError::NotFound { .. }) => Ok(None),
            Err(err) => Err(err),
        }
    }

    async fn get_track_file_path(&self, track_id: &str) -> Result<Option<String>, ProviderError> {
        let res = self
            .request_json(
                "getSong",
                &[
                    ("id", track_id.to_owned()),
                    ("c", String::from("MusicDeck File Management")),
                ],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await?;

        let path_opt = res
            .get("song")
            .and_then(|s| s.get("path"))
            .and_then(Value::as_str)
            .filter(|p| Path::new(p).is_absolute())
            .map(str::to_owned);

        Ok(path_opt)
    }

    async fn get_lyrics(&self, track_id: &str) -> Result<Option<String>, ProviderError> {
        if let Ok(res) = self
            .request_json(
                "getLyricsBySongId",
                &[("id", track_id.to_owned())],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await
            && let Some(plain) = res
                .get("lyricsList")
                .and_then(|l| l.get("lyrics"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        {
            return Ok(Some(plain.to_owned()));
        }

        let Some(track) = self.get_track(track_id).await? else {
            return Ok(None);
        };

        let Ok(res) = self
            .request_json(
                "getLyrics",
                &[("artist", track.artist_name), ("title", track.title)],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await
        else {
            return Ok(None);
        };

        let text = res
            .get("lyrics")
            .and_then(|l| l.get("value").or(Some(l)))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);

        Ok(text)
    }

    async fn get_artist_biography_for_track(
        &self,
        track_id: &str,
    ) -> Result<Option<String>, ProviderError> {
        let Some(track) = self.get_track(track_id).await? else {
            return Ok(None);
        };
        let Some(artist_id) = track.artist_id else {
            return Ok(None);
        };

        let Ok(res) = self
            .request_json(
                "getArtistInfo2",
                &[
                    ("id", artist_id),
                    ("count", String::from("0")),
                    ("includeNotPresent", String::from("false")),
                ],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await
        else {
            return Ok(None);
        };

        let bio = res
            .get("artistInfo2")
            .or_else(|| res.get("artistInfo"))
            .and_then(|i| i.get("biography"))
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

        let artist_count = if wants.contains("artists") { 20 } else { 0 };
        let album_count = if wants.contains("albums") { 20 } else { 0 };
        let song_count = if wants.contains("tracks") || wants.contains("songs") {
            pagination.map_or(50, |p| p.limit.clamp(1, 500))
        } else {
            0
        };
        let song_offset = pagination.map_or(0, |p| p.offset);

        let res = self
            .request_json(
                "search3",
                &[
                    ("query", trimmed.to_owned()),
                    ("artistCount", artist_count.to_string()),
                    ("artistOffset", String::from("0")),
                    ("albumCount", album_count.to_string()),
                    ("albumOffset", String::from("0")),
                    ("songCount", song_count.to_string()),
                    ("songOffset", song_offset.to_string()),
                ],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await?;

        let s3 = res.get("searchResult3");
        let artists = s3
            .and_then(|s| s.get("artist"))
            .and_then(Value::as_array)
            .map(|arr| arr.iter().map(map_subsonic_artist).collect())
            .unwrap_or_default();
        let albums = s3
            .and_then(|s| s.get("album"))
            .and_then(Value::as_array)
            .map(|arr| arr.iter().map(map_subsonic_album).collect())
            .unwrap_or_default();
        let tracks = s3
            .and_then(|s| s.get("song"))
            .and_then(Value::as_array)
            .map(|arr| arr.iter().map(map_subsonic_track).collect())
            .unwrap_or_default();

        Ok(SearchResult {
            artists,
            albums,
            tracks,
        })
    }

    async fn get_random_tracks(&self, limit: u32) -> Result<Vec<Track>, ProviderError> {
        let res = self
            .request_json(
                "getRandomSongs",
                &[("size", limit.to_string())],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await?;

        Ok(res
            .get("randomSongs")
            .and_then(|r| r.get("song"))
            .and_then(Value::as_array)
            .map(|arr| arr.iter().map(map_subsonic_track).collect())
            .unwrap_or_default())
    }

    async fn get_random_albums(&self, limit: u32) -> Result<Vec<Album>, ProviderError> {
        let res = self
            .request_json(
                "getAlbumList2",
                &[
                    ("type", String::from("random")),
                    ("size", limit.to_string()),
                ],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await?;

        Ok(res
            .get("albumList2")
            .and_then(|r| r.get("album"))
            .and_then(Value::as_array)
            .map(|arr| arr.iter().map(map_subsonic_album).collect())
            .unwrap_or_default())
    }

    async fn request_library_rescan(&self) -> Result<(), ProviderError> {
        self.request_json("startScan", &[], NAVIDROME_REQUEST_TIMEOUT_MS)
            .await?;
        Ok(())
    }

    async fn scan_library(&self) -> Result<LibraryScanResult, ProviderError> {
        self.request_library_rescan().await?;

        let mut last_count = None;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let Ok(res) = self
                .request_json("getScanStatus", &[], NAVIDROME_REQUEST_TIMEOUT_MS)
                .await
            else {
                break;
            };

            let status_obj = res.get("scanStatus");
            if let Some(count) = status_obj
                .and_then(|s| s.get("count"))
                .and_then(Value::as_u64)
            {
                last_count = Some(count);
            }

            let scanning = status_obj
                .and_then(|s| s.get("scanning"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !scanning {
                return Ok(LibraryScanResult {
                    scanning: false,
                    count: last_count,
                });
            }
        }

        Ok(LibraryScanResult {
            scanning: false,
            count: last_count,
        })
    }

    async fn fetch_stream(
        &self,
        track_id: &str,
        range: Option<&str>,
        max_bit_rate: Option<u32>,
    ) -> Result<StreamResult, ProviderError> {
        let mut params = vec![("id", track_id.to_owned())];
        if let Some(kbps) = max_bit_rate {
            params.push(("maxBitRate", kbps.to_string()));
            params.push(("format", String::from("mp3")));
        } else {
            params.push(("format", String::from("raw")));
        }

        let url = self.build_url("stream", &params)?;
        let mut req = self.http.get(url);
        if let Some(range_val) = range {
            req = req.header(RANGE, range_val);
        }

        let response = req.send().await.map_err(|err| ProviderError::Upstream {
            provider: "Navidrome",
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
        let mut params = vec![("id", artwork_id.to_owned())];
        if let Some(px) = size {
            params.push(("size", px.to_string()));
        }

        let url = self.build_url("getCoverArt", &params)?;
        let response = self
            .http
            .get(url)
            .timeout(Duration::from_millis(5_000))
            .send()
            .await
            .map_err(|err| ProviderError::Upstream {
                provider: "Navidrome",
                message: err.to_string(),
            })?;

        Ok(StreamResult {
            status: response.status(),
            headers: response.headers().clone(),
            response,
            audio_stream: None,
        })
    }

    fn supports_scrobble(&self) -> bool {
        true
    }

    async fn scrobble(
        &self,
        track_id: &str,
        played_at_ms: Option<i64>,
    ) -> Result<(), ProviderError> {
        let ts = played_at_ms.unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        self.request_json(
            "scrobble",
            &[
                ("id", track_id.to_owned()),
                ("time", ts.to_string()),
                ("submission", String::from("true")),
            ],
            NAVIDROME_REQUEST_TIMEOUT_MS,
        )
        .await?;
        Ok(())
    }

    fn supports_user_data_sync(&self) -> bool {
        true
    }

    async fn list_favorite_tracks(&self) -> Result<Vec<Track>, ProviderError> {
        let res = self
            .request_json("getStarred2", &[], NAVIDROME_REQUEST_TIMEOUT_MS)
            .await?;

        Ok(res
            .get("starred2")
            .and_then(|s| s.get("song"))
            .and_then(Value::as_array)
            .map(|arr| arr.iter().map(map_subsonic_track).collect())
            .unwrap_or_default())
    }

    async fn set_track_favorite(&self, track_id: &str, liked: bool) -> Result<(), ProviderError> {
        let endpoint = if liked { "star" } else { "unstar" };
        self.request_json(
            endpoint,
            &[("id", track_id.to_owned())],
            NAVIDROME_REQUEST_TIMEOUT_MS,
        )
        .await?;
        Ok(())
    }

    async fn list_playlists(&self) -> Result<Vec<Playlist>, ProviderError> {
        let res = self
            .request_json("getPlaylists", &[], NAVIDROME_REQUEST_TIMEOUT_MS)
            .await?;

        Ok(res
            .get("playlists")
            .and_then(|p| p.get("playlist"))
            .and_then(Value::as_array)
            .map(|arr| arr.iter().map(|pl| map_subsonic_playlist(pl, false)).collect())
            .unwrap_or_default())
    }

    async fn create_playlist(&self, name: &str) -> Result<Option<Playlist>, ProviderError> {
        let res = self
            .request_json(
                "createPlaylist",
                &[("name", name.to_owned())],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await?;
        Ok(res.get("playlist").map(|pl| map_subsonic_playlist(pl, true)))
    }

    async fn get_playlist(&self, playlist_id: &str) -> Result<Option<Playlist>, ProviderError> {
        match self
            .request_json(
                "getPlaylist",
                &[("id", playlist_id.to_owned())],
                NAVIDROME_REQUEST_TIMEOUT_MS,
            )
            .await
        {
            Ok(res) => Ok(res.get("playlist").map(|pl| map_subsonic_playlist(pl, true))),
            Err(ProviderError::NotFound { .. }) => Ok(None),
            Err(err) => Err(err),
        }
    }

    async fn update_playlist(
        &self,
        playlist_id: &str,
        input: PlaylistUpdateInput,
    ) -> Result<Option<Playlist>, ProviderError> {
        let mut params = vec![("playlistId", playlist_id.to_owned())];
        if let Some(name) = input.name {
            params.push(("name", name));
        }
        if let Some(desc) = input.description {
            params.push(("comment", desc));
        }
        self.request_json("updatePlaylist", &params, NAVIDROME_REQUEST_TIMEOUT_MS)
            .await?;
        self.get_playlist(playlist_id).await
    }

    async fn delete_playlist(&self, playlist_id: &str) -> Result<(), ProviderError> {
        self.request_json(
            "deletePlaylist",
            &[("id", playlist_id.to_owned())],
            NAVIDROME_REQUEST_TIMEOUT_MS,
        )
        .await?;
        Ok(())
    }

    async fn add_track_to_playlist(
        &self,
        playlist_id: &str,
        track_id: &str,
    ) -> Result<bool, ProviderError> {
        let existing = self.get_playlist(playlist_id).await?;
        if existing
            .and_then(|pl| pl.tracks)
            .is_some_and(|tracks| tracks.iter().any(|t| t.id == track_id))
        {
            return Ok(false);
        }

        self.request_json(
            "updatePlaylist",
            &[
                ("playlistId", playlist_id.to_owned()),
                ("songIdToAdd", track_id.to_owned()),
            ],
            NAVIDROME_REQUEST_TIMEOUT_MS,
        )
        .await?;
        Ok(true)
    }

    async fn remove_playlist_item(
        &self,
        playlist_id: &str,
        playlist_item_id: &str,
    ) -> Result<(), ProviderError> {
        let Some(playlist) = self.get_playlist(playlist_id).await? else {
            return Ok(());
        };
        let Some(tracks) = playlist.tracks else {
            return Ok(());
        };
        let Some(index) = tracks.iter().position(|t| t.id == playlist_item_id) else {
            return Ok(());
        };

        self.request_json(
            "updatePlaylist",
            &[
                ("playlistId", playlist_id.to_owned()),
                ("songIndexToRemove", index.to_string()),
            ],
            NAVIDROME_REQUEST_TIMEOUT_MS,
        )
        .await?;
        Ok(())
    }

    async fn reorder_playlist_tracks(
        &self,
        playlist_id: &str,
        track_ids: &[String],
    ) -> Result<Option<Playlist>, ProviderError> {
        let mut params = vec![("playlistId", playlist_id.to_owned())];
        for id in track_ids {
            params.push(("songId", id.clone()));
        }
        self.request_json("createPlaylist", &params, NAVIDROME_REQUEST_TIMEOUT_MS)
            .await?;
        self.get_playlist(playlist_id).await
    }
}

// ============================================================================
// Subsonic -> MusicDeck Mappers (`server/src/backends/navidrome/mappers.ts`)
// ============================================================================

fn value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn value_to_f64(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) => s.parse::<f64>().ok().filter(|f| f.is_finite()),
        _ => None,
    }
}

fn extract_identity_hints(item: &Value) -> IdentityHints {
    IdentityHints {
        music_brainz_id: item
            .get("musicBrainzId")
            .or_else(|| item.get("mbId"))
            .and_then(value_to_string),
        isrc: item.get("isrc").and_then(value_to_string),
        upc: item.get("upc").and_then(value_to_string),
    }
}

fn is_track_credited_to(track: &Track, artist_id: &str) -> bool {
    if track.artist_id.as_deref() == Some(artist_id) {
        return true;
    }
    track.artist_credits.as_ref().is_some_and(|credits| {
        credits
            .iter()
            .any(|credit| credit.id.as_deref() == Some(artist_id))
    })
}

/// Maps a raw Subsonic `song` JSON value into a MusicDeck [`Track`].
#[must_use]
pub fn map_subsonic_track(song: &Value) -> Track {
    let track_id = song
        .get("id")
        .and_then(value_to_string)
        .unwrap_or_default();

    let artist_credits: Vec<TrackArtistCredit> = song
        .get("artists")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|artist| {
                    let name = artist.get("name")?.as_str()?.trim();
                    if name.is_empty() {
                        return None;
                    }
                    Some(TrackArtistCredit {
                        id: artist.get("id").and_then(value_to_string),
                        name: name.to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let artist_id = song
        .get("artistId")
        .and_then(value_to_string)
        .or_else(|| artist_credits.first().and_then(|c| c.id.clone()));

    let artist_name = song
        .get("displayArtist")
        .or_else(|| song.get("artist"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            if artist_credits.is_empty() {
                None
            } else {
                Some(
                    artist_credits
                        .iter()
                        .map(|c| c.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                )
            }
        })
        .unwrap_or_else(|| String::from("Unknown artist"));

    let genres: Vec<String> = if let Some(arr) = song.get("genres").and_then(Value::as_array) {
        arr.iter()
            .filter_map(|g| {
                g.as_str()
                    .or_else(|| g.get("name").and_then(Value::as_str))
                    .map(str::to_owned)
            })
            .collect()
    } else if let Some(g) = song.get("genre").and_then(Value::as_str) {
        vec![g.to_owned()]
    } else {
        Vec::new()
    };

    let moods: Vec<String> = song
        .get("mood")
        .and_then(Value::as_str)
        .map(|m| vec![m.to_owned()])
        .unwrap_or_default();

    let artwork_id = song.get("coverArt").and_then(value_to_string);
    let artwork_url = format_artwork_url(artwork_id.as_deref());
    let stream_url = format_stream_url(&track_id);

    let suffix = song
        .get("suffix")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let codec = song
        .get("contentType")
        .and_then(Value::as_str)
        .map(|ct| ct.strip_prefix("audio/").unwrap_or(ct).to_owned())
        .or_else(|| suffix.clone());

    let rg_obj = song.get("replayGain").or_else(|| song.get("replaygain"));
    let replay_gain = ReplayGainMetadata {
        track_gain_db: value_to_f64(
            rg_obj
                .and_then(|r| r.get("trackGain").or_else(|| r.get("trackGainDb")))
                .or_else(|| song.get("replayGainTrackGain")),
        ),
        track_peak: value_to_f64(
            rg_obj
                .and_then(|r| r.get("trackPeak"))
                .or_else(|| song.get("replayGainTrackPeak")),
        ),
        album_gain_db: value_to_f64(
            rg_obj
                .and_then(|r| r.get("albumGain").or_else(|| r.get("albumGainDb")))
                .or_else(|| song.get("replayGainAlbumGain")),
        ),
        album_peak: value_to_f64(
            rg_obj
                .and_then(|r| r.get("albumPeak"))
                .or_else(|| song.get("replayGainAlbumPeak")),
        ),
    };

    Track {
        id: track_id.clone(),
        provider_id: track_id,
        title: song
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Unknown title")
            .to_owned(),
        artist_id,
        artist_name,
        artist_credits: if artist_credits.is_empty() {
            None
        } else {
            Some(artist_credits)
        },
        album_id: song.get("albumId").and_then(value_to_string),
        album_name: song
            .get("album")
            .and_then(Value::as_str)
            .unwrap_or("Unknown album")
            .to_owned(),
        duration_seconds: song
            .get("duration")
            .and_then(Value::as_u64)
            .and_then(|d| u32::try_from(d).ok()),
        genres: Some(genres),
        moods: Some(moods),
        year: song
            .get("year")
            .and_then(Value::as_i64)
            .and_then(|y| i32::try_from(y).ok()),
        original_release_year: song
            .get("originalReleaseDate")
            .and_then(|d| d.get("year"))
            .and_then(Value::as_i64)
            .and_then(|y| i32::try_from(y).ok()),
        bpm: value_to_f64(song.get("bpm")),
        play_count: song.get("playCount").and_then(Value::as_u64),
        last_played_at: song
            .get("played")
            .and_then(Value::as_str)
            .map(str::to_owned),
        added_at: song
            .get("created")
            .and_then(Value::as_str)
            .map(str::to_owned),
        track_number: song
            .get("track")
            .and_then(Value::as_u64)
            .and_then(|t| u32::try_from(t).ok()),
        disc_number: song
            .get("discNumber")
            .and_then(Value::as_u64)
            .and_then(|d| u32::try_from(d).ok()),
        artwork_id,
        artwork_url,
        stream_url,
        source_server: Some(String::from("navidrome")),
        audio_metadata: Some(AudioMetadataSummary {
            codec,
            container: suffix,
            bitrate_kbps: song
                .get("bitRate")
                .and_then(Value::as_u64)
                .filter(|&b| b > 0)
                .and_then(|b| u32::try_from(b).ok()),
            sample_rate_hz: song
                .get("samplingRate")
                .and_then(Value::as_u64)
                .filter(|&s| s > 0)
                .and_then(|s| u32::try_from(s).ok()),
            bit_depth: song
                .get("bitDepth")
                .and_then(Value::as_u64)
                .filter(|&d| d > 0)
                .and_then(|d| u32::try_from(d).ok()),
            channels: song
                .get("channelCount")
                .and_then(Value::as_u64)
                .filter(|&c| c > 0)
                .and_then(|c| u32::try_from(c).ok()),
        }),
        replay_gain: Some(replay_gain),
        normalization_gain_db: None,
        loudness: None,
        related_artist_ids: None,
        identity_hints: Some(extract_identity_hints(song)),
    }
}

/// Maps a raw Subsonic `album` JSON value into a MusicDeck [`Album`].
#[must_use]
pub fn map_subsonic_album(album: &Value) -> Album {
    let album_id = album
        .get("id")
        .and_then(value_to_string)
        .unwrap_or_default();

    let child_cover = album
        .get("song")
        .and_then(Value::as_array)
        .and_then(|songs| {
            songs
                .iter()
                .find_map(|s| s.get("coverArt").and_then(value_to_string))
        });

    let artwork_id = album
        .get("coverArt")
        .and_then(value_to_string)
        .or(child_cover);
    let artwork_url = format_artwork_url(artwork_id.as_deref());

    let song_count = album
        .get("songCount")
        .and_then(Value::as_u64)
        .and_then(|c| u32::try_from(c).ok())
        .or_else(|| {
            album
                .get("song")
                .and_then(Value::as_array)
                .and_then(|arr| u32::try_from(arr.len()).ok())
        })
        .unwrap_or(0);

    Album {
        id: album_id.clone(),
        provider_id: album_id,
        name: album
            .get("name")
            .or_else(|| album.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("Unknown album")
            .to_owned(),
        artist_id: album.get("artistId").and_then(value_to_string),
        artist_name: album
            .get("artist")
            .and_then(Value::as_str)
            .unwrap_or("Unknown artist")
            .to_owned(),
        year: album
            .get("year")
            .and_then(Value::as_i64)
            .and_then(|y| i32::try_from(y).ok()),
        artwork_id,
        artwork_url,
        song_count,
        source_server: Some(String::from("navidrome")),
        identity_hints: Some(extract_identity_hints(album)),
    }
}

/// Maps a raw Subsonic `artist` JSON value into a MusicDeck [`Artist`].
#[must_use]
pub fn map_subsonic_artist(artist: &Value) -> Artist {
    let artist_id = artist
        .get("id")
        .and_then(value_to_string)
        .unwrap_or_default();
    let artwork_id = artist.get("coverArt").and_then(value_to_string);
    let artwork_url = format_artwork_url(artwork_id.as_deref());

    let album_count = artist
        .get("albumCount")
        .and_then(Value::as_u64)
        .and_then(|c| u32::try_from(c).ok())
        .or_else(|| {
            artist
                .get("album")
                .and_then(Value::as_array)
                .and_then(|arr| u32::try_from(arr.len()).ok())
        })
        .unwrap_or(0);

    Artist {
        id: artist_id.clone(),
        provider_id: artist_id,
        name: artist
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Unknown artist")
            .to_owned(),
        artwork_id,
        artwork_url,
        image_url: None,
        album_count,
        song_count: artist
            .get("songCount")
            .and_then(Value::as_u64)
            .and_then(|c| u32::try_from(c).ok()),
        identity_hints: Some(extract_identity_hints(artist)),
    }
}

/// Maps a raw Subsonic `playlist` JSON value into a MusicDeck [`Playlist`].
#[must_use]
pub fn map_subsonic_playlist(playlist: &Value, include_tracks: bool) -> Playlist {
    let playlist_id = playlist
        .get("id")
        .and_then(value_to_string)
        .unwrap_or_default();
    let artwork_id = playlist.get("coverArt").and_then(value_to_string);
    let artwork_url = format_artwork_url(artwork_id.as_deref());

    let entries = playlist.get("entry").and_then(Value::as_array);
    let song_count = playlist
        .get("songCount")
        .and_then(Value::as_u64)
        .and_then(|c| u32::try_from(c).ok())
        .or_else(|| entries.and_then(|arr| u32::try_from(arr.len()).ok()))
        .unwrap_or(0);

    let tracks = if include_tracks {
        Some(
            entries
                .map(|arr| arr.iter().map(map_subsonic_track).collect())
                .unwrap_or_default(),
        )
    } else {
        None
    };

    Playlist {
        id: playlist_id.clone(),
        provider_id: playlist_id,
        name: playlist
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Untitled playlist")
            .to_owned(),
        description: playlist
            .get("comment")
            .and_then(Value::as_str)
            .map(str::to_owned),
        artwork_id,
        artwork_url,
        song_count,
        tracks,
    }
}
