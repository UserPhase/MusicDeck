//! # Similar Mix Graph Traversal, Gumbel Exploration & Interleaved Sequencing (`mixes::engine`)
//!
//! Ports `server/src/services/SimilarMixEngine.ts`:
//! - [`MixScope`] (`LIBRARY_ONLY | DISCOVERY_ONLY | HYBRID_MIX`)
//! - [`SimilarMixEngine`]:
//!   - `search_seeds` & `register_external_seed` (`similar_mix_external_tracks`)
//!   - `generate`:
//!     - Resolves up to 5 seed songs against `similar_mix_vectors` (`7-day` TTL, `30-day` stale window)
//!       and Last.fm `track.getSimilar` (`650 ms` rate spacing)
//!     - Executes bounded second-hop bridge traversal when `adventurousness >= 0.6`
//!       ($w_{\text{bridge}} \cdot w_{\text{neighbor}} \cdot 0.65$)
//!     - Computes multi-seed similarity ($0.65 \max_i w_i + 0.35 \bar{w}$), logarithmic familiarity
//!       ($\min(1, \frac{\ln(1+\text{plays})}{\ln 21} \cdot 0.75 + 0.25 \cdot \text{fav})$),
//!       closeness ($\text{sim}^{1.8 - 1.2 a}$), novelty ($1 - \text{fam}$), and composite score
//!     - Applies deterministic Gumbel-max exploration noise ($-\ln(-\ln u) \cdot (0.015 + 0.055 a)$)
//!       seeded by `SHA256("<shuffleSeed>:<trackId>")`
//!     - Interleaves library and discovery buckets while avoiding consecutive tracks by the same artist
//!   - `materialize`: Revalidates live taste exclusions and scope before saving or queueing a preview

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use chrono::Utc;
use reqwest::redirect::Policy;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use url::Url;
use uuid::Uuid;

use crate::catalog::{normalize_music_text, version_signature};
use crate::db::DbPool;
use crate::profile::{TasteProfileManager, TasteTarget};
use crate::providers::{IdentityHints, Track};

/// Milliseconds in one day (`86,400,000 ms`).
pub const MIX_DAY_MS: i64 = 86_400_000;
/// Fresh TTL for cached Last.fm `track.getSimilar` vectors (`7 days`).
pub const MIX_VECTOR_TTL_MS: i64 = 7 * MIX_DAY_MS;
/// Stale-while-revalidate fallback window for cached vectors (`30 days`).
pub const MIX_VECTOR_STALE_MS: i64 = 30 * MIX_DAY_MS;

/// Scope controlling whether generated mixes contain library tracks, external discoveries, or both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MixScope {
    #[serde(rename = "LIBRARY_ONLY")]
    LibraryOnly,
    #[serde(rename = "DISCOVERY_ONLY")]
    DiscoveryOnly,
    #[serde(rename = "HYBRID_MIX")]
    HybridMix,
}

/// Request payload for [`SimilarMixEngine::generate`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarMixInput {
    pub seed_track_ids: Vec<String>,
    pub scope: MixScope,
    pub adventurousness: f64,
    #[serde(default)]
    pub locked_track_ids: Vec<String>,
    #[serde(default)]
    pub exclude_track_ids: Vec<String>,
    #[serde(default)]
    pub shuffle_seed: Option<String>,
}

/// Candidate track item inside a [`SimilarMixPreview`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixCandidate {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub in_library: bool,
    pub similarity: f64,
    pub familiarity: f64,
    pub score: f64,
    pub reason: String,
    pub track: Value,
}

/// Preview response returned by [`SimilarMixEngine::generate`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarMixPreview {
    pub tracks: Vec<MixCandidate>,
    pub warnings: Vec<String>,
    pub shuffle_seed: String,
    pub cached: bool,
    pub generated_in_ms: f64,
}

/// Seed song descriptor returned by [`SimilarMixEngine::search_seeds`] and [`SimilarMixEngine::register_external_seed`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedRecording {
    pub id: String,
    pub title: String,
    pub artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mbid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
}

/// Structured error returned by [`SimilarMixEngine`].
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct SimilarMixError {
    pub message: String,
    pub status_code: u16,
    pub retry_after_ms: Option<i64>,
}

