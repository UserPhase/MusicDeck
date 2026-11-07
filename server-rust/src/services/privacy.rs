//! # Enterprise Privacy Governance & Outbound Policy Engine (`services::privacy`)
//!
//! Complete Rust port of `server/src/services/PrivacyManager.ts`.
//!
//! ## Core Architecture & Guarantees
//! 1. **Four-Domain Outbound Classification ([`PrivacyCategory`])**:
//!    - `Metadata`: External catalog search, lyrics, and discovery APIs (MusicBrainz, Deezer, iTunes).
//!    - `Imports`: Spotify playlist imports and on-demand downloader acquisitions (`spotdl`, `yt-dlp`).
//!    - `Artwork`: External cover art CDNs (`scdn.co`, `mzstatic.com`, `coverartarchive.org`, etc.).
//!    - `External`: Third-party scrobblers (`last.fm`, `audioscrobbler.com`, `listenbrainz.org`)
//!      and general external plugin webhooks.
//! 2. **Environment Lock Precedence (`LOCAL_ONLY_MODE`)**:
//!    - When `config.network.local_only_mode == true`, `enforced_by_environment` is locked to `true`
//!      and all four effective categories evaluate to `false` (`LOCAL_ONLY_MODE_ACTIVE`),
//!      regardless of database settings.
//! 3. **Cooperative In-Flight Cancellation**:
//!    - Every long-running external request or scrobble worker subscribes to a `tokio::sync::watch`
//!      channel on [`PrivacyManager`]. When an administrator tightens the privacy policy via
//!      `PATCH /api/v1/privacy`, any in-flight operation whose [`PrivacyCategory`] is no longer
//!      allowed is immediately notified and aborted.
//! 4. **Self-Hosted Media Backend Exemption**:
//!    - Requests targeting the operator's configured Navidrome or Jellyfin URLs are recognized
//!      as internal library traffic via [`PrivacyManager::is_library_url`] and are never blocked
//!      by external privacy restrictions.

use std::future::Future;
use std::sync::{Arc, RwLock as SyncRwLock};
use tokio_util::sync::CancellationToken;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use thiserror::Error;
use tokio::sync::{RwLock, watch};
use url::Url;

use crate::config::{AppConfig, MusicBackendKind};
use crate::db::DbPool;

/// SQLite `server_settings` key storing the persisted JSON privacy policy.
pub const PRIVACY_POLICY_SETTING_KEY: &str = "privacy.policy";

/// Outbound integration category governed by [`PrivacyManager`].
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrivacyCategory {
    /// External catalog metadata, search, and discovery APIs.
    Metadata,
    /// External downloader and playlist import pipelines.
    Imports,
    /// External album/artist artwork CDNs.
    Artwork,
    /// Scrobbling (`Last.fm`, `ListenBrainz`) and general external integrations.
    #[default]
    External,
}

/// Type alias for [`PrivacyCategory`].
pub type ExternalCategory = PrivacyCategory;

/// Persisted administrator privacy toggles (`server_settings.key = 'privacy.policy'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivacySettings {
    /// Master toggle disabling all external network traffic when `true`.
    pub local_only: bool,
    /// Permits external catalog/metadata queries when `local_only` is `false`.
    pub allow_metadata: bool,
    /// Permits external downloads/imports (requires `allow_metadata` and `allow_artwork` too).
    pub allow_imports: bool,
    /// Permits fetching external cover art when `local_only` is `false`.
    pub allow_artwork: bool,
}

impl Default for PrivacySettings {
    fn default() -> Self {
        Self {
            local_only: false,
            allow_metadata: true,
            allow_imports: true,
            allow_artwork: true,
        }
    }
}

