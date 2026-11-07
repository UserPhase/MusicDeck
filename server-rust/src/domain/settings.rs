//! # Hierarchical Server & User Settings Domain (`domain::settings`)
//!
//! Complete Rust port of `server/src/domain/settings.ts` and the cron schedule
//! validation rules from `server/src/services/scannerScheduler.ts`.
//!
//! ## Key Capabilities
//! 1. **Allowlisted User & Server Settings**:
//!    - Only keys in [`ALLOWED_USER_SETTINGS`] (22 keys) and [`ALLOWED_SERVER_SETTINGS`]
//!      are persisted; unknown keys are silently ignored by [`update_user_settings`] /
//!      [`update_server_settings`], while strict route schemas validate values before write.
//! 2. **Strict Value Validation**:
//!    - `ui.theme`: `"dark"` | `"light"`
//!    - `ui.layoutPreset`: `"spotify"` | `"apple"` | `"ytmusic"` | `"soundcloud"`
//!    - `playback.normalization.targetLufs`: `-18` | `-16` | `-14`
//!    - `playback.shuffleMode`: `"standard"` | `"smart"`
//!    - `playback.albumAware`: `bool`
//!    - `playback.streamQuality`: `"128"` | `"256"` | `"320"` | `"original"` | `"direct"`
//!    - `playback.downloadQuality`: `"lossless"` | `"320kbps"` | `"256kbps"` | `"192kbps"` | `"128kbps"`
//!    - `listening.thresholdSeconds`: finite number in `1.0..=240.0`
//!    - `library.scanSchedule`: 5-field cron expression or disabled alias (`""`, `"disabled"`, `"manual"`, `"none"`, `"off"`, `"never"`, `"not scheduled"`).
//! 3. **Public Branding (`branding.appName`)**:
//!    - Defaults to `"MusicDeck"`, validated to `1..=40` trimmed characters without ASCII control characters (`0x00..=0x1F`, `0x7F`).

use std::collections::HashSet;
use std::sync::LazyLock;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::{Row, Sqlite, SqliteConnection};
use thiserror::Error;

use crate::db::DbPool;
use crate::tasks::TaskType;
use crate::tasks::manager::{delete_schedule, upsert_schedule};
use crate::tasks::scheduler::{CronValidation, validate_scan_schedule as validate_cron};

/// Default public branding name (`"MusicDeck"`).
pub const DEFAULT_APP_NAME: &str = "MusicDeck";

/// Maximum length in characters for `branding.appName`.
pub const APP_NAME_MAX_LENGTH: usize = 40;

/// SQLite `server_settings` key storing the application branding name.
pub const APP_NAME_SETTING_KEY: &str = "branding.appName";

/// SQLite `server_settings` key storing the library scan cron schedule.
pub const SCAN_SCHEDULE_SETTING_KEY: &str = "library.scanSchedule";

/// Allowed LUFS targets for loudness normalization.
pub const NORMALIZATION_TARGETS: [i64; 3] = [-18, -16, -14];

/// Allowed UI layout presets.
pub const LAYOUT_PRESETS: [&str; 4] = ["spotify", "apple", "ytmusic", "soundcloud"];

/// Allowed user setting keys matching `ALLOWED_USER_SETTINGS` in `server/src/domain/settings.ts`.
pub static ALLOWED_USER_SETTINGS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    HashSet::from([
        "playback.defaultVolume",
        "ui.compactLists",
        "catalog.sourceMode",
        "playback.sourcePreference",
        "acquisition.enabled",
        "acquisition.provider",
        "acquisition.autoScan",
        "playback.silenceTrim.enabled",
        "playback.silenceTrim.thresholdDb",
        "playback.silenceTrim.minSilenceSeconds",
        "playback.crossfadeDuration",
        "playback.transitionMode",
        "playback.shuffleMode",
        "playback.albumAware",
        "playback.streamQuality",
        "playback.downloadQuality",
        "playback.replayGain.enabled",
        "playback.normalization.enabled",
        "playback.normalization.targetLufs",
        "playback.autoplay.enabled",
        "ui.theme",
        "ui.layoutDensity",
        "ui.accentColor",
        "ui.autoOpenSidebar",
        "ui.layoutPreset",
    ])
});

