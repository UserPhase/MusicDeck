//! # User Administration & Avatar HTTP Routes (`routes::users`)
//!
//! Complete Rust port of `server/src/routes/user-routes.ts`.
//!
//! ## Endpoints Mounted
//! - `GET /api/users/me` (and alias `GET /api/user`): Returns `{ "user": ... }` for the active session.
//! - `PATCH /api/users/me` (and alias `PATCH /api/user`): Updates the caller's `displayName` / `avatarRef`.
//! - `POST /api/users/profile/avatar` (and alias `POST /api/user/avatar`): Accepts either a JSON
//!   `{ "image": "data:image/png;base64,..." }` payload or a `multipart/form-data` upload under an
//!   8 MiB body limit (`MAX_AVATAR_REQUEST_BYTES`).
//! - `DELETE /api/users/profile/avatar` (and alias `DELETE /api/user/avatar`): Clears the caller's custom avatar.
//! - `GET /api/users/:user_id/avatar` (and alias `GET /api/user/:user_id/avatar`): Serves the user's
//!   avatar binary with `ETag`, `If-None-Match` (`304 Not Modified`),
//!   `Cache-Control: private, max-age=31536000, immutable`, and `X-Content-Type-Options: nosniff`.
//! - `GET /api/users`: Admin-only list of all users (`{ "users": [...] }`).
//! - `POST /api/users`: Admin-only user creation (`201 Created`).
//! - `PATCH /api/users/:user_id`: Admin-only user update enforcing `MASTER_ADMIN_PROTECTED` and `SELF_LOCKOUT`.
//! - `DELETE /api/users/:user_id`: Admin-only user deletion (`204 No Content`).

use std::net::{IpAddr, SocketAddr};

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, IF_NONE_MATCH, X_CONTENT_TYPE_OPTIONS};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::{
    AuthenticatedUser, OptionalUser, RequireAdmin, append_set_cookie, build_session_sse_stream,
    extract_session_cookie, format_clear_session_cookie, format_set_session_cookie, hash_password,
    revoke_user_sessions_tx, verify_password,
};
use crate::avatars::{
    MAX_AVATAR_BYTES, MAX_AVATAR_REQUEST_BYTES, clear_user_avatar, get_user_avatar,
    normalize_avatar_thumbnail, parse_avatar_data_url, set_user_avatar, validate_raw_avatar_bytes,
};
use crate::db::DbPool;
use crate::config::network::NetworkConfig;
use crate::error::{ApiErrorBody, ApiErrorEnvelope, ServerError};
use crate::state::AppState;
use crate::users::{
    CreateUserPayload, UpdateOwnProfilePayload, User, UserError, UserUpdatePayload,
    check_delete_guard, check_update_guard, create_user, delete_user, get_user_by_id,
    get_user_by_username, list_users, record_login_on_conn, update_own_profile, update_user,
};

#[cfg(test)]
mod tests;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AvatarDataUrlBody {
    image: String,
    #[serde(default)]
    normalize_thumbnail: bool,
}

/// Envelope `{ "user": User }` returned by single-user endpoints.
#[derive(Debug, Serialize, Deserialize)]
pub struct SingleUserResponse {
    /// Public user object.
    pub user: User,
}