/// Computed effective permission state across all four [`PrivacyCategory`] domains.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectivePrivacyPermissions {
    /// Effective state for `PrivacyCategory::Metadata`.
    pub metadata: bool,
    /// Effective state for `PrivacyCategory::Imports`.
    pub imports: bool,
    /// Effective state for `PrivacyCategory::Artwork`.
    pub artwork: bool,
    /// Effective state for `PrivacyCategory::External` (scrobbling & third-party plugins).
    pub external: bool,
}

/// Full privacy policy snapshot returned by `GET /api/v1/privacy` and `PATCH /api/v1/privacy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacySnapshot {
    /// Stored `localOnly` flag.
    pub local_only: bool,
    /// Stored `allowMetadata` flag.
    pub allow_metadata: bool,
    /// Stored `allowImports` flag.
    pub allow_imports: bool,
    /// Stored `allowArtwork` flag.
    pub allow_artwork: bool,
    /// `true` when `LOCAL_ONLY_MODE=true` is enforced by the process environment.
    pub enforced_by_environment: bool,
    /// Resolved effective permissions per category.
    pub effective: EffectivePrivacyPermissions,
}

/// Machine-readable rejection code when an outbound request is blocked by [`PrivacyManager`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PrivacyBlockCode {
    /// Blocked because `LOCAL_ONLY_MODE` or `localOnly` is active.
    #[serde(rename = "LOCAL_ONLY_MODE_ACTIVE")]
    LocalOnlyModeActive,
    /// Blocked because the specific category toggle (`allowMetadata`, `allowImports`, `allowArtwork`) is disabled.
    #[serde(rename = "EXTERNAL_INTEGRATION_DISABLED")]
    ExternalIntegrationDisabled,
}

impl PrivacyBlockCode {
    /// Returns the wire-format error code string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LocalOnlyModeActive => "LOCAL_ONLY_MODE_ACTIVE",
            Self::ExternalIntegrationDisabled => "EXTERNAL_INTEGRATION_DISABLED",
        }
    }

    /// Returns the human-readable error message matching `PrivacyBlockedError` in TypeScript.
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::LocalOnlyModeActive => "Local Only Mode Active",
            Self::ExternalIntegrationDisabled => {
                "External integration disabled by server privacy policy"
            }
        }
    }
}

/// Error returned when an operation or outbound URL violates the active privacy policy.
#[derive(Debug, Clone, Error)]
pub enum PrivacyError {
    /// Operation blocked by `LOCAL_ONLY_MODE` or category policy (`HTTP 403 Forbidden`).
    #[error("{}", .0.message())]
    Blocked(PrivacyBlockCode),

    /// Stored `privacy.policy` JSON in SQLite was corrupted or invalid.
    #[error("Invalid stored privacy policy; refusing to start: {0}")]
    CorruptStoredPolicy(String),

    /// Outbound URL was malformed or used a non-HTTP(S) scheme.
    #[error("Unsupported or invalid outbound URL: {0}")]
    InvalidOutboundUrl(String),

    /// Underlying SQLite failure.
    #[error("Privacy database error: {0}")]
    Database(String),

    /// Runtime configuration update could not complete.
    #[error("Privacy configuration update failed: {0}")]
    Configuration(String),
}

impl PrivacyError {
    /// Constructs a [`PrivacyError::Blocked`] with the appropriate [`PrivacyBlockCode`].
    #[must_use]
    pub const fn blocked(local_only_active: bool) -> Self {
        if local_only_active {
            Self::Blocked(PrivacyBlockCode::LocalOnlyModeActive)
        } else {
            Self::Blocked(PrivacyBlockCode::ExternalIntegrationDisabled)
        }
    }
}

/// Thread-safe privacy governance manager shared across request handlers, scrobblers,
/// and outbound HTTP adapters.
#[derive(Debug, Clone)]
pub struct PrivacyManager {
    db: Option<DbPool>,
    runtime: Arc<SyncRwLock<PrivacyRuntime>>,
    settings: Arc<RwLock<PrivacySettings>>,
    policy_tx: watch::Sender<PrivacySnapshot>,
}

