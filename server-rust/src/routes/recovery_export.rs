//! # Setup Recovery, System Backups & User Data Export Routes (`routes::recovery_export`)
//!
//! Ports `server/src/routes/admin/setup-recovery.ts` and `server/src/routes/user-export.ts`:
//! - `GET /api/v1/admin/system/status`
//! - `POST /api/v1/admin/system/diagnostics`
//! - `POST /api/v1/admin/system/setup/complete`
//! - `POST /api/v1/admin/system/configuration`
//! - `PATCH /api/v1/admin/system/backup-policy`
//! - `POST /api/v1/admin/system/backups`
//! - `GET /api/v1/admin/system/backups/:id`
//! - `POST /api/v1/admin/system/restore`
//! - `GET /api/v1/user/export/summary` & `GET /api/v1/admin/users/:user_id/export/summary`
//! - `GET /api/v1/user/export/playlists/:playlist_id` & `GET /api/v1/admin/users/:user_id/export/playlists/:playlist_id`
//! - `GET /api/v1/user/export/history` & `GET /api/v1/admin/users/:user_id/export/history`
//! - `GET /api/v1/user/export/favorites` & `GET /api/v1/admin/users/:user_id/export/favorites`
//! - `GET /api/v1/user/export/settings` & `GET /api/v1/admin/users/:user_id/export/settings`
//! - `GET /api/v1/user/export/bundle` & `GET /api/v1/admin/users/:user_id/export/bundle`

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, patch, post};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

use crate::AppState;
use crate::admin::SystemHealthWizard;
use crate::auth::passwords::hash_password;
use crate::auth::{AuthenticatedUser, RequireAdmin};
use crate::config::{AppConfig, MusicBackendKind, durable_bytes, durable_json, sync_directory};
use crate::db::DbError;
use crate::domain::settings::write_server_setting;
use crate::error::ServerError;
use crate::logger::register_log_secret;
use crate::recovery::{
    DataExportService, RestoreGuard, MAX_BACKUP_UPLOAD, MAX_EXPANDED_BYTES,
    PlaylistExportFormat, RecoveryError,
};
use crate::users::get_user_by_id;

fn recovery_error_response(err: RecoveryError) -> Response {
    let status = StatusCode::from_u16(err.status_code).unwrap_or(StatusCode::BAD_REQUEST);
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "error": {
                "code": "RECOVERY_ERROR",
                "message": err.message,
            }
        })),
    )
        .into_response()
}

fn build_export_service(state: &AppState) -> DataExportService {
    let public_url = state.config().network.public_url.clone();
    DataExportService::new(state.db().cloned(), public_url)
}

fn export_headers(content_type: &'static str, filename: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Ok(disp) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        headers.insert(header::CONTENT_DISPOSITION, disp);
    }
    headers
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupPolicyBody {
    pub daily: bool,
}

/// Optional Navidrome credentials & endpoint submitted during setup wizard completion.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavidromeSetupInput {
    pub url: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// Optional Jellyfin API key & endpoint submitted during setup wizard completion.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JellyfinSetupInput {
    pub url: Option<String>,
    #[serde(alias = "api_key")]
    pub api_key: Option<String>,
}

/// Optional administrator account credentials submitted during setup wizard completion.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminSetupInput {
    pub username: Option<String>,
    pub password: Option<String>,
    #[serde(alias = "display_name")]
    pub display_name: Option<String>,
}

/// Request payload accepted by `POST /api/v1/admin/system/setup/complete`,
/// `POST /api/v1/admin/system/configuration`, and `POST /api/v1/admin/system/diagnostics`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupCompleteRequest {
    pub version: Option<u8>,
    pub backend: Option<String>,
    pub navidrome: Option<NavidromeSetupInput>,
    pub jellyfin: Option<JellyfinSetupInput>,
    pub admin: Option<AdminSetupInput>,
    #[serde(alias = "music_root", alias = "libraryPath", alias = "storagePath")]
    pub music_root: Option<String>,
    #[serde(alias = "acquisition_tmp_dir", alias = "downloadDir", alias = "tmpDir")]
    pub acquisition_tmp_dir: Option<String>,
    #[serde(alias = "server_url", alias = "navidrome_url", alias = "serverUrl", alias = "navidromeUrl")]
    pub server_url: Option<String>,
    pub url: Option<String>,
    #[serde(alias = "navidrome_username", alias = "navidromeUsername")]
    pub navidrome_username: Option<String>,
    pub username: Option<String>,
    #[serde(alias = "navidrome_password", alias = "navidromePassword")]
    pub navidrome_password: Option<String>,
    pub password: Option<String>,
    #[serde(alias = "jellyfin_url", alias = "jellyfinUrl")]
    pub jellyfin_url: Option<String>,
    #[serde(alias = "jellyfin_api_key", alias = "jellyfinApiKey", alias = "api_key")]
    pub api_key: Option<String>,
    #[serde(alias = "admin_username", alias = "adminUsername")]
    pub admin_username: Option<String>,
    #[serde(alias = "admin_password", alias = "adminPassword")]
    pub admin_password: Option<String>,
    #[serde(alias = "admin_display_name", alias = "adminDisplayName")]
    pub admin_display_name: Option<String>,
}

