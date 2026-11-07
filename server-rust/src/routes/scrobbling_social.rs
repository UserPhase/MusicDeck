//! # Scrobbling & Artist Follow HTTP Routes (`routes::scrobbling_social`)
//!
//! Ports `server/src/routes/scrobble-routes.ts` and `server/src/routes/artist-follows.ts`:
//! - `GET /api/v1/scrobble`
//! - `POST /api/v1/scrobble/lastfm/authorize`
//! - `GET /api/v1/scrobble/lastfm/callback`
//! - `PUT /api/v1/scrobble/:provider`
//! - `DELETE /api/v1/scrobble/:provider`
//! - `POST /api/v1/scrobble/:provider/test`
//! - `POST /api/v1/scrobble/:provider/retry`
//! - `GET /api/v1/artist-follows`
//! - `POST /api/v1/artist-follows`
//! - `DELETE /api/v1/artist-follows/:key`
//! - `GET /api/v1/new-releases`
//! - `POST /api/v1/new-releases/scan`

use std::collections::HashMap;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json, Redirect, Response};
use axum::routing::{delete, get, post, put};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;

use crate::AppState;
use crate::auth::{AuthenticatedUser, RequireAdmin};
use crate::catalog::CatalogService;
use crate::error::ServerError;
use crate::logger::register_log_secret;
use crate::scrobbling::{FailureKind, LastFmConnectInput, ScrobbleError, ScrobbleProvider};
use crate::services::privacy::ExternalCategory;
use crate::social::{FollowArtistInput, FollowProvider};

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn scrobble_error_response(err: ScrobbleError) -> Response {
    let status = match err.kind {
        FailureKind::Transient => StatusCode::SERVICE_UNAVAILABLE,
        FailureKind::Paused => StatusCode::CONFLICT,
        _ => StatusCode::BAD_REQUEST,
    };
    (
        status,
        [
            (header::CACHE_CONTROL, "private, no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        Json(json!({
            "error": {
                "code": err.code,
                "message": err.message,
            }
        })),
    )
        .into_response()
}

