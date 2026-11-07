//! # Application & System Configuration (`config`)
//!
//! Complete Rust port of `server/src/config.ts` and `server/src/services/systemConfiguration.ts`.
//!
//! ## Priority & Resolution Order
//! [`AppConfig::load`] resolves runtime settings using a deterministic four-tier hierarchy:
//! 1. **Secret File Overrides (`<KEY>_FILE`)**: Physical secret files mounted into the
//!    container (e.g., `MUSICDECK_SESSION_SECRET_FILE`, `NAVIDROME_PASSWORD_FILE`,
//!    `JELLYFIN_API_KEY_FILE`, `MUSICDECK_ADMIN_PASSWORD_FILE`).
//! 2. **Environment Variables**: Process environment (and optional `.env` file in dev).
//! 3. **System Configuration Overrides (`config.json`)**: Persistent setup wizard
//!    overrides stored alongside the SQLite database (`backend`, `navidrome`, `jellyfin`,
//!    `music_root`, `acquisition_tmp_dir`), while keeping listener, database path,
//!    session secret, and first-admin bootstrap deployment-owned.
//! 4. **Static Default Fallbacks**: Safe development/container defaults.
//!
//! ## Dynamic `setup_required` Verification
//! Replicates `server/src/main.ts`: if core listener/session settings are valid but the
//! active media backend (`navidrome` or `jellyfin`) or initial database state is not yet
//! configured, [`AppConfig::load`] sets `setup_required = true` instead of aborting boot,
//! allowing administrators to complete onboarding via `/api/v1/admin/system/setup/*`.

pub mod network;
pub mod secrets;

use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

pub use network::{
    DEFAULT_HOST, DEFAULT_PORT, NetworkConfig, TrustedProxyEntry, parse_trusted_proxies,
    validate_clean_http_endpoint,
};
pub use secrets::{
    MAX_SECRET_FILE_BYTES, resolve_secret_from_file, resolve_secret_from_file_async,
    resolve_secret_with_env,
};

/// Type alias for [`MusicBackendKind`].
pub type BackendType = MusicBackendKind;

/// JavaScript `Number.MAX_SAFE_INTEGER` ($2^{53} - 1$), preserved for exact parity
/// with `Number.isSafeInteger` checks in `server/src/config.ts`.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Placeholder development session secret that [`AppConfig::validate`] rejects in production
/// and strict validation checks.
pub const DEFAULT_INSECURE_SESSION_SECRET: &str = "change-this-in-development";

/// Maximum permitted size (1 MiB) for the persistent `config.json` override file.
pub const MAX_SYSTEM_CONFIG_BYTES: u64 = 1024 * 1024;

/// Abstraction over environment variable lookups so unit tests can run deterministically
/// in parallel without mutating process-global `std::env` state.
pub trait EnvSource {
    /// Looks up the value of environment variable `key`.
    fn get_var(&self, key: &str) -> Option<String>;
}

/// Standard OS process environment reader.
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessEnv;

impl EnvSource for ProcessEnv {
    fn get_var(&self, key: &str) -> Option<String> {
        env::var(key).ok()
    }
}

impl EnvSource for HashMap<String, String> {
    fn get_var(&self, key: &str) -> Option<String> {
        self.get(key).cloned()
    }
}

/// Comprehensive error taxonomy for configuration parsing, secret loading, CIDR
/// validation, and persistent `config.json` overrides.
#[derive(Debug, Error)]
pub enum ConfigError {
    /// A required configuration variable is missing or set to an insecure placeholder.
    #[error("{0}")]
    MissingOrInsecure(String),

    /// A `<KEY>_FILE` secret file could not be opened or read.
    #[error("Failed to read secret file for {variable} at '{path}': {source}")]
    UnreadableSecretFile {
        /// Name of the `<KEY>_FILE` variable.
        variable: String,
        /// Path configured in `<KEY>_FILE`.
        path: PathBuf,
        /// Underlying filesystem error.
        #[source]
        source: std::io::Error,
    },

    /// A `<KEY>_FILE` secret file existed but contained only whitespace.
    #[error("Secret file for {variable} at '{path}' is empty")]
    EmptySecretFile {
        /// Name of the `<KEY>_FILE` variable.
        variable: String,
        /// Path configured in `<KEY>_FILE`.
        path: PathBuf,
    },

    /// Invalid IP address or CIDR block in `MUSICDECK_TRUSTED_PROXIES`.
    #[error("MUSICDECK_TRUSTED_PROXIES invalid entry '{entry}': {reason}")]
    InvalidTrustedProxy {
        /// Offending proxy token.
        entry: String,
        /// Human-readable rejection reason.
        reason: String,
    },

    /// Numeric configuration parameter was non-positive, non-integral, or exceeded safe bounds.
    #[error("{name} must be a positive safe integer (received '{value}')")]
    InvalidPositiveInteger {
        /// Environment variable or field name.
        name: String,
        /// Raw offending string value.
        value: String,
    },

    /// Invalid host IP address or TCP port.
    #[error("{0}")]
    InvalidListenerAddress(String),

    /// Invalid boolean flag value (e.g., `LOCAL_ONLY_MODE`).
    #[error("{name} must be true, false, 1 or 0 (received '{value}')")]
    InvalidBoolean {
        /// Environment variable name.
        name: String,
        /// Raw offending string value.
        value: String,
    },

    /// Invalid backend provider discriminant (`MUSIC_BACKEND`).
    #[error("MUSIC_BACKEND must be \"navidrome\" or \"jellyfin\" (received \"{0}\")")]
    InvalidBackend(String),

