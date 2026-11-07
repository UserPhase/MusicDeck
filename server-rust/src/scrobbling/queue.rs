//! # Durable Transactional Scrobble Outbox & Background Worker (`scrobbling::queue`)
//!
//! Ports `server/src/services/scrobble/ScrobbleQueueService.ts`:
//! - [`qualifies_for_scrobble`]: Last.fm (`duration > 30s`) and ListenBrainz (`>= min(duration/2, 240s)`)
//! - [`ScrobbleQueueService`]:
//!   - Transactional SQLite outbox (`scrobble_connections`, `scrobble_queue`, `scrobble_auth_states`)
//!   - Account-switch isolation (`account_key`, `generation`) cancelling stale listens on account change
//!   - Strict FIFO per-account claim query with `60,000 ms` lease tokens (`state = 'sending'`)
//!   - Compare-And-Swap (`WHERE id = ? AND lease_token = ? AND state = 'sending'`) state transitions
//!   - Exponential backoff (`min(6h, 30_000 * 2^min(12, attempts-1) * (1 + jitter*0.25))`) up to 12 attempts
//!   - `tokio::time::interval(Duration::from_secs(15))` background worker loop

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::db::DbPool;
use crate::logger::register_log_secret;
use crate::scrobbling::lastfm::{LastFmCredentials, LastFmScrobbler};
use crate::scrobbling::listenbrainz::ListenBrainzScrobbler;
use crate::scrobbling::protocol::{
    FailureKind, ScrobbleError, ScrobbleListen, ScrobbleProvider, validate_listen,
};
use crate::services::privacy::{PrivacyCategory, PrivacyManager};

/// Worker polling interval (`15,000 ms`).
pub const SCROBBLE_WORKER_INTERVAL_MS: u64 = 15_000;
/// Lease duration for a claimed `sending` scrobble job (`60,000 ms`).
pub const SCROBBLE_JOB_LEASE_MS: i64 = 60_000;
/// Maximum delivery attempts before a job transitions to `failed` (`12`).
pub const SCROBBLE_MAX_ATTEMPTS: i64 = 12;

fn queue_database_error(error: sqlx::Error) -> ScrobbleError {
    tracing::error!(error = %error, "Scrobble queue database operation failed");
    ScrobbleError::new(
        "INTERNAL_ERROR",
        "Could not persist the queued listen.",
        FailureKind::Transient,
        None,
        0,
    )
}

/// Determines whether a playback event qualifies for scrobbling under `provider`'s rules:
/// - Last.fm requires known `duration > 30` seconds.
/// - Both providers require `listened_seconds >= min(duration / 2, 240)` (or `240` when duration is unknown).
#[must_use]
pub fn qualifies_for_scrobble(
    provider: ScrobbleProvider,
    listened_seconds: f64,
    duration_seconds: Option<f64>,
) -> bool {
    if provider == ScrobbleProvider::Lastfm {
        let Some(dur) = duration_seconds else {
            return false;
        };
        if dur <= 30.0 {
            return false;
        }
    }
    let threshold = duration_seconds.map_or(240.0, |dur| (dur / 2.0).min(240.0));
    listened_seconds >= threshold
}

fn epoch_ms_to_iso(ms: Option<i64>) -> Option<String> {
    let ms = ms.filter(|&v| v > 0)?;
    DateTime::<Utc>::from_timestamp_millis(ms).map(|dt| dt.to_rfc3339())
}

/// Diagnostic item returned inside [`ScrobbleConnectionStatus::diagnostics`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrobbleDiagnosticItem {
    pub id: String,
    pub track: String,
    pub artist: String,
    pub listened_at: String,
    pub state: String,
    pub attempts: i64,
    pub code: Option<String>,
    pub message: Option<String>,
    pub http_status: Option<i64>,
    pub next_retry_at: Option<String>,
}

/// Error summary embedded in [`ScrobbleConnectionStatus`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrobbleConnectionError {
    pub code: String,
    pub message: String,
    pub http_status: Option<i64>,
}

/// Per-provider connection & outbox status returned by `GET /api/v1/scrobble`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrobbleConnectionStatus {
    pub provider: ScrobbleProvider,
    pub available: bool,
    pub unavailable_reason: Option<String>,
    pub enabled: bool,
    pub username: Option<String>,
    pub status: String,
    pub last_successful_scrobble: Option<String>,
    pub last_listened_at: Option<String>,
    pub last_checked_at: Option<String>,
    pub next_retry_at: Option<String>,
    pub pending: i64,
    pub failed: i64,
    pub error: Option<ScrobbleConnectionError>,
    pub diagnostics: Vec<ScrobbleDiagnosticItem>,
}

#[derive(Debug, Clone)]
struct ConnectionRow {
    user_id: String,
    provider: ScrobbleProvider,
    enabled: bool,
    credentials_json: String,
    username: String,
    account_key: String,
    generation: String,
    connected_at: i64,
    status: String,
    last_success_at: Option<i64>,
    last_listened_at: Option<i64>,
    last_error_code: Option<String>,
    last_error_message: Option<String>,
    last_http_status: Option<i64>,
    last_checked_at: Option<i64>,
    pause_until: i64,
}

#[derive(Debug, Clone)]
struct ClaimedJob {
    id: String,
    user_id: String,
    provider: ScrobbleProvider,
    account_name: String,
    payload_json: String,
    listened_at: i64,
    attempts: i64,
    lease_token: String,
    generation: String,
}

/// Input options for connecting a Last.fm account.
#[derive(Debug, Clone)]
pub enum LastFmConnectInput {
    Token(String),
    SessionKey(String),
}

/// Durable transactional scrobble outbox and background delivery worker.
#[derive(Clone)]
pub struct ScrobbleQueueService {
    db: Option<DbPool>,
    privacy: PrivacyManager,
    stopped: Arc<AtomicBool>,
    worker_started: Arc<AtomicBool>,
    draining: Arc<AtomicBool>,
    changing: Arc<Mutex<HashSet<String>>>,
    wake: Arc<Notify>,
    shutdown: CancellationToken,
    runtime_gate: Option<Arc<tokio::sync::RwLock<()>>>,
    #[cfg(test)]
    listenbrainz_endpoint: Option<String>,
}

impl std::fmt::Debug for ScrobbleQueueService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScrobbleQueueService")
            .field("stopped", &self.stopped.load(Ordering::Relaxed))
            .finish()
    }
}