/// Envelope `{ "users": Vec<User> }` returned by `GET /api/users`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UserListResponse {
    /// Ordered list of users.
    pub users: Vec<User>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginRequestBody {
    username: String,
    password: String,
    #[serde(default)]
    remember_me: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordRequestBody {
    current_password: String,
    new_password: String,
}

/// Registers all authentication, user profile, avatar, and admin user-management routes.
pub fn user_routes() -> Router<AppState> {
    let avatar_upload_routes = Router::new()
        .route("/api/users/profile/avatar", post(upload_own_avatar))
        .route("/api/user/avatar", post(upload_own_avatar))
        .layer(DefaultBodyLimit::max(MAX_AVATAR_REQUEST_BYTES));

    Router::new()
        .route("/api/auth/login", post(auth_login_handler))
        .route("/api/auth/logout", post(auth_logout_handler))
        .route("/api/auth/session", get(auth_session_handler))
        .route("/api/auth/session/events", get(auth_session_events_handler))
        .route("/api/auth/change-password", post(auth_change_password_handler))
        .route("/api/users/me", get(get_me).patch(patch_me))
        .route("/api/user", get(get_me).patch(patch_me))
        .route("/api/users/profile/avatar", delete(delete_own_avatar))
        .route("/api/user/avatar", delete(delete_own_avatar))
        .route("/api/users/:user_id/avatar", get(get_avatar_by_user_id))
        .route("/api/user/:user_id/avatar", get(get_avatar_by_user_id))
        .route("/api/users", get(admin_list_users).post(admin_create_user))
        .route(
            "/api/users/:user_id",
            axum::routing::patch(admin_update_user).delete(admin_delete_user),
        )
        .merge(avatar_upload_routes)
}

fn require_db(state: &AppState) -> Result<&DbPool, ServerError> {
    state
        .db()
        .ok_or_else(|| ServerError::Internal(String::from("Database pool is not initialized")))
}

fn map_user_error(err: UserError) -> Response {
    let (status, code, message) = match err {
        UserError::Validation(msg) => (StatusCode::BAD_REQUEST, "VALIDATION_ERROR", msg),
        UserError::InvalidAvatar(msg) => (StatusCode::BAD_REQUEST, "VALIDATION_ERROR", msg),
        UserError::NotFound(msg) => (StatusCode::NOT_FOUND, "NOT_FOUND", msg),
        UserError::Conflict(msg) => (StatusCode::CONFLICT, "CONFLICT", msg),
        UserError::GuardViolation { code, message } => (StatusCode::FORBIDDEN, code, message),
        UserError::Auth(auth_err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_SERVER_ERROR",
            auth_err.to_string(),
        ),
        UserError::Sqlx(sql_err) => {
            tracing::error!(error = %sql_err, "Database error in user route");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_SERVER_ERROR",
                String::from("An unexpected database error occurred"),
            )
        }
    };

    (
        status,
        Json(ApiErrorEnvelope {
            error: ApiErrorBody {
                code: String::from(code),
                message,
            },
        }),
    )
        .into_response()
}

/// `GET /api/users/me` (`GET /api/user`)
async fn get_me(auth: AuthenticatedUser) -> Json<SingleUserResponse> {
    Json(SingleUserResponse { user: auth.user })
}

/// `PATCH /api/users/me` (`PATCH /api/user`)
async fn patch_me(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
     payload_res: Result<Json<UpdateOwnProfilePayload>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload_res else {
        return map_user_error(UserError::Validation(String::from(
            "Invalid profile update request",
        )));
    };

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match update_own_profile(db, &auth.user.id, payload).await {
        Ok(Some(updated)) => Json(SingleUserResponse { user: updated }).into_response(),
        Ok(None) => map_user_error(UserError::NotFound(String::from("User not found"))),
        Err(err) => map_user_error(err),
    }
}

/// `POST /api/users/profile/avatar` (`POST /api/user/avatar`)
///
/// Supports both:
/// 1. JSON data URL payload (`{ "image": "data:image/png;base64,..." }`) used by the web client, and
/// 2. `multipart/form-data` binary upload (`avatar` or `file` field) with optional `256x256` resizing.
async fn upload_own_avatar(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    request: Request,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let parsed_avatar = if content_type.starts_with("multipart/form-data") {
        extract_multipart_avatar(request).await
    } else {
        extract_json_data_url_avatar(request).await
    };

    let avatar = match parsed_avatar {
        Ok(img) => img,
        Err(err) => return map_user_error(err),
    };

    match set_user_avatar(db, &auth.user.id, &avatar.data, &avatar.content_type).await {
        Ok(true) => match get_user_by_id(db, &auth.user.id).await {
            Ok(Some(user)) => Json(SingleUserResponse { user }).into_response(),
            Ok(None) => map_user_error(UserError::NotFound(String::from("User not found"))),
            Err(err) => map_user_error(err),
        },
        Ok(false) => map_user_error(UserError::NotFound(String::from("User not found"))),
        Err(err) => map_user_error(err),
    }
}

async fn extract_json_data_url_avatar(
    request: Request,
) -> Result<crate::avatars::AvatarImage, UserError> {
    let body_bytes: Bytes = axum::body::to_bytes(request.into_body(), MAX_AVATAR_REQUEST_BYTES)
        .await
        .map_err(|_| {
            UserError::InvalidAvatar(String::from(
                "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
            ))
        })?;

    let parsed: AvatarDataUrlBody = serde_json::from_slice(&body_bytes).map_err(|_| {
        UserError::InvalidAvatar(String::from(
            "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
        ))
    })?;

    let raw_image = parse_avatar_data_url(&parsed.image)?;
    if parsed.normalize_thumbnail {
        let ct = raw_image.content_type.clone();
        let bytes = raw_image.data;
        tokio::task::spawn_blocking(move || normalize_avatar_thumbnail(&bytes, Some(&ct)))
            .await
            .map_err(|err| UserError::InvalidAvatar(format!("Image worker failed: {err}")))?
    } else {
        Ok(raw_image)
    }
}