fn validate_credential(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 4096 || trimmed.contains(['\r', '\n', '\0']) {
        return None;
    }
    Some(trimmed.to_owned())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FollowArtistRequestBody {
    pub owner_id: String,
    pub artist_id: String,
    pub artist_name: String,
    pub provider: FollowProvider,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnfollowArtistRequestBody {
    pub owner_id: String,
}

/// Builds the router for `/api/v1/scrobble/*`, `/api/v1/artist-follows/*`, and `/api/v1/new-releases/*`.
pub fn scrobbling_and_social_routes() -> Router<AppState> {
    Router::new()
        // Scrobbling endpoints
        .route("/api/v1/scrobble", get(get_scrobble_statuses_handler))
        .route(
            "/api/v1/scrobble/lastfm/authorize",
            post(authorize_lastfm_handler),
        )
        .route(
            "/api/v1/scrobble/lastfm/callback",
            get(lastfm_callback_handler),
        )
        .route(
            "/api/v1/scrobble/:provider",
            put(put_scrobble_connection_handler).delete(delete_scrobble_connection_handler),
        )
        .route(
            "/api/v1/scrobble/:provider/test",
            post(test_scrobble_connection_handler),
        )
        .route(
            "/api/v1/scrobble/:provider/retry",
            post(retry_scrobble_queue_handler),
        )
        // Artist follows & release radar endpoints
        .route(
            "/api/v1/artist-follows",
            get(list_artist_follows_handler).post(follow_artist_handler),
        )
        .route(
            "/api/v1/artist-follows/:key",
            delete(unfollow_artist_handler),
        )
        .route("/api/v1/new-releases", get(get_new_releases_handler))
        .route(
            "/api/v1/new-releases/scan",
            post(trigger_new_releases_scan_handler),
        )
}

async fn get_scrobble_statuses_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let connections = state.scrobble_queue().statuses(&auth.user.id).await;
    (
        StatusCode::OK,
        [
            (header::CACHE_CONTROL, "private, no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        Json(json!({ "connections": connections })),
    )
        .into_response()
}

async fn authorize_lastfm_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let api_key = match state.scrobble_queue().application_key().await {
        Ok(key) => key,
        Err(err) => return scrobble_error_response(err),
    };

    let Some(pool) = state.db() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": { "code": "DB_UNAVAILABLE", "message": "Database is unavailable" } })),
        )
            .into_response();
    };

    let raw_state = format!(
        "{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let public_url = state.config().network.public_url.clone();
    let Ok(mut callback_url) = Url::parse(&public_url)
        .and_then(|base| base.join("/api/v1/scrobble/lastfm/callback"))
    else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": { "code": "SCROBBLE_ERROR", "message": "Invalid server public URL" } })),
        )
            .into_response();
    };
    callback_url.query_pairs_mut().append_pair("state", &raw_state);

    let mut auth_url = Url::parse("https://www.last.fm/api/auth/").expect("valid constant URL");
    auth_url
        .query_pairs_mut()
        .append_pair("api_key", &api_key)
        .append_pair("cb", callback_url.as_str());

    let now = Utc::now().timestamp_millis();
    let state_hash = sha256_hex(&raw_state);
    let session_hash = sha256_hex(&auth.session_id);

    let _ = sqlx::query(
        "DELETE FROM scrobble_auth_states WHERE user_id = ? OR expires_at < ?",
    )
    .bind(&auth.user.id)
    .bind(now)
    .execute(pool.inner())
    .await;

    let _ = sqlx::query(
        r"
        INSERT INTO scrobble_auth_states (state_hash, user_id, session_hash, expires_at)
        VALUES (?, ?, ?, ?)
        ",
    )
    .bind(state_hash)
    .bind(&auth.user.id)
    .bind(session_hash)
    .bind(now + 10 * 60_000)
    .execute(pool.inner())
    .await;

    (
        StatusCode::OK,
        [
            (header::CACHE_CONTROL, "private, no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        Json(json!({ "authorizationUrl": auth_url.to_string() })),
    )
        .into_response()
}

async fn lastfm_callback_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let raw_state = params.get("state").map(String::as_str).unwrap_or("");
    let raw_token = params.get("token").map(String::as_str).unwrap_or("");

    let valid_state = raw_state.len() == 64
        && raw_state
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
    let valid_token = raw_token.len() == 32 && raw_token.chars().all(|c| c.is_ascii_hexdigit());

    if !valid_state || !valid_token {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "code": "BAD_REQUEST",
                    "message": "Authorization callback is incomplete. Start authorization again."
                }
            })),
        )
            .into_response();
    }

    register_log_secret(raw_token);

    let Some(pool) = state.db() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": { "code": "DB_UNAVAILABLE", "message": "Database is unavailable" } })),
        )
            .into_response();
    };

    let state_hash = sha256_hex(raw_state);
    let session_hash = sha256_hex(&auth.session_id);
    let now = Utc::now().timestamp_millis();

    let consumed = sqlx::query(
        r"
        DELETE FROM scrobble_auth_states
        WHERE state_hash = ? AND user_id = ? AND session_hash = ? AND expires_at > ?
        RETURNING state_hash
        ",
    )
    .bind(state_hash)
    .bind(&auth.user.id)
    .bind(session_hash)
    .bind(now)
    .fetch_optional(pool.inner())
    .await
    .ok()
    .flatten();

    if consumed.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "code": "BAD_REQUEST",
                    "message": "Authorization expired or belongs to another session. Start authorization again."
                }
            })),
        )
            .into_response();
    }

    if let Err(err) = state
        .scrobble_queue()
        .connect_lastfm(&auth.user.id, LastFmConnectInput::Token(raw_token.to_owned()))
        .await
    {
        return scrobble_error_response(err);
    }

    let destination = if auth.user.is_admin() {
        "/admin/server?scrobble=connected#scrobble-title"
    } else {
        "/settings?scrobble=connected"
    };
    let public_url = state.config().network.public_url.clone();
    let target = Url::parse(&public_url)
        .and_then(|b| b.join(destination))
        .map(|u| u.to_string())
        .unwrap_or_else(|_| destination.to_owned());

    Redirect::temporary(&target).into_response()
}