/// Allowed server setting keys matching `ALLOWED_SERVER_SETTINGS` in `server/src/domain/settings.ts`.
pub static ALLOWED_SERVER_SETTINGS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    HashSet::from([
        "library.scanSchedule",
        "jobs.maxConcurrency",
        "acquisition.maxConcurrentDownloads",
        "acquisition.autoScanLibrary",
    ])
});

/// Single persisted setting row from `user_settings` or `server_settings`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingRecord {
    /// Setting key (e.g., `"ui.theme"`).
    pub key: String,
    /// JSON-serialized setting value string.
    pub value: String,
    /// ISO-8601 UTC timestamp of last update.
    pub updated_at: String,
}

/// Public branding configuration returned by `GET /api/public/config` and `PATCH /api/admin/config`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicAppConfig {
    /// Display name of the MusicDeck instance (`1..=40` chars, no control chars).
    pub app_name: String,
}

impl Default for PublicAppConfig {
    fn default() -> Self {
        Self {
            app_name: String::from(DEFAULT_APP_NAME),
        }
    }
}

/// Error taxonomy for settings and branding validation/persistence.
#[derive(Debug, Error)]
pub enum SettingsError {
    /// Client payload failed validation (`400 Bad Request`, `VALIDATION_ERROR`).
    #[error("{0}")]
    Validation(String),

    /// Referenced user does not exist (`404 Not Found`).
    #[error("{0}")]
    NotFound(String),

    /// Underlying SQLite failure.
    #[error("Settings database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    /// Failed to serialize a setting value for storage.
    #[error("Settings JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Returns the user's configured loudness normalization target (`-18`, `-16`, or `-14` LUFS),
/// defaulting to `-16` when unset or invalid.
pub async fn get_normalization_target(pool: &DbPool, user_id: &str) -> i64 {
    let row = sqlx::query(
        "SELECT value FROM user_settings WHERE user_id = ? AND key = 'playback.normalization.targetLufs';",
    )
    .bind(user_id)
    .fetch_optional(pool.inner())
    .await
    .ok()
    .flatten();

    let Some(row) = row else {
        return -16;
    };

    let Ok(raw_value) = row.try_get::<String, _>("value") else {
        return -16;
    };

    let Ok(parsed) = serde_json::from_str::<i64>(&raw_value) else {
        return -16;
    };

    if NORMALIZATION_TARGETS.contains(&parsed) {
        parsed
    } else {
        -16
    }
}

/// Lists all saved settings for `user_id` ordered by `key ASC`.
pub async fn list_user_settings(
    pool: &DbPool,
    user_id: &str,
) -> Result<Vec<SettingRecord>, SettingsError> {
    fetch_user_settings(pool.inner(), user_id).await
}

async fn fetch_user_settings<'e>(
    executor: impl sqlx::Executor<'e, Database = Sqlite>,
    user_id: &str,
) -> Result<Vec<SettingRecord>, SettingsError> {
    let rows = sqlx::query(
        "SELECT key, value, updated_at FROM user_settings WHERE user_id = ? ORDER BY key ASC;",
    )
    .bind(user_id)
    .fetch_all(executor)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(SettingRecord {
            key: row.try_get("key")?,
            value: row.try_get("value")?,
            updated_at: row.try_get("updated_at")?,
        });
    }
    Ok(out)
}

/// Validates user settings key-values submitted to `PATCH /api/settings/user`.
pub fn validate_user_settings_patch(settings: &Map<String, Value>) -> Result<(), SettingsError> {
    if let Some(album_aware) = settings.get("playback.albumAware")
        && !album_aware.is_boolean()
    {
        return Err(SettingsError::Validation(String::from(
            "Album-aware playback must be a boolean",
        )));
    }

    if let Some(shuffle_mode) = settings.get("playback.shuffleMode") {
        let valid = shuffle_mode
            .as_str()
            .is_some_and(|s| matches!(s, "standard" | "smart"));
        if !valid {
            return Err(SettingsError::Validation(String::from(
                "Shuffle mode must be standard or smart",
            )));
        }
    }

    if let Some(target) = settings.get("playback.normalization.targetLufs") {
        let valid = target
            .as_i64()
            .is_some_and(|n| NORMALIZATION_TARGETS.contains(&n));
        if !valid {
            return Err(SettingsError::Validation(String::from(
                "Loudness target must be -18, -16 or -14 LUFS",
            )));
        }
    }

    if let Some(theme) = settings.get("ui.theme") {
        let valid = theme
            .as_str()
            .is_some_and(|s| matches!(s, "dark" | "light"));
        if !valid {
            return Err(SettingsError::Validation(String::from(
                "Theme must be \"dark\" or \"light\"",
            )));
        }
    }

    if let Some(preset) = settings.get("ui.layoutPreset") {
        let valid = preset
            .as_str()
            .is_some_and(|s| LAYOUT_PRESETS.contains(&s));
        if !valid {
            return Err(SettingsError::Validation(format!(
                "Layout preset must be one of: {}",
                LAYOUT_PRESETS.join(", ")
            )));
        }
    }

    Ok(())
}