async fn extract_multipart_avatar(
    request: Request,
) -> Result<crate::avatars::AvatarImage, UserError> {
    use axum::extract::FromRequest;

    let mut multipart = Multipart::from_request(request, &())
        .await
        .map_err(|_| {
            UserError::InvalidAvatar(String::from(
                "Invalid multipart avatar upload request",
            ))
        })?;

    while let Some(mut field) = multipart.next_field().await.map_err(|_| {
        UserError::InvalidAvatar(String::from(
            "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
        ))
    })? {
        let field_name = field.name().unwrap_or_default().to_owned();
        if !matches!(field_name.as_str(), "avatar" | "file" | "image") {
            continue;
        }

        let declared_mime = field.content_type().map(str::to_owned);
        let mut buffer = Vec::with_capacity(64 * 1024);

        while let Some(chunk) = field.chunk().await.map_err(|_| {
            UserError::InvalidAvatar(String::from(
                "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
            ))
        })? {
            if buffer.len() + chunk.len() > MAX_AVATAR_BYTES {
                return Err(UserError::InvalidAvatar(String::from(
                    "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
                )));
            }
            buffer.extend_from_slice(&chunk);
        }

        return tokio::task::spawn_blocking(move || {
            normalize_avatar_thumbnail(&buffer, declared_mime.as_deref())
                .or_else(|_| validate_raw_avatar_bytes(&buffer, declared_mime.as_deref()))
        })
        .await
        .map_err(|err| UserError::InvalidAvatar(format!("Image worker failed: {err}")))?;
    }

    Err(UserError::InvalidAvatar(String::from(
        "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
    )))
}

/// `DELETE /api/users/profile/avatar` (`DELETE /api/user/avatar`)
async fn delete_own_avatar(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    if let Err(err) = clear_user_avatar(db, &auth.user.id).await {
        return map_user_error(err);
    }

    match get_user_by_id(db, &auth.user.id).await {
        Ok(Some(user)) => Json(SingleUserResponse { user }).into_response(),
        Ok(None) => map_user_error(UserError::NotFound(String::from("User not found"))),
        Err(err) => map_user_error(err),
    }
}

/// `GET /api/users/:user_id/avatar` (`GET /api/user/:user_id/avatar`)
async fn get_avatar_by_user_id(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Path(user_id): Path<String>,
    request_headers: HeaderMap,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let avatar = match get_user_avatar(db, &user_id).await {
        Ok(Some(img)) => img,
        Ok(None) => {
            return map_user_error(UserError::NotFound(String::from("Avatar not found")));
        }
        Err(err) => return map_user_error(err),
    };

    // Conditional ETag check (`304 Not Modified`)
    if let Some(if_none_match) = request_headers
        .get(IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        && if_none_match
            .split(',')
            .any(|candidate| candidate.trim() == avatar.etag || candidate.trim() == "*")
    {
        let mut not_modified = StatusCode::NOT_MODIFIED.into_response();
        if let Ok(etag_val) = HeaderValue::from_str(&avatar.etag) {
            not_modified.headers_mut().insert(ETAG, etag_val);
        }
        not_modified.headers_mut().insert(
            CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=31536000, immutable"),
        );
        return not_modified;
    }

    let mut response = (StatusCode::OK, avatar.data).into_response();
    let headers = response.headers_mut();
    if let Ok(ct) = HeaderValue::from_str(&avatar.content_type) {
        headers.insert(CONTENT_TYPE, ct);
    }
    if let Ok(etag_val) = HeaderValue::from_str(&avatar.etag) {
        headers.insert(ETAG, etag_val);
    }
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    headers.insert(
        X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

/// `GET /api/users` (admin only)
async fn admin_list_users(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match list_users(db).await {
        Ok(users) => Json(UserListResponse { users }).into_response(),
        Err(err) => map_user_error(err),
    }
}

/// `POST /api/users` (admin only)
async fn admin_create_user(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    payload_res: Result<Json<CreateUserPayload>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload_res else {
        return map_user_error(UserError::Validation(String::from("Invalid user request")));
    };

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match create_user(db, payload).await {
        Ok(created) => (StatusCode::CREATED, Json(SingleUserResponse { user: created })).into_response(),
        Err(UserError::Conflict(_)) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": {
                    "code": "CONFLICT",
                    "message": "User could not be created"
                }
            })),
        )
            .into_response(),
        Err(err) => map_user_error(err),
    }
}

