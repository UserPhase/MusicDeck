//! # Privacy Policy Routes & Pre-Handler Request Guard (`routes::privacy`)
//!
//! Complete Rust port of `server/src/routes/privacy-settings.ts`.
//!
//! ## Endpoints & Middleware
//! - `GET /api/v1/privacy`: Authenticated user endpoint returning [`PrivacySnapshot`]
//!   with `Cache-Control: private, no-store`.
//! - `PATCH /api/v1/privacy`: Admin-only endpoint updating [`PrivacySettings`]
//!   with `Cache-Control: private, no-store`.
//! - [`privacy_guard_middleware`]: Classifies incoming request paths/methods/queries
//!   via [`classify_integration_request`] and rejects disallowed external integrations
//!   with `HTTP 403 Forbidden` (`LOCAL_ONLY_MODE_ACTIVE` or `EXTERNAL_INTEGRATION_DISABLED`).

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::header::CACHE_CONTROL;
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;

use crate::auth::{AuthenticatedUser, RequireAdmin};
use crate::error::{ApiErrorBody, ApiErrorEnvelope, ServerError};
use crate::services::privacy::{PrivacyCategory, PrivacyError, PrivacySettings};
use crate::state::AppState;

/// Mounts `/api/v1/privacy` (`GET` and `PATCH`).
pub fn privacy_routes() -> Router<AppState> {
    Router::new().route(
        "/api/v1/privacy",
        get(get_privacy_policy).patch(patch_privacy_policy),
    )
}

/// `GET /api/v1/privacy` (authenticated user)
async fn get_privacy_policy(State(state): State<AppState>, _user: AuthenticatedUser) -> Response {
    let snapshot = state.privacy().snapshot();
    let mut response = Json(snapshot).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}

/// `PATCH /api/v1/privacy` (admin only)
async fn patch_privacy_policy(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    payload_res: Result<Json<PrivacySettings>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(settings)) = payload_res else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: String::from("VALIDATION_ERROR"),
                    message: String::from("Invalid privacy policy"),
                },
            }),
        )
            .into_response();
    };

    let updated = tokio::spawn(async move {
        let _serial = state.privacy_update_lock().await;
        state
            .revalidate_admin(&_admin.session_id)
            .await
            .map_err(IntoResponse::into_response)?;
        state
            .privacy()
            .update(settings)
            .await
            .map_err(map_privacy_error)
    })
    .await
    .unwrap_or_else(|err| Err(ServerError::Internal(err.to_string()).into_response()));
    match updated {
        Ok(snapshot) => {
            let mut response = Json(snapshot).into_response();
            response
                .headers_mut()
                .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
            response
        }
        Err(response) => response,
    }
}

/// Classifies an incoming HTTP request path, method, and query string into a
/// [`PrivacyCategory`] when it invokes an external integration, matching
/// `integrationCategory` in `server/src/routes/privacy-settings.ts`.
#[must_use]
pub fn classify_integration_request(
    path: &str,
    method: &Method,
    raw_query: Option<&str>,
) -> Option<PrivacyCategory> {
    if path == "/api/admin/downloader/diagnostics" {
        return Some(PrivacyCategory::Imports);
    }

    if (path.starts_with("/api/v1/playlists/import-spotify") && *method == Method::POST)
        || (path == "/api/acquisitions" && *method == Method::POST)
        || is_acquisition_retry_path(path)
    {
        return Some(PrivacyCategory::Imports);
    }

    if path.starts_with("/api/artwork/external/") || path == "/api/metadata/album-artwork" {
        return Some(PrivacyCategory::Artwork);
    }

    if path.starts_with("/api/discovery/")
        || path.starts_with("/api/external/")
        || path.starts_with("/api/metadata/")
        || path == "/api/playback/preview"
    {
        return Some(PrivacyCategory::Metadata);
    }

    if path == "/api/search"
        && let Some(q) = raw_query
        && url::form_urlencoded::parse(q.as_bytes())
            .any(|(key, value)| (key == "mode" || key == "phase") && value == "external")
    {
        return Some(PrivacyCategory::Metadata);
    }

    if path == "/api/v1/new-releases/scan" {
        return Some(PrivacyCategory::Metadata);
    }
    if path.starts_with("/api/v1/scrobble/") && *method != Method::DELETE {
        return Some(PrivacyCategory::External);
    }

    if is_external_entity_detail_path(path) || is_artist_discography_path(path) {
        return Some(PrivacyCategory::Metadata);
    }

    if is_artist_musicbrainz_portrait_path(path) {
        return Some(PrivacyCategory::Artwork);
    }

    if is_admin_provider_test_path(path, "search-providers") {
        return Some(PrivacyCategory::Metadata);
    }

    if is_admin_provider_test_path(path, "source-providers")
        || is_admin_provider_test_path(path, "plugins")
    {
        return Some(PrivacyCategory::External);
    }

    None
}

