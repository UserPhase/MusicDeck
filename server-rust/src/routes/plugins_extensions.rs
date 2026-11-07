//! # Plugin Registry & Server Extensions Admin HTTP Routes (`routes::plugins_extensions`)
//!
//! Ports:
//! - `GET /api/plugins` (`server/src/routes/admin-routes.ts`)
//! - `GET /api/admin/plugins`
//! - `GET /api/admin/plugins/:plugin_id`
//! - `POST /api/admin/plugins/install`
//! - `DELETE /api/admin/plugins/:plugin_id`
//! - `PATCH /api/admin/plugins/:plugin_id`
//! - `POST /api/admin/plugins/:plugin_id/test`
//! - `GET /api/v1/admin/extensions` (`server/src/routes/admin/extensions.ts`)
//! - `POST /api/v1/admin/extensions/discover`
//! - `PATCH /api/v1/admin/extensions/:extension_id`
//! - `/api/v1/admin/extensions/:extension_id/routes/*path`

use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{any, get, patch, post};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::auth::{AuthenticatedUser, RequireAdmin};
use crate::error::ServerError;
use crate::plugins::{
    ExtensionError, ExtensionErrorCode, http_status_for_plugin_error, parse_custom_manifest,
};

fn no_store_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers
}

fn extension_error_response(err: ExtensionError) -> Response {
    let status = match err.code {
        ExtensionErrorCode::NotFound => StatusCode::NOT_FOUND,
        ExtensionErrorCode::Conflict => StatusCode::CONFLICT,
        ExtensionErrorCode::Failed => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        Json(json!({
            "error": {
                "code": err.code.as_str(),
                "message": err.message,
            }
        })),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallPluginBody {
    pub manifest: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchPluginBody {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub config: Option<Value>,
    #[serde(default)]
    pub permissions: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchExtensionBody {
    pub enabled: bool,
}

/// Builds the router for `/api/plugins`, `/api/admin/plugins/*`, and `/api/v1/admin/extensions/*`.
pub fn plugins_and_extensions_routes() -> Router<AppState> {
    Router::new()
        .route("/api/plugins", get(list_public_plugins_handler))
        .route("/api/admin/plugins", get(list_admin_plugins_handler))
        .route(
            "/api/admin/plugins/install",
            post(install_custom_plugin_handler),
        )
        .route(
            "/api/admin/plugins/:plugin_id",
            get(get_admin_plugin_handler)
                .patch(patch_admin_plugin_handler)
                .delete(delete_admin_plugin_handler),
        )
        .route(
            "/api/admin/plugins/:plugin_id/test",
            post(test_admin_plugin_handler),
        )
        .route("/api/v1/admin/extensions", get(list_extensions_handler))
        .route(
            "/api/v1/admin/extensions/discover",
            post(discover_extensions_handler),
        )
        .route(
            "/api/v1/admin/extensions/:extension_id",
            patch(patch_extension_handler),
        )
        .route(
            "/api/v1/admin/extensions/:extension_id/routes/*path",
            any(dispatch_extension_route_handler),
        )
}

async fn list_public_plugins_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
) -> Response {
    let plugins = state.plugins().list(false).await;
    (StatusCode::OK, Json(json!({ "plugins": plugins }))).into_response()
}

async fn list_admin_plugins_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    let plugins = state.plugins().list(true).await;
    (StatusCode::OK, Json(json!({ "plugins": plugins }))).into_response()
}

async fn get_admin_plugin_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(plugin_id): Path<String>,
) -> Result<Response, ServerError> {
    let Some(plugin) = state.plugins().get(&plugin_id, true).await else {
        return Err(ServerError::NotFound(String::from("Plugin not found")));
    };
    Ok((StatusCode::OK, Json(json!({ "plugin": plugin }))).into_response())
}

async fn install_custom_plugin_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Json(body): Json<InstallPluginBody>,
) -> Response {
    let manifest = match parse_custom_manifest(&body.manifest) {
        Ok(m) => m,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": {
                        "code": "INVALID_MANIFEST",
                        "message": err.0,
                    }
                })),
            )
                .into_response();
        }
    };

    match state.plugins().install_custom_plugin(manifest).await {
        Ok(plugin) => (StatusCode::CREATED, Json(json!({ "plugin": plugin }))).into_response(),
        Err(msg) if msg == "Plugin is already registered" => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": {
                    "code": "ALREADY_INSTALLED",
                    "message": "A plugin with this ID is already installed",
                }
            })),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "Could not install plugin",
                }
            })),
        )
            .into_response(),
    }
}