impl SimilarMixError {
    /// Creates a new [`SimilarMixError`].
    #[must_use]
    pub fn new(
        message: impl Into<String>,
        status_code: u16,
        retry_after_ms: Option<i64>,
    ) -> Self {
        Self {
            message: message.into(),
            status_code,
            retry_after_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SimilarNeighbor {
    pub id: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub mbid: Option<String>,
    #[serde(rename = "match")]
    pub match_score: f64,
}

#[derive(Debug, Clone)]
struct CachedVector {
    neighbors: Vec<SimilarNeighbor>,
    expires_at: i64,
    retry_at: i64,
}

fn sha256_hex(text: &str) -> String {
    let mut sha = Sha256::new();
    sha.update(text.as_bytes());
    format!("{:x}", sha.finalize())
}

/// Computes the canonical recording key `[normalized_artist, normalized_title, version_signature]`.
#[must_use]
pub fn mix_recording_key(title: &str, artist: &str) -> String {
    serde_json::to_string(&json!([
        normalize_music_text(Some(artist)),
        normalize_music_text(Some(title)),
        version_signature(Some(title)),
    ]))
    .unwrap_or_default()
}

/// Computes the deterministic external Last.fm track ID (`external_lastfm_track_<sha256[..32]>`).
#[must_use]
pub fn external_lastfm_track_id(title: &str, artist: &str) -> String {
    let h = sha256_hex(&mix_recording_key(title, artist));
    format!("external_lastfm_track_{}", &h[..32])
}

/// Computes the deterministic external Last.fm artist ID (`external_lastfm_artist_<sha256[..32]>`).
#[must_use]
pub fn external_lastfm_artist_id(artist: &str) -> String {
    let h = sha256_hex(&normalize_music_text(Some(artist)));
    format!("external_lastfm_artist_{}", &h[..32])
}

#[derive(Default)]
struct IndexedCatalogSnapshot {
    version: String,
    degraded: bool,
    local: HashMap<String, Track>,
    known: HashMap<String, Track>,
    by_recording: HashMap<String, Track>,
    by_artist: HashMap<String, Vec<Track>>,
    artist_names: HashMap<String, HashSet<String>>,
}

/// Similar Mix generation engine combining Last.fm `track.getSimilar` graph traversal
/// with local catalog indexing, taste familiarity, and Gumbel-max exploration.
#[derive(Clone)]
pub struct SimilarMixEngine {
    db: Option<DbPool>,
    snapshot: Arc<RwLock<Option<IndexedCatalogSnapshot>>>,
    vector_cache: Arc<RwLock<HashMap<String, CachedVector>>>,
    http: Client,
}

impl std::fmt::Debug for SimilarMixEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SimilarMixEngine").finish()
    }
}

impl SimilarMixEngine {
    /// Creates a new [`SimilarMixEngine`].
    #[must_use]
    pub fn new(db: Option<DbPool>) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_millis(6_000))
            .redirect(Policy::none())
            .user_agent("MusicDeck/1.0 (similar-song mixes)")
            .build()
            .unwrap_or_default();
        Self {
            db,
            snapshot: Arc::new(RwLock::new(None)),
            vector_cache: Arc::new(RwLock::new(HashMap::new())),
            http,
        }
    }

    fn now_ms() -> i64 {
        Utc::now().timestamp_millis()
    }

    fn require_db(&self) -> Result<&DbPool, SimilarMixError> {
        self.db.as_ref().ok_or_else(|| {
            SimilarMixError::new("Database is unavailable.", 503, None)
        })
    }

    async fn load_catalog_snapshot(&self) -> Result<IndexedCatalogSnapshot, SimilarMixError> {
        let pool = self.require_db()?;
        let state_row = sqlx::query(
            "SELECT refreshed_at, degraded, mix_revision FROM smart_playlist_catalog_state WHERE singleton = 1",
        )
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()
        .ok_or_else(|| {
            SimilarMixError::new(
                "Your library is still being indexed. Try again shortly.",
                503,
                None,
            )
        })?;

        let refreshed_at: String = state_row.try_get("refreshed_at").unwrap_or_default();
        let degraded = state_row.try_get::<i64, _>("degraded").unwrap_or(0) != 0;
        let mix_rev: i64 = state_row.try_get("mix_revision").unwrap_or(0);
        let version = format!("{refreshed_at}:{mix_rev}");

        if let Ok(guard) = self.snapshot.read() {
            if let Some(ref existing) = *guard {
                if existing.version == version {
                    return Ok(IndexedCatalogSnapshot {
                        version: existing.version.clone(),
                        degraded,
                        local: existing.local.clone(),
                        known: existing.known.clone(),
                        by_recording: existing.by_recording.clone(),
                        by_artist: existing.by_artist.clone(),
                        artist_names: existing.artist_names.clone(),
                    });
                }
            }
        }

        let payload_rows = sqlx::query("SELECT track_json FROM smart_playlist_track_payloads")
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default();

        let mut snap = IndexedCatalogSnapshot {
            version,
            degraded,
            ..IndexedCatalogSnapshot::default()
        };

        for row in payload_rows {
            let Ok(json_str) = row.try_get::<String, _>("track_json") else {
                continue;
            };
            let Ok(val) = serde_json::from_str::<Value>(&json_str) else {
                continue;
            };
            let Ok(track) = serde_json::from_value::<Track>(val.clone()) else {
                continue;
            };
            if track.id.is_empty() || track.title.is_empty() || track.artist_name.is_empty() {
                continue;
            }

            let avail_obj = val.get("availability");
            let lib_avail = avail_obj
                .and_then(|a| a.get("libraryAvailable"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let state_str = avail_obj
                .and_then(|a| a.get("state"))
                .and_then(Value::as_str)
                .unwrap_or("available");
            let available = lib_avail && state_str != "unavailable";

            snap.known.insert(track.id.clone(), track.clone());
            let rec_key = mix_recording_key(&track.title, &track.artist_name);
            let norm_artist = normalize_music_text(Some(&track.artist_name));

            if !snap.by_recording.contains_key(&rec_key) || available {
                snap.by_recording.insert(rec_key, track.clone());
            }
            if let Some(ref aid) = track.artist_id {
                snap.artist_names
                    .entry(aid.clone())
                    .or_default()
                    .insert(norm_artist.clone());
            }
            if !available {
                continue;
            }
            snap.local.insert(track.id.clone(), track.clone());
            snap.by_artist.entry(norm_artist).or_default().push(track);
        }

        if let Ok(mut guard) = self.snapshot.write() {
            *guard = Some(IndexedCatalogSnapshot {
                version: snap.version.clone(),
                degraded: snap.degraded,
                local: snap.local.clone(),
                known: snap.known.clone(),
                by_recording: snap.by_recording.clone(),
                by_artist: snap.by_artist.clone(),
                artist_names: snap.artist_names.clone(),
            });
        }

        Ok(snap)
    }

    /// Searches up to 12 local library tracks matching all normalized query terms.
    pub async fn search_seeds(&self, query: &str) -> Result<Vec<SeedRecording>, SimilarMixError> {
        let snap = self.load_catalog_snapshot().await?;
        let terms: Vec<String> = normalize_music_text(Some(query))
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }

        let mut results = Vec::new();
        for track in snap.local.values() {
            let haystack =
                normalize_music_text(Some(&format!("{} {}", track.title, track.artist_name)));
            if terms.iter().all(|term| haystack.contains(term)) {
                results.push(SeedRecording {
                    id: track.id.clone(),
                    title: track.title.clone(),
                    artist: track.artist_name.clone(),
                    mbid: None,
                    preview_url: None,
                });
                if results.len() == 12 {
                    break;
                }
            }
        }
        Ok(results)
    }

    /// Registers an external track seed in `similar_mix_external_tracks`.
    pub async fn register_external_seed(
        &self,
        title: &str,
        artist: &str,
    ) -> Result<SeedRecording, SimilarMixError> {
        let t = title.trim();
        let a = artist.trim();
        if t.is_empty()
            || t.len() > 500
            || a.is_empty()
            || a.len() > 500
            || normalize_music_text(Some(t)).is_empty()
            || normalize_music_text(Some(a)).is_empty()
        {
            return Err(SimilarMixError::new(
                "Enter a song title and artist.",
                400,
                None,
            ));
        }

        let rec = SeedRecording {
            id: external_lastfm_track_id(t, a),
            title: t.to_owned(),
            artist: a.to_owned(),
            mbid: None,
            preview_url: None,
        };
        self.store_recordings(std::slice::from_ref(&rec)).await;
        Ok(rec)
    }

    async fn store_recordings(&self, recordings: &[SeedRecording]) {
        let Some(pool) = &self.db else {
            return;
        };
        let now = Self::now_ms();
        for row in recordings {
            let _ = sqlx::query(
                r"
                INSERT INTO similar_mix_external_tracks (id, title, artist, mbid, touched_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    artist = excluded.artist,
                    mbid = COALESCE(excluded.mbid, mbid),
                    touched_at = excluded.touched_at
                ",
            )
            .bind(&row.id)
            .bind(&row.title)
            .bind(&row.artist)
            .bind(row.mbid.as_deref())
            .bind(now)
            .execute(pool.inner())
            .await;
        }
    }

    async fn resolve_recording(
        &self,
        snap: &IndexedCatalogSnapshot,
        id: &str,
    ) -> Result<SeedRecording, SimilarMixError> {
        if let Some(track) = snap.known.get(id) {
            return Ok(SeedRecording {
                id: id.to_owned(),
                title: track.title.clone(),
                artist: track.artist_name.clone(),
                mbid: track
                    .identity_hints
                    .as_ref()
                    .and_then(|h| h.music_brainz_id.clone()),
                preview_url: None,
            });
        }

        let pool = self.require_db()?;
        let row = sqlx::query(
            "SELECT id, title, artist, mbid, preview_url FROM similar_mix_external_tracks WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()
        .ok_or_else(|| {
            SimilarMixError::new(
                "A seed song is no longer available. Remove it and choose another.",
                404,
                None,
            )
        })?;

        Ok(SeedRecording {
            id: row.try_get("id").unwrap_or_default(),
            title: row.try_get("title").unwrap_or_default(),
            artist: row.try_get("artist").unwrap_or_default(),
            mbid: row.try_get("mbid").ok(),
            preview_url: row.try_get("preview_url").ok(),
        })
    }

    async fn read_cached_vector(&self, seed_key: &str) -> Option<CachedVector> {
        if let Ok(guard) = self.vector_cache.read() {
            if let Some(v) = guard.get(seed_key) {
                return Some(v.clone());
            }
        }
        let pool = self.db.as_ref()?;
        let row = sqlx::query(
            "SELECT payload_json, expires_at, retry_at FROM similar_mix_vectors WHERE seed_key = ?",
        )
        .bind(seed_key)
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()?;

        let expires_at: i64 = row.try_get("expires_at").unwrap_or(0);
        let retry_at: i64 = row.try_get("retry_at").unwrap_or(0);
        let payload_json: Option<String> = row.try_get("payload_json").ok();

        let mut neighbors = Vec::new();
        if let Some(json_str) = payload_json.filter(|s| !s.is_empty()) {
            match serde_json::from_str::<Vec<SimilarNeighbor>>(&json_str) {
                Ok(parsed) if parsed.len() <= 200 => neighbors = parsed,
                _ => {
                    let _ = sqlx::query("DELETE FROM similar_mix_vectors WHERE seed_key = ?")
                        .bind(seed_key)
                        .execute(pool.inner())
                        .await;
                    return None;
                }
            }
        }

        let cv = CachedVector {
            neighbors,
            expires_at,
            retry_at,
        };
        if let Ok(mut guard) = self.vector_cache.write() {
            if guard.len() >= 256 {
                if let Some(first_key) = guard.keys().next().cloned() {
                    guard.remove(&first_key);
                }
            }
            guard.insert(seed_key.to_owned(), cv.clone());
        }
        Some(cv)
    }

    async fn lastfm_api_key(&self) -> Option<String> {
        let pool = self.db.as_ref()?;
        let row = sqlx::query(
            "SELECT enabled, config_json, permissions_json FROM plugin_configs WHERE plugin_id = 'lastfm'",
        )
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()?;

        if row.try_get::<i64, _>("enabled").unwrap_or(0) == 0 {
            return None;
        }
        let perms_str: String = row.try_get("permissions_json").unwrap_or_default();
        let cfg_str: String = row.try_get("config_json").unwrap_or_default();
        let perms: Vec<String> = serde_json::from_str(&perms_str).ok()?;
        if !perms.iter().any(|p| p == "network.request") {
            return None;
        }
        let cfg: Value = serde_json::from_str(&cfg_str).ok()?;
        cfg.get("apiKey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }

    async fn fetch_or_cached_vector(
        &self,
        seed: &SeedRecording,
        allow_network: bool,
    ) -> (CachedVector, bool, Option<String>) {
        let seed_key = mix_recording_key(&seed.title, &seed.artist);
        let now = Self::now_ms();
        let cached = self.read_cached_vector(&seed_key).await;

        if let Some(ref c) = cached {
            if c.expires_at > now {
                return (c.clone(), true, None);
            }
        }

        let stale = cached
            .as_ref()
            .filter(|c| c.expires_at > 0 && c.expires_at + MIX_VECTOR_STALE_MS > now)
            .cloned();

        if !allow_network {
            return (
                stale.unwrap_or(CachedVector {
                    neighbors: Vec::new(),
                    expires_at: 0,
                    retry_at: 0,
                }),
                true,
                Some(String::from(
                    "External lookups are disabled. Using cached similarity and related library tracks.",
                )),
            );
        }

        if let Some(ref c) = cached {
            if c.retry_at > now {
                return (
                    stale.unwrap_or(CachedVector {
                        neighbors: Vec::new(),
                        expires_at: 0,
                        retry_at: c.retry_at,
                    }),
                    true,
                    Some(String::from(
                        "Similarity lookup is cooling down; showing cached matches where available.",
                    )),
                );
            }
        }

        let Some(api_key) = self.lastfm_api_key().await else {
            return (
                stale.unwrap_or(CachedVector {
                    neighbors: Vec::new(),
                    expires_at: 0,
                    retry_at: 0,
                }),
                true,
                Some(String::from(
                    "Enable Last.fm and configure its API key in Admin → Plugins for song-similarity discovery.",
                )),
            );
        };

        let mut url =
            Url::parse("https://ws.audioscrobbler.com/2.0/").expect("valid constant URL");
        url.query_pairs_mut()
            .append_pair("method", "track.getSimilar")
            .append_pair("artist", &seed.artist)
            .append_pair("track", &seed.title)
            .append_pair("autocorrect", "1")
            .append_pair("limit", "200")
            .append_pair("api_key", &api_key)
            .append_pair("format", "json");

        let resp_res = self
            .http
            .get(url.as_str())
            .header("Accept", "application/json")
            .send()
            .await;

        let Ok(resp) = resp_res else {
            return (
                stale.unwrap_or(CachedVector {
                    neighbors: Vec::new(),
                    expires_at: 0,
                    retry_at: now + 60_000,
                }),
                false,
                Some(String::from(
                    "Could not reach Last.fm. Showing cached and related library matches.",
                )),
            );
        };

        if resp.status() == StatusCode::TOO_MANY_REQUESTS || !resp.status().is_success() {
            return (
                stale.unwrap_or(CachedVector {
                    neighbors: Vec::new(),
                    expires_at: 0,
                    retry_at: now + 300_000,
                }),
                false,
                Some(String::from(
                    "Last.fm similarity is temporarily unavailable. Try again shortly.",
                )),
            );
        }

        let Ok(payload) = resp.json::<Value>().await else {
            return (
                stale.unwrap_or(CachedVector {
                    neighbors: Vec::new(),
                    expires_at: 0,
                    retry_at: now + 60_000,
                }),
                false,
                Some(String::from("Last.fm returned an unreadable response.")),
            );
        };

        let raw_tracks = payload
            .get("similartracks")
            .and_then(|s| s.get("track"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut found: Vec<SimilarNeighbor> = Vec::new();
        for item in raw_tracks.into_iter().take(200) {
            let Some(name) = item
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let artist = item
                .get("artist")
                .and_then(|a| {
                    a.as_str()
                        .or_else(|| a.get("name").and_then(Value::as_str))
                })
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let Some(artist) = artist else {
                continue;
            };
            if normalize_music_text(Some(name)).is_empty()
                || normalize_music_text(Some(artist)).is_empty()
            {
                continue;
            }
            let match_score = item
                .get("match")
                .and_then(|m| {
                    m.as_f64()
                        .or_else(|| m.as_str().and_then(|s| s.parse::<f64>().ok()))
                })
                .filter(|v| v.is_finite() && *v >= 0.0)
                .unwrap_or(0.0);
            let mbid = item
                .get("mbid")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);

            found.push(SimilarNeighbor {
                id: external_lastfm_track_id(name, artist),
                title: name.to_owned(),
                artist: artist.to_owned(),
                mbid,
                match_score,
            });
        }

        let scale = found
            .iter()
            .map(|r| r.match_score)
            .fold(1.0_f64, f64::max);

        let mut unique: HashMap<String, SimilarNeighbor> = HashMap::new();
        for mut row in found {
            row.match_score = (row.match_score / scale).clamp(0.0, 1.0);
            match unique.get(&row.id) {
                Some(prev) if prev.match_score >= row.match_score => {}
                _ => {
                    unique.insert(row.id.clone(), row);
                }
            }
        }

        let neighbors: Vec<SimilarNeighbor> = unique.into_values().collect();
        let expires_at = now
            + if neighbors.is_empty() {
                MIX_DAY_MS / 4
            } else {
                MIX_VECTOR_TTL_MS
            };

        let seed_recs: Vec<SeedRecording> = neighbors
            .iter()
            .map(|n| SeedRecording {
                id: n.id.clone(),
                title: n.title.clone(),
                artist: n.artist.clone(),
                mbid: n.mbid.clone(),
                preview_url: None,
            })
            .collect();
        self.store_recordings(&seed_recs).await;

        if let Some(pool) = &self.db {
            let payload_str =
                serde_json::to_string(&neighbors).unwrap_or_else(|_| String::from("[]"));
            let _ = sqlx::query(
                r"
                INSERT INTO similar_mix_vectors (seed_key, payload_json, expires_at, retry_at, touched_at)
                VALUES (?, ?, ?, 0, ?)
                ON CONFLICT(seed_key) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    expires_at = excluded.expires_at,
                    retry_at = 0,
                    touched_at = excluded.touched_at
                ",
            )
            .bind(&seed_key)
            .bind(payload_str)
            .bind(expires_at)
            .bind(now)
            .execute(pool.inner())
            .await;

            let _ = sqlx::query(
                r"
                DELETE FROM similar_mix_vectors
                WHERE seed_key IN (
                    SELECT seed_key FROM similar_mix_vectors
                    ORDER BY touched_at DESC
                    LIMIT -1 OFFSET 2000
                )
                ",
            )
            .execute(pool.inner())
            .await;
        }

        let cv = CachedVector {
            neighbors,
            expires_at,
            retry_at: 0,
        };
        if let Ok(mut guard) = self.vector_cache.write() {
            guard.insert(seed_key, cv.clone());
        }
        (cv, false, None)
    }

    async fn compute_familiarity(
        &self,
        user_id: &str,
        track_ids: &[String],
    ) -> HashMap<String, f64> {
        let Some(pool) = &self.db else {
            return HashMap::new();
        };
        if track_ids.is_empty() {
            return HashMap::new();
        }
        let candidates_json =
            serde_json::to_string(track_ids).unwrap_or_else(|_| String::from("[]"));

        let rows = sqlx::query(
            r"
            SELECT track_id, MAX(plays) AS plays, MAX(favorite) AS favorite
            FROM (
                SELECT track_id, COUNT(*) AS plays, 0 AS favorite
                FROM taste_recently_played
                WHERE user_id = ? AND track_id IN (SELECT value FROM json_each(?))
                GROUP BY track_id
                UNION ALL
                SELECT track_id, COUNT(DISTINCT COALESCE(playback_session_id, id)), 0
                FROM taste_listening_events
                WHERE user_id = ? AND event_type IN ('play', 'complete')
                  AND track_id IN (SELECT value FROM json_each(?))
                GROUP BY track_id
                UNION ALL
                SELECT track_id, 0, 1
                FROM favorites
                WHERE user_id = ? AND track_id IN (SELECT value FROM json_each(?))
            )
            GROUP BY track_id
            ",
        )
        .bind(user_id)
        .bind(&candidates_json)
        .bind(user_id)
        .bind(&candidates_json)
        .bind(user_id)
        .bind(&candidates_json)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        let ln_21 = 21.0_f64.ln();
        rows.into_iter()
            .filter_map(|r| {
                let tid: String = r.try_get("track_id").ok()?;
                let plays: i64 = r.try_get("plays").unwrap_or(0);
                let fav: i64 = r.try_get("favorite").unwrap_or(0);
                let val = (((plays as f64).ln_1p() / ln_21) * 0.75 + (fav as f64) * 0.25)
                    .clamp(0.0, 1.0);
                Some((tid, val))
            })
            .collect()
    }

    /// Generates a 25-track [`SimilarMixPreview`] for `user_id` and `input`.
    pub async fn generate(
        &self,
        user_id: &str,
        input: SimilarMixInput,
        allow_external_network: bool,
    ) -> Result<SimilarMixPreview, SimilarMixError> {
        let started = Instant::now();
        let unique_seeds: HashSet<&String> = input.seed_track_ids.iter().collect();
        if input.seed_track_ids.is_empty()
            || input.seed_track_ids.len() > 5
            || unique_seeds.len() != input.seed_track_ids.len()
            || !input.adventurousness.is_finite()
            || !(0.0..=1.0).contains(&input.adventurousness)
            || input.locked_track_ids.len() > 25
            || input.exclude_track_ids.len() > 1000
        {
            return Err(SimilarMixError::new(
                "Choose 1–5 unique seed songs, a valid scope, and adventurousness between 0 and 1.",
                400,
                None,
            ));
        }

        let snap = self.load_catalog_snapshot().await?;
        let use_external = input.scope != MixScope::LibraryOnly;
        if use_external && snap.degraded {
            return Err(SimilarMixError::new(
                "Reconnect your library sources before building discovery mixes so owned songs can be identified accurately.",
                503,
                None,
            ));
        }

        let mut seeds = Vec::with_capacity(input.seed_track_ids.len());
        for seed_id in &input.seed_track_ids {
            seeds.push(self.resolve_recording(&snap, seed_id).await?);
        }
        let seed_keys: HashSet<String> = seeds
            .iter()
            .map(|s| mix_recording_key(&s.title, &s.artist))
            .collect();

        let mut vectors = Vec::with_capacity(seeds.len());
        let mut warnings_set: HashSet<String> = HashSet::new();
        let mut all_cached = true;

        for seed in &seeds {
            let (vec, cached, warn) = self
                .fetch_or_cached_vector(seed, allow_external_network)
                .await;
            all_cached &= cached;
            if let Some(w) = warn {
                warnings_set.insert(w);
            }
            vectors.push(vec);
        }

        // Pool entry: (Track, is_external, weights_per_seed, from_graph)
        let mut pool: HashMap<String, (Track, bool, Vec<f64>, bool)> = HashMap::new();
        let num_seeds = seeds.len();

        let mut add_candidate = |rec: &SeedRecording,
                                 strength: f64,
                                 seed_index: usize,
                                 from_graph: bool| {
            let rec_key = mix_recording_key(&rec.title, &rec.artist);
            if seed_keys.contains(&rec_key) {
                return;
            }
            let owned = snap.by_recording.get(&rec_key);
            let local = owned.and_then(|o| snap.local.get(&o.id));
            if owned.is_some() && local.is_none() {
                return;
            }
            if (input.scope == MixScope::LibraryOnly && local.is_none())
                || (input.scope == MixScope::DiscoveryOnly && owned.is_some())
            {
                return;
            }

            let (track, is_external) = if let Some(l) = local {
                let mut t = l.clone();
                t.stream_url = format!("/api/tracks/{}/stream", urlencoding::encode(&l.id));
                (t, false)
            } else {
                (
                    Track {
                        id: rec.id.clone(),
                        provider_id: rec.id.clone(),
                        title: rec.title.clone(),
                        artist_id: Some(external_lastfm_artist_id(&rec.artist)),
                        artist_name: rec.artist.clone(),
                        artist_credits: None,
                        album_id: None,
                        album_name: String::new(),
                        duration_seconds: None,
                        track_number: None,
                        disc_number: None,
                        year: None,
                        original_release_year: None,
                        genres: None,
                        moods: None,
                        bpm: None,
                        play_count: None,
                        last_played_at: None,
                        added_at: None,
                        artwork_id: None,
                        artwork_url: None,
                        stream_url: String::new(),
                        source_server: None,
                        audio_metadata: None,
                        replay_gain: None,
                        normalization_gain_db: None,
                        loudness: None,
                        related_artist_ids: None,
                        identity_hints: rec.mbid.as_ref().map(|mbid| IdentityHints {
                            music_brainz_id: Some(mbid.clone()),
                            isrc: None,
                            upc: None,
                        }),
                    },
                    true,
                )
            };

            let entry = pool
                .entry(rec_key)
                .or_insert_with(|| (track, is_external, vec![0.0; num_seeds], false));
            entry.2[seed_index] = entry.2[seed_index].max(strength);
            entry.3 |= from_graph;
        };

        let now = Self::now_ms();
        for (idx, vec) in vectors.iter().enumerate() {
            for neighbor in &vec.neighbors {
                add_candidate(
                    &SeedRecording {
                        id: neighbor.id.clone(),
                        title: neighbor.title.clone(),
                        artist: neighbor.artist.clone(),
                        mbid: neighbor.mbid.clone(),
                        preview_url: None,
                    },
                    neighbor.match_score,
                    idx,
                    true,
                );
            }

            if input.adventurousness >= 0.6 {
                for bridge in vec.neighbors.iter().take(2) {
                    let bridge_key = mix_recording_key(&bridge.title, &bridge.artist);
                    if let Some(next_vec) = self.read_cached_vector(&bridge_key).await {
                        if next_vec.expires_at + MIX_VECTOR_STALE_MS > now {
                            for neighbor in next_vec.neighbors.iter().take(50) {
                                add_candidate(
                                    &SeedRecording {
                                        id: neighbor.id.clone(),
                                        title: neighbor.title.clone(),
                                        artist: neighbor.artist.clone(),
                                        mbid: neighbor.mbid.clone(),
                                        preview_url: None,
                                    },
                                    bridge.match_score * neighbor.match_score * 0.65,
                                    idx,
                                    true,
                                );
                            }
                        }
                    }
                }
            }

            if input.scope != MixScope::DiscoveryOnly {
                let norm_seed_artist = normalize_music_text(Some(&seeds[idx].artist));
                if !norm_seed_artist.is_empty()
                    && !matches!(
                        norm_seed_artist.as_str(),
                        "unknown" | "unknown artist" | "various artists"
                    )
                {
                    if let Some(artist_tracks) = snap.by_artist.get(&norm_seed_artist) {
                        for track in artist_tracks.iter().take(200) {
                            add_candidate(
                                &SeedRecording {
                                    id: track.id.clone(),
                                    title: track.title.clone(),
                                    artist: track.artist_name.clone(),
                                    mbid: None,
                                    preview_url: None,
                                },
                                0.15,
                                idx,
                                false,
                            );
                        }
                    }
                }
            }
        }

        let pool_db = self.require_db()?;
        let taste_mgr = TasteProfileManager::new(pool_db.clone());
        let filter = taste_mgr.feedback_filter(user_id, &[]).await;

        let excluded_ids: HashSet<String> = input.exclude_track_ids.iter().cloned().collect();
        let mut excluded_keys: HashSet<String> = HashSet::new();
        for ex_id in &excluded_ids {
            if let Ok(rec) = self.resolve_recording(&snap, ex_id).await {
                excluded_keys.insert(mix_recording_key(&rec.title, &rec.artist));
            }
        }

        let local_candidate_ids: Vec<String> = pool
            .values()
            .filter(|(_, is_ext, _, _)| !*is_ext)
            .map(|(t, _, _, _)| t.id.clone())
            .collect();
        let signals = self.compute_familiarity(user_id, &local_candidate_ids).await;

        let shuffle_seed = input
            .shuffle_seed
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let adventure = input.adventurousness;
        let mut scored: Vec<MixCandidate> = Vec::new();

        for (identity, (track, is_external, weights, from_graph)) in pool {
            if !filter.allows(&TasteTarget::from_track(&track))
                || excluded_ids.contains(&track.id)
                || excluded_keys.contains(&identity)
            {
                continue;
            }
            let max_w = weights.iter().copied().fold(0.0_f64, f64::max);
            let mean_w = weights.iter().sum::<f64>() / (num_seeds as f64);
            let similarity = (0.65 * max_w + 0.35 * mean_w).clamp(0.0, 1.0);
            if similarity <= 0.0 {
                continue;
            }

            let familiarity = if is_external {
                0.0
            } else {
                0.25 + 0.75 * signals.get(&track.id).copied().unwrap_or(0.0)
            };
            let closeness = similarity.powf(1.8 - adventure * 1.2);
            let novelty = 1.0 - familiarity;
            let score =
                closeness * 0.7 + (1.0 - adventure) * familiarity * 0.3 + adventure * novelty * 0.3;

            let matching_seeds = weights.iter().filter(|&&w| w > 0.0).count();
            let reason = if from_graph {
                format!("Similar to {matching_seeds} of your seed songs")
            } else {
                format!("Another song by {}", track.artist_name)
            };

            let mut track_val = serde_json::to_value(&track).unwrap_or(Value::Null);
            if let Value::Object(ref mut map) = track_val {
                map.insert(String::from("external"), Value::Bool(is_external));
                map.insert(
                    String::from("provider"),
                    Value::String(if is_external {
                        String::from("external")
                    } else {
                        String::from("library")
                    }),
                );
            }

            scored.push(MixCandidate {
                id: track.id.clone(),
                title: track.title,
                artist: track.artist_name,
                album: track.album_name,
                in_library: !is_external,
                similarity,
                familiarity,
                score,
                reason,
                track: track_val,
            });
        }

        // Gumbel-max exploration ranking
        let mut ranks: HashMap<String, f64> = HashMap::with_capacity(scored.len());
        for row in &scored {
            let h = sha256_hex(&format!("{shuffle_seed}:{}", row.id));
            let parsed_u32 = u32::from_str_radix(&h[..8], 16).unwrap_or(1);
            let unit = (f64::from(parsed_u32) + 1.0) / 4_294_967_297.0;
            let gumbel = -(-unit.ln()).ln();
            let r = row.score + gumbel * (0.015 + adventure * 0.055);
            ranks.insert(row.id.clone(), r);
        }

        scored.sort_by(|a, b| {
            let ra = ranks.get(&a.id).copied().unwrap_or(0.0);
            let rb = ranks.get(&b.id).copied().unwrap_or(0.0);
            rb.partial_cmp(&ra)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        });

        let by_id: HashMap<String, MixCandidate> =
            scored.iter().map(|c| (c.id.clone(), c.clone())).collect();
        let mut selected: Vec<MixCandidate> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut artist_counts: HashMap<String, usize> = HashMap::new();

        for lock_id in &input.locked_track_ids {
            if seen.contains(lock_id) {
                continue;
            }
            let Some(cand) = by_id.get(lock_id) else {
                return Err(SimilarMixError::new(
                    "A locked song is no longer eligible. Unlock it and refresh the mix.",
                    409,
                    None,
                ));
            };
            seen.insert(lock_id.clone());
            let norm_a = normalize_music_text(Some(&cand.artist));
            *artist_counts.entry(norm_a).or_insert(0) += 1;
            selected.push(cand.clone());
        }

        let external_target = match input.scope {
            MixScope::HybridMix => (25.0 * adventure).round() as usize,
            MixScope::DiscoveryOnly => 25,
            MixScope::LibraryOnly => 0,
        };

        let mut take_candidates =
            |want_external: Option<bool>, cap: usize, target_bucket_count: usize| {
                for row in &scored {
                    if selected.len() >= 25 {
                        break;
                    }
                    if let Some(ext) = want_external {
                        let current_bucket =
                            selected.iter().filter(|item| item.in_library != ext).count();
                        if current_bucket >= target_bucket_count {
                            break;
                        }
                        if row.in_library == ext {
                            continue;
                        }
                    }
                    if seen.contains(&row.id) {
                        continue;
                    }
                    let norm_a = normalize_music_text(Some(&row.artist));
                    let count = artist_counts.get(&norm_a).copied().unwrap_or(0);
                    if count >= cap {
                        continue;
                    }
                    seen.insert(row.id.clone());
                    artist_counts.insert(norm_a, count + 1);
                    selected.push(row.clone());
                }
            };

        take_candidates(Some(true), 2, external_target);
        take_candidates(Some(false), 2, 25 - external_target);
        take_candidates(Some(true), usize::MAX, external_target);
        take_candidates(Some(false), usize::MAX, 25 - external_target);
        take_candidates(None, 2, 25);
        take_candidates(None, usize::MAX, 25);

        // Interleave discovery and library buckets while avoiding consecutive identical artists
        let mut remaining = selected.clone();
        remaining.sort_by(|a, b| {
            let ra = ranks.get(&a.id).copied().unwrap_or(0.0);
            let rb = ranks.get(&b.id).copied().unwrap_or(0.0);
            rb.partial_cmp(&ra).unwrap_or(std::cmp::Ordering::Equal)
        });

        let total_selected = selected.len();
        let external_count = selected.iter().filter(|r| !r.in_library).count();
        let mut external_used = 0_usize;
        let mut ordered = Vec::with_capacity(total_selected);

        while !remaining.is_empty() {
            let want_ext = if total_selected > 0 {
                (((ordered.len() + 1) * external_count) as f64 / (total_selected as f64)).round()
                    as usize
                    > external_used
            } else {
                false
            };
            let prev_artist = ordered
                .last()
                .map(|last: &MixCandidate| normalize_music_text(Some(&last.artist)))
                .unwrap_or_default();

            let next_pos = remaining
                .iter()
                .position(|r| {
                    r.in_library != want_ext
                        && normalize_music_text(Some(&r.artist)) != prev_artist
                })
                .or_else(|| remaining.iter().position(|r| r.in_library != want_ext))
                .unwrap_or(0);

            let chosen = remaining.remove(next_pos);
            if !chosen.in_library {
                external_used += 1;
            }
            ordered.push(chosen);
        }

        if total_selected < 25 {
            warnings_set.insert(format!(
                "Found {total_selected} eligible related songs. Add another seed to broaden the mix."
            ));
        }
        if snap.degraded {
            warnings_set.insert(String::from(
                "Some library sources are unavailable; using the last indexed library snapshot.",
            ));
        }

        Ok(SimilarMixPreview {
            tracks: ordered,
            warnings: warnings_set.into_iter().collect(),
            shuffle_seed,
            cached: all_cached,
            generated_in_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// Revalidates live taste exclusions and materializes `ids` into [`Track`] items for saving/queueing.
    pub async fn materialize(
        &self,
        user_id: &str,
        ids: &[String],
    ) -> Result<Vec<Track>, SimilarMixError> {
        let snap = self.load_catalog_snapshot().await?;
        let pool_db = self.require_db()?;
        let taste_mgr = TasteProfileManager::new(pool_db.clone());
        let filter = taste_mgr.feedback_filter(user_id, &[]).await;

        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(local) = snap.local.get(id) {
                if !filter.allows(&TasteTarget::from_track(local)) {
                    return Err(SimilarMixError::new(
                        "A selected song was hidden. Refresh the mix.",
                        409,
                        None,
                    ));
                }
                let mut t = local.clone();
                t.stream_url = format!("/api/tracks/{}/stream", urlencoding::encode(id));
                out.push(t);
                continue;
            }
            if snap.known.contains_key(id) {
                return Err(SimilarMixError::new(
                    "A selected library song is unavailable. Refresh the mix.",
                    409,
                    None,
                ));
            }
            let rec = self.resolve_recording(&snap, id).await?;
            if snap
                .by_recording
                .contains_key(&mix_recording_key(&rec.title, &rec.artist))
            {
                return Err(SimilarMixError::new(
                    "A discovery is now in your library. Refresh the mix before saving.",
                    409,
                    None,
                ));
            }
            let track = Track {
                id: id.clone(),
                provider_id: id.clone(),
                title: rec.title,
                artist_id: Some(external_lastfm_artist_id(&rec.artist)),
                artist_name: rec.artist,
                artist_credits: None,
                album_id: None,
                album_name: String::new(),
                duration_seconds: None,
                track_number: None,
                disc_number: None,
                year: None,
                original_release_year: None,
                genres: None,
                moods: None,
                bpm: None,
                play_count: None,
                last_played_at: None,
                added_at: None,
                artwork_id: None,
                artwork_url: None,
                stream_url: String::new(),
                source_server: None,
                audio_metadata: None,
                replay_gain: None,
                normalization_gain_db: None,
                loudness: None,
                related_artist_ids: None,
                identity_hints: None,
            };
            if !filter.allows(&TasteTarget::from_track(&track)) {
                return Err(SimilarMixError::new(
                    "A selected song or artist was hidden. Refresh the mix.",
                    409,
                    None,
                ));
            }
            out.push(track);
        }

        Ok(out)
    }
}