async fn put_scrobble_connection_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(provider_raw): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let Some(provider) = ScrobbleProvider::parse(&provider_raw) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "Check the provider and credential fields."
                }
            })),
        )
            .into_response();
    };

    let res = match provider {
        ScrobbleProvider::Lastfm => {
            let Some(sk) = body
                .get("sessionKey")
                .and_then(Value::as_str)
                .and_then(validate_credential)
            else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "error": {
                            "code": "VALIDATION_ERROR",
                            "message": "Check the provider and credential fields."
                        }
                    })),
                )
                    .into_response();
            };
            state
                .scrobble_queue()
                .connect_lastfm(&auth.user.id, LastFmConnectInput::SessionKey(sk))
                .await
        }
        ScrobbleProvider::Listenbrainz => {
            let Some(token) = body
                .get("token")
                .and_then(Value::as_str)
                .and_then(validate_credential)
            else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "error": {
                            "code": "VALIDATION_ERROR",
                            "message": "Check the provider and credential fields."
                        }
                    })),
                )
                    .into_response();
            };
            state
                .scrobble_queue()
                .connect_listenbrainz(&auth.user.id, &token)
                .await
        }
    };

    if let Err(err) = res {
        return scrobble_error_response(err);
    }

    let connections = state.scrobble_queue().statuses(&auth.user.id).await;
    (
        StatusCode::OK,
        [
            (header::CACHE_CONTROL, "private, no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        Json(json!({ "connections": connections })),
    )
        .into_response()
}

async fn delete_scrobble_connection_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(provider_raw): Path<String>,
) -> Response {
    let Some(provider) = ScrobbleProvider::parse(&provider_raw) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "Check the provider and credential fields."
                }
            })),
        )
            .into_response();
    };

    if let Err(err) = state.scrobble_queue().disconnect(&auth.user.id, provider).await {
        return scrobble_error_response(err);
    }

    let connections = state.scrobble_queue().statuses(&auth.user.id).await;
    (
        StatusCode::OK,
        [
            (header::CACHE_CONTROL, "private, no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        Json(json!({ "connections": connections })),
    )
        .into_response()
}

async fn test_scrobble_connection_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(provider_raw): Path<String>,
) -> Response {
    let Some(provider) = ScrobbleProvider::parse(&provider_raw) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "Check the provider and credential fields."
                }
            })),
        )
            .into_response();
    };

    if let Err(err) = state
        .scrobble_queue()
        .test_connection(&auth.user.id, provider)
        .await
    {
        return scrobble_error_response(err);
    }

    let connections = state.scrobble_queue().statuses(&auth.user.id).await;
    (
        StatusCode::OK,
        [
            (header::CACHE_CONTROL, "private, no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        Json(json!({ "connections": connections })),
    )
        .into_response()
}

async fn retry_scrobble_queue_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(provider_raw): Path<String>,
) -> Response {
    let Some(provider) = ScrobbleProvider::parse(&provider_raw) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "Check the provider and credential fields."
                }
            })),
        )
            .into_response();
    };

    if let Err(err) = state.scrobble_queue().retry(&auth.user.id, provider).await {
        return scrobble_error_response(err);
    }

    let connections = state.scrobble_queue().statuses(&auth.user.id).await;
    (
        StatusCode::OK,
        [
            (header::CACHE_CONTROL, "private, no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        Json(json!({ "connections": connections })),
    )
        .into_response()
}

async fn list_artist_follows_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let artists = state.artist_follows().list(&auth.user.id).await;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    (StatusCode::OK, headers, Json(json!({ "artists": artists }))).into_response()
}