/// `PATCH /api/users/:user_id` (admin only)
async fn admin_update_user(
    State(state): State<AppState>,
    admin: RequireAdmin,
    Path(user_id): Path<String>,
    payload_res: Result<Json<UserUpdatePayload>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload_res else {
        return map_user_error(UserError::Validation(String::from(
            "Invalid user update request",
        )));
    };

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let target = match get_user_by_id(db, &user_id).await {
        Ok(Some(u)) => u,
        Ok(None) => return map_user_error(UserError::NotFound(String::from("User not found"))),
        Err(err) => return map_user_error(err),
    };

    if let Err(guard_err) = check_update_guard(&admin.user, &target, &payload) {
        return map_user_error(guard_err);
    }

    match update_user(db, state.session_store(), &user_id, payload).await {
        Ok(Some(updated)) => Json(SingleUserResponse { user: updated }).into_response(),
        Ok(None) => map_user_error(UserError::NotFound(String::from("User not found"))),
        Err(err) => map_user_error(err),
    }
}

/// `DELETE /api/users/:user_id` (admin only)
async fn admin_delete_user(
    State(state): State<AppState>,
    admin: RequireAdmin,
    Path(user_id): Path<String>,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let target = match get_user_by_id(db, &user_id).await {
        Ok(Some(u)) => u,
        Ok(None) => return map_user_error(UserError::NotFound(String::from("User not found"))),
        Err(err) => return map_user_error(err),
    };

    if let Err(guard_err) = check_delete_guard(&admin.user, &target) {
        return map_user_error(guard_err);
    }

    match delete_user(db, state.session_store(), &user_id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => map_user_error(UserError::NotFound(String::from("User not found"))),
        Err(err) => map_user_error(err),
    }
}

/// Resolves the login rate-limit key from the socket and explicitly trusted proxy hops.
fn login_client_ip(config: &NetworkConfig, peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    let peer_ip = peer.ip().to_canonical();
    if !config.is_trusted_proxy(&peer_ip) {
        return peer_ip;
    }
    let Ok(forwarded) = headers
        .get_all("x-forwarded-for")
        .iter()
        .map(|value| value.to_str())
        .collect::<Result<Vec<_>, _>>()
    else {
        return peer_ip;
    };
    config.resolve_client_ip(peer_ip, Some(&forwarded.join(",")))
}

/// `POST /api/auth/login`
async fn auth_login_handler(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    payload_res: Result<Json<LoginRequestBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "code": "BAD_REQUEST", "message": "Invalid login request" } })),
        )
            .into_response();
    };
    if body.username.trim().is_empty() || body.password.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "code": "BAD_REQUEST", "message": "Invalid login request" } })),
        )
            .into_response();
    }

    let client_ip = login_client_ip(&state.config().network, peer, &headers).to_string();
    let admission = state.login_limiter().admit(&client_ip, &body.username);
    if let Some(retry_after) = admission.retry_after() {
        let mut resp = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": {
                    "code": "RATE_LIMITED",
                    "message": "Too many login attempts. Please try again later."
                }
            })),
        )
            .into_response();
        if let Ok(val) = HeaderValue::from_str(&retry_after.to_string()) {
            resp.headers_mut().insert(axum::http::header::RETRY_AFTER, val);
        }
        return resp;
    }

    let (Ok(db), Some(sessions)) = (require_db(&state), state.session_store()) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let stored = match get_user_by_username(db, &body.username).await {
        Ok(Some(u)) if !u.disabled => u,
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({
                    "error": {
                        "code": "UNAUTHORIZED",
                        "message": "Invalid username or password"
                    }
                })),
            )
                .into_response();
        }
    };

    let valid = verify_password(&body.password, &stored.password_hash)
        .await
        .unwrap_or(false);
    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": {
                    "code": "UNAUTHORIZED",
                    "message": "Invalid username or password"
                }
            })),
        )
            .into_response();
    }

    let remember_me = body.remember_me.unwrap_or(true);
    let Ok(session) = sessions.create_session(&stored.id, remember_me).await else {
        return ServerError::Internal(String::from("Could not create session")).into_response();
    };

    let mut conn = match db.inner().acquire().await {
        Ok(c) => c,
        Err(_) => return ServerError::Internal(String::from("Database unavailable")).into_response(),
    };
    let last_login_at = record_login_on_conn(&mut conn, &stored.id).await.ok();
    drop(conn);

    let mut user = stored.public_user;
    if last_login_at.is_some() {
        user.last_login_at = last_login_at;
    }

    let cookie = format_set_session_cookie(
        &session.id,
        session.expires_at,
        state.config().auth.secure_cookies,
        session.persistent,
    );

    let mut resp = Json(SingleUserResponse { user }).into_response();
    append_set_cookie(resp.headers_mut(), cookie);
    resp
}