    /// Malformed or unsafe URL in backend or system configuration.
    #[error("{field} must be a valid URL: {reason}")]
    InvalidUrl {
        /// Configuration field or environment variable name.
        field: String,
        /// Detailed URL validation failure reason.
        reason: String,
    },

    /// Invalid or tampered `config.json` system override file.
    #[error("Invalid MusicDeck config.json file: {0}")]
    InvalidSystemConfigFile(String),

    /// Underlying filesystem I/O failure.
    #[error("Configuration I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Primary music library backend provider kind (`navidrome` or `jellyfin`).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MusicBackendKind {
    /// Subsonic/Navidrome upstream backend.
    #[default]
    Navidrome,
    /// Jellyfin upstream backend.
    Jellyfin,
}

impl MusicBackendKind {
    /// Parses `MUSIC_BACKEND` case-insensitively.
    pub fn parse_str(raw: &str) -> Result<Self, ConfigError> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "navidrome" => Ok(Self::Navidrome),
            "jellyfin" => Ok(Self::Jellyfin),
            other => Err(ConfigError::InvalidBackend(other.to_owned())),
        }
    }
}

/// Navidrome connection parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NavidromeConfig {
    /// Base HTTP(S) URL of the Navidrome instance (`NAVIDROME_URL`).
    pub url: String,
    /// Service account username (`NAVIDROME_USERNAME`).
    pub username: String,
    /// Service account password (`NAVIDROME_PASSWORD` or `NAVIDROME_PASSWORD_FILE`).
    pub password: String,
}

impl Default for NavidromeConfig {
    fn default() -> Self {
        Self {
            url: String::from("http://localhost:4533"),
            username: String::new(),
            password: String::new(),
        }
    }
}

/// Jellyfin connection parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JellyfinConfig {
    /// Base HTTP(S) URL of the Jellyfin instance (`JELLYFIN_URL`).
    pub url: String,
    /// Jellyfin API token (`JELLYFIN_API_KEY` or `JELLYFIN_API_KEY_FILE`).
    #[serde(rename = "apiKey")]
    pub api_key: String,
}

impl Default for JellyfinConfig {
    fn default() -> Self {
        Self {
            url: String::from("http://jellyfin:8096"),
            api_key: String::new(),
        }
    }
}

/// First-start administrator bootstrap credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FirstAdminConfig {
    /// Initial admin username (`MUSICDECK_ADMIN_USERNAME`, defaults to `"admin"`).
    pub username: String,
    /// Initial admin password (`MUSICDECK_ADMIN_PASSWORD` or `MUSICDECK_ADMIN_PASSWORD_FILE`).
    pub password: String,
}

impl Default for FirstAdminConfig {
    fn default() -> Self {
        Self {
            username: String::from("admin"),
            password: String::new(),
        }
    }
}

/// Fixed-window login rate-limiting bounds (`server/src/auth/login-rate-limiter.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRateLimitConfig {
    /// Sliding/fixed window duration in milliseconds (`MUSICDECK_LOGIN_WINDOW_MS`).
    pub window_ms: u64,
    /// Maximum login attempts per IP within `window_ms` (`MUSICDECK_LOGIN_IP_MAX`).
    pub ip_max: u64,
    /// Maximum login attempts per normalized username within `window_ms` (`MUSICDECK_LOGIN_ACCOUNT_MAX`).
    pub account_max: u64,
    /// Maximum concurrent in-flight password verifications (`MUSICDECK_LOGIN_MAX_CONCURRENT`).
    pub max_concurrent: u64,
    /// Maximum tracked rate-limit buckets in memory (`MUSICDECK_LOGIN_MAX_ENTRIES`, $\ge 2$).
    pub max_entries: u64,
}

impl Default for LoginRateLimitConfig {
    fn default() -> Self {
        Self {
            window_ms: 15 * 60 * 1000,
            ip_max: 20,
            account_max: 10,
            max_concurrent: 4,
            max_entries: 10_000,
        }
    }
}

/// Per-process acquisition queue, rate, retention, and SSE limits (`server/src/domain/acquisition-limits.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionLimits {
    /// Maximum globally pending/active acquisition jobs (`MUSICDECK_ACQUISITION_MAX_PENDING`).
    pub max_pending: u64,
    /// Maximum pending/active acquisition jobs per user (`MUSICDECK_ACQUISITION_MAX_PENDING_PER_USER`).
    pub max_pending_per_user: u64,
    /// Submission rate-limit window in milliseconds (`MUSICDECK_ACQUISITION_SUBMISSION_WINDOW_MS`).
    pub submission_window_ms: u64,
    /// Maximum job submissions per user per window (`MUSICDECK_ACQUISITION_SUBMISSIONS_PER_USER`).
    pub submissions_per_user: u64,
    /// Maximum job submissions globally per window (`MUSICDECK_ACQUISITION_SUBMISSIONS_GLOBAL`).
    pub submissions_global: u64,
    /// Maximum rate-limit buckets retained (`MUSICDECK_ACQUISITION_MAX_RATE_ENTRIES`).
    pub max_rate_entries: u64,
    /// Terminal job history retention period in milliseconds (`MUSICDECK_ACQUISITION_RETENTION_MS`).
    pub retention_ms: u64,
    /// Maximum retained terminal jobs (`MUSICDECK_ACQUISITION_MAX_RETAINED_JOBS`).
    pub max_retained_jobs: u64,
    /// Background cleanup interval in milliseconds (`MUSICDECK_ACQUISITION_CLEANUP_INTERVAL_MS`).
    pub cleanup_interval_ms: u64,
    /// Maximum concurrent acquisition SSE streams per user (`MUSICDECK_ACQUISITION_SSE_PER_USER`).
    pub sse_per_user: u64,
    /// Maximum concurrent acquisition SSE streams globally (`MUSICDECK_ACQUISITION_SSE_GLOBAL`).
    pub sse_global: u64,
}