impl SetupCompleteRequest {
    fn has_any_fields(&self) -> bool {
        self.version.is_some()
            || self.backend.is_some()
            || self.navidrome.is_some()
            || self.jellyfin.is_some()
            || self.admin.is_some()
            || self.music_root.is_some()
            || self.acquisition_tmp_dir.is_some()
            || self.server_url.is_some()
            || self.url.is_some()
            || self.navidrome_username.is_some()
            || self.username.is_some()
            || self.navidrome_password.is_some()
            || self.password.is_some()
            || self.jellyfin_url.is_some()
            || self.api_key.is_some()
            || self.admin_username.is_some()
            || self.admin_password.is_some()
    }
}

fn setup_validation_error_response(message: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "error": {
                "code": "VALIDATION_ERROR",
                "message": message.into(),
            }
        })),
    )
        .into_response()
}

fn public_configuration_json(cfg: &AppConfig) -> Value {
    json!({
        "backend": cfg.backend,
        "musicRoot": cfg.music_root,
        "acquisitionTmpDir": cfg.acquisition_tmp_dir,
        "navidrome": {
            "url": cfg.navidrome.url,
            "username": cfg.navidrome.username,
            "passwordSet": !cfg.navidrome.password.is_empty(),
        },
        "jellyfin": {
            "url": cfg.jellyfin.url,
            "apiKeySet": !cfg.jellyfin.api_key.is_empty(),
        }
    })
}

fn merge_and_validate_candidate_config(
    base: &AppConfig,
    payload: &SetupCompleteRequest,
) -> Result<(AppConfig, Option<(String, String, Option<String>)>), String> {
    if let Some(v) = payload.version {
        if v != 1 {
            return Err(format!("Unsupported configuration version {v} (expected 1)."));
        }
    }

    let mut next = base.clone();

    if let Some(ref raw_backend) = payload.backend {
        next.backend = MusicBackendKind::parse_str(raw_backend).map_err(|_| {
            String::from("Invalid setup configuration: backend must be \"navidrome\" or \"jellyfin\".")
        })?;
    }

    if let Some(ref nav) = payload.navidrome {
        if let Some(ref u) = nav.url {
            next.navidrome.url = u.trim().to_owned();
        }
        if let Some(ref usr) = nav.username {
            next.navidrome.username = usr.trim().to_owned();
        }
        if let Some(ref pwd) = nav.password {
            next.navidrome.password = pwd.clone();
        }
    }

    if let Some(ref jf) = payload.jellyfin {
        if let Some(ref u) = jf.url {
            next.jellyfin.url = u.trim().to_owned();
        }
        if let Some(ref k) = jf.api_key {
            next.jellyfin.api_key = k.clone();
        }
    }

    if let Some(ref s_url) = payload.server_url.as_ref().or(payload.url.as_ref()) {
        match next.backend {
            MusicBackendKind::Navidrome => next.navidrome.url = s_url.trim().to_owned(),
            MusicBackendKind::Jellyfin => next.jellyfin.url = s_url.trim().to_owned(),
        }
    }
    if let Some(ref jf_url) = payload.jellyfin_url {
        next.jellyfin.url = jf_url.trim().to_owned();
    }
    if let Some(ref nav_usr) = payload
        .navidrome_username
        .as_ref()
        .or(payload.username.as_ref())
    {
        next.navidrome.username = nav_usr.trim().to_owned();
    }
    if let Some(nav_pwd) = payload
        .navidrome_password
        .as_ref()
        .or(payload.password.as_ref())
    {
        next.navidrome.password = nav_pwd.clone();
    }
    if let Some(ref jf_key) = payload.api_key {
        next.jellyfin.api_key = jf_key.clone();
    }

    if let Some(ref mr) = payload.music_root {
        next.music_root = mr.trim().to_owned();
    }
    if let Some(ref tmp) = payload.acquisition_tmp_dir {
        next.acquisition_tmp_dir = tmp.trim().to_owned();
    }

    next.configuration_snapshot().validate().map_err(|_| {
        String::from(
            "Invalid setup configuration or backup manifest. Check the selected server URL and required fields.",
        )
    })?;

    match next.backend {
        MusicBackendKind::Navidrome => {
            if next.navidrome.username.trim().is_empty()
                || next.navidrome.password.trim().is_empty()
            {
                return Err(String::from(
                    "Navidrome username and password are required to complete setup.",
                ));
            }
        }
        MusicBackendKind::Jellyfin => {
            if next.jellyfin.api_key.trim().is_empty() {
                return Err(String::from(
                    "Jellyfin API key is required to complete setup.",
                ));
            }
        }
    }

    let admin_usr = payload
        .admin
        .as_ref()
        .and_then(|a| a.username.clone())
        .or_else(|| payload.admin_username.clone());
    let admin_pwd = payload
        .admin
        .as_ref()
        .and_then(|a| a.password.clone())
        .or_else(|| payload.admin_password.clone());
    let admin_disp = payload
        .admin
        .as_ref()
        .and_then(|a| a.display_name.clone())
        .or_else(|| payload.admin_display_name.clone());

    let admin_creds = match (admin_usr, admin_pwd) {
        (Some(u), Some(p)) => {
            let trimmed_u = u.trim().to_owned();
            if trimmed_u.is_empty()
                || trimmed_u.len() > 64
                || trimmed_u.chars().any(char::is_control)
            {
                return Err(String::from(
                    "Administrator username must be 1..=64 characters without control characters.",
                ));
            }
            if p.len() < 8 || p.len() > 1024 {
                return Err(String::from(
                    "Administrator password must be between 8 and 1024 characters.",
                ));
            }
            next.auth.first_admin.username = trimmed_u.clone();
            next.auth.first_admin.password = p.clone();
            Some((trimmed_u, p, admin_disp))
        }
        (Some(_), None) | (None, Some(_)) => {
            return Err(String::from(
                "Both administrator username and password must be provided when updating admin credentials.",
            ));
        }
        (None, None) => None,
    };

    register_log_secret(&next.navidrome.password);
    register_log_secret(&next.jellyfin.api_key);

    Ok((next, admin_creds))
}