/// Validates admin-overridable user preferences submitted to `PATCH /api/admin/users/:userId/settings`.
pub fn validate_admin_user_settings_patch(
    settings: &Map<String, Value>,
) -> Result<(), SettingsError> {
    for (key, value) in settings {
        match key.as_str() {
            "ui.theme" => {
                if !value
                    .as_str()
                    .is_some_and(|s| matches!(s, "dark" | "light"))
                {
                    return Err(SettingsError::Validation(String::from(
                        "Invalid user preferences request",
                    )));
                }
            }
            "ui.layoutPreset" => {
                if !value.as_str().is_some_and(|s| LAYOUT_PRESETS.contains(&s)) {
                    return Err(SettingsError::Validation(String::from(
                        "Invalid user preferences request",
                    )));
                }
            }
            "playback.streamQuality" => {
                if !value
                    .as_str()
                    .is_some_and(|s| matches!(s, "128" | "256" | "320" | "original" | "direct"))
                {
                    return Err(SettingsError::Validation(String::from(
                        "Invalid user preferences request",
                    )));
                }
            }
            "playback.downloadQuality" => {
                if !value.as_str().is_some_and(|s| {
                    matches!(s, "lossless" | "320kbps" | "256kbps" | "192kbps" | "128kbps")
                }) {
                    return Err(SettingsError::Validation(String::from(
                        "Invalid user preferences request",
                    )));
                }
            }
            _ => {
                return Err(SettingsError::Validation(String::from(
                    "Invalid user preferences request",
                )));
            }
        }
    }
    Ok(())
}

/// Atomically upserts allowlisted user settings for `user_id` and returns the updated list.
pub async fn update_user_settings(
    pool: &DbPool,
    user_id: &str,
    settings: &Map<String, Value>,
) -> Result<Vec<SettingRecord>, SettingsError> {
    let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut tx = pool.inner().begin().await?;

    for (key, value) in settings {
        if !ALLOWED_USER_SETTINGS.contains(key.as_str()) {
            continue;
        }
        let serialized = serde_json::to_string(value)?;
        sqlx::query(
            r"
            INSERT INTO user_settings (user_id, key, value, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, key)
            DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
            ",
        )
        .bind(user_id)
        .bind(key)
        .bind(serialized)
        .bind(&now_iso)
        .execute(&mut *tx)
        .await?;
    }

    let updated = fetch_user_settings(&mut *tx, user_id).await?;
    tx.commit().await?;
    Ok(updated)
}

/// Lists all saved server settings ordered by `key ASC`.
pub async fn list_server_settings(pool: &DbPool) -> Result<Vec<SettingRecord>, SettingsError> {
    fetch_server_settings(pool.inner()).await
}

async fn fetch_server_settings<'e>(
    executor: impl sqlx::Executor<'e, Database = Sqlite>,
) -> Result<Vec<SettingRecord>, SettingsError> {
    let rows = sqlx::query("SELECT key, value, updated_at FROM server_settings ORDER BY key ASC;")
        .fetch_all(executor)
        .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(SettingRecord {
            key: row.try_get("key")?,
            value: row.try_get("value")?,
            updated_at: row.try_get("updated_at")?,
        });
    }
    Ok(out)
}