async fn get_new_releases_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ServerError> {
    let offset = params
        .get("offset")
        .map_or(Ok(0_usize), |s| s.parse::<usize>())
        .ok()
        .filter(|&v| v <= 100_000)
        .ok_or_else(|| ServerError::BadRequest(String::from("Invalid release page.")))?;

    let limit = params
        .get("limit")
        .map_or(Ok(30_usize), |s| s.parse::<usize>())
        .ok()
        .filter(|&v| (1..=60).contains(&v))
        .ok_or_else(|| ServerError::BadRequest(String::from("Invalid release page.")))?;

    let feed = state
        .artist_follows()
        .feed(&auth.user.id, offset, limit)
        .await;
    let artists = state.artist_follows().list(&auth.user.id).await;

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );

    Ok((
        StatusCode::OK,
        headers,
        Json(json!({
            "releases": feed.releases,
            "hasMore": feed.has_more,
            "artists": artists,
        })),
    )
        .into_response())
}

async fn follow_artist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(mut body): Json<FollowArtistRequestBody>,
) -> Result<Response, ServerError> {
    if body.owner_id != auth.user.id {
        return Err(ServerError::Conflict(String::from(
            "Your signed-in account changed. Reopen this page.",
        )));
    }
    if !auth.user.is_admin() && !auth.user.external_search_enabled {
        return Err(ServerError::Forbidden(String::from(
            "External discovery is not enabled for this account.",
        )));
    }
    state
        .privacy()
        .assert_external_allowed(ExternalCategory::Metadata)
        .map_err(|e| ServerError::Forbidden(e.to_string()))?;

    if body.provider == FollowProvider::Library {
        let Some(pool) = state.db() else {
            return Err(ServerError::ServiceUnavailable(String::from(
                "Database is unavailable",
            )));
        };
        let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
        let Some(artist) = catalog.get_artist(&body.artist_id).await else {
            return Err(ServerError::NotFound(String::from(
                "Library artist not found.",
            )));
        };
        body.artist_name = artist.item.name;
    }

    let artist = state
        .artist_follows()
        .follow(
            &auth.user.id,
            FollowArtistInput {
                artist_id: body.artist_id,
                artist_name: body.artist_name,
                provider: body.provider,
            },
        )
        .await
        .map_err(|err| ServerError::BadRequest(err.message))?;

    // Trigger an asynchronous release scan in the background
    let follows_service = state.artist_follows().clone();
    let task_id = format!("task_{}", Uuid::new_v4().simple());
    tokio::spawn(async move {
        let _ = follows_service.scan_due_artists().await;
    });

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "artist": artist,
            "taskId": task_id,
        })),
    )
        .into_response())
}

async fn unfollow_artist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(key): Path<String>,
    Json(body): Json<UnfollowArtistRequestBody>,
) -> Result<Response, ServerError> {
    if body.owner_id.trim().is_empty() {
        return Err(ServerError::BadRequest(String::from(
            "Account identity is required.",
        )));
    }
    if body.owner_id != auth.user.id {
        return Err(ServerError::Conflict(String::from(
            "Your signed-in account changed. Reopen this page.",
        )));
    }

    state.artist_follows().unfollow(&auth.user.id, &key).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn trigger_new_releases_scan_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Result<Response, ServerError> {
    state
        .privacy()
        .assert_external_allowed(ExternalCategory::Metadata)
        .map_err(|e| ServerError::Forbidden(e.to_string()))?;

    let follows_service = state.artist_follows().clone();
    let task_id = format!("task_{}", Uuid::new_v4().simple());
    tokio::spawn(async move {
        let _ = follows_service.scan_due_artists().await;
    });

    Ok((StatusCode::ACCEPTED, Json(json!({ "taskId": task_id }))).into_response())
}