async fn persist_setup_configuration(
    state: &AppState,
    request: SetupCompleteRequest,
    session: String,
) -> Result<AppConfig, Response> {
    let state = state.clone();
    tokio::spawn(async move {
        let transition = state.begin_runtime_update().await;
        if let Err(err) = state.revalidate_admin(&session).await {
            transition.unchanged();
            return Err(err.into_response());
        }
        let (candidate, admin) =
            match merge_and_validate_candidate_config(&state.config(), &request) {
                Ok(value) => value,
                Err(message) => {
                    transition.unchanged();
                    return Err(setup_validation_error_response(message));
                }
            };
        let saved = persist_setup_configuration_inner(&state, candidate, admin)
            .await
            .map_err(IntoResponse::into_response)?;
        state
            .refresh_runtime(saved.clone())
            .await
            .map_err(IntoResponse::into_response)?;
        transition.complete();
        Ok(saved)
    })
    .await
    .map_err(|err| ServerError::Internal(err.to_string()).into_response())?
}

async fn persist_setup_configuration_inner(
    state: &AppState,
    mut next_config: AppConfig,
    admin_creds: Option<(String, String, Option<String>)>,
) -> Result<AppConfig, ServerError> {
    let pool = state
        .db()
        .ok_or_else(|| ServerError::Internal("Database unavailable".into()))?;
    tokio::fs::create_dir_all(&next_config.music_root).await?;
    tokio::fs::create_dir_all(&next_config.acquisition_tmp_dir).await?;

    let snapshot = next_config.configuration_snapshot();
    let snapshot_json = serde_json::to_string(&snapshot).map_err(|err| {
        ServerError::Internal(format!("Could not serialize setup configuration: {err}"))
    })?;
    let admin = if let Some((username, password, display_name)) = admin_creds {
        let password_hash = hash_password(password).await.map_err(|err| {
            ServerError::Internal(format!("Failed hashing administrator password: {err}"))
        })?;
        let display_name = display_name
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| username.clone());
        Some((username, password_hash, display_name))
    } else {
        None
    };
    let now = Utc::now().to_rfc3339();
    let mut transaction = pool.inner().begin().await.map_err(DbError::from)?;
    for (key, value) in [
        ("setup.completedAt", json!(&now).to_string()),
        ("setup.configuration", snapshot_json),
    ] {
        write_server_setting(&mut transaction, key, &value, &now)
            .await
            .map_err(DbError::from)?;
    }

    let (conn_type, conn_name, conn_cfg) = match next_config.backend {
        MusicBackendKind::Navidrome => (
            "navidrome",
            "Navidrome",
            json!({
                "url": next_config.navidrome.url,
                "username": next_config.navidrome.username,
                "password": next_config.navidrome.password,
            }),
        ),
        MusicBackendKind::Jellyfin => (
            "jellyfin",
            "Jellyfin",
            json!({
                "url": next_config.jellyfin.url,
                "apiKey": next_config.jellyfin.api_key,
            }),
        ),
    };

    sqlx::query("UPDATE backend_connections SET enabled = 0")
        .execute(&mut *transaction)
        .await
        .map_err(DbError::from)?;
    sqlx::query(
        r"
        INSERT INTO backend_connections (id, type, name, config_json, enabled, created_at, updated_at)
        VALUES ('backend-primary', ?, ?, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            type = excluded.type,
            name = excluded.name,
            config_json = excluded.config_json,
            enabled = 1,
            updated_at = excluded.updated_at
        ",
    )
    .bind(conn_type)
    .bind(conn_name)
    .bind(conn_cfg.to_string())
    .bind(&now)
    .bind(&now)
    .execute(&mut *transaction)
    .await.map_err(DbError::from)?;

    if let Some((admin_username, password_hash, disp)) = admin {
        sqlx::query(
            "INSERT INTO roles (name, description) VALUES ('admin', 'Full server administrator')
             ON CONFLICT(name) DO NOTHING",
        )
        .execute(&mut *transaction)
        .await
        .map_err(DbError::from)?;

        let existing_admin_id: Option<String> = sqlx::query_scalar(
            "SELECT id FROM users WHERE username = ? OR role = 'admin' ORDER BY is_master DESC, created_at ASC LIMIT 1",
        )
        .bind(&admin_username)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(DbError::from)?;

        if let Some(uid) = existing_admin_id {
            sqlx::query(
                r"
                UPDATE users
                SET username = ?,
                    password_hash = ?,
                    display_name = ?,
                    role = 'admin',
                    disabled = 0,
                    updated_at = ?
                WHERE id = ?
                ",
            )
            .bind(&admin_username)
            .bind(&password_hash)
            .bind(&disp)
            .bind(&now)
            .bind(&uid)
            .execute(&mut *transaction)
            .await
            .map_err(DbError::from)?;
        } else {
            let uid = format!("user_{}", Uuid::new_v4().simple());
            sqlx::query(
                r"
                INSERT INTO users (
                    id, username, password_hash, display_name, role,
                    disabled, is_master, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, 'admin', 0, 1, ?, ?)
                ",
            )
            .bind(&uid)
            .bind(&admin_username)
            .bind(&password_hash)
            .bind(&disp)
            .bind(&now)
            .bind(&now)
            .execute(&mut *transaction)
            .await
            .map_err(DbError::from)?;
        }
    }
    // Keep the previous config until every SQL statement succeeds. If publication
    // or SQLite's commit fails, restore the file before returning the error.
    let result = if next_config.database.is_persistent() {
        let path = next_config.database.system_paths().configuration;
        let previous = match tokio::fs::read(&path).await {
            Ok(bytes) => Some(bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => return Err(err.into()),
        };
        let result = match durable_json(&path, &snapshot) {
            Ok(()) => transaction
                .commit()
                .await
                .map_err(DbError::from)
                .map_err(ServerError::from),
            Err(err) => Err(err.into()),
        };
        if result.is_err() {
            let rollback = match previous {
                Some(bytes) => durable_bytes(&path, &bytes),
                None => match std::fs::remove_file(&path) {
                    Ok(()) => sync_directory(&next_config.database.system_paths().root),
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(err) => Err(err),
                },
            };
            if let Err(err) = rollback {
                tracing::error!(error = %err, "Could not restore config.json after a failed save");
            }
        }
        result
    } else {
        transaction
            .commit()
            .await
            .map_err(DbError::from)
            .map_err(ServerError::from)
    };
    result?;

    next_config.setup_required = false;
    Ok(next_config)
}

/// Builds the router for `/api/v1/admin/system/*`, `/api/v1/user/export/*`, and `/api/v1/admin/users/:user_id/export/*`.
pub fn recovery_and_export_routes() -> Router<AppState> {
    Router::new()
        // Setup & recovery routes
        .route(
            "/api/v1/admin/system/status",
            get(get_system_status_handler),
        )
        .route(
            "/api/v1/admin/system/diagnostics",
            post(post_system_diagnostics_handler),
        )
        .route(
            "/api/v1/admin/system/setup/complete",
            post(post_setup_complete_handler),
        )
        .route(
            "/api/v1/admin/system/configuration",
            post(post_system_configuration_handler),
        )
        .route(
            "/api/v1/admin/system/backup-policy",
            patch(patch_backup_policy_handler),
        )
        .route(
            "/api/v1/admin/system/backups",
            post(post_create_backup_handler),
        )
        .route(
            "/api/v1/admin/system/backups/:id",
            get(get_backup_archive_handler),
        )
        .route(
            "/api/v1/admin/system/restore",
            post(post_restore_backup_handler),
        )
        // Self user export routes
        .route(
            "/api/v1/user/export/summary",
            get(get_self_export_summary_handler),
        )
        .route(
            "/api/v1/user/export/playlists/:playlist_id",
            get(get_self_export_playlist_handler),
        )
        .route(
            "/api/v1/user/export/history",
            get(get_self_export_history_handler),
        )
        .route(
            "/api/v1/user/export/favorites",
            get(get_self_export_favorites_handler),
        )
        .route(
            "/api/v1/user/export/settings",
            get(get_self_export_settings_handler),
        )
        .route(
            "/api/v1/user/export/bundle",
            get(get_self_export_bundle_handler),
        )
        // Admin user export routes
        .route(
            "/api/v1/admin/users/:user_id/export/summary",
            get(get_admin_export_summary_handler),
        )
        .route(
            "/api/v1/admin/users/:user_id/export/playlists/:playlist_id",
            get(get_admin_export_playlist_handler),
        )
        .route(
            "/api/v1/admin/users/:user_id/export/history",
            get(get_admin_export_history_handler),
        )
        .route(
            "/api/v1/admin/users/:user_id/export/favorites",
            get(get_admin_export_favorites_handler),
        )
        .route(
            "/api/v1/admin/users/:user_id/export/settings",
            get(get_admin_export_settings_handler),
        )
        .route(
            "/api/v1/admin/users/:user_id/export/bundle",
            get(get_admin_export_bundle_handler),
        )
}

async fn get_system_status_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    let cfg = state.config();
    let recovery = state.recovery_service();

    let mut completed = false;
    let mut backup_daily = false;
    if let Some(pool) = state.db() {
        completed = sqlx::query(
            "SELECT value FROM server_settings WHERE key = 'setup.completedAt'",
        )
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()
        .is_some();

        if let Ok(Some(row)) = sqlx::query(
            "SELECT value FROM server_settings WHERE key = 'recovery.backupDaily'",
        )
        .fetch_optional(pool.inner())
        .await
        {
            if let Ok(val) = row.try_get::<String, _>("value") {
                backup_daily = val.trim() == "true";
            }
        }
    }

    let op_status = match recovery.status() {
        Ok(s) => s,
        Err(err) => return recovery_error_response(err),
    };
    let backups = recovery.list_backups().await;

    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "configuration": {
                "backend": cfg.backend,
                "musicRoot": cfg.music_root,
                "acquisitionTmpDir": cfg.acquisition_tmp_dir,
                "navidrome": {
                    "url": cfg.navidrome.url,
                    "username": cfg.navidrome.username,
                    "passwordSet": !cfg.navidrome.password.is_empty(),
                },
                "jellyfin": {
                    "url": cfg.jellyfin.url,
                    "apiKeySet": !cfg.jellyfin.api_key.is_empty(),
                }
            },
            "firstRun": !completed || cfg.setup_required,
            "restartSupported": false,
            "runtimeRefreshSupported": true,
            "backupDaily": backup_daily,
            "operation": op_status,
            "backups": backups,
            "limits": {
                "uploadBytes": MAX_BACKUP_UPLOAD,
                "expandedBytes": MAX_EXPANDED_BYTES,
            },
            "mediaIncluded": false,
        })),
    )
        .into_response()
}