/// `POST /api/auth/logout`
async fn auth_logout_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Some(sessions) = state.session_store() {
        let sid = extract_session_cookie(&headers);
        let _ = sessions.delete_session(sid.as_deref()).await;
    }
    let clear_cookie = format_clear_session_cookie(state.config().auth.secure_cookies);
    let mut resp = Json(json!({ "ok": true })).into_response();
    append_set_cookie(resp.headers_mut(), clear_cookie);
    resp
}

/// `GET /api/auth/session`
async fn auth_session_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    opt_user: OptionalUser,
) -> Response {
    let mut resp = Json(json!({
        "authenticated": opt_user.0.is_some(),
        "user": opt_user.0.as_ref().map(|u| &u.user),
    }))
    .into_response();

    if opt_user.0.is_some() {
        if let (Some(sessions), Some(sid)) = (state.session_store(), extract_session_cookie(&headers)) {
            if let Ok(Some(refreshed_cookie)) = sessions
                .refresh_session_if_remembered(&sid, state.config().auth.secure_cookies)
                .await
            {
                append_set_cookie(resp.headers_mut(), refreshed_cookie);
            }
        }
    }

    resp
}

/// `GET /api/auth/session/events`
async fn auth_session_events_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    headers: HeaderMap,
) -> Response {
    let Some(sessions) = state.session_store().cloned() else {
        return ServerError::ServiceUnavailable(String::from("Session store unavailable"))
            .into_response();
    };
    let session_id = if auth.session_id.is_empty() {
        extract_session_cookie(&headers).unwrap_or_default()
    } else {
        auth.session_id
    };
    build_session_sse_stream(sessions, session_id, false).into_response()
}

/// `POST /api/auth/change-password`
async fn auth_change_password_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    headers: HeaderMap,
    payload_res: Result<Json<ChangePasswordRequestBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "code": "BAD_REQUEST",
                    "message": "Invalid password change request"
                }
            })),
        )
            .into_response();
    };
    if body.current_password.is_empty() || body.new_password.chars().count() < 8 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "code": "BAD_REQUEST",
                    "message": "Invalid password change request"
                }
            })),
        )
            .into_response();
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let stored = match get_user_by_username(db, &auth.user.username).await {
        Ok(Some(u)) => u,
        _ => return ServerError::Unauthorized(String::from("Authentication required")).into_response(),
    };

    let valid = verify_password(&body.current_password, &stored.password_hash)
        .await
        .unwrap_or(false);
    if !valid {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "code": "BAD_REQUEST",
                    "message": "Current password is incorrect"
                }
            })),
        )
            .into_response();
    }

    let Ok(new_hash) = hash_password(&body.new_password).await else {
        return ServerError::Internal(String::from("Could not hash password")).into_response();
    };

    let current_sid = if auth.session_id.is_empty() {
        extract_session_cookie(&headers)
    } else {
        Some(auth.session_id)
    };

    let Ok(mut tx) = db.inner().begin().await else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let now_iso = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    if sqlx::query("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?;")
        .bind(&new_hash)
        .bind(&now_iso)
        .bind(&auth.user.id)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        let _ = tx.rollback().await;
        return ServerError::Internal(String::from("Could not update password")).into_response();
    }

    if revoke_user_sessions_tx(&mut tx, &auth.user.id, current_sid.as_deref())
        .await
        .is_err()
    {
        let _ = tx.rollback().await;
        return ServerError::Internal(String::from("Could not revoke sessions")).into_response();
    }

    if tx.commit().await.is_err() {
        return ServerError::Internal(String::from("Could not commit password update"))
            .into_response();
    }

    if let Some(sessions) = state.session_store() {
        sessions
            .notify_user_sessions_revoked(&auth.user.id, current_sid.as_deref())
            .await;
        sessions.events().notify_changes();
    }

    Json(json!({ "ok": true })).into_response()
}