impl Default for AcquisitionLimits {
    fn default() -> Self {
        Self {
            max_pending: 50,
            max_pending_per_user: 10,
            submission_window_ms: 60_000,
            submissions_per_user: 20,
            submissions_global: 100,
            max_rate_entries: 10_000,
            retention_ms: 7 * 24 * 60 * 60_000,
            max_retained_jobs: 1000,
            cleanup_interval_ms: 60_000,
            sse_per_user: 3,
            sse_global: 20,
        }
    }
}

/// SQLite database and derived filesystem layout configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabaseConfig {
    /// Path to the SQLite database file (`MUSICDECK_DB_PATH` or `MUSICDECK_DATABASE_PATH`),
    /// or `":memory:"` for ephemeral in-memory test databases.
    pub database_path: String,
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        Self {
            database_path: String::from("./data/musicdeck.sqlite"),
        }
    }
}

impl DatabaseConfig {
    /// Returns `true` if `database_path` points to a persistent file on disk rather than `":memory:"`.
    #[must_use]
    pub fn is_persistent(&self) -> bool {
        let trimmed = self.database_path.trim();
        !trimmed.is_empty() && trimmed != ":memory:"
    }

    /// Resolves the canonical sibling directories (`config.json`, `artwork`, `.recovery`, `backups`)
    /// matching `systemPaths()` in `server/src/services/systemConfiguration.ts`.
    #[must_use]
    pub fn system_paths(&self) -> SystemPaths {
        let db_path = Path::new(&self.database_path);
        let abs_db = if db_path.is_absolute() {
            db_path.to_path_buf()
        } else {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(db_path)
        };
        let root = abs_db
            .parent()
            .map_or_else(|| PathBuf::from("."), Path::to_path_buf);

        SystemPaths {
            configuration: root.join("config.json"),
            artwork: root.join("artwork"),
            recovery: root.join(".recovery"),
            backups: root.join("backups"),
            root,
            database: abs_db,
        }
    }
}

/// Resolved filesystem paths co-located with the SQLite database directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemPaths {
    /// Parent directory of the SQLite database file.
    pub root: PathBuf,
    /// Absolute path to the SQLite database file.
    pub database: PathBuf,
    /// Path to `config.json` containing setup wizard overrides.
    pub configuration: PathBuf,
    /// Path to imported artwork storage directory.
    pub artwork: PathBuf,
    /// Path to `.recovery` staging and journal directory.
    pub recovery: PathBuf,
    /// Path to `.tar.gz` system backup archives directory.
    pub backups: PathBuf,
}

/// Authentication, session cookie signing, and login rate-limiting configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthConfig {
    /// Secret key used for cookie signing and token HMACs (`MUSICDECK_SESSION_SECRET`).
    pub session_secret: String,
    /// Whether `Secure` cookie attribute is enforced (`MUSICDECK_SECURE_COOKIES`).
    pub secure_cookies: bool,
    /// First-start administrator account settings.
    pub first_admin: FirstAdminConfig,
    /// Fixed-window login rate limiter settings.
    pub login_rate_limit: LoginRateLimitConfig,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            session_secret: String::from(DEFAULT_INSECURE_SESSION_SECRET),
            secure_cookies: false,
            first_admin: FirstAdminConfig::default(),
            login_rate_limit: LoginRateLimitConfig::default(),
        }
    }
}

/// Persistent setup wizard configuration schema (`config.json` version 1)
/// matching `systemConfigurationSchema` in `server/src/services/systemConfiguration.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemOverrides {
    /// Schema version literal (must be `1`).
    pub version: u8,
    /// Selected primary media backend (`navidrome` or `jellyfin`).
    pub backend: MusicBackendKind,
    /// Navidrome connection settings saved by the setup wizard.
    pub navidrome: NavidromeConfig,
    /// Jellyfin connection settings saved by the setup wizard.
    pub jellyfin: JellyfinConfig,
    /// Root music library directory path.
    pub music_root: String,
    /// Temporary staging directory for in-progress downloads.
    pub acquisition_tmp_dir: String,
}

impl SystemOverrides {
    /// Validates all structural invariants of `config.json` (version = 1, clean HTTP(S)
    /// endpoints without credentials/query/fragment, non-empty paths without NUL bytes,
    /// and string length bounds).
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.version != 1 {
            return Err(ConfigError::InvalidSystemConfigFile(format!(
                "Unsupported config.json version {} (expected 1)",
                self.version
            )));
        }

        validate_clean_http_endpoint("navidrome.url", &self.navidrome.url)?;
        validate_clean_http_endpoint("jellyfin.url", &self.jellyfin.url)?;

        if self.navidrome.username.len() > 512 {
            return Err(ConfigError::InvalidSystemConfigFile(String::from(
                "navidrome.username exceeds 512 characters",
            )));
        }
        if self.navidrome.password.len() > 4096 {
            return Err(ConfigError::InvalidSystemConfigFile(String::from(
                "navidrome.password exceeds 4096 characters",
            )));
        }
        if self.jellyfin.api_key.len() > 4096 {
            return Err(ConfigError::InvalidSystemConfigFile(String::from(
                "jellyfin.apiKey exceeds 4096 characters",
            )));
        }

        validate_non_null_path("musicRoot", &self.music_root)?;
        validate_non_null_path("acquisitionTmpDir", &self.acquisition_tmp_dir)?;

        Ok(())
    }
}

fn validate_non_null_path(field: &str, value: &str) -> Result<(), ConfigError> {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        return Err(ConfigError::InvalidSystemConfigFile(format!(
            "{field} must be 1..=4096 characters and must not contain NUL bytes"
        )));
    }
    Ok(())
}