impl ScrobbleQueueService {
    /// Creates a new [`ScrobbleQueueService`].
    #[must_use]
    pub fn new(db: Option<DbPool>, privacy: PrivacyManager) -> Self {
        Self {
            db,
            privacy,
            stopped: Arc::new(AtomicBool::new(false)),
            worker_started: Arc::new(AtomicBool::new(false)),
            draining: Arc::new(AtomicBool::new(false)),
            changing: Arc::new(Mutex::new(HashSet::new())),
            wake: Arc::new(Notify::new()),
            shutdown: CancellationToken::new(),
            runtime_gate: None,
            #[cfg(test)]
            listenbrainz_endpoint: None,
        }
    }

    /// Privacy-cancelled jobs are terminal and must never replay after re-enabling.
    pub(crate) async fn cancel_privacy_pending(&self) -> Result<(), ScrobbleError> {
        let Some(pool) = &self.db else {
            return Ok(());
        };
        sqlx::query("UPDATE scrobble_queue SET state = 'cancelled', lease_token = NULL, lease_until = NULL, error_code = 'PRIVACY_CANCELLED', error_message = 'Cancelled by privacy policy' WHERE state IN ('pending', 'sending', 'blocked', 'failed')")
            .execute(pool.inner()).await.map_err(queue_database_error)?;
        Ok(())
    }

    async fn cancel_claimed(&self, job: &ClaimedJob) {
        if let Some(pool) = &self.db {
            if let Err(err) = sqlx::query("UPDATE scrobble_queue SET state = 'cancelled', lease_token = NULL, lease_until = NULL, error_code = 'PRIVACY_CANCELLED', error_message = 'Submission cancelled; delivery will not be retried' WHERE id = ? AND lease_token = ? AND state = 'sending'")
                .bind(&job.id).bind(&job.lease_token).execute(pool.inner()).await {
                tracing::error!(error = %err, "Could not persist scrobble cancellation");
            }
        }
    }

    pub(crate) fn with_runtime_gate(mut self, gate: Arc<tokio::sync::RwLock<()>>) -> Self {
        self.runtime_gate = Some(gate);
        self
    }

    fn now_ms() -> i64 {
        Utc::now().timestamp_millis()
    }

    fn require_db(&self) -> Result<&DbPool, ScrobbleError> {
        self.db.as_ref().ok_or_else(|| {
            ScrobbleError::new(
                "QUEUE_CLOSED",
                "Database is unavailable.",
                FailureKind::Paused,
                None,
                0,
            )
        })
    }

    async fn fetch_connection(
        &self,
        user_id: &str,
        provider: ScrobbleProvider,
    ) -> Option<ConnectionRow> {
        let pool = self.db.as_ref()?;
        let mut connection = pool.inner().acquire().await.ok()?;
        Self::fetch_connection_on_conn(&mut connection, user_id, provider)
            .await
            .ok()
            .flatten()
    }

    async fn fetch_connection_on_conn(
        connection: &mut sqlx::SqliteConnection,
        user_id: &str,
        provider: ScrobbleProvider,
    ) -> Result<Option<ConnectionRow>, sqlx::Error> {
        let row =
            sqlx::query("SELECT * FROM scrobble_connections WHERE user_id = ? AND provider = ?")
                .bind(user_id)
                .bind(provider.as_str())
                .fetch_optional(connection)
                .await?;
        let Some(row) = row else {
            return Ok(None);
        };

        Ok(Some(ConnectionRow {
            user_id: row.try_get("user_id").unwrap_or_default(),
            provider,
            enabled: row.try_get::<i64, _>("enabled").unwrap_or(0) != 0,
            credentials_json: row.try_get("credentials_json").unwrap_or_default(),
            username: row.try_get("username").unwrap_or_default(),
            account_key: row.try_get("account_key").unwrap_or_default(),
            generation: row.try_get("generation").unwrap_or_default(),
            connected_at: row.try_get("connected_at").unwrap_or(0),
            status: row
                .try_get("status")
                .unwrap_or_else(|_| String::from("disconnected")),
            last_success_at: row.try_get("last_success_at").ok(),
            last_listened_at: row.try_get("last_listened_at").ok(),
            last_error_code: row.try_get("last_error_code").ok(),
            last_error_message: row.try_get("last_error_message").ok(),
            last_http_status: row.try_get("last_http_status").ok(),
            last_checked_at: row.try_get("last_checked_at").ok(),
            pause_until: row.try_get("pause_until").unwrap_or(0),
        }))
    }

    async fn plugin_config(&self, provider: ScrobbleProvider) -> Result<Value, ScrobbleError> {
        let pool = self.require_db()?;
        let mut connection = pool.inner().acquire().await.map_err(queue_database_error)?;
        Self::plugin_config_on_conn(&mut connection, provider).await
    }

    async fn plugin_config_on_conn(
        connection: &mut sqlx::SqliteConnection,
        provider: ScrobbleProvider,
    ) -> Result<Value, ScrobbleError> {
        let row = sqlx::query(
            "SELECT enabled, config_json, permissions_json FROM plugin_configs WHERE plugin_id = ?",
        )
        .bind(provider.as_str())
        .fetch_optional(connection)
        .await
        .map_err(queue_database_error)?;

        let Some(row) = row else {
            return Err(ScrobbleError::new(
                "PLUGIN_DISABLED",
                "Ask your administrator to enable this integration in Plugins.",
                FailureKind::Configuration,
                None,
                0,
            ));
        };

        let enabled: i64 = row.try_get("enabled").unwrap_or(0);
        if enabled == 0 {
            return Err(ScrobbleError::new(
                "PLUGIN_DISABLED",
                "Ask your administrator to enable this integration in Plugins.",
                FailureKind::Configuration,
                None,
                0,
            ));
        }

        let permissions_str: String = row.try_get("permissions_json").unwrap_or_default();
        let config_str: String = row.try_get("config_json").unwrap_or_default();

        let permissions: Vec<String> = serde_json::from_str(&permissions_str).map_err(|_| {
            ScrobbleError::new(
                "APPLICATION_NOT_CONFIGURED",
                "The administrator must repair this integration's stored configuration.",
                FailureKind::Configuration,
                None,
                0,
            )
        })?;

        let config: Value = serde_json::from_str(&config_str).map_err(|_| {
            ScrobbleError::new(
                "APPLICATION_NOT_CONFIGURED",
                "The administrator must repair this integration's stored configuration.",
                FailureKind::Configuration,
                None,
                0,
            )
        })?;

        if !config.is_object() {
            return Err(ScrobbleError::new(
                "APPLICATION_NOT_CONFIGURED",
                "The administrator must repair this integration's stored configuration.",
                FailureKind::Configuration,
                None,
                0,
            ));
        }

        if !permissions.iter().any(|p| p == "history.read")
            || !permissions.iter().any(|p| p == "network.request")
        {
            return Err(ScrobbleError::new(
                "PERMISSION_REQUIRED",
                "The administrator must approve listening history and network permissions.",
                FailureKind::Configuration,
                None,
                0,
            ));
        }

        if provider == ScrobbleProvider::Lastfm {
            let api_key = config
                .get("apiKey")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let api_secret = config
                .get("apiSecret")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let (Some(api_key), Some(api_secret)) = (api_key, api_secret) else {
                return Err(ScrobbleError::new(
                    "APPLICATION_NOT_CONFIGURED",
                    "Ask your administrator to configure the Last.fm API key and shared secret.",
                    FailureKind::Configuration,
                    None,
                    0,
                ));
            };
            register_log_secret(api_key);
            register_log_secret(api_secret);
        }

        Ok(config)
    }

