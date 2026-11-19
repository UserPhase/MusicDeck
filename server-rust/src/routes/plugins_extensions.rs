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

use crate::error::ApiJson;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{any, get, patch, post};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::auth::{AuthenticatedUser, RequireAdmin};
use crate::plugins::{
    ExtensionError, ExtensionErrorCode, PluginRegistryError, http_status_for_plugin_error,
    parse_custom_manifest,
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

fn plugin_error_response(error: PluginRegistryError) -> Response {
    let (status, code, message) = match error {
        PluginRegistryError::Unknown => (
            StatusCode::NOT_FOUND,
            "NOT_FOUND".into(),
            "Plugin not found".into(),
        ),
        PluginRegistryError::AlreadyRegistered => (
            StatusCode::CONFLICT,
            "ALREADY_INSTALLED".into(),
            "A plugin with this ID is already installed".into(),
        ),
        PluginRegistryError::NotUninstallable => (
            StatusCode::BAD_REQUEST,
            "NOT_UNINSTALLABLE".into(),
            error.to_string(),
        ),
        PluginRegistryError::InvalidManifest(_) => (
            StatusCode::BAD_REQUEST,
            "INVALID_MANIFEST".into(),
            error.to_string(),
        ),
        PluginRegistryError::InvalidConfiguration => (
            StatusCode::BAD_REQUEST,
            "INVALID_CONFIG".into(),
            error.to_string(),
        ),
        PluginRegistryError::Rejected(classified) => (
            http_status_for_plugin_error(classified.status),
            classified.status.as_str().to_ascii_uppercase(),
            classified.message,
        ),
        other => {
            tracing::warn!(error = %other, "Plugin storage operation failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR".into(),
                "Plugin storage operation failed".into(),
            )
        }
    };
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

async fn list_public_plugins_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
) -> Response {
    match state.plugins().list(false).await {
        Ok(plugins) => Json(json!({ "plugins": plugins })).into_response(),
        Err(error) => plugin_error_response(error),
    }
}

async fn list_admin_plugins_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    match state.plugins().list(true).await {
        Ok(plugins) => Json(json!({ "plugins": plugins })).into_response(),
        Err(error) => plugin_error_response(error),
    }
}

async fn get_admin_plugin_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(plugin_id): Path<String>,
) -> Response {
    match state.plugins().get(&plugin_id, true).await {
        Ok(Some(plugin)) => Json(json!({ "plugin": plugin })).into_response(),
        Ok(None) => plugin_error_response(PluginRegistryError::Unknown),
        Err(error) => plugin_error_response(error),
    }
}

async fn install_custom_plugin_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    ApiJson(body): ApiJson<InstallPluginBody>,
) -> Response {
    let manifest = match parse_custom_manifest(&body.manifest) {
        Ok(manifest) => manifest,
        Err(error) => return plugin_error_response(error.into()),
    };
    match state.plugins().install_custom_plugin(manifest).await {
        Ok(plugin) => (StatusCode::CREATED, Json(json!({ "plugin": plugin }))).into_response(),
        Err(error) => plugin_error_response(error),
    }
}

async fn delete_admin_plugin_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(plugin_id): Path<String>,
) -> Response {
    match state.plugins().uninstall_plugin(&plugin_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => plugin_error_response(error),
    }
}

async fn patch_admin_plugin_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(plugin_id): Path<String>,
    ApiJson(body): ApiJson<PatchPluginBody>,
) -> Response {
    match state
        .plugins()
        .configure(&plugin_id, body.enabled, body.config, body.permissions)
        .await
    {
        Ok(plugin) => Json(json!({ "plugin": plugin })).into_response(),
        Err(error) => plugin_error_response(error),
    }
}

async fn test_admin_plugin_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(plugin_id): Path<String>,
) -> Response {
    match state.plugins().test(&plugin_id).await {
        Ok(test) => Json(json!({ "test": test })).into_response(),
        Err(error) => plugin_error_response(error),
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
    ApiJson(body): ApiJson<PatchExtensionBody>,
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn plugin_patch_reports_failure_and_keeps_the_previous_settings() {
        let db = crate::db::DbPool::connect_memory().await.unwrap();
        crate::db::run_migrations(&db, None).await.unwrap();
        sqlx::raw_sql(
            "INSERT OR IGNORE INTO roles (name, description) VALUES ('admin', 'Administrator');
             INSERT INTO users (id, username, password_hash, display_name, role, disabled, created_at, updated_at)
             VALUES ('admin', 'admin', 'unused', 'Admin', 'admin', 0, '2026-01-01', '2026-01-01');",
        ).execute(db.inner()).await.unwrap();
        let state = AppState::with_database(crate::AppConfig::default(), db.clone())
            .await
            .unwrap();
        let session = state
            .session_store()
            .unwrap()
            .create_session("admin", false)
            .await
            .unwrap();
        let router = plugins_and_extensions_routes().with_state(state.clone());
        let request = |method: &str, path: &str, body: Value| {
            router.clone().oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header(header::COOKIE, format!("musicdeck_session={}", session.id))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
        };
        let manifest = json!({"manifestVersion": 1, "id": "fixture", "name": "Fixture", "version": "1",
            "capabilities": ["lyrics"], "configuration": {"secret": {"type": "secret", "required": true}}});
        let response = request(
            "POST",
            "/api/admin/plugins/install",
            json!({"manifest": manifest}),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let path = "/api/admin/plugins/fixture";
        let response = request(
            "PATCH",
            path,
            json!({"enabled": true, "config": {"region": "nl"}}),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            state.plugins().get("fixture", true).await.unwrap().unwrap()["config"],
            json!({})
        );

        sqlx::query("CREATE TRIGGER fail_settings BEFORE UPDATE ON plugin_configs BEGIN SELECT RAISE(ABORT, 'fixture'); END")
            .execute(db.inner()).await.unwrap();
        let patch = json!({"enabled": true, "config": {"secret": "sample"}});
        let response = request("PATCH", path, patch.clone()).await.unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            state.plugins().get("fixture", true).await.unwrap().unwrap()["enabled"],
            false
        );
        sqlx::query("DROP TRIGGER fail_settings")
            .execute(db.inner())
            .await
            .unwrap();

        let response = request("PATCH", path, patch).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = request("PATCH", path, json!({"config": {"region": "nl"}}))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["plugin"]["enabled"], true);
        assert_eq!(
            body["plugin"]["config"],
            json!({"secret": true, "region": "nl"})
        );
    }
}