/// Unified, immutable application configuration shared across threads via `Arc<AppConfig>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppConfig {
    /// Network listener, CORS, local-only mode, and trusted proxy settings.
    pub network: NetworkConfig,
    /// SQLite database path and sibling directory layout.
    pub database: DatabaseConfig,
    /// Session secret, cookie flags, initial admin, and login rate-limit bounds.
    pub auth: AuthConfig,
    /// Active music backend provider (`navidrome` or `jellyfin`).
    pub backend: MusicBackendKind,
    /// Navidrome provider credentials and endpoint.
    pub navidrome: NavidromeConfig,
    /// Jellyfin provider credentials and endpoint.
    pub jellyfin: JellyfinConfig,
    /// Acquisition concurrency, rate, and retention limits.
    pub acquisition_limits: AcquisitionLimits,
    /// Directory containing trusted server extensions (`MUSICDECK_EXTENSIONS_DIR`).
    pub extensions_dir: String,
    /// Root folder where music files are stored and scanned (`MUSICDECK_MUSIC_ROOT`).
    pub music_root: String,
    /// Subdirectory under `music_root` for Spotify imports (`MUSICDECK_SPOTIFY_IMPORT_SUBDIR`).
    pub spotify_import_subdir: String,
    /// Temporary download staging directory (`MUSICDECK_ACQUISITION_TMP_DIR`).
    pub acquisition_tmp_dir: String,
    /// True when `NODE_ENV=production` or `MUSICDECK_ENV=production`.
    pub is_production: bool,
    /// Dynamic onboarding flag set to `true` when backend credentials or initial
    /// database state require interactive setup via the System Health / Setup Wizard.
    pub setup_required: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            network: NetworkConfig::default(),
            database: DatabaseConfig::default(),
            auth: AuthConfig::default(),
            backend: MusicBackendKind::Navidrome,
            navidrome: NavidromeConfig::default(),
            jellyfin: JellyfinConfig::default(),
            acquisition_limits: AcquisitionLimits::default(),
            extensions_dir: String::from("./extensions"),
            music_root: String::from("./data/music"),
            spotify_import_subdir: String::from("Spotify Imports"),
            acquisition_tmp_dir: String::from("./data/acquisitions/tmp"),
            is_production: false,
            setup_required: true,
        }
    }
}

impl AppConfig {
    /// Loads configuration from `.env` (if present in development), process environment
    /// variables, `<KEY>_FILE` secret files, and persistent `config.json` overrides.
    pub fn load() -> Result<Self, ConfigError> {
        let _ = dotenvy::dotenv();
        Self::load_from_source(&ProcessEnv)
    }