async fn post_system_diagnostics_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    body: Bytes,
) -> Response {
    let target_cfg = if body.is_empty() {
        state.shared_config()
    } else {
        let Ok(parsed) = serde_json::from_slice::<SetupCompleteRequest>(&body) else {
            return setup_validation_error_response(
                "Invalid setup configuration or backup manifest. Check the selected server URL and required fields.",
            );
        };
        if parsed.has_any_fields() {
            match merge_and_validate_candidate_config(&state.config(), &parsed) {
                Ok((candidate, _)) => Arc::new(candidate),
                Err(msg) => return setup_validation_error_response(msg),
            }
        } else {
            state.shared_config()
        }
    };

    let wizard = SystemHealthWizard::new(state.db().cloned(), target_cfg);
    let report = wizard.run().await;
    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "report": report })),
    )
        .into_response()
}

async fn post_setup_complete_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    body: Bytes,
) -> Response {
    if !body.is_empty() {
        let Ok(parsed) = serde_json::from_slice::<SetupCompleteRequest>(&body) else {
            return setup_validation_error_response(
                "Invalid setup configuration or backup manifest. Check the selected server URL and required fields.",
            );
        };

        if parsed.has_any_fields() {
            let saved_cfg = match persist_setup_configuration(
                &state,
                parsed,
                _admin.session_id.clone(),
            )
            .await
            {
                Ok(cfg) => cfg,
                Err(resp) => return resp,
            };

            let wizard = SystemHealthWizard::new(state.db().cloned(), state.shared_config());
            let report = wizard.run().await;

            return (
                StatusCode::OK,
                [(header::CACHE_CONTROL, "no-store")],
                Json(json!({
                    "completed": true,
                    "setupRequired": false,
                    "configuration": public_configuration_json(&saved_cfg),
                    "report": report,
                })),
            )
                .into_response();
        }
    }

    let wizard = SystemHealthWizard::new(state.db().cloned(), state.shared_config());
    let report = wizard.run().await;
    if !report.ready {
        return (
            StatusCode::CONFLICT,
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({
                "error": {
                    "code": "SETUP_INCOMPLETE",
                    "message": "Resolve failed connection, storage, and database checks before completing setup.",
                }
            })),
        )
            .into_response();
    }

    let current_cfg = match persist_setup_configuration(
        &state,
        SetupCompleteRequest::default(),
        _admin.session_id.clone(),
    )
    .await
    {
        Ok(config) => config,
        Err(response) => return response,
    };

    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "completed": true,
            "setupRequired": false,
            "configuration": public_configuration_json(&current_cfg),
            "report": report,
        })),
    )
        .into_response()
}