/// Axum pre-handler middleware that blocks external integration endpoints when
/// disallowed by [`crate::services::privacy::PrivacyManager`], matching the `preHandler`
/// hook in `server/src/routes/privacy-settings.ts`.
pub async fn privacy_guard_middleware(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, Response> {
    // Mutation handlers own the write side; all other handlers see one generation.
    let mutation = (request.method() == Method::PATCH && request.uri().path() == "/api/v1/privacy")
        || (request.method() == Method::POST
            && matches!(
                request.uri().path(),
                "/api/v1/admin/system/configuration"
                    | "/api/v1/admin/system/setup/complete"
                    | "/api/v1/admin/system/restore"
                    | "/api/v1/admin/system/backups"
            ));
    let _generation = if mutation {
        None
    } else {
        Some(state.runtime_read().await)
    };
    let recovery_access = request.uri().path().starts_with("/api/auth/")
        || matches!(
            request.uri().path(),
            "/api/health" | "/api/v1/admin/system/status" | "/api/v1/privacy"
        );
    if !mutation && !recovery_access && !state.runtime_ready() {
        return Err(ServerError::ServiceUnavailable(
            "Runtime refresh failed; retry configuration or restore".into(),
        )
        .into_response());
    }
    let raw_path = request.uri().path();
    let Ok(decoded_path) = urlencoding::decode(raw_path) else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: String::from("VALIDATION_ERROR"),
                    message: String::from("Malformed request path"),
                },
            }),
        )
            .into_response());
    };

    let category =
        classify_integration_request(&decoded_path, request.method(), request.uri().query());

    let Some(category) = category else {
        return Ok(next.run(request).await);
    };

    let (mut parts, body) = request.into_parts();
    if let Err(auth_err) = AuthenticatedUser::from_request_parts(&mut parts, &state).await {
        return Err(auth_err.into_response());
    }

    let request = Request::from_parts(parts, body);
    state
        .privacy()
        .run_external(category, next.run(request))
        .await
        .map_err(map_privacy_error)
}

pub(crate) fn map_privacy_error(err: PrivacyError) -> Response {
    match err {
        PrivacyError::Blocked(code) => (
            StatusCode::FORBIDDEN,
            Json(ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: String::from(code.as_str()),
                    message: String::from(code.message()),
                },
            }),
        )
            .into_response(),
        other => ServerError::Internal(other.to_string()).into_response(),
    }
}

fn is_acquisition_retry_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/acquisitions/") else {
        return false;
    };
    let Some(job_id) = rest.strip_suffix("/retry") else {
        return false;
    };
    !job_id.is_empty() && !job_id.contains('/')
}

fn is_external_entity_detail_path(path: &str) -> bool {
    for prefix in ["/api/albums/", "/api/artists/", "/api/tracks/"] {
        if let Some(rest) = path.strip_prefix(prefix)
            && let Some(id) = rest.split('/').next()
            && (id.starts_with("external_")
                || id.starts_with("extdetail_")
                || id.starts_with("deezer_artist_"))
        {
            return true;
        }
    }
    false
}

fn is_artist_discography_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/artists/") else {
        return false;
    };
    let Some(artist_id) = rest.strip_suffix("/discography") else {
        return false;
    };
    !artist_id.is_empty() && !artist_id.contains('/')
}

fn is_artist_musicbrainz_portrait_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/artists/") else {
        return false;
    };
    let Some(artist_id) = rest.strip_suffix("/portrait/musicbrainz") else {
        return false;
    };
    !artist_id.is_empty() && !artist_id.contains('/')
}

fn is_admin_provider_test_path(path: &str, group: &str) -> bool {
    let prefix = format!("/api/admin/{group}/");
    let Some(rest) = path.strip_prefix(&prefix) else {
        return false;
    };
    let Some(provider_id) = rest.strip_suffix("/test") else {
        return false;
    };
    !provider_id.is_empty() && !provider_id.contains('/')
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    #[tokio::test]
    async fn configuration_errors_return_http_500_without_exposing_internal_details() {
        let response = map_privacy_error(PrivacyError::Configuration(String::from(
            "privacy update task failed",
        )));
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("read error body")
            .to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).expect("JSON error");
        assert_eq!(body["error"]["code"], "INTERNAL_SERVER_ERROR");
        assert!(!body.to_string().contains("privacy update task failed"));
    }
}

#[cfg(test)]
mod enforcement_tests;