    /// Loads configuration from ProcessEnv without validating backend readiness, matching
    /// `loadConfig()` in `server/src/config.ts`.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::load()
    }

    /// Loads configuration from an arbitrary [`EnvSource`] (such as a test `HashMap`),
    /// applies secret file overrides and `config.json` system overrides, and computes
    /// the dynamic `setup_required` state.
    pub fn load_from_source<E: EnvSource>(env: &E) -> Result<Self, ConfigError> {
        let deployment = Self::parse_deployment_env(env)?;
        let merged = apply_system_configuration(deployment)?;
        Ok(merged.with_evaluated_setup_state())
    }

    /// Loads configuration from an iterator of `(key, value)` pairs.
    pub fn load_from_iter<I, K, V>(iter: I) -> Result<Self, ConfigError>
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let map: HashMap<String, String> = iter
            .into_iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        Self::load_from_source(&map)
    }

    /// Parses raw environment variables and `<KEY>_FILE` secret files prior to
    /// merging `config.json` system overrides.
    pub fn parse_deployment_env<E: EnvSource>(env: &E) -> Result<Self, ConfigError> {
        let is_production = env
            .get_var("MUSICDECK_ENV")
            .or_else(|| env.get_var("NODE_ENV"))
            .is_some_and(|val| val.trim().eq_ignore_ascii_case("production"));

        let local_only_raw = read_env(env, "LOCAL_ONLY_MODE", "false").to_ascii_lowercase();
        let local_only_mode = match local_only_raw.as_str() {
            "true" | "1" => true,
            "false" | "0" => false,
            _ => {
                return Err(ConfigError::InvalidBoolean {
                    name: String::from("LOCAL_ONLY_MODE"),
                    value: local_only_raw,
                });
            }
        };

        let (host, port) = parse_listener_addr(env)?;
        let public_url = read_env(env, "MUSICDECK_PUBLIC_URL", "http://localhost:4534");
        let cors_origin = read_env(env, "MUSICDECK_CORS_ORIGIN", "http://localhost:3000");
        let trusted_proxies =
            parse_trusted_proxies(&read_env(env, "MUSICDECK_TRUSTED_PROXIES", ""))?;

        let database_path = env
            .get_var("MUSICDECK_DB_PATH")
            .filter(|v| !v.is_empty())
            .or_else(|| {
                env.get_var("MUSICDECK_DATABASE_PATH")
                    .filter(|v| !v.is_empty())
            })
            .unwrap_or_else(|| String::from("./data/musicdeck.sqlite"));

        let session_secret = resolve_secret_with_env(
            env,
            "MUSICDECK_SESSION_SECRET",
            DEFAULT_INSECURE_SESSION_SECRET,
        )?;

        let secure_cookies = match read_env(env, "MUSICDECK_SECURE_COOKIES", "").as_str() {
            "true" => true,
            "false" => false,
            _ => is_production,
        };

        let defaults_login = LoginRateLimitConfig::default();
        let login_rate_limit = LoginRateLimitConfig {
            window_ms: read_positive_int(
                env,
                "MUSICDECK_LOGIN_WINDOW_MS",
                defaults_login.window_ms,
            )?,
            ip_max: read_positive_int(env, "MUSICDECK_LOGIN_IP_MAX", defaults_login.ip_max)?,
            account_max: read_positive_int(
                env,
                "MUSICDECK_LOGIN_ACCOUNT_MAX",
                defaults_login.account_max,
            )?,
            max_concurrent: read_positive_int(
                env,
                "MUSICDECK_LOGIN_MAX_CONCURRENT",
                defaults_login.max_concurrent,
            )?,
            max_entries: {
                let entries = read_positive_int(
                    env,
                    "MUSICDECK_LOGIN_MAX_ENTRIES",
                    defaults_login.max_entries,
                )?;
                if entries < 2 {
                    return Err(ConfigError::InvalidPositiveInteger {
                        name: String::from("MUSICDECK_LOGIN_MAX_ENTRIES"),
                        value: entries.to_string(),
                    });
                }
                entries
            },
        };

        let defaults_acq = AcquisitionLimits::default();
        let acquisition_limits = AcquisitionLimits {
            max_pending: read_positive_int(
                env,
                "MUSICDECK_ACQUISITION_MAX_PENDING",
                defaults_acq.max_pending,
            )?,
            max_pending_per_user: read_positive_int(
                env,
                "MUSICDECK_ACQUISITION_MAX_PENDING_PER_USER",
                defaults_acq.max_pending_per_user,
            )?,
            submission_window_ms: read_positive_int(
                env,
                "MUSICDECK_ACQUISITION_SUBMISSION_WINDOW_MS",
                defaults_acq.submission_window_ms,
            )?,
            submissions_per_user: read_positive_int(
                env,
                "MUSICDECK_ACQUISITION_SUBMISSIONS_PER_USER",
                defaults_acq.submissions_per_user,
            )?,
            submissions_global: read_positive_int(
                env,
                "MUSICDECK_ACQUISITION_SUBMISSIONS_GLOBAL",
                defaults_acq.submissions_global,
            )?,
            max_rate_entries: read_positive_int(
                env,
                "MUSICDECK_ACQUISITION_MAX_RATE_ENTRIES",
                defaults_acq.max_rate_entries,
            )?,
            retention_ms: read_positive_int(
                env,
                "MUSICDECK_ACQUISITION_RETENTION_MS",
                defaults_acq.retention_ms,
            )?,
            max_retained_jobs: read_positive_int(
                env,
                "MUSICDECK_ACQUISITION_MAX_RETAINED_JOBS",
                defaults_acq.max_retained_jobs,
            )?,
            cleanup_interval_ms: read_positive_int(
                env,
                "MUSICDECK_ACQUISITION_CLEANUP_INTERVAL_MS",
                defaults_acq.cleanup_interval_ms,
            )?,
            sse_per_user: read_positive_int(
                env,
                "MUSICDECK_ACQUISITION_SSE_PER_USER",
                defaults_acq.sse_per_user,
            )?,
            sse_global: read_positive_int(
                env,
                "MUSICDECK_ACQUISITION_SSE_GLOBAL",
                defaults_acq.sse_global,
            )?,
        };

        let backend_raw = env
            .get_var("MUSIC_BACKEND")
            .filter(|v| !v.is_empty())
            .or_else(|| env.get_var("MUSICDECK_BACKEND").filter(|v| !v.is_empty()))
            .unwrap_or_else(|| String::from("navidrome"));
        let backend = MusicBackendKind::parse_str(&backend_raw)?;

        let navidrome = NavidromeConfig {
            url: read_env(env, "NAVIDROME_URL", "http://localhost:4533"),
            username: read_env(env, "NAVIDROME_USERNAME", ""),
            password: resolve_secret_with_env(env, "NAVIDROME_PASSWORD", "")?,
        };

        let jellyfin = JellyfinConfig {
            url: read_env(env, "JELLYFIN_URL", "http://jellyfin:8096"),
            api_key: resolve_secret_with_env(env, "JELLYFIN_API_KEY", "")?,
        };

        let first_admin = FirstAdminConfig {
            username: read_env(env, "MUSICDECK_ADMIN_USERNAME", "admin"),
            password: resolve_secret_with_env(env, "MUSICDECK_ADMIN_PASSWORD", "")?,
        };

        Ok(Self {
            network: NetworkConfig {
                host,
                port,
                public_url,
                cors_origin,
                local_only_mode,
                trusted_proxies,
            },
            database: DatabaseConfig { database_path },
            auth: AuthConfig {
                session_secret,
                secure_cookies,
                first_admin,
                login_rate_limit,
            },
            backend,
            navidrome,
            jellyfin,
            acquisition_limits,
            extensions_dir: read_env(env, "MUSICDECK_EXTENSIONS_DIR", "./extensions"),
            music_root: read_env(env, "MUSICDECK_MUSIC_ROOT", "./data/music"),
            spotify_import_subdir: read_env(
                env,
                "MUSICDECK_SPOTIFY_IMPORT_SUBDIR",
                "Spotify Imports",
            ),
            acquisition_tmp_dir: read_env(
                env,
                "MUSICDECK_ACQUISITION_TMP_DIR",
                "./data/acquisitions/tmp",
            ),
            is_production,
            setup_required: false,
        })
    }

    /// Validates both core deployment settings and active media backend credentials,
    /// matching `validateConfig(config)` in `server/src/config.ts`.
    pub fn validate(&self) -> Result<(), ConfigError> {
        self.validate_core()?;
        self.validate_backend()
    }

    /// Validates deployment-owned listener, database path, and session secret invariants
    /// that must hold even when `setup_required = true`.
    pub fn validate_core(&self) -> Result<(), ConfigError> {
        if self.network.port == 0 {
            return Err(ConfigError::InvalidListenerAddress(String::from(
                "MUSICDECK_PORT must be a valid TCP port",
            )));
        }

        if self.database.database_path.trim().is_empty() {
            return Err(ConfigError::MissingOrInsecure(String::from(
                "MUSICDECK_DB_PATH is required",
            )));
        }

        if self.auth.session_secret.trim().is_empty()
            || self.auth.session_secret == DEFAULT_INSECURE_SESSION_SECRET
        {
            return Err(ConfigError::MissingOrInsecure(String::from(
                "MUSICDECK_SESSION_SECRET must be set to a non-default value",
            )));
        }

        Ok(())
    }

    /// Validates only the selected primary backend's URL and credentials.
    pub fn validate_backend(&self) -> Result<(), ConfigError> {
        match self.backend {
            MusicBackendKind::Jellyfin => {
                Url::parse(&self.jellyfin.url).map_err(|err| ConfigError::InvalidUrl {
                    field: String::from("JELLYFIN_URL"),
                    reason: err.to_string(),
                })?;

                if self.jellyfin.api_key.trim().is_empty() {
                    return Err(ConfigError::MissingOrInsecure(String::from(
                        "JELLYFIN_API_KEY is required when MUSIC_BACKEND=jellyfin",
                    )));
                }
            }
            MusicBackendKind::Navidrome => {
                Url::parse(&self.navidrome.url).map_err(|err| ConfigError::InvalidUrl {
                    field: String::from("NAVIDROME_URL"),
                    reason: err.to_string(),
                })?;

                if self.navidrome.username.trim().is_empty() {
                    return Err(ConfigError::MissingOrInsecure(String::from(
                        "NAVIDROME_USERNAME is required",
                    )));
                }

                if self.navidrome.password.trim().is_empty() {
                    return Err(ConfigError::MissingOrInsecure(String::from(
                        "NAVIDROME_PASSWORD is required",
                    )));
                }
            }
        }

        Ok(())
    }

    /// Evaluates whether the server must boot into dynamic setup mode (`setup_required = true`).
    ///
    /// Matches `server/src/main.ts` and `setup-recovery.ts`:
    /// - If `validate_backend()` fails (e.g., Navidrome/Jellyfin credentials are not yet
    ///   supplied), or
    /// - If the persistent SQLite database file does not exist yet on disk and no initial
    ///   admin password was provided,
    /// then `setup_required` is set to `true`.
    #[must_use]
    pub fn with_evaluated_setup_state(mut self) -> Self {
        let backend_unconfigured = self.validate_backend().is_err();
        let db_missing_on_disk = self.database.is_persistent()
            && !Path::new(&self.database.database_path).exists()
            && self.auth.first_admin.password.trim().is_empty();

        self.setup_required = backend_unconfigured || db_missing_on_disk;
        self
    }

    /// Produces a [`SystemOverrides`] snapshot of the current backend and media paths,
    /// matching `configurationSnapshot(config)` in `systemConfiguration.ts`.
    #[must_use]
    pub fn configuration_snapshot(&self) -> SystemOverrides {
        SystemOverrides {
            version: 1,
            backend: self.backend,
            navidrome: self.navidrome.clone(),
            jellyfin: self.jellyfin.clone(),
            music_root: self.music_root.clone(),
            acquisition_tmp_dir: self.acquisition_tmp_dir.clone(),
        }
    }

    /// Convenience accessor for the listener [`SocketAddr`].
    #[must_use]
    pub const fn socket_addr(&self) -> SocketAddr {
        self.network.socket_addr()
    }

    /// Convenience accessor for the listener host [`IpAddr`].
    #[must_use]
    pub const fn host(&self) -> IpAddr {
        self.network.host
    }

    /// Convenience accessor for the listener TCP port.
    #[must_use]
    pub const fn port(&self) -> u16 {
        self.network.port
    }

    /// Convenience accessor for the allowed CORS origin.
    #[must_use]
    pub fn cors_origin(&self) -> &str {
        &self.network.cors_origin
    }

    /// Convenience accessor for the SQLite database path.
    #[must_use]
    pub fn database_path(&self) -> &str {
        &self.database.database_path
    }

    /// Convenience accessor for `local_only_mode`.
    #[must_use]
    pub const fn local_only_mode(&self) -> bool {
        self.network.local_only_mode
    }
}