async fn post_system_configuration_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    body: Bytes,
) -> Response {
    if body.is_empty() {
        return setup_validation_error_response(
            "Invalid setup configuration or backup manifest. Check the selected server URL and required fields.",
        );
    }

    let Ok(parsed) = serde_json::from_slice::<SetupCompleteRequest>(&body) else {
        return setup_validation_error_response(
            "Invalid setup configuration or backup manifest. Check the selected server URL and required fields.",
        );
    };

    if !parsed.has_any_fields() {
        return setup_validation_error_response(
            "Invalid setup configuration or backup manifest. Check the selected server URL and required fields.",
        );
    }

    let saved_cfg =
        match persist_setup_configuration(&state, parsed, _admin.session_id.clone()).await {
            Ok(cfg) => cfg,
            Err(resp) => return resp,
        };

    let op_id = Uuid::new_v4().to_string();
    (
        StatusCode::ACCEPTED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "accepted": true,
            "completed": true,
            "setupRequired": false,
            "operationId": op_id,
            "configuration": public_configuration_json(&saved_cfg),
            "message": "Runtime refreshed. Restoring a backup requires signing in again.",
        })),
    )
        .into_response()
}

async fn patch_backup_policy_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Json(body): Json<BackupPolicyBody>,
) -> Result<Response, ServerError> {
    let pool = state
        .db()
        .ok_or_else(|| ServerError::Internal("Database unavailable".into()))?;
    let mut conn = pool.inner().acquire().await.map_err(DbError::from)?;
    write_server_setting(
        &mut conn,
        "recovery.backupDaily",
        if body.daily { "true" } else { "false" },
        &Utc::now().to_rfc3339(),
    )
    .await
    .map_err(DbError::from)?;

    Ok((
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "daily": body.daily })),
    )
        .into_response())
}