#[derive(Debug)]
struct PrivacyRuntime {
    stored: PrivacySnapshot,
    snapshot: PrivacySnapshot,
    library_urls: Vec<Url>,
    suspended: bool,
    permits: [CancellationToken; 4],
}

impl PrivacyRuntime {
    fn publish(&mut self, tx: &watch::Sender<PrivacySnapshot>) -> PrivacySnapshot {
        let mut next = self.stored;
        if self.suspended {
            next.effective = EffectivePrivacyPermissions {
                metadata: false,
                imports: false,
                artwork: false,
                external: false,
            };
        }
        for (index, allowed) in [
            next.effective.metadata,
            next.effective.imports,
            next.effective.artwork,
            next.effective.external,
        ]
        .into_iter()
        .enumerate()
        {
            if !allowed {
                self.permits[index].cancel();
            } else if self.permits[index].is_cancelled() {
                self.permits[index] = CancellationToken::new();
            }
        }
        self.snapshot = next;
        tx.send_replace(next);
        next
    }
}

impl Default for PrivacyManager {
    fn default() -> Self {
        Self::new_in_memory(false, Vec::new(), PrivacySettings::default())
    }
}

impl PrivacyManager {
    /// Creates an in-memory [`PrivacyManager`] without a backing SQLite pool (useful for unit tests).
    #[must_use]
    pub fn new_in_memory(
        environment_lock: bool,
        library_urls: Vec<Url>,
        initial_settings: PrivacySettings,
    ) -> Self {
        let initial_snapshot = compute_snapshot(initial_settings, environment_lock);
        let (policy_tx, _) = watch::channel(initial_snapshot);
        Self {
            db: None,
            runtime: Arc::new(SyncRwLock::new(PrivacyRuntime {
                stored: initial_snapshot,
                snapshot: initial_snapshot,
                library_urls,
                suspended: false,
                permits: std::array::from_fn(|_| CancellationToken::new()),
            })),
            settings: Arc::new(RwLock::new(initial_settings)),
            policy_tx,
        }
    }

    /// Initializes a SQLite-backed [`PrivacyManager`], loading any persisted `privacy.policy`
    /// from `server_settings` and resolving configured Navidrome/Jellyfin library origins.
    pub async fn from_database(db: DbPool, config: &AppConfig) -> Result<Self, PrivacyError> {
        let mut transaction = db
            .inner()
            .begin()
            .await
            .map_err(|err| PrivacyError::Database(err.to_string()))?;
        let library_urls = load_library_urls(&mut transaction, config).await?;
        let row = sqlx::query("SELECT value FROM server_settings WHERE key = ?;")
            .bind(PRIVACY_POLICY_SETTING_KEY)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|err| PrivacyError::Database(err.to_string()))?;

        let initial_settings = if let Some(row) = row {
            let raw_json: String = row
                .try_get("value")
                .map_err(|err| PrivacyError::Database(err.to_string()))?;
            serde_json::from_str::<PrivacySettings>(&raw_json)
                .map_err(|err| PrivacyError::CorruptStoredPolicy(err.to_string()))?
        } else {
            PrivacySettings::default()
        };

        transaction
            .commit()
            .await
            .map_err(|err| PrivacyError::Database(err.to_string()))?;

        let snapshot = compute_snapshot(initial_settings, config.local_only_mode());
        let (policy_tx, _) = watch::channel(snapshot);

