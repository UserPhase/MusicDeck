//! # Public & Administrative Branding Configuration Routes (`routes::config`)
//!
//! Complete Rust port of `server/src/routes/config-routes.ts`.
//!
//! ## Endpoints
//! - `GET /api/public/config`: Unauthenticated endpoint returning `{ "appName": "MusicDeck" }`
//!   (or the custom persisted `branding.appName` value) so the login screen and document
//!   title render the instance brand before authentication, without exposing any secrets.
//! - `PATCH /api/admin/config`: Admin-only endpoint updating `branding.appName` after
//!   validating that `appName` is a non-empty string of `1..=40` characters after trimming
//!   and contains no ASCII control characters (`0x00..=0x1F` or `0x7F`).

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};

use crate::auth::RequireAdmin;
use crate::domain::settings::{
    APP_NAME_MAX_LENGTH, PublicAppConfig, SettingsError, get_public_app_config,
    update_public_app_config,
};
use crate::error::{ApiErrorBody, ApiErrorEnvelope};
use crate::state::AppState;

/// Registers `/api/public/config` and `/api/admin/config`.
pub fn config_routes() -> Router<AppState> {
    Router::new()
        .route("/api/public/config", get(get_public_config))
        .route("/api/admin/config", patch(patch_admin_config))
}

/// `GET /api/public/config` (unauthenticated)
async fn get_public_config(State(state): State<AppState>) -> Json<PublicAppConfig> {
    if let Some(db) = state.db() {
        Json(get_public_app_config(db).await)
    } else {
        Json(PublicAppConfig::default())
    }
}

/// `PATCH /api/admin/config` (admin only)
async fn patch_admin_config(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    payload_res: Result<Json<PublicAppConfig>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let validation_err = || {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: String::from("VALIDATION_ERROR"),
                    message: format!(
                        "Application name must be 1-{APP_NAME_MAX_LENGTH} characters without control characters"
                    ),
                },
            }),
        )
            .into_response()
    };

    let Ok(Json(payload)) = payload_res else {
        return validation_err();
    };

    let Some(db) = state.db() else {
        return validation_err();
    };

    match update_public_app_config(db, &payload.app_name).await {
        Ok(updated) => Json(updated).into_response(),
        Err(SettingsError::Validation(_)) => validation_err(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: String::from("INTERNAL_SERVER_ERROR"),
                    message: String::from("Failed to persist application configuration"),
                },
            }),
        )
            .into_response(),
    }
}