async fn post_create_backup_handler(
    State(state): State<AppState>,
    admin: RequireAdmin,
    reservation: Option<axum::Extension<RestoreGuard>>,
) -> Response {
    let guard = match reservation {
        Some(axum::Extension(guard)) => guard,
        None => match state.restore_state().try_acquire() {
            Ok(guard) => guard,
            Err(err) => return recovery_error_response(err),
        },
    };
    tokio::spawn(async move {
        let _generation = state.runtime_read().await;
        if !state.runtime_ready() {
            return ServerError::ServiceUnavailable(
                "Runtime recovery must complete before backup".into(),
            )
            .into_response();
        }
        if let Err(err) = state.revalidate_admin(&admin.session_id).await {
            return err.into_response();
        }
        match state
            .recovery_service()
            .capture_archive_guarded("system", &guard)
            .await
        {
            Ok(backup) => (
                StatusCode::CREATED,
                [(header::CACHE_CONTROL, "no-store")],
                Json(json!({"backup": backup})),
            )
                .into_response(),
            Err(err) => recovery_error_response(err),
        }
    })
    .await
    .unwrap_or_else(|err| ServerError::Internal(err.to_string()).into_response())
}

async fn get_backup_archive_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(id): Path<String>,
) -> Response {
    let recovery = state.recovery_service();
    let file_path = match recovery.backup_path(&id).await {
        Ok(p) => p,
        Err(err) => return recovery_error_response(err),
    };
    let Ok(bytes) = tokio::fs::read(&file_path).await else {
        return recovery_error_response(RecoveryError::new("Backup not found.", 404));
    };

    let filename = file_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("backup.tar.gz");
    let headers = export_headers("application/gzip", filename);
    (StatusCode::OK, headers, Body::from(bytes)).into_response()
}