/// Applies saved setup wizard values from `<db_dir>/config.json` over deployment defaults,
/// matching `applySystemConfiguration()` in `server/src/services/systemConfiguration.ts`.
///
/// Listener address, database path, session secret, and initial administrator credentials
/// remain deployment-owned and cannot be overwritten by `config.json`.
pub fn apply_system_configuration(mut config: AppConfig) -> Result<AppConfig, ConfigError> {
    if !config.database.is_persistent() {
        return Ok(config);
    }

    let config_file = config.database.system_paths().configuration;
    if !config_file.exists() {
        return Ok(config);
    }

    let metadata = fs::symlink_metadata(&config_file).map_err(|err| {
        ConfigError::InvalidSystemConfigFile(format!("Could not stat config.json: {err}"))
    })?;

    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_SYSTEM_CONFIG_BYTES
    {
        return Err(ConfigError::InvalidSystemConfigFile(String::from(
            "config.json must be a regular non-symlink file under 1 MiB",
        )));
    }

    let raw = fs::read_to_string(&config_file).map_err(|err| {
        ConfigError::InvalidSystemConfigFile(format!("Could not read config.json: {err}"))
    })?;

    let saved: SystemOverrides = serde_json::from_str(&raw).map_err(|err| {
        ConfigError::InvalidSystemConfigFile(format!("Malformed JSON in config.json: {err}"))
    })?;
    saved.validate()?;

    config.backend = saved.backend;
    config.navidrome = saved.navidrome;
    config.jellyfin = saved.jellyfin;
    config.music_root = saved.music_root;
    config.acquisition_tmp_dir = saved.acquisition_tmp_dir;

    Ok(config)
}