async fn delete_admin_plugin_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(plugin_id): Path<String>,
) -> Response {
    match state.plugins().uninstall_plugin(&plugin_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(msg) if msg == "Unknown plugin" => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": { "code": "NOT_FOUND", "message": "Plugin not found" } })),
        )
            .into_response(),
        Err(msg) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "code": "NOT_UNINSTALLABLE", "message": msg } })),
        )
            .into_response(),
    }
}

async fn patch_admin_plugin_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(plugin_id): Path<String>,
    Json(body): Json<PatchPluginBody>,
) -> Response {
    if state.plugins().get(&plugin_id, true).await.is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": { "code": "NOT_FOUND", "message": "Plugin not found" } })),
        )
            .into_response();
    }

    if let Err(classified) = state
        .plugins()
        .configure(&plugin_id, Some(false), body.config, body.permissions)
        .await
    {
        return (
            http_status_for_plugin_error(classified.status),
            Json(json!({
                "error": {
                    "code": classified.status.as_str().to_ascii_uppercase(),
                    "message": classified.message,
                }
            })),
        )
            .into_response();
    }

    if body.enabled == Some(true) {
        if let Err(classified) = state.plugins().enable(&plugin_id).await {
            return (
                http_status_for_plugin_error(classified.status),
                Json(json!({
                    "error": {
                        "code": classified.status.as_str().to_ascii_uppercase(),
                        "message": classified.message,
                    }
                })),
            )
                .into_response();
        }
    } else if body.enabled == Some(false) {
        let _ = state.plugins().disable(&plugin_id).await;
    }

    let plugin = state.plugins().get(&plugin_id, true).await;
    (StatusCode::OK, Json(json!({ "plugin": plugin }))).into_response()
}

async fn test_admin_plugin_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(plugin_id): Path<String>,
) -> Response {
    match state.plugins().test(&plugin_id).await {
        Ok(test) => (StatusCode::OK, Json(json!({ "test": test }))).into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": { "code": "NOT_FOUND", "message": "Plugin not found" } })),
        )
            .into_response(),
    }
}

async fn list_extensions_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    let (extensions, issues) = state.extensions().list();
    (
        StatusCode::OK,
        no_store_headers(),
        Json(json!({
            "extensions": extensions,
            "issues": issues,
        })),
    )
        .into_response()
}

async fn discover_extensions_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    match state.extensions().discover().await {
        Ok((extensions, issues)) => (
            StatusCode::OK,
            Json(json!({
                "extensions": extensions,
                "issues": issues,
            })),
        )
            .into_response(),
        Err(err) => extension_error_response(err),
    }
}

async fn patch_extension_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(extension_id): Path<String>,
    Json(body): Json<PatchExtensionBody>,
) -> Response {
    match state
        .extensions()
        .set_enabled(&extension_id, body.enabled)
        .await
    {
        Ok(ext) => (StatusCode::OK, Json(json!({ "extension": ext }))).into_response(),
        Err(err) => extension_error_response(err),
    }
}

async fn dispatch_extension_route_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    method: Method,
    Path((extension_id, path)): Path<(String, String)>,
) -> Response {
    let normalized_route = if path.starts_with('/') {
        path
    } else {
        format!("/{path}")
    };
    match state
        .extensions()
        .dispatch(&extension_id, method.as_str(), &normalized_route, json!({}))
        .await
    {
        Ok(payload) => (StatusCode::OK, Json(payload)).into_response(),
        Err(err) => extension_error_response(err),
    }
}