async fn post_restore_backup_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    reservation: Option<axum::Extension<RestoreGuard>>,
    body: Bytes,
) -> Response {
    let guard = match reservation {
        Some(axum::Extension(guard)) => guard,
        None => match state.restore_state().try_acquire() {
            Ok(guard) => guard,
            Err(err) => return recovery_error_response(err),
        },
    };
    tokio::spawn(async move { restore_and_refresh(state, body, _admin.session_id, guard).await })
        .await
        .unwrap_or_else(|err| ServerError::Internal(err.to_string()).into_response())
}

async fn restore_and_refresh(
    state: AppState,
    body: Bytes,
    session: String,
    guard: RestoreGuard,
) -> Response {
    let transition = state.begin_runtime_update().await;
    if let Err(err) = state.revalidate_admin(&session).await {
        transition.unchanged();
        return err.into_response();
    }
    let recovery = state.recovery_service();

    match recovery.restore_from_archive_guarded(&body, &guard).await {
        Ok(outcome) => {
            let mut next_cfg = (*state.config()).clone();
            next_cfg.backend = outcome.restored_config.backend;
            next_cfg.navidrome = outcome.restored_config.navidrome;
            next_cfg.jellyfin = outcome.restored_config.jellyfin;
            next_cfg.music_root = outcome.restored_config.music_root;
            next_cfg.acquisition_tmp_dir = outcome.restored_config.acquisition_tmp_dir;
            next_cfg.setup_required = false;
            if let Err(err) = state.refresh_runtime(next_cfg).await {
                return err.into_response();
            }
            transition.complete();

            (
                StatusCode::ACCEPTED,
                [(header::CACHE_CONTROL, "no-store")],
                Json(json!({
                    "accepted": true,
                    "operationId": outcome.operation_id,
                    "safetyBackupId": outcome.safety_backup_id,
                    "message": "Runtime refreshed. Restoring a backup requires signing in again.",
                })),
            )
                .into_response()
        }
        Err(err) => {
            if err.status_code < 500 {
                transition.unchanged();
            }
            recovery_error_response(err)
        }
    }
}

// ============================================================================
// User Data Export Handlers (`/api/v1/user/export/*` & `/api/v1/admin/users/:user_id/export/*`)
// ============================================================================

async fn verify_export_target_user(
    state: &AppState,
    user_id: &str,
) -> Result<(), ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let user = get_user_by_id(pool, user_id)
        .await
        .map_err(|e| ServerError::Internal(e.to_string()))?;
    if user.is_none() {
        return Err(ServerError::NotFound(String::from("User not found.")));
    }
    Ok(())
}

async fn get_self_export_summary_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let service = build_export_service(&state);
    let summary = service.summary(&auth.user.id).await;
    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(summary),
    )
        .into_response()
}

async fn get_admin_export_summary_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(user_id): Path<String>,
) -> Result<Response, ServerError> {
    verify_export_target_user(&state, &user_id).await?;
    let service = build_export_service(&state);
    let summary = service.summary(&user_id).await;
    Ok((
        StatusCode::OK,
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(summary),
    )
        .into_response())
}

async fn render_playlist_export(
    state: &AppState,
    user_id: &str,
    playlist_id: &str,
    params: &HashMap<String, String>,
) -> Result<Response, ServerError> {
    let Some(format) = PlaylistExportFormat::parse(params.get("format").map(String::as_str)) else {
        return Err(ServerError::BadRequest(String::from(
            "Invalid export format.",
        )));
    };
    let service = build_export_service(state);
    let text = service
        .export_playlist_text(user_id, playlist_id, format)
        .await
        .map_err(|e| ServerError::NotFound(e.0))?;

    let date_part = Utc::now().to_rfc3339().chars().take(10).collect::<String>();
    let safe_id: String = playlist_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(100)
        .collect();
    let (ext, ct) = match format {
        PlaylistExportFormat::M3u8 => ("m3u8", "audio/x-mpegurl; charset=utf-8"),
        PlaylistExportFormat::Xspf => ("xspf", "application/xspf+xml; charset=utf-8"),
    };
    let filename = format!("musicdeck-playlists-{safe_id}-{date_part}.{ext}");
    let headers = export_headers(ct, &filename);
    Ok((StatusCode::OK, headers, text).into_response())
}