/// Validates and normalizes a 5-field cron schedule or legacy disabled alias,
/// matching `validateScanSchedule` in `server/src/services/scannerScheduler.ts`.
pub fn validate_scan_schedule(raw: &Value) -> Result<Option<String>, SettingsError> {
    if raw.is_null() {
        return Ok(None);
    }
    let Some(s) = raw.as_str() else {
        return Err(SettingsError::Validation(String::from(
            "Library scan schedule must be a string",
        )));
    };

    match validate_cron(Some(s)) {
        CronValidation::Valid(expression) => Ok(expression),
        CronValidation::Invalid(message) => Err(SettingsError::Validation(message)),
    }
}

pub(crate) async fn write_server_setting(
    conn: &mut SqliteConnection,
    key: &str,
    serialized: &str,
    now_iso: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r"
        INSERT INTO server_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key)
        DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
        ",
    )
    .bind(key)
    .bind(serialized)
    .bind(now_iso)
    .execute(conn)
    .await?;
    Ok(())
}

/// Validates and atomically persists allowlisted server settings.
pub async fn update_server_settings(
    pool: &DbPool,
    mut settings: Map<String, Value>,
) -> Result<Vec<SettingRecord>, SettingsError> {
    if let Some(threshold) = settings.get("listening.thresholdSeconds") {
        let valid = threshold
            .as_f64()
            .is_some_and(|v| v.is_finite() && (1.0..=240.0).contains(&v));
        if !valid {
            return Err(SettingsError::Validation(String::from(
                "Listening threshold must be between 1 and 240 seconds",
            )));
        }
    }

    let schedule = settings
        .get(SCAN_SCHEDULE_SETTING_KEY)
        .map(validate_scan_schedule)
        .transpose()?;
    if let Some(normalized) = &schedule {
        settings.insert(
            String::from(SCAN_SCHEDULE_SETTING_KEY),
            Value::String(normalized.as_deref().unwrap_or("").to_owned()),
        );
    }

    let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut tx = pool.inner().begin().await?;

    for (key, value) in &settings {
        if !ALLOWED_SERVER_SETTINGS.contains(key.as_str()) {
            continue;
        }
        let serialized = serde_json::to_string(value)?;
        write_server_setting(&mut tx, key, &serialized, &now_iso).await?;
    }

    match schedule {
        Some(Some(expression)) => {
            upsert_schedule(
                &mut tx,
                TaskType::LibraryScan,
                "{}",
                &expression,
                "system:scheduler",
            )
            .await?;
        }
        Some(None) => delete_schedule(&mut tx, TaskType::LibraryScan).await?,
        None => {}
    }

    let updated = fetch_server_settings(&mut *tx).await?;
    tx.commit().await?;
    Ok(updated)
}

/// Reads the public branding configuration (`branding.appName`), defaulting to `"MusicDeck"`.
pub async fn get_public_app_config(pool: &DbPool) -> PublicAppConfig {
    let row = sqlx::query("SELECT value FROM server_settings WHERE key = ?;")
        .bind(APP_NAME_SETTING_KEY)
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten();

    let app_name = row
        .and_then(|r| r.try_get::<String, _>("value").ok())
        .and_then(|raw| serde_json::from_str::<String>(&raw).ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| String::from(DEFAULT_APP_NAME));

    PublicAppConfig { app_name }
}

/// Validates and updates `branding.appName` (`1..=40` chars, no control characters).
pub async fn update_public_app_config(
    pool: &DbPool,
    raw_name: &str,
) -> Result<PublicAppConfig, SettingsError> {
    let trimmed = raw_name.trim();
    let char_count = trimmed.chars().count();
    let has_control = trimmed
        .chars()
        .any(|c| ('\u{0000}'..='\u{001F}').contains(&c) || c == '\u{007F}');

    if trimmed.is_empty() || char_count > APP_NAME_MAX_LENGTH || has_control {
        return Err(SettingsError::Validation(format!(
            "Application name must be 1-{APP_NAME_MAX_LENGTH} characters without control characters"
        )));
    }

    let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let serialized = serde_json::to_string(trimmed)?;

    sqlx::query(
        r"
        INSERT INTO server_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key)
        DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
        ",
    )
    .bind(APP_NAME_SETTING_KEY)
    .bind(serialized)
    .bind(now_iso)
    .execute(pool.inner())
    .await?;

    Ok(get_public_app_config(pool).await)
}