        Ok(Self {
            db: Some(db),
            runtime: Arc::new(SyncRwLock::new(PrivacyRuntime {
                stored: snapshot,
                snapshot,
                library_urls,
                suspended: false,
                permits: std::array::from_fn(|_| CancellationToken::new()),
            })),
            settings: Arc::new(RwLock::new(initial_settings)),
            policy_tx,
        })
    }

    /// Returns the current [`PrivacySnapshot`].
    #[must_use]
    pub fn snapshot(&self) -> PrivacySnapshot {
        self.runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .snapshot
    }

    /// Returns `true` if external network traffic for `category` is currently permitted.
    #[must_use]
    pub fn is_external_allowed(&self, category: PrivacyCategory) -> bool {
        let snap = self.snapshot();
        match category {
            PrivacyCategory::Metadata => snap.effective.metadata,
            PrivacyCategory::Imports => snap.effective.imports,
            PrivacyCategory::Artwork => snap.effective.artwork,
            PrivacyCategory::External => snap.effective.external,
        }
    }

    /// Alias for [`PrivacyManager::is_external_allowed`].
    #[must_use]
    pub fn is_category_allowed(&self, category: PrivacyCategory) -> bool {
        self.is_external_allowed(category)
    }

    /// Checks whether `category` is allowed, returning `Err(PrivacyError::Blocked(...))` if disallowed.
    pub fn assert_external_allowed(&self, category: PrivacyCategory) -> Result<(), PrivacyError> {
        let snap = self.snapshot();
        let allowed = match category {
            PrivacyCategory::Metadata => snap.effective.metadata,
            PrivacyCategory::Imports => snap.effective.imports,
            PrivacyCategory::Artwork => snap.effective.artwork,
            PrivacyCategory::External => snap.effective.external,
        };
        if !allowed {
            return Err(PrivacyError::blocked(
                snap.enforced_by_environment || snap.local_only,
            ));
        }
        Ok(())
    }

    /// Atomically persists updated [`PrivacySettings`] to SQLite (when attached) and
    /// broadcasts the new [`PrivacySnapshot`] so in-flight disallowed operations abort immediately.
    pub async fn update(&self, next: PrivacySettings) -> Result<PrivacySnapshot, PrivacyError> {
        let manager = self.clone();
        // Finish persistence and publication even if the HTTP request is cancelled.
        tokio::spawn(async move {
            let mut settings = manager.settings.write().await;
            if let Some(ref db) = manager.db {
                let serialized = serde_json::to_string(&next)
                    .map_err(|err| PrivacyError::Database(err.to_string()))?;
                let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let mut transaction = db.inner().begin().await
                    .map_err(|err| PrivacyError::Database(err.to_string()))?;

                sqlx::query(
                    r"
                    INSERT INTO server_settings (key, value, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                      value = excluded.value,
                      updated_at = excluded.updated_at;
                    ",
                )
                .bind(PRIVACY_POLICY_SETTING_KEY)
                .bind(serialized)
                .bind(now_iso)
                .execute(&mut *transaction)
                .await
                .map_err(|err| PrivacyError::Database(err.to_string()))?;
                let environment_lock = manager.runtime.read().unwrap_or_else(std::sync::PoisonError::into_inner).stored.enforced_by_environment;
                if !compute_snapshot(next, environment_lock).effective.external {
                    sqlx::query("UPDATE scrobble_queue SET state = 'cancelled', lease_token = NULL, lease_until = NULL, error_code = 'PRIVACY_CANCELLED', error_message = 'Cancelled by privacy policy' WHERE state IN ('pending', 'sending', 'blocked', 'failed')")
                        .execute(&mut *transaction).await.map_err(|err| PrivacyError::Database(err.to_string()))?;
                }
                transaction.commit().await
                    .map_err(|err| PrivacyError::Database(err.to_string()))?;
            }

            *settings = next;
            let mut runtime = manager.runtime.write().unwrap_or_else(std::sync::PoisonError::into_inner);
            runtime.stored = compute_snapshot(next, runtime.stored.enforced_by_environment);
            Ok(runtime.publish(&manager.policy_tx))
        })
        .await
        .map_err(|err| PrivacyError::Configuration(err.to_string()))?
    }

    /// Stops existing outbound work before a configuration/restore transition.
    pub(crate) fn suspend(&self) {
        let mut runtime = self
            .runtime
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        runtime.suspended = true;
        runtime.publish(&self.policy_tx);
    }

    pub(crate) fn resume(&self) {
        let mut runtime = self
            .runtime
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        runtime.suspended = false;
        runtime.publish(&self.policy_tx);
    }

    pub(crate) fn is_suspended(&self) -> bool {
        self.runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .suspended
    }

    pub(crate) fn configured_snapshot(&self) -> PrivacySnapshot {
        self.runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .stored
    }

    /// Refreshes this manager in place, preserving every worker's shared handle.
    pub(crate) async fn reload(&self, config: &AppConfig) -> Result<(), PrivacyError> {
        let mut settings = self.settings.write().await;
        let db = self
            .db
            .clone()
            .ok_or_else(|| PrivacyError::Configuration("Database unavailable".into()))?;
        let loaded = Self::from_database(db, config).await?;
        *settings = *loaded.settings.read().await;
        let loaded = loaded
            .runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut runtime = self
            .runtime
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        runtime.stored = loaded.stored;
        runtime.library_urls = loaded.library_urls.clone();
        runtime.publish(&self.policy_tx);
        Ok(())
    }

    /// Captures a permit that remains cancelled across rapid restrict/allow toggles.
    pub(crate) fn outbound_permit(
        &self,
        category: PrivacyCategory,
    ) -> Result<CancellationToken, PrivacyError> {
        let runtime = self
            .runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (index, allowed) = match category {
            PrivacyCategory::Metadata => (0, runtime.snapshot.effective.metadata),
            PrivacyCategory::Imports => (1, runtime.snapshot.effective.imports),
            PrivacyCategory::Artwork => (2, runtime.snapshot.effective.artwork),
            PrivacyCategory::External => (3, runtime.snapshot.effective.external),
        };
        if !allowed {
            return Err(PrivacyError::blocked(
                runtime.snapshot.local_only || runtime.snapshot.enforced_by_environment,
            ));
        }
        Ok(runtime.permits[index].clone())
    }

    /// Does not poll outbound work when blocked; drops it on policy revocation.
    pub async fn run_external<F: Future>(
        &self,
        category: PrivacyCategory,
        work: F,
    ) -> Result<F::Output, PrivacyError> {
        let permit = self.outbound_permit(category)?;
        tokio::select! {
            biased;
            () = permit.cancelled() => Err(PrivacyError::blocked(self.snapshot().local_only || self.snapshot().enforced_by_environment)),
            result = work => Ok(result),
        }
    }

    /// Subscribes to live [`PrivacySnapshot`] updates so long-running tasks can abort
    /// immediately if their [`PrivacyCategory`] becomes disallowed.
    #[must_use]
    pub fn subscribe(&self) -> watch::Receiver<PrivacySnapshot> {
        self.policy_tx.subscribe()
    }

    /// Returns `true` if `target` points to one of the configured self-hosted media
    /// backend origins (`Navidrome` or `Jellyfin`).
    #[must_use]
    pub fn is_library_url(&self, target: &Url) -> bool {
        self.runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .library_urls
            .iter()
            .any(|base| {
                if target.scheme() != base.scheme()
                    || target.host_str() != base.host_str()
                    || target.port_or_known_default() != base.port_or_known_default()
                {
                    return false;
                }
                let base_path = base.path().trim_end_matches('/');
                let target_path = target.path();
                target_path == base_path
                    || (base_path.is_empty() && target_path.starts_with('/'))
                    || target_path.starts_with(&format!("{base_path}/"))
            })
    }

    /// Verifies that an outbound HTTP(S) request to `raw_url` is permitted under the
    /// active privacy policy.
    pub fn assert_url_allowed(
        &self,
        raw_url: &str,
        explicit_category: Option<PrivacyCategory>,
    ) -> Result<Url, PrivacyError> {
        let parsed =
            Url::parse(raw_url).map_err(|err| PrivacyError::InvalidOutboundUrl(err.to_string()))?;

        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(PrivacyError::InvalidOutboundUrl(String::from(
                "Unsupported outbound protocol",
            )));
        }

        if !self.is_library_url(&parsed) {
            let category = explicit_category.unwrap_or_else(|| classify_outbound_url(&parsed));
            self.assert_external_allowed(category)?;
        }

        Ok(parsed)
    }
}