async fn get_self_export_playlist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ServerError> {
    render_playlist_export(&state, &auth.user.id, &playlist_id, &params).await
}

async fn get_admin_export_playlist_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path((user_id, playlist_id)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ServerError> {
    verify_export_target_user(&state, &user_id).await?;
    render_playlist_export(&state, &user_id, &playlist_id, &params).await
}

async fn get_self_export_history_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ServerError> {
    if params
        .get("format")
        .is_some_and(|f| !f.eq_ignore_ascii_case("csv"))
    {
        return Err(ServerError::BadRequest(String::from(
            "Invalid export format.",
        )));
    }
    let service = build_export_service(&state);
    let csv = service.export_history_csv(&auth.user.id).await;
    let date_part = Utc::now().to_rfc3339().chars().take(10).collect::<String>();
    let headers = export_headers(
        "text/csv; charset=utf-8",
        &format!("musicdeck-history-{date_part}.csv"),
    );
    Ok((StatusCode::OK, headers, csv).into_response())
}

async fn get_admin_export_history_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(user_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ServerError> {
    verify_export_target_user(&state, &user_id).await?;
    if params
        .get("format")
        .is_some_and(|f| !f.eq_ignore_ascii_case("csv"))
    {
        return Err(ServerError::BadRequest(String::from(
            "Invalid export format.",
        )));
    }
    let service = build_export_service(&state);
    let csv = service.export_history_csv(&user_id).await;
    let date_part = Utc::now().to_rfc3339().chars().take(10).collect::<String>();
    let headers = export_headers(
        "text/csv; charset=utf-8",
        &format!("musicdeck-history-{date_part}.csv"),
    );
    Ok((StatusCode::OK, headers, csv).into_response())
}

async fn get_self_export_favorites_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let service = build_export_service(&state);
    let payload = service.export_favorites_json(&auth.user.id).await;
    let date_part = Utc::now().to_rfc3339().chars().take(10).collect::<String>();
    let headers = export_headers(
        "application/json; charset=utf-8",
        &format!("musicdeck-favorites-{date_part}.json"),
    );
    (StatusCode::OK, headers, Json(payload)).into_response()
}

async fn get_admin_export_favorites_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(user_id): Path<String>,
) -> Result<Response, ServerError> {
    verify_export_target_user(&state, &user_id).await?;
    let service = build_export_service(&state);
    let payload = service.export_favorites_json(&user_id).await;
    let date_part = Utc::now().to_rfc3339().chars().take(10).collect::<String>();
    let headers = export_headers(
        "application/json; charset=utf-8",
        &format!("musicdeck-favorites-{date_part}.json"),
    );
    Ok((StatusCode::OK, headers, Json(payload)).into_response())
}

async fn get_self_export_settings_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let service = build_export_service(&state);
    let payload = service.export_settings_json(&auth.user.id).await;
    let date_part = Utc::now().to_rfc3339().chars().take(10).collect::<String>();
    let headers = export_headers(
        "application/json; charset=utf-8",
        &format!("musicdeck-settings-{date_part}.json"),
    );
    (StatusCode::OK, headers, Json(payload)).into_response()
}

async fn get_admin_export_settings_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(user_id): Path<String>,
) -> Result<Response, ServerError> {
    verify_export_target_user(&state, &user_id).await?;
    let service = build_export_service(&state);
    let payload = service.export_settings_json(&user_id).await;
    let date_part = Utc::now().to_rfc3339().chars().take(10).collect::<String>();
    let headers = export_headers(
        "application/json; charset=utf-8",
        &format!("musicdeck-settings-{date_part}.json"),
    );
    Ok((StatusCode::OK, headers, Json(payload)).into_response())
}

async fn get_self_export_bundle_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let service = build_export_service(&state);
    let payload = service.export_bundle_json(&auth.user.id).await;
    let date_part = Utc::now().to_rfc3339().chars().take(10).collect::<String>();
    let headers = export_headers(
        "application/json; charset=utf-8",
        &format!("musicdeck-bundle-{date_part}.json"),
    );
    (StatusCode::OK, headers, Json(payload)).into_response()
}

async fn get_admin_export_bundle_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(user_id): Path<String>,
) -> Result<Response, ServerError> {
    verify_export_target_user(&state, &user_id).await?;
    let service = build_export_service(&state);
    let payload = service.export_bundle_json(&user_id).await;
    let date_part = Utc::now().to_rfc3339().chars().take(10).collect::<String>();
    let headers = export_headers(
        "application/json; charset=utf-8",
        &format!("musicdeck-bundle-{date_part}.json"),
    );
    Ok((StatusCode::OK, headers, Json(payload)).into_response())
}
