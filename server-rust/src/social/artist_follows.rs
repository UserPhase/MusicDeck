//! # Artist Follow & Release Radar Scanner Service (`social::artist_follows`)
//!
//! Ports `server/src/services/ArtistFollowService.ts`:
//! - [`followed_artist_key`]: SHA-256 of `["<provider>", "<artist_id>"]`
//! - [`ArtistFollowService`]:
//!   - `follow`: Enforces 1,000-artist limit per user, validates numeric external artist IDs,
//!     and inserts into `followed_artist_catalog` + `followed_artists`
//!   - `unfollow` & `list`
//!   - `feed`: 30-day release feed deduplicated by `canonical_key` (`GROUP BY r.canonical_key`)
//!     with external artwork token minting (`extart_...`)
//!   - `scan`: Claims artists due for scanning with a 5-minute lease (`lease_until`), enforces
//!     SQLite-backed cross-worker throttling (`release_provider_throttle`, `3,500 ms` spacing),
//!     exponential failure backoff (`15m * 2^min(failures, 7)` capped at 24h), and 45-day pruning

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use reqwest::redirect::Policy;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use url::Url;

use crate::catalog::{normalize_music_text, version_signature};
use crate::db::DbPool;
use crate::external::ExternalArtworkTokenStore;

/// Milliseconds in one hour (`3,600,000 ms`).
pub const HOUR_MS: i64 = 3_600_000;
/// Milliseconds in one day (`86,400,000 ms`).
pub const DAY_MS: i64 = 24 * HOUR_MS;
/// Maximum followed artists per user (`1,000`).
pub const MAX_FOLLOWED_ARTISTS_PER_USER: i64 = 1_000;
/// Default minimum interval between release lookup requests to the same store (`3,500 ms`).
pub const DEFAULT_RELEASE_REQUEST_INTERVAL_MS: i64 = 3_500;
/// Maximum response body size for release metadata lookups (`2 MiB`).
pub const MAX_RELEASE_METADATA_BYTES: usize = 2 * 1024 * 1024;

/// Provider origin for a followed artist (`library | deezer | itunes`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FollowProvider {
    Library,
    Deezer,
    Itunes,
}

impl FollowProvider {
    /// Canonical lowercase string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Library => "library",
            Self::Deezer => "deezer",
            Self::Itunes => "itunes",
        }
    }

    /// Parses a provider string.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "library" => Some(Self::Library),
            "deezer" => Some(Self::Deezer),
            "itunes" => Some(Self::Itunes),
            _ => None,
        }
    }
}

/// Input payload for following an artist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowArtistInput {
    pub artist_id: String,
    pub artist_name: String,
    pub provider: FollowProvider,
}

/// Followed artist record returned to the client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowedArtist {
    pub key: String,
    pub artist_id: String,
    pub artist_name: String,
    pub provider: FollowProvider,
    pub followed_at: String,
    pub checked_at: Option<String>,
    pub next_scan_at: String,
    pub error: Option<String>,
}

/// Release classification (`Album | EP | Single`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReleaseAlbumType {
    Album,
    #[serde(rename = "EP")]
    Ep,
    Single,
}

/// Normalized new release item cached in `new_release_cache`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRelease {
    pub id: String,
    pub provider: String,
    pub provider_id: String,
    pub title: String,
    pub artist: String,
    pub artist_id: String,
    pub release_date: String,
    pub album_type: ReleaseAlbumType,
    pub cover_url: Option<String>,
    pub store_url: Option<String>,
    pub track_count: u32,
}

/// Paginated release feed response returned by `GET /api/v1/new-releases`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseFeedPage {
    pub releases: Vec<NewRelease>,
    pub has_more: bool,
}

/// Error returned during artist follow validation or release scanning.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ReleaseLookupError {
    pub message: String,
    pub retry_at: i64,
}

impl ReleaseLookupError {
    /// Creates a new [`ReleaseLookupError`].
    #[must_use]
    pub fn new(message: impl Into<String>, retry_at: i64) -> Self {
        Self {
            message: message.into(),
            retry_at,
        }
    }
}

/// Computes the deterministic SHA-256 `artist_key` for `(provider, artist_id)`.
#[must_use]
pub fn followed_artist_key(provider: FollowProvider, artist_id: &str) -> String {
    let serialized =
        serde_json::to_string(&json!([provider.as_str(), artist_id])).unwrap_or_default();
    let mut sha = Sha256::new();
    sha.update(serialized.as_bytes());
    format!("{:x}", sha.finalize())
}