/// Atomically writes a JSON serializable value to `file_path` via a sibling `.tmp` file
/// with `fsync` before rename, matching `durableJson()` in `systemConfiguration.ts`.
pub fn durable_json<T: Serialize>(file_path: &Path, value: &T) -> Result<(), ConfigError> {
    let serialized = serde_json::to_vec_pretty(value).map_err(|err| {
        ConfigError::InvalidSystemConfigFile(format!("Failed to serialize JSON: {err}"))
    })?;
    durable_bytes(file_path, &serialized)?;
    Ok(())
}

pub(crate) fn durable_bytes(file_path: &Path, content: &[u8]) -> std::io::Result<()> {
    let parent = file_path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid target path")
    })?;
    fs::create_dir_all(parent)?;

    let temp_path = file_path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let write_result = (|| -> Result<(), std::io::Error> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        file.write_all(content)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp_path, file_path)?;
        sync_directory(parent)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    write_result
}

/// Flushes directory metadata entries to disk on Unix platforms.
/// No-op on Windows where directory handles cannot be opened with standard `File::open`.
pub fn sync_directory(directory: &Path) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        let dir_handle = fs::File::open(directory)?;
        dir_handle.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
    }
    Ok(())
}

fn read_env<E: EnvSource>(env: &E, name: &str, fallback: &str) -> String {
    env.get_var(name)
        .filter(|val| !val.is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

fn read_positive_int<E: EnvSource>(env: &E, name: &str, fallback: u64) -> Result<u64, ConfigError> {
    let raw = read_env(env, name, &fallback.to_string());
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ConfigError::InvalidPositiveInteger {
            name: name.to_owned(),
            value: raw,
        });
    }

    let parsed: u64 = trimmed
        .parse()
        .map_err(|_| ConfigError::InvalidPositiveInteger {
            name: name.to_owned(),
            value: raw.clone(),
        })?;

    if parsed == 0 || parsed > MAX_SAFE_INTEGER {
        return Err(ConfigError::InvalidPositiveInteger {
            name: name.to_owned(),
            value: raw,
        });
    }

    Ok(parsed)
}