    async fn unavailable_reason(&self, provider: ScrobbleProvider) -> Option<String> {
        if !self.privacy.is_external_allowed(PrivacyCategory::External) {
            return Some(String::from(
                "External integrations are paused by the server's privacy settings.",
            ));
        }
        match self.plugin_config(provider).await {
            Ok(_) => None,
            Err(err) => Some(err.message),
        }
    }

    async fn assert_available(&self, provider: ScrobbleProvider) -> Result<Value, ScrobbleError> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(ScrobbleError::new(
                "QUEUE_CLOSED",
                "Scrobble processing is stopping. Try again after the server restarts.",
                FailureKind::Paused,
                None,
                0,
            ));
        }
        if !self.privacy.is_external_allowed(PrivacyCategory::External) {
            return Err(ScrobbleError::new(
                "PRIVACY_BLOCKED",
                "External integrations are paused by privacy settings.",
                FailureKind::Paused,
                None,
                0,
            ));
        }
        self.plugin_config(provider).await
    }

    /// Returns the configured Last.fm application API key (`apiKey`).
    pub async fn application_key(&self) -> Result<String, ScrobbleError> {
        let cfg = self.assert_available(ScrobbleProvider::Lastfm).await?;
        Ok(cfg
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned())
    }

    async fn build_lastfm_scrobbler(
        &self,
        session_key: Option<String>,
    ) -> Result<LastFmScrobbler, ScrobbleError> {
        let cfg = self.assert_available(ScrobbleProvider::Lastfm).await?;
        let api_key = cfg
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let api_secret = cfg
            .get("apiSecret")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        LastFmScrobbler::new(LastFmCredentials {
            api_key,
            api_secret,
            session_key,
        })
    }

    fn begin_change(&self, user_id: &str, provider: ScrobbleProvider) -> Result<String, ScrobbleError> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(ScrobbleError::new(
                "QUEUE_CLOSED",
                "Scrobble processing is stopping. Try again after the server restarts.",
                FailureKind::Paused,
                None,
                0,
            ));
        }
        let key = format!("{user_id}:{}", provider.as_str());
        let mut guard = self.changing.lock().map_err(|_| {
            ScrobbleError::new(
                "CONNECTION_BUSY",
                "A connection update is already in progress.",
                FailureKind::Paused,
                None,
                0,
            )
        })?;
        if !guard.insert(key.clone()) {
            return Err(ScrobbleError::new(
                "CONNECTION_BUSY",
                "A connection update is already in progress.",
                FailureKind::Paused,
                None,
                0,
            ));
        }
        Ok(key)
    }

    fn end_change(&self, key: &str) {
        if let Ok(mut guard) = self.changing.lock() {
            guard.remove(key);
        }
    }

    async fn save_connection(
        &self,
        user_id: &str,
        provider: ScrobbleProvider,
        username: &str,
        credentials: Value,
    ) -> Result<(), ScrobbleError> {
        self.assert_available(provider).await?;
        let pool = self.require_db()?;
        let now = Self::now_ms();
        let previous = self.fetch_connection(user_id, provider).await;
        let account_key = username.to_lowercase();
        let same_account = previous
            .as_ref()
            .is_some_and(|p| p.enabled && p.account_key == account_key);
        let connected_at = if same_account {
            previous.as_ref().map_or(now, |p| p.connected_at)
        } else {
            now
        };

        let mut tx = pool.inner().begin().await.map_err(|_| {
            ScrobbleError::new(
                "INTERNAL_ERROR",
                "Could not save scrobble connection.",
                FailureKind::Transient,
                None,
                0,
            )
        })?;

        if !same_account {
            sqlx::query(
                r"
                UPDATE scrobble_queue
                SET state = 'cancelled', lease_token = NULL, lease_until = NULL
                WHERE user_id = ? AND provider = ?
                  AND state IN ('pending', 'sending', 'blocked', 'failed')
                ",
            )
            .bind(user_id)
            .bind(provider.as_str())
            .execute(&mut *tx)
            .await
            .ok();
        } else {
            sqlx::query(
                r"
                UPDATE scrobble_queue
                SET state = 'pending', next_attempt_at = ?, lease_token = NULL, lease_until = NULL
                WHERE user_id = ? AND provider = ?
                  AND state IN ('blocked', 'sending')
                ",
            )
            .bind(now)
            .bind(user_id)
            .bind(provider.as_str())
            .execute(&mut *tx)
            .await
            .ok();
        }

        let generation = Uuid::new_v4().to_string();
        let cred_str = serde_json::to_string(&credentials).unwrap_or_else(|_| String::from("{}"));
        let keep_flag = i64::from(same_account);

        sqlx::query(
            r"
            INSERT INTO scrobble_connections (
                user_id, provider, credentials_json, username, account_key,
                generation, connected_at, updated_at, last_checked_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, provider) DO UPDATE SET
                enabled = 1,
                credentials_json = excluded.credentials_json,
                username = excluded.username,
                account_key = excluded.account_key,
                generation = excluded.generation,
                connected_at = excluded.connected_at,
                status = 'connected',
                last_success_at = CASE WHEN ? THEN last_success_at ELSE NULL END,
                last_listened_at = CASE WHEN ? THEN last_listened_at ELSE NULL END,
                last_error_code = NULL,
                last_error_message = NULL,
                last_http_status = NULL,
                pause_until = 0,
                updated_at = excluded.updated_at,
                last_checked_at = excluded.last_checked_at
            ",
        )
        .bind(user_id)
        .bind(provider.as_str())
        .bind(cred_str)
        .bind(username)
        .bind(account_key)
        .bind(generation)
        .bind(connected_at)
        .bind(now)
        .bind(now)
        .bind(keep_flag)
        .bind(keep_flag)
        .execute(&mut *tx)
        .await
        .map_err(|_| {
            ScrobbleError::new(
                "INTERNAL_ERROR",
                "Could not save scrobble connection.",
                FailureKind::Transient,
                None,
                0,
            )
        })?;

        tx.commit().await.map_err(|_| {
            ScrobbleError::new(
                "INTERNAL_ERROR",
                "Could not commit scrobble connection.",
                FailureKind::Transient,
                None,
                0,
            )
        })?;

        self.kick();
        Ok(())
    }

    /// Validates and connects a ListenBrainz user token.
    pub async fn connect_listenbrainz(
        &self,
        user_id: &str,
        token: &str,
    ) -> Result<(), ScrobbleError> {
        register_log_secret(token);
        let change_key = self.begin_change(user_id, ScrobbleProvider::Listenbrainz)?;
        let res = async {
            self.assert_available(ScrobbleProvider::Listenbrainz).await?;
            let scrobbler = ListenBrainzScrobbler::new(token)?;
            let username = scrobbler.validate_token().await?;
            self.save_connection(
                user_id,
                ScrobbleProvider::Listenbrainz,
                &username,
                json!({ "token": token }),
            )
            .await
        }
        .await;
        self.end_change(&change_key);
        res
    }

    /// Exchanges a token or validates a session key and connects a Last.fm account.
    pub async fn connect_lastfm(
        &self,
        user_id: &str,
        input: LastFmConnectInput,
    ) -> Result<(), ScrobbleError> {
        match &input {
            LastFmConnectInput::Token(t) => register_log_secret(t),
            LastFmConnectInput::SessionKey(sk) => register_log_secret(sk),
        }
        let change_key = self.begin_change(user_id, ScrobbleProvider::Lastfm)?;
        let res = async {
            let (username, session_key) = match input {
                LastFmConnectInput::Token(token) => {
                    let scrobbler = self.build_lastfm_scrobbler(None).await?;
                    scrobbler.exchange_token(&token).await?
                }
                LastFmConnectInput::SessionKey(sk) => {
                    let scrobbler = self.build_lastfm_scrobbler(Some(sk.clone())).await?;
                    let uname = scrobbler.validate_session().await?;
                    (uname, sk)
                }
            };
            register_log_secret(&session_key);
            self.save_connection(
                user_id,
                ScrobbleProvider::Lastfm,
                &username,
                json!({ "sessionKey": session_key }),
            )
            .await
        }
        .await;
        self.end_change(&change_key);
        res
    }

    /// Disconnects a user's scrobble integration and cancels any unsent queued listens.
    pub async fn disconnect(
        &self,
        user_id: &str,
        provider: ScrobbleProvider,
    ) -> Result<(), ScrobbleError> {
        let change_key = self.begin_change(user_id, provider)?;
        let res = async {
            let pool = self.require_db()?;
            let now = Self::now_ms();
            let generation = Uuid::new_v4().to_string();

            let mut tx = pool.inner().begin().await.map_err(|_| {
                ScrobbleError::new(
                    "INTERNAL_ERROR",
                    "Could not disconnect scrobbler.",
                    FailureKind::Transient,
                    None,
                    0,
                )
            })?;

            sqlx::query(
                r"
                UPDATE scrobble_connections
                SET enabled = 0,
                    credentials_json = '{}',
                    status = 'disconnected',
                    generation = ?,
                    last_error_code = NULL,
                    last_error_message = NULL,
                    last_http_status = NULL,
                    pause_until = 0,
                    updated_at = ?
                WHERE user_id = ? AND provider = ?
                ",
            )
            .bind(generation)
            .bind(now)
            .bind(user_id)
            .bind(provider.as_str())
            .execute(&mut *tx)
            .await
            .ok();

            sqlx::query(
                r"
                UPDATE scrobble_queue
                SET state = 'cancelled', lease_token = NULL, lease_until = NULL
                WHERE user_id = ? AND provider = ?
                  AND state IN ('pending', 'sending', 'blocked', 'failed')
                ",
            )
            .bind(user_id)
            .bind(provider.as_str())
            .execute(&mut *tx)
            .await
            .ok();

            if provider == ScrobbleProvider::Lastfm {
                sqlx::query("DELETE FROM scrobble_auth_states WHERE user_id = ?")
                    .bind(user_id)
                    .execute(&mut *tx)
                    .await
                    .ok();
            }

            tx.commit().await.map_err(|_| {
                ScrobbleError::new(
                    "INTERNAL_ERROR",
                    "Could not commit disconnect.",
                    FailureKind::Transient,
                    None,
                    0,
                )
            })?;
            Ok(())
        }
        .await;
        self.end_change(&change_key);
        res
    }

    async fn record_connection_error(
        &self,
        conn: &ConnectionRow,
        error: &ScrobbleError,
        pause_until: i64,
    ) {
        let Some(pool) = &self.db else {
            return;
        };
        let status = match error.kind {
            FailureKind::Auth => "auth-error",
            FailureKind::Configuration => "configuration-error",
            _ => "error",
        };
        let _ = sqlx::query(
            r"
            UPDATE scrobble_connections
            SET status = ?,
                last_error_code = ?,
                last_error_message = ?,
                last_http_status = ?,
                last_checked_at = ?,
                pause_until = ?
            WHERE user_id = ? AND provider = ? AND generation = ?
            ",
        )
        .bind(status)
        .bind(&error.code)
        .bind(&error.message)
        .bind(error.http_status.map(i64::from))
        .bind(Self::now_ms())
        .bind(pause_until)
        .bind(&conn.user_id)
        .bind(conn.provider.as_str())
        .bind(&conn.generation)
        .execute(pool.inner())
        .await;
    }

    /// Tests an existing user connection, unblocking `blocked` jobs if verification succeeds.
    pub async fn test_connection(
        &self,
        user_id: &str,
        provider: ScrobbleProvider,
    ) -> Result<(), ScrobbleError> {
        let change_key = self.begin_change(user_id, provider)?;
        let res = async {
            self.assert_available(provider).await?;
            let conn = self
                .fetch_connection(user_id, provider)
                .await
                .filter(|c| c.enabled)
                .ok_or_else(|| {
                    ScrobbleError::new(
                        "NOT_CONNECTED",
                        "Connect this account before testing it.",
                        FailureKind::Auth,
                        None,
                        0,
                    )
                })?;

            let creds: Value =
                serde_json::from_str(&conn.credentials_json).unwrap_or_else(|_| json!({}));

            let verify_res: Result<String, ScrobbleError> = async {
                let username = match provider {
                    ScrobbleProvider::Lastfm => {
                        let sk = creds
                            .get("sessionKey")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        if let Some(ref s) = sk {
                            register_log_secret(s);
                        }
                        self.build_lastfm_scrobbler(sk)
                            .await?
                            .validate_session()
                            .await?
                    }
                    ScrobbleProvider::Listenbrainz => {
                        let token = creds
                            .get("token")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        register_log_secret(token);
                        ListenBrainzScrobbler::new(token)?.validate_token().await?
                    }
                };

                if !username.eq_ignore_ascii_case(&conn.username) {
                    return Err(ScrobbleError::new(
                        "ACCOUNT_CHANGED",
                        "This credential now identifies another account. Disconnect and connect it again.",
                        FailureKind::Auth,
                        None,
                        0,
                    ));
                }
                Ok(username)
            }
            .await;

            match verify_res {
                Ok(_) => {
                    let pool = self.require_db()?;
                    let now = Self::now_ms();
                    let _ = sqlx::query(
                        r"
                        UPDATE scrobble_connections
                        SET status = 'connected',
                            last_error_code = NULL,
                            last_error_message = NULL,
                            last_http_status = NULL,
                            last_checked_at = ?,
                            pause_until = 0
                        WHERE user_id = ? AND provider = ? AND generation = ?
                        ",
                    )
                    .bind(now)
                    .bind(user_id)
                    .bind(provider.as_str())
                    .bind(&conn.generation)
                    .execute(pool.inner())
                    .await;

                    let _ = sqlx::query(
                        r"
                        UPDATE scrobble_queue
                        SET state = 'pending', next_attempt_at = ?
                        WHERE user_id = ? AND provider = ? AND state = 'blocked'
                        ",
                    )
                    .bind(now)
                    .bind(user_id)
                    .bind(provider.as_str())
                    .execute(pool.inner())
                    .await;

                    Ok(())
                }
                Err(err) => {
                    self.record_connection_error(&conn, &err, 0).await;
                    Err(err)
                }
            }
        }
        .await;
        self.end_change(&change_key);
        if res.is_ok() {
            self.kick();
        }
        res
    }

    /// Resets `failed` scrobbles back to `pending` (`attempts = 0`) while respecting existing `next_attempt_at` backoff.
    pub async fn retry(
        &self,
        user_id: &str,
        provider: ScrobbleProvider,
    ) -> Result<(), ScrobbleError> {
        self.assert_available(provider).await?;
        let conn = self
            .fetch_connection(user_id, provider)
            .await
            .filter(|c| c.enabled)
            .ok_or_else(|| {
                ScrobbleError::new(
                    "NOT_CONNECTED",
                    "Connect an account before retrying queued listens.",
                    FailureKind::Auth,
                    None,
                    0,
                )
            })?;

        if conn.status == "auth-error" || conn.status == "configuration-error" {
            return Err(ScrobbleError::new(
                "RECONNECT_REQUIRED",
                "Reconnect or successfully test the connection before retrying.",
                FailureKind::Auth,
                None,
                0,
            ));
        }

        let pool = self.require_db()?;
        let now = Self::now_ms();
        let _ = sqlx::query(
            r"
            UPDATE scrobble_queue
            SET state = 'pending',
                attempts = 0,
                next_attempt_at = MAX(next_attempt_at, ?)
            WHERE user_id = ? AND provider = ? AND account_name = ? AND state = 'failed'
            ",
        )
        .bind(now)
        .bind(user_id)
        .bind(provider.as_str())
        .bind(&conn.account_key)
        .execute(pool.inner())
        .await;

        self.kick();
        Ok(())
    }

    /// Enqueues a qualified playback event into `scrobble_queue` (idempotent on `(user_id, provider, listening_event_id)`).
    pub async fn enqueue_playback(
        &self,
        user_id: &str,
        event_id: &str,
        artist: &str,
        track: &str,
        album: Option<&str>,
        started_at_iso: &str,
        listened_seconds: f64,
        duration_seconds: Option<f64>,
    ) {
        let Some(pool) = &self.db else {
            return;
        };
        let result = async {
            let mut transaction = pool.inner().begin().await.map_err(queue_database_error)?;
            self.enqueue_playback_on_conn(
                &mut transaction,
                user_id,
                event_id,
                artist,
                track,
                album,
                started_at_iso,
                listened_seconds,
                duration_seconds,
            )
            .await?;
            transaction.commit().await.map_err(queue_database_error)
        }
        .await;
        if let Err(error) = result {
            tracing::error!(error = %error, "Could not enqueue playback");
            return;
        }
        self.kick();
    }

    /// Enqueues the canonical saved event inside its listening-event transaction.
    pub(crate) async fn enqueue_recorded_playback(
        &self,
        connection: &mut sqlx::SqliteConnection,
        user_id: &str,
        event_id: &str,
    ) -> Result<(), ScrobbleError> {
        let row = sqlx::query(
            "SELECT track_json, created_at, listened_seconds, duration_seconds
             FROM listening_events WHERE id = ? AND user_id = ?",
        )
        .bind(event_id)
        .bind(user_id)
        .fetch_one(&mut *connection)
        .await
        .map_err(queue_database_error)?;
        let raw: String = row.try_get("track_json").map_err(queue_database_error)?;
        let track: crate::services::listening_activity::PlaybackTrackSnapshot =
            serde_json::from_str(&raw).map_err(|_| {
                ScrobbleError::new(
                    "INVALID_LISTEN",
                    "Stored playback metadata is unreadable.",
                    FailureKind::Configuration,
                    None,
                    0,
                )
            })?;
        let started_at: String = row.try_get("created_at").map_err(queue_database_error)?;
        let seconds: f64 = row
            .try_get("listened_seconds")
            .map_err(queue_database_error)?;
        let duration: Option<f64> = row
            .try_get("duration_seconds")
            .map_err(queue_database_error)?;
        self.enqueue_playback_on_conn(
            connection,
            user_id,
            event_id,
            &track.artist,
            &track.title,
            Some(&track.album),
            &started_at,
            seconds,
            duration,
        )
        .await
    }

    async fn enqueue_playback_on_conn(
        &self,
        connection: &mut sqlx::SqliteConnection,
        user_id: &str,
        event_id: &str,
        artist: &str,
        track: &str,
        album: Option<&str>,
        started_at_iso: &str,
        listened_seconds: f64,
        duration_seconds: Option<f64>,
    ) -> Result<(), ScrobbleError> {
        if self.stopped.load(Ordering::Acquire) {
            return Ok(());
        }
        if !self.privacy.is_external_allowed(PrivacyCategory::External) {
            return Ok(());
        }

        let Ok(started_dt) = DateTime::parse_from_rfc3339(started_at_iso) else {
            return Ok(());
        };
        let started_ms = started_dt.timestamp_millis();

        // Respect privacy policy change boundary
        if let Some(policy_row) =
            sqlx::query("SELECT updated_at FROM server_settings WHERE key = 'privacy.policy'")
                .fetch_optional(&mut *connection)
                .await
                .map_err(queue_database_error)?
        {
            if let Ok(updated_str) = policy_row.try_get::<String, _>("updated_at") {
                if let Ok(policy_dt) = DateTime::parse_from_rfc3339(&updated_str) {
                    if started_ms < policy_dt.timestamp_millis() {
                        return Ok(());
                    }
                }
            }
        }

        let artist_trimmed = artist.trim();
        let track_trimmed = track.trim();
        if artist_trimmed.is_empty()
            || track_trimmed.is_empty()
            || artist_trimmed.eq_ignore_ascii_case("unknown artist")
            || track_trimmed.eq_ignore_ascii_case("unknown title")
            || track_trimmed.eq_ignore_ascii_case("unknown track")
        {
            return Ok(());
        }

        let listen = ScrobbleListen {
            artist: artist_trimmed.to_owned(),
            track: track_trimmed.to_owned(),
            album: album
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            listened_at: started_dt.timestamp(),
            duration: duration_seconds
                .filter(|&d| d.is_finite() && d > 0.0)
                .map(|d| d.floor() as u32),
        };

        if validate_listen(&listen).is_err() {
            return Ok(());
        }

        let dedupe_input =
            serde_json::to_string(&json!([listen.listened_at, listen.artist, listen.track]))
                .unwrap_or_default();
        let mut sha = Sha256::new();
        sha.update(dedupe_input.as_bytes());
        let dedupe_key = format!("{:x}", sha.finalize());
        let payload_json = serde_json::to_string(&listen).unwrap_or_default();
        let now = Self::now_ms();

        for provider in ScrobbleProvider::ALL {
            if !qualifies_for_scrobble(provider, listened_seconds, duration_seconds) {
                continue;
            }
            if let Err(error) = Self::plugin_config_on_conn(connection, provider).await {
                if error.kind == FailureKind::Transient {
                    return Err(error);
                }
                continue;
            }
            let Some(conn) = Self::fetch_connection_on_conn(connection, user_id, provider)
                .await
                .map_err(queue_database_error)?
            else {
                continue;
            };
            if !conn.enabled || started_ms < conn.connected_at {
                continue;
            }

            sqlx::query(
                r"
                INSERT OR IGNORE INTO scrobble_queue (
                    id, user_id, provider, listening_event_id, dedupe_key,
                    account_name, payload_json, listened_at, next_attempt_at, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(user_id)
            .bind(provider.as_str())
            .bind(event_id)
            .bind(&dedupe_key)
            .bind(&conn.account_key)
            .bind(&payload_json)
            .bind(listen.listened_at)
            .bind(now)
            .bind(now)
            .execute(&mut *connection)
            .await
            .map_err(queue_database_error)?;
        }

        Ok(())
    }

    /// Returns the connection and queue diagnostic status for both `lastfm` and `listenbrainz`.
    pub async fn statuses(&self, user_id: &str) -> Vec<ScrobbleConnectionStatus> {
        let mut out = Vec::with_capacity(2);
        for provider in ScrobbleProvider::ALL {
            let conn = self.fetch_connection(user_id, provider).await;
            let unavailable_reason = self.unavailable_reason(provider).await;

            let (mut pending, mut failed, mut next_attempt) = (0_i64, 0_i64, None::<i64>);
            let mut diagnostics = Vec::new();

            if let Some(pool) = &self.db {
                if let Ok(Some(row)) = sqlx::query(
                    r"
                    SELECT
                        COALESCE(SUM(state IN ('pending', 'sending', 'blocked')), 0) AS pending,
                        COALESCE(SUM(state = 'failed'), 0) AS failed,
                        MIN(CASE WHEN state = 'pending' THEN next_attempt_at END) AS next_at
                    FROM scrobble_queue
                    WHERE user_id = ? AND provider = ?
                    ",
                )
                .bind(user_id)
                .bind(provider.as_str())
                .fetch_optional(pool.inner())
                .await
                {
                    pending = row.try_get("pending").unwrap_or(0);
                    failed = row.try_get("failed").unwrap_or(0);
                    next_attempt = row.try_get("next_at").ok();
                }

                if let Ok(rows) = sqlx::query(
                    r"
                    SELECT id, payload_json, listened_at, state, attempts,
                           error_code, error_message, http_status, next_attempt_at
                    FROM scrobble_queue
                    WHERE user_id = ? AND provider = ?
                      AND state IN ('pending', 'blocked', 'failed', 'ignored')
                      AND error_code IS NOT NULL
                    ORDER BY created_at DESC, id DESC
                    LIMIT 20
                    ",
                )
                .bind(user_id)
                .bind(provider.as_str())
                .fetch_all(pool.inner())
                .await
                {
                    let pause_until = conn.as_ref().map_or(0, |c| c.pause_until);
                    for row in rows {
                        let payload_str: String = row.try_get("payload_json").unwrap_or_default();
                        let Ok(listen) = serde_json::from_str::<ScrobbleListen>(&payload_str)
                        else {
                            continue;
                        };
                        let state: String = row.try_get("state").unwrap_or_default();
                        let row_next: i64 = row.try_get("next_attempt_at").unwrap_or(0);
                        let listened_secs: i64 = row.try_get("listened_at").unwrap_or(0);

                        diagnostics.push(ScrobbleDiagnosticItem {
                            id: row.try_get("id").unwrap_or_default(),
                            track: listen.track,
                            artist: listen.artist,
                            listened_at: epoch_ms_to_iso(Some(listened_secs * 1000))
                                .unwrap_or_default(),
                            next_retry_at: (state == "pending")
                                .then(|| epoch_ms_to_iso(Some(row_next.max(pause_until))))
                                .flatten(),
                            state,
                            attempts: row.try_get("attempts").unwrap_or(0),
                            code: row.try_get("error_code").ok(),
                            message: row.try_get("error_message").ok(),
                            http_status: row.try_get("http_status").ok(),
                        });
                    }
                }
            }

            let pause_until = conn.as_ref().map_or(0, |c| c.pause_until);
            let enabled = conn.as_ref().is_some_and(|c| c.enabled);
            let status = if unavailable_reason.is_some() {
                String::from("paused")
            } else {
                conn.as_ref()
                    .map_or_else(|| String::from("disconnected"), |c| c.status.clone())
            };

            let error = conn.as_ref().and_then(|c| {
                let code = c.last_error_code.as_ref()?;
                let message = c.last_error_message.as_ref()?;
                Some(ScrobbleConnectionError {
                    code: code.clone(),
                    message: message.clone(),
                    http_status: c.last_http_status,
                })
            });

            out.push(ScrobbleConnectionStatus {
                provider,
                available: unavailable_reason.is_none(),
                unavailable_reason,
                enabled,
                username: enabled.then(|| conn.as_ref().map(|c| c.username.clone())).flatten(),
                status,
                last_successful_scrobble: epoch_ms_to_iso(
                    conn.as_ref().and_then(|c| c.last_success_at),
                ),
                last_listened_at: epoch_ms_to_iso(
                    conn.as_ref()
                        .and_then(|c| c.last_listened_at)
                        .map(|s| s * 1000),
                ),
                last_checked_at: epoch_ms_to_iso(conn.as_ref().and_then(|c| c.last_checked_at)),
                next_retry_at: next_attempt.and_then(|n| epoch_ms_to_iso(Some(n.max(pause_until)))),
                pending,
                failed,
                error,
                diagnostics,
            });
        }
        out
    }

    async fn claim_next_job(&self) -> Option<ClaimedJob> {
        let pool = self.db.as_ref()?;
        let mut active_providers = Vec::new();
        for p in ScrobbleProvider::ALL {
            if self.unavailable_reason(p).await.is_none() {
                active_providers.push(p.as_str());
            }
        }
        if active_providers.is_empty() {
            return None;
        }

        let now = Self::now_ms();
        let mut tx = pool.inner().begin().await.ok()?;

        // Recover expired sending leases
        sqlx::query(
            r"
            UPDATE scrobble_queue
            SET state = 'pending', lease_token = NULL, lease_until = NULL
            WHERE state = 'sending' AND lease_until <= ?
            ",
        )
        .bind(now)
        .execute(&mut *tx)
        .await
        .ok()?;

        let placeholders = active_providers
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            r"
            SELECT q.*, c.generation
            FROM scrobble_queue q
            JOIN scrobble_connections c ON c.user_id = q.user_id AND c.provider = q.provider
            JOIN users u ON u.id = q.user_id
            JOIN plugin_configs p ON p.plugin_id = q.provider AND p.enabled = 1
            WHERE q.state = 'pending'
              AND q.next_attempt_at <= ?
              AND c.enabled = 1
              AND c.pause_until <= ?
              AND q.provider IN ({placeholders})
              AND c.account_key = q.account_name
              AND u.disabled = 0
              AND c.status NOT IN ('auth-error', 'configuration-error')
              AND NOT EXISTS (
                  SELECT 1 FROM scrobble_queue older
                  WHERE older.user_id = q.user_id
                    AND older.provider = q.provider
                    AND older.account_name = q.account_name
                    AND older.state IN ('pending', 'sending', 'blocked')
                    AND (older.listened_at, older.created_at, older.id) < (q.listened_at, q.created_at, q.id)
              )
            ORDER BY q.listened_at, q.created_at, q.id
            LIMIT 1
            "
        );

        let mut query = sqlx::query(&sql).bind(now).bind(now);
        for p in &active_providers {
            query = query.bind(*p);
        }

        let row = query.fetch_optional(&mut *tx).await.ok().flatten()?;
        let job_id: String = row.try_get("id").ok()?;
        let provider_str: String = row.try_get("provider").ok()?;
        let provider = ScrobbleProvider::parse(&provider_str)?;
        let lease_token = Uuid::new_v4().to_string();

        let updated = sqlx::query(
            r"
            UPDATE scrobble_queue
            SET state = 'sending', lease_token = ?, lease_until = ?
            WHERE id = ? AND state = 'pending'
            ",
        )
        .bind(&lease_token)
        .bind(now + SCROBBLE_JOB_LEASE_MS)
        .bind(&job_id)
        .execute(&mut *tx)
        .await
        .ok()?;

        if updated.rows_affected() == 0 {
            return None;
        }

        tx.commit().await.ok()?;

        Some(ClaimedJob {
            id: job_id,
            user_id: row.try_get("user_id").unwrap_or_default(),
            provider,
            account_name: row.try_get("account_name").unwrap_or_default(),
            payload_json: row.try_get("payload_json").unwrap_or_default(),
            listened_at: row.try_get("listened_at").unwrap_or(0),
            attempts: row.try_get("attempts").unwrap_or(0),
            lease_token,
            generation: row.try_get("generation").unwrap_or_default(),
        })
    }

    async fn deliver_job(&self, job: ClaimedJob) {
        let Ok(permit) = self.privacy.outbound_permit(PrivacyCategory::External) else {
            self.cancel_claimed(&job).await;
            return;
        };
        let conn = self.fetch_connection(&job.user_id, job.provider).await;
        let submission = async {
            let Some(ref c) = conn else {
                return Err(ScrobbleError::new(
                    "PAUSED",
                    "The account connection changed.",
                    FailureKind::Paused,
                    None,
                    0,
                ));
            };
            if !c.enabled || c.generation != job.generation || c.account_key != job.account_name {
                return Err(ScrobbleError::new(
                    "PAUSED",
                    "The account connection changed.",
                    FailureKind::Paused,
                    None,
                    0,
                ));
            }
            self.assert_available(job.provider).await?;
            let creds: Value =
                serde_json::from_str(&c.credentials_json).unwrap_or_else(|_| json!({}));
            let listen: ScrobbleListen = serde_json::from_str(&job.payload_json).map_err(|_| {
                ScrobbleError::new(
                    "INVALID_LISTEN",
                    "Queued listen payload is unreadable.",
                    FailureKind::Permanent,
                    None,
                    0,
                )
            })?;

            match job.provider {
                ScrobbleProvider::Lastfm => {
                    let sk = creds
                        .get("sessionKey")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    if let Some(ref s) = sk {
                        register_log_secret(s);
                    }
                    self.build_lastfm_scrobbler(sk)
                        .await?
                        .scrobble(&listen)
                        .await
                }
                ScrobbleProvider::Listenbrainz => {
                    let token = creds
                        .get("token")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    register_log_secret(token);
                    #[cfg(test)]
                    if let Some(endpoint) = &self.listenbrainz_endpoint {
                        return ListenBrainzScrobbler::with_base_url(token, endpoint)?
                            .scrobble(&listen)
                            .await;
                    }
                    ListenBrainzScrobbler::new(token)?.scrobble(&listen).await
                }
            }
        };
        let delivery_result: Result<(), ScrobbleError> = tokio::select! {
            biased;
            () = permit.cancelled() => { self.cancel_claimed(&job).await; return; },
            () = self.shutdown.cancelled() => { self.cancel_claimed(&job).await; return; },
            result = submission => result,
        };

        self.finish_delivery(job, delivery_result).await;
    }

    async fn finish_delivery(&self, job: ClaimedJob, delivery_result: Result<(), ScrobbleError>) {
        let Some(current) = self.fetch_connection(&job.user_id, job.provider).await else {
            return;
        };
        if current.generation != job.generation {
            return;
        }

        // A confirmed success is never rewritten as retryable after policy changes.
        let final_error = delivery_result.err();

        let Some(pool) = &self.db else {
            return;
        };
        let Ok(mut tx) = pool.inner().begin().await else {
            return;
        };

        let lease_valid = sqlx::query(
            "SELECT 1 FROM scrobble_queue WHERE id = ? AND lease_token = ? AND state = 'sending'",
        )
        .bind(&job.id)
        .bind(&job.lease_token)
        .fetch_optional(&mut *tx)
        .await
        .ok()
        .flatten()
        .is_some();

        if !lease_valid {
            return;
        }

        let now = Self::now_ms();
        match final_error {
            None => {
                let _ = sqlx::query(
                    r"
                    UPDATE scrobble_queue
                    SET state = 'sent',
                        delivered_at = ?,
                        lease_token = NULL,
                        lease_until = NULL,
                        error_code = NULL,
                        error_message = NULL,
                        http_status = NULL
                    WHERE id = ? AND lease_token = ?
                    ",
                )
                .bind(now)
                .bind(&job.id)
                .bind(&job.lease_token)
                .execute(&mut *tx)
                .await;

                let _ = sqlx::query(
                    r"
                    UPDATE scrobble_connections
                    SET status = 'connected',
                        last_success_at = ?,
                        last_listened_at = ?,
                        last_error_code = NULL,
                        last_error_message = NULL,
                        last_http_status = NULL,
                        pause_until = 0
                    WHERE user_id = ? AND provider = ? AND generation = ?
                    ",
                )
                .bind(now)
                .bind(job.listened_at)
                .bind(&job.user_id)
                .bind(job.provider.as_str())
                .bind(&job.generation)
                .execute(&mut *tx)
                .await;

                let _ = tx.commit().await;
            }
            Some(err) => {
                let attempts = job.attempts + i64::from(err.kind != FailureKind::Paused);
                let exp = 2_u64.pow((attempts.saturating_sub(1)).clamp(0, 12) as u32);
                let base_delay = (30_000_u64.saturating_mul(exp)).min(6 * 3_600_000);
                let delay_ms = err.retry_after_ms.max(base_delay);
                let next_state = match err.kind {
                    FailureKind::Paused => "pending",
                    FailureKind::Auth | FailureKind::Configuration => "blocked",
                    FailureKind::Ignored => "ignored",
                    FailureKind::Permanent => "failed",
                    FailureKind::Transient => {
                        if attempts >= SCROBBLE_MAX_ATTEMPTS {
                            "failed"
                        } else {
                            "pending"
                        }
                    }
                };
                let next_attempt_at = now
                    + if err.kind == FailureKind::Paused {
                        15_000
                    } else {
                        delay_ms as i64
                    };

                let _ = sqlx::query(
                    r"
                    UPDATE scrobble_queue
                    SET state = ?,
                        attempts = ?,
                        next_attempt_at = ?,
                        lease_token = NULL,
                        lease_until = NULL,
                        error_code = ?,
                        error_message = ?,
                        http_status = ?
                    WHERE id = ? AND lease_token = ?
                    ",
                )
                .bind(next_state)
                .bind(attempts)
                .bind(next_attempt_at)
                .bind(&err.code)
                .bind(&err.message)
                .bind(err.http_status.map(i64::from))
                .bind(&job.id)
                .bind(&job.lease_token)
                .execute(&mut *tx)
                .await;

                let _ = tx.commit().await;
                if err.kind != FailureKind::Paused {
                    let pause = if err.kind == FailureKind::Transient {
                        next_attempt_at
                    } else {
                        0
                    };
                    self.record_connection_error(&current, &err, pause).await;
                }
            }
        }
    }

    /// Drains up to 100 ready scrobble jobs sequentially per drain pass.
    pub async fn drain(&self) {
        let _generation = match &self.runtime_gate {
            Some(gate) => Some(gate.read().await),
            None => None,
        };
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        if !self.privacy.is_external_allowed(PrivacyCategory::External) {
            if !self.privacy.is_suspended()
                && let Err(err) = self.cancel_privacy_pending().await
            {
                tracing::error!(error = %err, "Could not flush restricted scrobbles");
            }
            return;
        }
        if self
            .draining
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        for _ in 0..100 {
            if self.stopped.load(Ordering::Acquire)
                || !self.privacy.is_external_allowed(PrivacyCategory::External)
            {
                break;
            }
            let Some(job) = self.claim_next_job().await else {
                break;
            };
            self.deliver_job(job).await;
        }

        self.draining.store(false, Ordering::Release);
    }

    /// Wakes the background worker to drain ready jobs immediately.
    pub fn kick(&self) {
        if !self.stopped.load(Ordering::Acquire) {
            self.wake.notify_one();
        }
    }

    /// Spawns the `tokio::time::interval(Duration::from_secs(15))` background worker loop.
    pub fn start_worker(&self) -> Option<tokio::task::JoinHandle<()>> {
        if self.stopped.load(Ordering::Acquire)
            || self
                .worker_started
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return None;
        }
        let queue = self.clone();
        Some(tokio::spawn(async move {
            let mut policy = queue.privacy.subscribe();
            let mut ticker =
                tokio::time::interval(Duration::from_millis(SCROBBLE_WORKER_INTERVAL_MS));
            while !queue.stopped.load(Ordering::Acquire) {
                tokio::select! {
                    _ = ticker.tick() => {},
                    () = queue.wake.notified() => {},
                    changed = policy.changed() => { if changed.is_err() { break; } },
                }
                if queue.stopped.load(Ordering::Acquire) {
                    break;
                }
                queue.drain().await;
            }
        }))
    }

    /// Stops the background scrobble worker gracefully.
    pub fn close(&self) {
        self.stopped.store(true, Ordering::Release);
        self.shutdown.cancel();
        self.wake.notify_one();
    }
}

#[cfg(test)]
mod privacy_tests;