/// Computes the deduplication `canonical_key` for a [`NewRelease`] across stores.
#[must_use]
pub fn canonical_release_key(release: &NewRelease) -> String {
    serde_json::to_string(&json!([
        normalize_music_text(Some(&release.artist)),
        normalize_music_text(Some(&release.title)),
        version_signature(Some(&release.title)),
        release.release_date,
    ]))
    .unwrap_or_default()
}

fn extract_numeric_id(value: &Value) -> Option<String> {
    if let Some(n) = value.as_u64().filter(|&n| n > 0) {
        return Some(n.to_string());
    }
    if let Some(s) = value.as_str() {
        if !s.is_empty()
            && s.len() <= 16
            && !s.starts_with('0')
            && s.chars().all(|c| c.is_ascii_digit())
        {
            return Some(s.to_owned());
        }
    }
    None
}

fn validate_numeric_str(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 16
        && !raw.starts_with('0')
        && raw.chars().all(|c| c.is_ascii_digit())
}

fn safe_domain_url(raw: Option<&str>, allowed_domains: &[&str]) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() || raw.len() > 500 {
        return None;
    }
    let parsed = Url::parse(raw).ok()?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
    {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    let allowed = allowed_domains.iter().any(|domain| {
        let d = domain.trim_start_matches('.').to_ascii_lowercase();
        host == d || host.ends_with(&format!(".{d}"))
    });
    allowed.then(|| parsed.to_string())
}

fn epoch_ms_to_iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
}

/// Service managing per-user artist follows and shared release radar caches.
#[derive(Clone)]
pub struct ArtistFollowService {
    privacy: crate::services::privacy::PrivacyManager,
    db: Option<DbPool>,
    artwork: ExternalArtworkTokenStore,
    artwork_cache: Arc<RwLock<HashMap<String, String>>>,
    http: Client,
    request_interval_ms: i64,
    runtime_gate: Option<Arc<tokio::sync::RwLock<()>>>,
    #[cfg(test)]
    store_base_url: Option<String>,
}

impl std::fmt::Debug for ArtistFollowService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArtistFollowService")
            .field("request_interval_ms", &self.request_interval_ms)
            .finish()
    }
}

