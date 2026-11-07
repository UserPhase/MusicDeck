//! # User & Server Settings Routes (`routes::settings`)
//!
//! Complete Rust port of `server/src/routes/settings-routes.ts`.
//!
//! ## Endpoints
//! - `GET /api/settings/user`: Lists the authenticated user's preferences.
//! - `PATCH /api/settings/user`: Validates and updates the authenticated user's preferences.
//! - `GET /api/admin/users/:user_id/settings`: Admin-only read of a specific user's preferences.
//! - `PATCH /api/admin/users/:user_id/settings`: Admin-only override of a user's `ui.theme`,
//!   `ui.layoutPreset`, `playback.streamQuality`, or `playback.downloadQuality`.
//! - `GET /api/admin/settings/server`: Admin-only list of global server settings.
//! - `PATCH /api/admin/settings/server`: Admin-only update of global server settings (including
//!   5-field cron schedule validation for `library.scanSchedule` and `listening.thresholdSeconds`).

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::auth::{AuthenticatedUser, RequireAdmin};
use crate::db::DbPool;
use crate::domain::settings::{
    SCAN_SCHEDULE_SETTING_KEY, SettingRecord, SettingsError, list_server_settings,
    list_user_settings, update_server_settings, update_user_settings,
    validate_admin_user_settings_patch, validate_user_settings_patch,
};
use crate::error::{ApiErrorBody, ApiErrorEnvelope, ServerError};
use crate::state::AppState;
use crate::users::get_user_by_id;

#[cfg(test)]
#[path = "settings/tests.rs"]
mod tests;

/// Request body `{ "settings": { ... } }` accepted by settings `PATCH` endpoints.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsPatchEnvelope {
    /// Key-value map of settings to update.
    pub settings: Map<String, Value>,
}

/// Response body `{ "settings": [...] }` returned by settings endpoints.
#[derive(Debug, Serialize, Deserialize)]
pub struct SettingsListEnvelope {
    /// Ordered list of saved setting records.
    pub settings: Vec<SettingRecord>,
}

/// Registers user and admin settings routes onto an [`axum::Router`].
pub fn settings_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/settings/user",
            get(get_own_user_settings).patch(patch_own_user_settings),
        )
        .route(
            "/api/admin/users/:user_id/settings",
            get(admin_get_user_settings).patch(admin_patch_user_settings),
        )
        .route(
            "/api/admin/settings/server",
            get(admin_get_server_settings).patch(admin_patch_server_settings),
        )
        .route(
            "/api/admin/library/scan/status",
            get(admin_get_library_scan_status),
        )
        .route("/api/admin/library/scan", axum::routing::post(admin_post_library_scan))
}

fn require_db(state: &AppState) -> Result<&DbPool, ServerError> {
    state
        .db()
        .ok_or_else(|| ServerError::Internal(String::from("Database pool is not initialized")))
}

fn map_settings_error(err: SettingsError) -> Response {
    match err {
        SettingsError::Validation(message) => (
            StatusCode::BAD_REQUEST,
            Json(ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: String::from("VALIDATION_ERROR"),
                    message,
                },
            }),
        )
            .into_response(),
        SettingsError::NotFound(message) => (
            StatusCode::NOT_FOUND,
            Json(ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: String::from("NOT_FOUND"),
                    message,
                },
            }),
        )
            .into_response(),
        err @ (SettingsError::Sqlx(_) | SettingsError::Json(_)) => {
            ServerError::Internal(err.to_string()).into_response()
        }
    }
}

/// `GET /api/settings/user`
async fn get_own_user_settings(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match list_user_settings(db, &auth.user.id).await {
        Ok(settings) => Json(SettingsListEnvelope { settings }).into_response(),
        Err(err) => map_settings_error(err),
    }
}

/// `PATCH /api/settings/user`
async fn patch_own_user_settings(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<Json<SettingsPatchEnvelope>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload_res else {
        return map_settings_error(SettingsError::Validation(String::from(
            "Invalid user settings request",
        )));
    };

    if let Err(err) = validate_user_settings_patch(&payload.settings) {
        return map_settings_error(err);
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match update_user_settings(db, &auth.user.id, &payload.settings).await {
        Ok(settings) => Json(SettingsListEnvelope { settings }).into_response(),
        Err(err) => map_settings_error(err),
    }
}

/// `GET /api/admin/users/:user_id/settings`
async fn admin_get_user_settings(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(user_id): Path<String>,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match get_user_by_id(db, &user_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return map_settings_error(SettingsError::NotFound(String::from("User not found"))),
        Err(err) => return ServerError::Internal(err.to_string()).into_response(),
    }

    match list_user_settings(db, &user_id).await {
        Ok(settings) => Json(SettingsListEnvelope { settings }).into_response(),
        Err(err) => map_settings_error(err),
    }
}

/// `PATCH /api/admin/users/:user_id/settings`
async fn admin_patch_user_settings(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(user_id): Path<String>,
    payload_res: Result<Json<SettingsPatchEnvelope>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match get_user_by_id(db, &user_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return map_settings_error(SettingsError::NotFound(String::from("User not found"))),
        Err(err) => return ServerError::Internal(err.to_string()).into_response(),
    }

    let Ok(Json(payload)) = payload_res else {
        return map_settings_error(SettingsError::Validation(String::from(
            "Invalid user preferences request",
        )));
    };

    if let Err(err) = validate_admin_user_settings_patch(&payload.settings) {
        return map_settings_error(err);
    }

    match update_user_settings(db, &user_id, &payload.settings).await {
        Ok(settings) => Json(SettingsListEnvelope { settings }).into_response(),
        Err(err) => map_settings_error(err),
    }
}

/// `GET /api/admin/settings/server`
async fn admin_get_server_settings(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match list_server_settings(db).await {
        Ok(settings) => Json(SettingsListEnvelope { settings }).into_response(),
        Err(err) => map_settings_error(err),
    }
}

/// `PATCH /api/admin/settings/server`
async fn admin_patch_server_settings(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    payload_res: Result<Json<SettingsPatchEnvelope>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload_res else {
        return map_settings_error(SettingsError::Validation(String::from(
            "Invalid server settings request",
        )));
    };

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let schedule_changed = payload.settings.contains_key(SCAN_SCHEDULE_SETTING_KEY);
    match update_server_settings(db, payload.settings).await {
        Ok(settings) => {
            if schedule_changed {
                state.tasks().start_scheduler();
            }
            Json(SettingsListEnvelope { settings }).into_response()
        }
        Err(err) => map_settings_error(err),
    }
}

/// `GET /api/admin/library/scan/status`
async fn admin_get_library_scan_status(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    Json(serde_json::json!({
        "status": state.scanner_scheduler().start().await
    }))
    .into_response()
}

/// `POST /api/admin/library/scan`
async fn admin_post_library_scan(State(state): State<AppState>, admin: RequireAdmin) -> Response {
    if let Err(err) = state
        .tasks()
        .enqueue(
            crate::tasks::TaskType::LibraryScan,
            serde_json::json!({}),
            &admin.user.id,
            None,
        )
        .await
    {
        return ServerError::Internal(err.to_string()).into_response();
    }
    Json(serde_json::json!({
        "status": state.scanner_scheduler().start().await
    }))
    .into_response()
}