fn parse_listener_addr<E: EnvSource>(env: &E) -> Result<(IpAddr, u16), ConfigError> {
    if let Some(bind_addr) = env
        .get_var("MUSICDECK_BIND_ADDR")
        .filter(|v| !v.trim().is_empty())
    {
        let sock: SocketAddr = bind_addr.trim().parse().map_err(|err| {
            ConfigError::InvalidListenerAddress(format!(
                "Invalid MUSICDECK_BIND_ADDR '{}': {err}",
                bind_addr.trim()
            ))
        })?;
        if sock.port() == 0 {
            return Err(ConfigError::InvalidListenerAddress(String::from(
                "MUSICDECK_PORT must be a valid TCP port",
            )));
        }
        return Ok((sock.ip(), sock.port()));
    }

    let raw_host = env
        .get_var("MUSICDECK_HOST")
        .filter(|v| !v.trim().is_empty())
        .or_else(|| env.get_var("HOST").filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| DEFAULT_HOST.to_string());
    let host: IpAddr = raw_host.trim().parse().map_err(|err| {
        ConfigError::InvalidListenerAddress(format!(
            "MUSICDECK_HOST '{}' is not a valid IP address: {err}",
            raw_host.trim()
        ))
    })?;

    let raw_port = env
        .get_var("MUSICDECK_PORT")
        .filter(|v| !v.trim().is_empty())
        .or_else(|| env.get_var("PORT").filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| DEFAULT_PORT.to_string());
    let port: u16 = raw_port.trim().parse().map_err(|_| {
        ConfigError::InvalidListenerAddress(String::from("MUSICDECK_PORT must be a valid TCP port"))
    })?;

    if port == 0 {
        return Err(ConfigError::InvalidListenerAddress(String::from(
            "MUSICDECK_PORT must be a valid TCP port",
        )));
    }

    Ok((host, port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn base_valid_env() -> HashMap<String, String> {
        HashMap::from([
            (
                String::from("MUSICDECK_DB_PATH"),
                String::from(":memory:"),
            ),
            (
                String::from("MUSICDECK_SESSION_SECRET"),
                String::from("local-production-secret-key"),
            ),
            (
                String::from("NAVIDROME_URL"),
                String::from("http://navidrome:4533"),
            ),
            (
                String::from("NAVIDROME_USERNAME"),
                String::from("service-user"),
            ),
            (
                String::from("NAVIDROME_PASSWORD"),
                String::from("service-password"),
            ),
        ])
    }

    #[test]
    fn validates_acquisition_and_login_rate_bounds() {
        let mut env = base_valid_env();
        env.insert(
            String::from("MUSICDECK_ACQUISITION_MAX_PENDING"),
            String::from("7"),
        );
        env.insert(String::from("MUSICDECK_LOGIN_IP_MAX"), String::from("12"));

        let cfg = AppConfig::load_from_source(&env).expect("valid config");
        assert_eq!(cfg.acquisition_limits.max_pending, 7);
        assert_eq!(cfg.auth.login_rate_limit.ip_max, 12);

        for invalid in ["0", "-1", "NaN", "1.5", "9007199254740992"] {
            env.insert(
                String::from("MUSICDECK_ACQUISITION_MAX_PENDING"),
                invalid.to_owned(),
            );
            let err = AppConfig::load_from_source(&env).unwrap_err();
            assert!(
                err.to_string()
                    .contains("MUSICDECK_ACQUISITION_MAX_PENDING"),
                "expected error mentioning variable for input {invalid}, got: {err}"
            );
        }
    }

    #[test]
    fn parses_trusted_proxies_and_rejects_wildcard_or_malformed_cidrs() {
        let mut env = base_valid_env();
        env.insert(
            String::from("MUSICDECK_TRUSTED_PROXIES"),
            String::from("127.0.0.1, 10.20.0.0/24, ::1"),
        );

        let cfg = AppConfig::load_from_source(&env).expect("valid trusted proxies");
        assert_eq!(
            cfg.network.trusted_proxy_strings(),
            vec!["127.0.0.1", "10.20.0.0/24", "::1"]
        );
        assert!(cfg.network.is_trusted_proxy(&IpAddr::V4(Ipv4Addr::new(10, 20, 0, 99))));
        assert!(!cfg.network.is_trusted_proxy(&IpAddr::V4(Ipv4Addr::new(10, 21, 0, 1))));

        for unsafe_proxy in [
            "true",
            "*",
            "0.0.0.0/0",
            "::/0",
            "10.0.0.1/33",
            "localhost",
            "127.0.0.1/",
        ] {
            env.insert(
                String::from("MUSICDECK_TRUSTED_PROXIES"),
                unsafe_proxy.to_owned(),
            );
            let err = AppConfig::load_from_source(&env).unwrap_err();
            assert!(
                err.to_string().contains("MUSICDECK_TRUSTED_PROXIES"),
                "expected MUSICDECK_TRUSTED_PROXIES rejection for '{unsafe_proxy}', got: {err}"
            );
        }
    }

    #[test]
    fn resolves_secrets_from_file_and_strips_newlines() {
        let temp_dir = env::temp_dir().join(format!("musicdeck-secret-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let session_secret_file = temp_dir.join("session_secret.txt");
        let navidrome_pw_file = temp_dir.join("navidrome_password.txt");
        fs::write(&session_secret_file, "file-session-secret\r\n").expect("write session secret");
        fs::write(&navidrome_pw_file, "file-navidrome-password\n").expect("write navidrome pw");

        let mut env = base_valid_env();
        env.insert(
            String::from("MUSICDECK_SESSION_SECRET"),
            String::from("ignored-env-secret"),
        );
        env.insert(
            String::from("MUSICDECK_SESSION_SECRET_FILE"),
            session_secret_file.to_string_lossy().into_owned(),
        );
        env.insert(
            String::from("NAVIDROME_PASSWORD_FILE"),
            navidrome_pw_file.to_string_lossy().into_owned(),
        );

        let cfg = AppConfig::load_from_source(&env).expect("load config with secret files");
        assert_eq!(cfg.auth.session_secret, "file-session-secret");
        assert_eq!(cfg.navidrome.password, "file-navidrome-password");

        // Missing secret file must fail loudly
        env.insert(
            String::from("MUSICDECK_SESSION_SECRET_FILE"),
            temp_dir.join("nonexistent.secret").to_string_lossy().into_owned(),
        );
        let err = AppConfig::load_from_source(&env).unwrap_err();
        assert!(matches!(err, ConfigError::UnreadableSecretFile { .. }));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn toggles_setup_required_when_backend_credentials_missing_and_applies_system_overrides() {
        let temp_dir = env::temp_dir().join(format!("musicdeck-sysconfig-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        let db_path = temp_dir.join("musicdeck.sqlite");

        // 1. Unconfigured Navidrome credentials -> setup_required = true, core validation passes
        let mut env = HashMap::from([
            (
                String::from("MUSICDECK_DB_PATH"),
                db_path.to_string_lossy().into_owned(),
            ),
            (
                String::from("MUSICDECK_SESSION_SECRET"),
                String::from("valid-secret"),
            ),
            (
                String::from("MUSICDECK_ADMIN_PASSWORD"),
                String::from("admin-pass"),
            ),
        ]);

        let unconfigured = AppConfig::load_from_source(&env).expect("loads in setup mode");
        assert!(unconfigured.setup_required);
        assert!(unconfigured.validate_core().is_ok());
        assert!(unconfigured.validate().is_err());

        // 2. Write config.json system override switching backend to Jellyfin with valid API key
        let overrides = SystemOverrides {
            version: 1,
            backend: MusicBackendKind::Jellyfin,
            navidrome: NavidromeConfig {
                url: String::from("http://navidrome:4533"),
                username: String::new(),
                password: String::new(),
            },
            jellyfin: JellyfinConfig {
                url: String::from("http://jellyfin:8096"),
                api_key: String::from("jf-api-token-123"),
            },
            music_root: String::from("/mnt/music"),
            acquisition_tmp_dir: String::from("/mnt/music/.tmp"),
        };
        durable_json(&temp_dir.join("config.json"), &overrides).expect("write config.json");

        let overridden = AppConfig::load_from_source(&env).expect("loads with config.json");
        assert_eq!(overridden.backend, MusicBackendKind::Jellyfin);
        assert_eq!(overridden.jellyfin.api_key, "jf-api-token-123");
        assert_eq!(overridden.music_root, "/mnt/music");
        assert!(!overridden.setup_required);
        assert!(overridden.validate().is_ok());

        // 3. Default insecure session secret must fail validate_core()
        env.insert(
            String::from("MUSICDECK_SESSION_SECRET"),
            String::from(DEFAULT_INSECURE_SESSION_SECRET),
        );
        let insecure = AppConfig::load_from_source(&env).expect("loads config struct");
        assert!(insecure.validate_core().is_err());

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