/// Classifies an outbound [`Url`] into its governing [`PrivacyCategory`], matching
/// `categoryFor(url)` in `server/src/services/PrivacyManager.ts`.
#[must_use]
pub fn classify_outbound_url(url: &Url) -> PrivacyCategory {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let path = url.path().to_ascii_lowercase();

    let is_artwork_host = [
        "scdn.co",
        "mzstatic.com",
        "deezercover.com",
        "coverartarchive.org",
        "fanart.tv",
        "wikimedia.org",
        "discogs.com",
    ]
    .iter()
    .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
        || host == "e-cdns-images.dzcdn.net";

    let is_image_path = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]
        .iter()
        .any(|ext| path.ends_with(ext) || path.contains(&format!("{ext}/")));

    if is_artwork_host || is_image_path {
        return PrivacyCategory::Artwork;
    }

    if ["spotify.com", "spotifycdn.com"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
    {
        return PrivacyCategory::Imports;
    }

    if ["last.fm", "audioscrobbler.com", "listenbrainz.org"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
    {
        return PrivacyCategory::External;
    }

    PrivacyCategory::Metadata
}

const fn compute_snapshot(
    settings: PrivacySettings,
    enforced_by_environment: bool,
) -> PrivacySnapshot {
    let locked = enforced_by_environment || settings.local_only;
    let metadata = !locked && settings.allow_metadata;
    let artwork = !locked && settings.allow_artwork;
    let imports =
        !locked && settings.allow_imports && settings.allow_metadata && settings.allow_artwork;
    let external =
        !locked && settings.allow_metadata && settings.allow_imports && settings.allow_artwork;

    PrivacySnapshot {
        local_only: settings.local_only,
        allow_metadata: settings.allow_metadata,
        allow_imports: settings.allow_imports,
        allow_artwork: settings.allow_artwork,
        enforced_by_environment,
        effective: EffectivePrivacyPermissions {
            metadata,
            imports,
            artwork,
            external,
        },
    }
}

async fn load_library_urls(
    connection: &mut sqlx::SqliteConnection,
    config: &AppConfig,
) -> Result<Vec<Url>, PrivacyError> {
    let mut urls = Vec::new();
    let rows = sqlx::query("SELECT type, config_json FROM backend_connections WHERE enabled = 1;")
        .fetch_all(connection)
        .await
        .map_err(|err| PrivacyError::Database(err.to_string()))?;
    for row in rows {
        let conn_type: String = row.try_get("type").unwrap_or_default();
        let config_json: String = row.try_get("config_json").unwrap_or_default();
        let stored_url = serde_json::from_str::<serde_json::Value>(&config_json)
            .ok()
            .and_then(|v| {
                v.get("url")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default();

        let candidate = match conn_type.as_str() {
            "navidrome" if !config.navidrome.url.is_empty() => config.navidrome.url.clone(),
            "jellyfin" if !config.jellyfin.url.is_empty() => config.jellyfin.url.clone(),
            _ => stored_url,
        };

        if let Ok(parsed) = Url::parse(&candidate) {
            urls.push(parsed);
        }
    }

    if urls.is_empty() {
        let fallback = match config.backend {
            MusicBackendKind::Navidrome => &config.navidrome.url,
            MusicBackendKind::Jellyfin => &config.jellyfin.url,
        };
        if let Ok(parsed) = Url::parse(fallback) {
            urls.push(parsed);
        }
    }

    Ok(urls)
}

#[cfg(test)]
mod tests;