impl ArtistFollowService {
    /// Creates a new [`ArtistFollowService`].
    #[must_use]
    pub fn new(db: Option<DbPool>, artwork: ExternalArtworkTokenStore) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_millis(8_000))
            .redirect(Policy::none())
            .build()
            .unwrap_or_default();
        Self {
            db,
            artwork,
            artwork_cache: Arc::new(RwLock::new(HashMap::new())),
            http,
            request_interval_ms: DEFAULT_RELEASE_REQUEST_INTERVAL_MS,
            runtime_gate: None,
            privacy: crate::services::privacy::PrivacyManager::default(),
            #[cfg(test)]
            store_base_url: None,
        }
    }

    #[must_use]
    pub fn with_privacy(mut self, privacy: crate::services::privacy::PrivacyManager) -> Self {
        self.privacy = privacy;
        self
    }

    pub(crate) fn with_runtime_gate(mut self, gate: Arc<tokio::sync::RwLock<()>>) -> Self {
        self.runtime_gate = Some(gate);
        self
    }

    fn now_ms() -> i64 {
        Utc::now().timestamp_millis()
    }

    fn require_db(&self) -> Result<&DbPool, ReleaseLookupError> {
        self.db
            .as_ref()
            .ok_or_else(|| ReleaseLookupError::new("Database is unavailable.", 0))
    }

    fn resolve_artwork_url(&self, raw_url: Option<&str>) -> Option<String> {
        let url = raw_url?;
        if let Ok(guard) = self.artwork_cache.read() {
            if let Some(prev_token) = guard.get(url) {
                if self.artwork.resolve(prev_token).is_some() {
                    return Some(format!(
                        "/api/artwork/external/{}",
                        urlencoding::encode(prev_token)
                    ));
                }
            }
        }

        let token = self
            .artwork
            .mint_token(Some(url), &[".mzstatic.com", ".dzcdn.net"])?;
        if let Ok(mut guard) = self.artwork_cache.write() {
            if guard.len() >= 1_000 {
                if let Some(first_key) = guard.keys().next().cloned() {
                    guard.remove(&first_key);
                }
            }
            guard.insert(url.to_owned(), token.clone());
        }
        Some(format!(
            "/api/artwork/external/{}",
            urlencoding::encode(&token)
        ))
    }

    /// Follows an artist for `user_id`, enforcing the 1,000-artist cap and normalizing external IDs.
    pub async fn follow(
        &self,
        user_id: &str,
        mut input: FollowArtistInput,
    ) -> Result<FollowedArtist, ReleaseLookupError> {
        input.artist_id = input.artist_id.trim().to_owned();
        input.artist_name = input.artist_name.trim().to_owned();
        if input.artist_id.is_empty()
            || input.artist_id.len() > 500
            || input.artist_name.is_empty()
            || input.artist_name.len() > 300
        {
            return Err(ReleaseLookupError::new(
                "Choose an artist with a valid name and provider ID.",
                0,
            ));
        }

        let prefix = format!("external_{}_artist_", input.provider.as_str());
        let external_id = input
            .artist_id
            .strip_prefix(&prefix)
            .unwrap_or(&input.artist_id)
            .to_owned();

        if input.provider != FollowProvider::Library {
            if !validate_numeric_str(&external_id) {
                return Err(ReleaseLookupError::new(
                    "Choose a valid artist from discovery search.",
                    0,
                ));
            }
            input.artist_id = format!("external_{}_artist_{external_id}", input.provider.as_str());
        }

        let key = followed_artist_key(input.provider, &input.artist_id);
        let pool = self.require_db()?;
        let mut tx = pool
            .inner()
            .begin()
            .await
            .map_err(|_| ReleaseLookupError::new("Could not save followed artist.", 0))?;

        let count_row = sqlx::query("SELECT COUNT(*) AS n FROM followed_artists WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| ReleaseLookupError::new("Could not check followed artists.", 0))?;
        let count: i64 = count_row.try_get("n").unwrap_or(0);

        let already_exists =
            sqlx::query("SELECT 1 FROM followed_artists WHERE user_id = ? AND artist_key = ?")
                .bind(user_id)
                .bind(&key)
                .fetch_optional(&mut *tx)
                .await
                .ok()
                .flatten()
                .is_some();

        if count >= MAX_FOLLOWED_ARTISTS_PER_USER && !already_exists {
            return Err(ReleaseLookupError::new(
                "You can follow up to 1,000 artists. Unfollow an artist before adding another.",
                0,
            ));
        }

        let resolved_id = (input.provider != FollowProvider::Library).then_some(external_id);
        sqlx::query(
            r"
            INSERT INTO followed_artist_catalog (
                artist_key, artist_id, artist_name, provider, resolved_id
            )
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(artist_key) DO NOTHING
            ",
        )
        .bind(&key)
        .bind(&input.artist_id)
        .bind(&input.artist_name)
        .bind(input.provider.as_str())
        .bind(resolved_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| ReleaseLookupError::new("Could not save artist catalog entry.", 0))?;

        let followed_at = epoch_ms_to_iso(Self::now_ms());
        sqlx::query(
            r"
            INSERT OR IGNORE INTO followed_artists (user_id, artist_key, followed_at)
            VALUES (?, ?, ?)
            ",
        )
        .bind(user_id)
        .bind(&key)
        .bind(&followed_at)
        .execute(&mut *tx)
        .await
        .map_err(|_| ReleaseLookupError::new("Could not save followed artist.", 0))?;

        tx.commit()
            .await
            .map_err(|_| ReleaseLookupError::new("Could not commit followed artist.", 0))?;

        let list = self.list(user_id).await;
        list.into_iter()
            .find(|item| item.key == key)
            .ok_or_else(|| ReleaseLookupError::new("Followed artist was not found.", 0))
    }

    /// Unfollows `key` for `user_id`.
    pub async fn unfollow(&self, user_id: &str, key: &str) {
        if let Some(pool) = &self.db {
            let _ =
                sqlx::query("DELETE FROM followed_artists WHERE user_id = ? AND artist_key = ?")
                    .bind(user_id)
                    .bind(key)
                    .execute(pool.inner())
                    .await;
        }
    }

    /// Returns `true` if any user follows at least one artist.
    pub async fn has_followers(&self) -> bool {
        let Some(pool) = &self.db else {
            return false;
        };
        sqlx::query("SELECT 1 FROM followed_artists LIMIT 1")
            .fetch_optional(pool.inner())
            .await
            .ok()
            .flatten()
            .is_some()
    }

    /// Lists all artists followed by `user_id` ordered case-insensitively by artist name.
    pub async fn list(&self, user_id: &str) -> Vec<FollowedArtist> {
        let Some(pool) = &self.db else {
            return Vec::new();
        };
        let rows = sqlx::query(
            r"
            SELECT c.*, f.followed_at
            FROM followed_artists f
            JOIN followed_artist_catalog c ON c.artist_key = f.artist_key
            WHERE f.user_id = ?
            ORDER BY c.artist_name COLLATE NOCASE, c.artist_key
            ",
        )
        .bind(user_id)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        rows.into_iter()
            .filter_map(|row| {
                let provider_str: String = row.try_get("provider").ok()?;
                let provider = FollowProvider::parse(&provider_str)?;
                let checked_at_ms: Option<i64> = row.try_get("checked_at").ok();
                let next_scan_at_ms: i64 = row.try_get("next_scan_at").unwrap_or(0);

                Some(FollowedArtist {
                    key: row.try_get("artist_key").ok()?,
                    artist_id: row.try_get("artist_id").ok()?,
                    artist_name: row.try_get("artist_name").ok()?,
                    provider,
                    followed_at: row.try_get("followed_at").unwrap_or_default(),
                    checked_at: checked_at_ms.map(epoch_ms_to_iso),
                    next_scan_at: epoch_ms_to_iso(next_scan_at_ms),
                    error: row.try_get("last_error").ok(),
                })
            })
            .collect()
    }

    /// Returns the paginated 30-day new-release feed for `user_id`, deduplicating store editions by `canonical_key`.
    pub async fn feed(&self, user_id: &str, offset: usize, limit: usize) -> ReleaseFeedPage {
        let Some(pool) = &self.db else {
            return ReleaseFeedPage {
                releases: Vec::new(),
                has_more: false,
            };
        };

        let clamped_limit = limit.clamp(1, 60);
        let now_ms = Self::now_ms();
        let since_date = epoch_ms_to_iso(now_ms - 30 * DAY_MS)
            .chars()
            .take(10)
            .collect::<String>();
        let today_date = epoch_ms_to_iso(now_ms).chars().take(10).collect::<String>();

        let rows = sqlx::query(
            r"
            SELECT MIN(r.data_json) AS data_json
            FROM new_release_cache r
            WHERE r.release_date BETWEEN ? AND ?
              AND EXISTS (
                  SELECT 1 FROM followed_artists f
                  WHERE f.artist_key = r.artist_key AND f.user_id = ?
              )
            GROUP BY r.canonical_key
            ORDER BY r.release_date DESC, r.canonical_key
            LIMIT ? OFFSET ?
            ",
        )
        .bind(&since_date)
        .bind(&today_date)
        .bind(user_id)
        .bind((clamped_limit + 1) as i64)
        .bind(offset as i64)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        let has_more = rows.len() > clamped_limit;
        let mut releases = Vec::new();
        for row in rows.into_iter().take(clamped_limit) {
            let Ok(data_json) = row.try_get::<String, _>("data_json") else {
                continue;
            };
            if let Ok(mut release) = serde_json::from_str::<NewRelease>(&data_json) {
                release.cover_url = self.resolve_artwork_url(release.cover_url.as_deref());
                releases.push(release);
            }
        }

        ReleaseFeedPage { releases, has_more }
    }

    /// Authorizes against `user_id`'s current follows before returning a cached [`NewRelease`].
    pub async fn release_for_user(&self, user_id: &str, release_id: &str) -> Option<NewRelease> {
        let pool = self.db.as_ref()?;
        let row = sqlx::query(
            r"
            SELECT r.data_json
            FROM new_release_cache r
            JOIN followed_artists f ON f.artist_key = r.artist_key
            WHERE f.user_id = ? AND r.release_id = ?
            LIMIT 1
            ",
        )
        .bind(user_id)
        .bind(release_id)
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()?;

        let data_json: String = row.try_get("data_json").ok()?;
        serde_json::from_str::<NewRelease>(&data_json).ok()
    }

    async fn throttled_store_request(
        &self,
        store: &str,
        path: &str,
        params: &[(&str, String)],
    ) -> Result<Value, ReleaseLookupError> {
        self.privacy
            .run_external(
                crate::services::privacy::PrivacyCategory::Metadata,
                self.throttled_store_request_inner(store, path, params),
            )
            .await
            .map_err(|err| ReleaseLookupError::new(err.to_string(), 0))?
    }

    async fn throttled_store_request_inner(
        &self,
        store: &str,
        path: &str,
        params: &[(&str, String)],
    ) -> Result<Value, ReleaseLookupError> {
        let pool = self.require_db()?;
        let slot_ms = {
            let mut tx = pool
                .inner()
                .begin()
                .await
                .map_err(|_| ReleaseLookupError::new("Database error", 0))?;
            let now = Self::now_ms();
            let next_req: i64 = sqlx::query(
                "SELECT next_request_at FROM release_provider_throttle WHERE provider = ?",
            )
            .bind(store)
            .fetch_optional(&mut *tx)
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get("next_request_at").ok())
            .unwrap_or(0);

            let at = now.max(next_req);
            if at - now > 30_000 {
                return Err(ReleaseLookupError::new(
                    format!("{store} is cooling down; the scanner will retry automatically."),
                    at,
                ));
            }

            sqlx::query(
                r"
                INSERT INTO release_provider_throttle (provider, next_request_at)
                VALUES (?, ?)
                ON CONFLICT(provider) DO UPDATE SET next_request_at = excluded.next_request_at
                ",
            )
            .bind(store)
            .bind(at + self.request_interval_ms)
            .execute(&mut *tx)
            .await
            .ok();

            tx.commit().await.ok();
            at
        };

        let now = Self::now_ms();
        if slot_ms > now {
            tokio::time::sleep(Duration::from_millis((slot_ms - now) as u64)).await;
        }

        let base = if store == "itunes" {
            "https://itunes.apple.com/"
        } else {
            "https://api.deezer.com/"
        };
        #[cfg(test)]
        let base = self.store_base_url.as_deref().unwrap_or(base);
        let mut url = Url::parse(base)
            .and_then(|b| b.join(path))
            .map_err(|_| ReleaseLookupError::new("Invalid store URL", 0))?;
        {
            let mut qp = url.query_pairs_mut();
            for (k, v) in params {
                qp.append_pair(k, v);
            }
        }

        let resp =
            self.http.get(url.as_str()).send().await.map_err(|_| {
                ReleaseLookupError::new(format!("{store} metadata lookup failed."), 0)
            })?;

        let status = resp.status();
        if status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::SERVICE_UNAVAILABLE {
            let now = Self::now_ms();
            let retry_after_secs = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<i64>().ok())
                .unwrap_or(60);
            let retry_at = now + (retry_after_secs * 1000).clamp(60_000, DAY_MS);
            let _ = sqlx::query(
                "UPDATE release_provider_throttle SET next_request_at = MAX(next_request_at, ?) WHERE provider = ?",
            )
            .bind(retry_at)
            .bind(store)
            .execute(pool.inner())
            .await;

            return Err(ReleaseLookupError::new(
                format!("{store} is temporarily unavailable; cached releases are still available."),
                retry_at,
            ));
        }

        if !status.is_success() {
            return Err(ReleaseLookupError::new(
                format!("{store} metadata lookup failed (HTTP {}).", status.as_u16()),
                0,
            ));
        }

        let mut buffer = Vec::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk_res) = stream.next().await {
            let chunk = chunk_res.map_err(|_| {
                ReleaseLookupError::new(format!("{store} returned an unreadable stream."), 0)
            })?;
            if buffer.len().saturating_add(chunk.len()) > MAX_RELEASE_METADATA_BYTES {
                return Err(ReleaseLookupError::new(
                    "Metadata response exceeded the safe size limit.",
                    0,
                ));
            }
            buffer.extend_from_slice(&chunk);
        }

        let body: Value = serde_json::from_slice(&buffer).map_err(|_| {
            ReleaseLookupError::new(format!("{store} returned invalid metadata."), 0)
        })?;
        if !body.is_object() {
            return Err(ReleaseLookupError::new(
                format!("{store} returned invalid metadata."),
                0,
            ));
        }

        if let Some(err_val) = body.get("error").filter(|v| !v.is_null()) {
            let code = err_val.get("code").and_then(Value::as_i64);
            if store == "deezer" && code == Some(4) {
                let retry_at = Self::now_ms() + 60_000;
                let _ = sqlx::query(
                    "UPDATE release_provider_throttle SET next_request_at = MAX(next_request_at, ?) WHERE provider = ?",
                )
                .bind(retry_at)
                .bind(store)
                .execute(pool.inner())
                .await;
                return Err(ReleaseLookupError::new(
                    "deezer rejected the metadata lookup due to its quota; it will be retried automatically.",
                    retry_at,
                ));
            }
            return Err(ReleaseLookupError::new(
                format!("{store} rejected the metadata lookup; it will be retried automatically."),
                0,
            ));
        }

        Ok(body)
    }

    /// Scans up to 100 followed artists due for a release check (`next_scan_at <= now` and `lease_until <= now`),
    /// updating `new_release_cache` and pruning entries older than 45 days.
    pub async fn scan_due_artists(&self) -> (usize, usize) {
        let _generation = match &self.runtime_gate {
            Some(gate) => Some(gate.read().await),
            None => None,
        };
        let Ok(scan_permit) = self
            .privacy
            .outbound_permit(crate::services::privacy::PrivacyCategory::Metadata)
        else {
            return (0, 0);
        };
        let Some(pool) = &self.db else {
            return (0, 0);
        };
        let now = Self::now_ms();
        let rows = sqlx::query(
            r"
            SELECT * FROM followed_artist_catalog c
            WHERE next_scan_at <= ? AND lease_until <= ?
              AND EXISTS (
                  SELECT 1 FROM followed_artists f WHERE f.artist_key = c.artist_key
              )
            ORDER BY next_scan_at, artist_key
            LIMIT 100
            ",
        )
        .bind(now)
        .bind(now)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        let mut processed = 0_usize;
        let mut failures = 0_usize;

        for row in rows {
            if scan_permit.is_cancelled() {
                break;
            }
            let Ok(artist_key) = row.try_get::<String, _>("artist_key") else {
                continue;
            };
            let artist_name: String = row.try_get("artist_name").unwrap_or_default();
            let provider_str: String = row.try_get("provider").unwrap_or_default();
            let resolved_id: Option<String> = row.try_get("resolved_id").ok();
            let fail_count: i64 = row.try_get("failures").unwrap_or(0);

            let claim_now = Self::now_ms();
            let lease = claim_now + 5 * 60_000;
            let claimed = sqlx::query(
                r"
                UPDATE followed_artist_catalog
                SET lease_until = ?
                WHERE artist_key = ? AND lease_until <= ? AND next_scan_at <= ?
                ",
            )
            .bind(lease)
            .bind(&artist_key)
            .bind(claim_now)
            .bind(claim_now)
            .execute(pool.inner())
            .await
            .ok()
            .map_or(0, |r| r.rows_affected());

            if claimed == 0 {
                continue;
            }

            let lookup_res = tokio::select! {
                biased;
                () = scan_permit.cancelled() => Err(ReleaseLookupError::new("Release scan cancelled by privacy policy", 0)),
                result = self.fetch_artist_releases(&artist_key, &artist_name, &provider_str, resolved_id) => result,
            };

            if scan_permit.is_cancelled() {
                let _ = sqlx::query("UPDATE followed_artist_catalog SET lease_until = 0 WHERE artist_key = ? AND lease_until = ?")
                    .bind(&artist_key).bind(lease).execute(pool.inner()).await;
                break;
            }
            match lookup_res {
                Ok(found) => {
                    let finish_now = Self::now_ms();
                    if let Ok(mut tx) = pool.inner().begin().await {
                        let still_owned = sqlx::query(
                            "SELECT 1 FROM followed_artist_catalog WHERE artist_key = ? AND lease_until = ?",
                        )
                        .bind(&artist_key)
                        .bind(lease)
                        .fetch_optional(&mut *tx)
                        .await
                        .ok()
                        .flatten()
                        .is_some();

                        if still_owned {
                            for rel in found {
                                let c_key = canonical_release_key(&rel);
                                let data_json = serde_json::to_string(&rel)
                                    .unwrap_or_else(|_| String::from("{}"));
                                let _ = sqlx::query(
                                    r"
                                    INSERT INTO new_release_cache (
                                        artist_key, release_id, canonical_key, release_date, data_json, cached_at
                                    )
                                    VALUES (?, ?, ?, ?, ?, ?)
                                    ON CONFLICT(artist_key, release_id) DO UPDATE SET
                                        canonical_key = excluded.canonical_key,
                                        release_date = excluded.release_date,
                                        data_json = excluded.data_json,
                                        cached_at = excluded.cached_at
                                    ",
                                )
                                .bind(&artist_key)
                                .bind(&rel.id)
                                .bind(c_key)
                                .bind(&rel.release_date)
                                .bind(data_json)
                                .bind(finish_now)
                                .execute(&mut *tx)
                                .await;
                            }

                            let _ = sqlx::query(
                                r"
                                UPDATE followed_artist_catalog
                                SET checked_at = ?,
                                    next_scan_at = ?,
                                    failures = 0,
                                    last_error = NULL
                                WHERE artist_key = ? AND lease_until = ?
                                ",
                            )
                            .bind(finish_now)
                            .bind(finish_now + 6 * HOUR_MS)
                            .bind(&artist_key)
                            .bind(lease)
                            .execute(&mut *tx)
                            .await;
                        }
                        let _ = tx.commit().await;
                    }
                }
                Err(err) => {
                    failures += 1;
                    let fail_now = Self::now_ms();
                    let backoff =
                        (15 * 60_000_i64 * 2_i64.pow(fail_count.clamp(0, 7) as u32)).min(DAY_MS);
                    let next_scan = (fail_now + backoff).max(err.retry_at);
                    let _ = sqlx::query(
                        r"
                        UPDATE followed_artist_catalog
                        SET failures = failures + 1,
                            next_scan_at = ?,
                            last_error = ?
                        WHERE artist_key = ? AND lease_until = ?
                        ",
                    )
                    .bind(next_scan)
                    .bind(&err.message)
                    .bind(&artist_key)
                    .bind(lease)
                    .execute(pool.inner())
                    .await;
                }
            }

            let _ = sqlx::query(
                "UPDATE followed_artist_catalog SET lease_until = 0 WHERE artist_key = ? AND lease_until = ?",
            )
            .bind(&artist_key)
            .bind(lease)
            .execute(pool.inner())
            .await;

            processed += 1;
        }

        let prune_now = Self::now_ms();
        let cutoff_date = epoch_ms_to_iso(prune_now - 45 * DAY_MS)
            .chars()
            .take(10)
            .collect::<String>();
        let _ = sqlx::query("DELETE FROM new_release_cache WHERE release_date < ?")
            .bind(cutoff_date)
            .execute(pool.inner())
            .await;
        let _ = sqlx::query(
            r"
            DELETE FROM followed_artist_catalog
            WHERE NOT EXISTS (
                SELECT 1 FROM followed_artists f
                WHERE f.artist_key = followed_artist_catalog.artist_key
            )
              AND lease_until = 0
              AND COALESCE(checked_at, 0) < ?
            ",
        )
        .bind(prune_now - 45 * DAY_MS)
        .execute(pool.inner())
        .await;

        (processed, failures)
    }

    async fn fetch_artist_releases(
        &self,
        artist_key: &str,
        artist_name: &str,
        provider_str: &str,
        resolved_id: Option<String>,
    ) -> Result<Vec<NewRelease>, ReleaseLookupError> {
        let store = if provider_str == "deezer" {
            "deezer"
        } else {
            "itunes"
        };

        let mut id = resolved_id;
        if id.is_none() {
            let body = self
                .throttled_store_request(
                    "itunes",
                    "search",
                    &[
                        ("term", artist_name.to_owned()),
                        ("media", String::from("music")),
                        ("entity", String::from("musicArtist")),
                        ("limit", String::from("50")),
                        ("country", String::from("US")),
                    ],
                )
                .await?;

            let results = body
                .get("results")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ReleaseLookupError::new(
                        "The metadata provider returned an invalid release list.",
                        0,
                    )
                })?;

            let norm_target = normalize_music_text(Some(artist_name));
            let matches: HashSet<String> = results
                .iter()
                .filter(|item| {
                    normalize_music_text(item.get("artistName").and_then(Value::as_str))
                        == norm_target
                })
                .filter_map(|item| item.get("artistId").and_then(extract_numeric_id))
                .collect();

            if matches.len() != 1 {
                return Err(ReleaseLookupError::new(
                    "Artist identity is ambiguous or unavailable. Follow the specific iTunes or Deezer artist from discovery search instead.",
                    0,
                ));
            }
            let matched_id = matches.into_iter().next().unwrap_or_default();
            if let Some(pool) = &self.db {
                let _ = sqlx::query(
                    "UPDATE followed_artist_catalog SET resolved_id = ? WHERE artist_key = ?",
                )
                .bind(&matched_id)
                .bind(artist_key)
                .execute(pool.inner())
                .await;
            }
            id = Some(matched_id);
        }

        let id = id.unwrap_or_default();
        let mut display_artist = artist_name.to_owned();

        if store == "deezer" {
            let artist_body = self
                .throttled_store_request("deezer", &format!("artist/{id}"), &[])
                .await?;
            let returned_id = artist_body.get("id").and_then(extract_numeric_id);
            let returned_name = artist_body
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let (Some(ret_id), Some(ret_name)) = (returned_id, returned_name) else {
                return Err(ReleaseLookupError::new(
                    "The followed artist is no longer available on Deezer.",
                    0,
                ));
            };
            if ret_id != id {
                return Err(ReleaseLookupError::new(
                    "The followed artist is no longer available on Deezer.",
                    0,
                ));
            }
            display_artist = ret_name.to_owned();
        }

        let mut items = Vec::new();
        let max_pages = if store == "deezer" { 3 } else { 1 };
        for page in 0..max_pages {
            let body = if store == "itunes" {
                self.throttled_store_request(
                    "itunes",
                    "lookup",
                    &[
                        ("id", id.clone()),
                        ("entity", String::from("album")),
                        ("limit", String::from("200")),
                        ("sort", String::from("recent")),
                        ("country", String::from("US")),
                    ],
                )
                .await?
            } else {
                self.throttled_store_request(
                    "deezer",
                    &format!("artist/{id}/albums"),
                    &[
                        ("limit", String::from("100")),
                        ("index", (page * 100).to_string()),
                    ],
                )
                .await?
            };

            let field = if store == "itunes" { "results" } else { "data" };
            let batch = body.get(field).and_then(Value::as_array).ok_or_else(|| {
                ReleaseLookupError::new(
                    "The metadata provider returned an invalid release list.",
                    0,
                )
            })?;
            let batch_len = batch.len();
            items.extend(batch.iter().cloned());
            if store == "itunes" || body.get("next").is_none() || batch_len < 100 {
                break;
            }
        }

        let now_ms = Self::now_ms();
        let since_date = epoch_ms_to_iso(now_ms - 30 * DAY_MS)
            .chars()
            .take(10)
            .collect::<String>();
        let today_date = epoch_ms_to_iso(now_ms).chars().take(10).collect::<String>();

        let mut releases = HashMap::new();
        for item in items {
            let release_id = if store == "itunes" {
                item.get("collectionId").and_then(extract_numeric_id)
            } else {
                item.get("id").and_then(extract_numeric_id)
            };
            let Some(release_id) = release_id else {
                continue;
            };

            if store == "itunes" {
                let is_collection =
                    item.get("wrapperType").and_then(Value::as_str) == Some("collection");
                let same_artist = item.get("artistId").and_then(extract_numeric_id).as_deref()
                    == Some(id.as_str());
                if !is_collection || !same_artist {
                    continue;
                }
            }

            let raw_date = if store == "itunes" {
                item.get("releaseDate").and_then(Value::as_str)
            } else {
                item.get("release_date").and_then(Value::as_str)
            };
            let date: String = raw_date.unwrap_or_default().chars().take(10).collect();
            if date.len() != 10 || date < since_date || date > today_date {
                continue;
            }

            let title = if store == "itunes" {
                item.get("collectionName").and_then(Value::as_str)
            } else {
                item.get("title").and_then(Value::as_str)
            }
            .map(str::trim)
            .filter(|s| !s.is_empty());
            let Some(title) = title else {
                continue;
            };

            let track_count = item
                .get("trackCount")
                .or_else(|| item.get("nb_tracks"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32;

            let record_type = item
                .get("record_type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let lower_title = title.to_ascii_lowercase();
            let album_type = if record_type == "single" || lower_title.ends_with(" - single") {
                ReleaseAlbumType::Single
            } else if record_type == "ep" || lower_title.ends_with(" - ep") {
                ReleaseAlbumType::Ep
            } else {
                ReleaseAlbumType::Album
            };

            let cover_url = if store == "itunes" {
                safe_domain_url(
                    item.get("artworkUrl100").and_then(Value::as_str),
                    &["mzstatic.com"],
                )
            } else {
                safe_domain_url(
                    item.get("cover_big")
                        .or_else(|| item.get("cover_medium"))
                        .and_then(Value::as_str),
                    &["dzcdn.net"],
                )
            };

            let store_url = if store == "itunes" {
                safe_domain_url(
                    item.get("collectionViewUrl").and_then(Value::as_str),
                    &["music.apple.com", "itunes.apple.com"],
                )
                .or_else(|| Some(format!("https://music.apple.com/us/album/{release_id}")))
            } else {
                safe_domain_url(item.get("link").and_then(Value::as_str), &["deezer.com"])
                    .or_else(|| Some(format!("https://www.deezer.com/album/{release_id}")))
            };

            let rel_id = format!("external_{store}_album_{release_id}");
            releases.insert(
                rel_id.clone(),
                NewRelease {
                    id: rel_id,
                    provider: store.to_owned(),
                    provider_id: release_id,
                    title: title.to_owned(),
                    artist: if store == "itunes" {
                        item.get("artistName")
                            .and_then(Value::as_str)
                            .unwrap_or(&display_artist)
                            .to_owned()
                    } else {
                        display_artist.clone()
                    },
                    artist_id: format!("external_{store}_artist_{id}"),
                    release_date: date,
                    album_type,
                    cover_url,
                    store_url,
                    track_count,
                },
            );
        }

        Ok(releases.into_values().collect())
    }
}

#[cfg(test)]
mod privacy_tests;
