//! # Resumable Media & Durable Queue Synchronization HTTP Routes (`routes::queue_media`)
//!
//! Complete Rust port of `server/src/routes/media-session.ts` and
//! `server/src/routes/queue-session.ts`.

use std::collections::HashMap;

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header::CACHE_CONTROL;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::AuthenticatedUser;
use crate::db::DbPool;
use crate::error::{ApiErrorBody, ApiErrorEnvelope, ServerError};
use crate::media::{
    MediaCheckpointInput, MediaCollectionType, MediaSessionError, ResumableMediaService,
};
use crate::playlists::collaboration::PlaylistCollaborationService;
use crate::queue::{MAX_QUEUE_CONTENT_BYTES, QueueCheckpoint, QueueSyncError, SyncPayload};
use crate::state::AppState;
use crate::streaming::send_error_response;

/// Request body limit (`8 KiB`) for `POST /api/v1/user/media-sessions`.
pub const MAX_MEDIA_SESSION_BODY_BYTES: usize = 8192;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteDeviceSessionBody {
    #[serde(rename = "ownerId")]
    owner_id: String,
    #[serde(rename = "deviceId")]
    device_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveNamedQueueBody {
    #[serde(rename = "ownerId")]
    owner_id: String,
    name: String,
    #[serde(rename = "contentId")]
    content_id: String,
    checkpoint: QueueCheckpoint,
    #[serde(rename = "operationId")]
    operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteNamedQueueBody {
    #[serde(rename = "ownerId")]
    owner_id: String,
    revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveQueueAsPlaylistBody {
    #[serde(rename = "ownerId")]
    owner_id: String,
    name: String,
    #[serde(rename = "contentId")]
    content_id: String,
    #[serde(rename = "operationId")]
    operation_id: String,
}

/// Registers all `/api/v1/user/media-sessions` and `/api/v1/user/queue-session` routes.
pub fn queue_and_media_session_routes() -> Router<AppState> {
    let media_post_route = Router::new()
        .route(
            "/api/v1/user/media-sessions",
            post(post_media_session_handler),
        )
        .layer(DefaultBodyLimit::max(MAX_MEDIA_SESSION_BODY_BYTES));

    let queue_content_post_route = Router::new()
        .route(
            "/api/v1/user/queue-session/content",
            post(post_queue_content_handler),
        )
        .layer(DefaultBodyLimit::max(MAX_QUEUE_CONTENT_BYTES));

    Router::new()
        .route(
            "/api/v1/user/media-sessions",
            get(get_media_sessions_handler).delete(delete_media_session_handler),
        )
        .route(
            "/api/v1/user/queue-session",
            get(get_queue_sessions_handler)
                .put(put_queue_session_handler)
                .delete(delete_queue_session_handler),
        )
        .route(
            "/api/v1/user/queue-session/content/:content_id",
            get(get_queue_content_handler),
        )
        .route(
            "/api/v1/user/queue-session/named",
            post(post_named_queue_handler),
        )
        .route(
            "/api/v1/user/queue-session/named/:queue_id",
            delete(delete_named_queue_handler),
        )
        .route(
            "/api/v1/user/queue-session/playlist",
            post(post_queue_as_playlist_handler),
        )
        .merge(media_post_route)
        .merge(queue_content_post_route)
}

fn require_db(state: &AppState) -> Result<&DbPool, ServerError> {
    state
        .db()
        .ok_or_else(|| ServerError::Internal(String::from("Database pool is not initialized")))
}

fn with_no_store(mut response: Response) -> Response {
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

fn map_queue_error(err: QueueSyncError) -> Response {
    let status =
        StatusCode::from_u16(err.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (
        status,
        Json(ApiErrorEnvelope {
            error: ApiErrorBody {
                code: String::from("QUEUE_SYNC_ERROR"),
                message: err.message,
            },
        }),
    )
        .into_response()
}

fn is_valid_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

// ============================================================================
// Resumable Media Session Handlers (`/api/v1/user/media-sessions`)
// ============================================================================

async fn get_media_sessions_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if params.keys().any(|k| !matches!(k.as_str(), "type" | "mediaId")) {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid media session query.",
            "BAD_REQUEST",
        );
    }

    let type_opt = params.get("type");
    let media_id_opt = params.get("mediaId");
    if type_opt.is_some() != media_id_opt.is_some() {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Specify both collection type and ID.",
            "BAD_REQUEST",
        );
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };
    let service = ResumableMediaService::new(db.clone());

    if let (Some(raw_type), Some(media_id)) = (type_opt, media_id_opt) {
        let Some(media_type) = MediaCollectionType::parse_str(raw_type) else {
            return send_error_response(
                StatusCode::BAD_REQUEST,
                "Invalid collection type.",
                "BAD_REQUEST",
            );
        };
        if media_id.is_empty() || media_id.len() > 300 {
            return send_error_response(
                StatusCode::BAD_REQUEST,
                "Invalid mediaId.",
                "BAD_REQUEST",
            );
        }

        return match service.get(&auth.user.id, media_type, media_id).await {
            Ok(Some(item)) => with_no_store(Json(json!({ "items": [item] })).into_response()),
            Ok(None) => with_no_store(Json(json!({ "items": [] })).into_response()),
            Err(err) => ServerError::Internal(err.to_string()).into_response(),
        };
    }

    match service.list(&auth.user.id).await {
        Ok(items) => with_no_store(Json(json!({ "items": items })).into_response()),
        Err(err) => ServerError::Internal(err.to_string()).into_response(),
    }
}

async fn post_media_session_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<Json<MediaCheckpointInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(input)) = payload_res else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid media checkpoint payload.",
            "BAD_REQUEST",
        );
    };

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    if input.media_type == MediaCollectionType::Playlist {
        let collab = PlaylistCollaborationService::new(db.clone());
        let can_read = collab
            .access(&input.media_id, &auth.user, false)
            .await
            .is_ok_and(|p| p.can_read);
        if !can_read {
            return send_error_response(StatusCode::NOT_FOUND, "Playlist not found.", "NOT_FOUND");
        }
    }

    let service = ResumableMediaService::new(db.clone());
    let now_ms = Utc::now().timestamp_millis();
    match service.save_at(&auth.user.id, input, now_ms).await {
        Ok(checkpoint) => Json(json!({ "checkpoint": checkpoint })).into_response(),
        Err(MediaSessionError::Validation(msg)) => {
            send_error_response(StatusCode::BAD_REQUEST, msg, "BAD_REQUEST")
        }
        Err(err) => ServerError::Internal(err.to_string()).into_response(),
    }
}

async fn delete_media_session_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let (Some(raw_type), Some(media_id)) = (params.get("type"), params.get("mediaId")) else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Specify both collection type and ID.",
            "BAD_REQUEST",
        );
    };
    let Some(media_type) = MediaCollectionType::parse_str(raw_type) else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid collection type.",
            "BAD_REQUEST",
        );
    };
    if media_id.is_empty() || media_id.len() > 300 || params.len() != 2 {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid media session identity.",
            "BAD_REQUEST",
        );
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };
    let service = ResumableMediaService::new(db.clone());
    match service.remove(&auth.user.id, media_type, media_id).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => ServerError::Internal(err.to_string()).into_response(),
    }
}

// ============================================================================
// Queue Synchronization Handlers (`/api/v1/user/queue-session`)
// ============================================================================

async fn get_queue_sessions_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };
    let service = state.queue_sync_service(db.clone());

    let sessions = match service.list_sessions(&auth.user.id).await {
        Ok(s) => s,
        Err(err) => return map_queue_error(err),
    };
    let named_queues = match service.list_named(&auth.user.id).await {
        Ok(n) => n,
        Err(err) => return map_queue_error(err),
    };

    with_no_store(
        Json(json!({
            "sessions": sessions,
            "namedQueues": named_queues,
        }))
        .into_response(),
    )
}

async fn post_queue_content_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
    payload_res: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Some(owner_id) = params.get("ownerId") else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Account identity is required for queue sync.",
            "BAD_REQUEST",
        );
    };
    if params.len() != 1 || owner_id.is_empty() || owner_id.len() > 300 {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Account identity is required for queue sync.",
            "BAD_REQUEST",
        );
    }
    if owner_id != &auth.user.id {
        return send_error_response(
            StatusCode::CONFLICT,
            "The signed-in account changed. Reopen the queue.",
            "CONFLICT",
        );
    }

    let Ok(Json(raw_body)) = payload_res else {
        return map_queue_error(QueueSyncError::new(
            "The queue contains invalid tracks or duplicate occurrence IDs.",
            400,
        ));
    };

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };
    let service = state.queue_sync_service(db.clone());

    let _permit = match service.try_acquire_upload_slot() {
        Ok(p) => p,
        Err(err) => return map_queue_error(err),
    };

    let now_ms = Utc::now().timestamp_millis();
    match service.store_content(&auth.user.id, &raw_body, now_ms).await {
        Ok((content_id, track_count)) => Json(json!({
            "contentId": content_id,
            "trackCount": track_count,
        }))
        .into_response(),
        Err(err) => map_queue_error(err),
    }
}

async fn get_queue_content_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(content_id): Path<String>,
) -> Response {
    if !is_valid_sha256_hex(&content_id) {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid queue content ID.",
            "BAD_REQUEST",
        );
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };
    let service = state.queue_sync_service(db.clone());

    match service.get_content(&auth.user.id, &content_id).await {
        Ok(content) => with_no_store(Json(content).into_response()),
        Err(err) => map_queue_error(err),
    }
}

async fn put_queue_session_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<Json<SyncPayload>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid queue session checkpoint.",
            "BAD_REQUEST",
        );
    };

    if body.device_id.is_empty()
        || body.device_id.len() > 300
        || body.device_name.trim().is_empty()
        || body.device_name.trim().chars().count() > 200
        || !is_valid_sha256_hex(&body.content_id)
    {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid queue session checkpoint.",
            "BAD_REQUEST",
        );
    }

    if body.owner_id != auth.user.id {
        return send_error_response(
            StatusCode::CONFLICT,
            "The signed-in account changed. Reopen the queue.",
            "CONFLICT",
        );
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };
    let service = state.queue_sync_service(db.clone());
    let now_ms = Utc::now().timestamp_millis();

    match service
        .save_session_at(
            &auth.user.id,
            &body.device_id,
            &body.device_name,
            &body.content_id,
            &body.checkpoint,
            body.sequence,
            now_ms,
        )
        .await
    {
        Ok((saved, sequence)) => Json(json!({
            "saved": saved,
            "sequence": sequence,
        }))
        .into_response(),
        Err(err) => map_queue_error(err),
    }
}

async fn delete_queue_session_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<Json<DeleteDeviceSessionBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid queue device.",
            "BAD_REQUEST",
        );
    };

    if body.device_id.is_empty() || body.device_id.len() > 300 {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid queue device.",
            "BAD_REQUEST",
        );
    }
    if body.owner_id != auth.user.id {
        return send_error_response(
            StatusCode::CONFLICT,
            "Your signed-in account changed.",
            "CONFLICT",
        );
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };
    let service = state.queue_sync_service(db.clone());

    match service.remove_session(&auth.user.id, &body.device_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => map_queue_error(err),
    }
}

async fn post_named_queue_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<Json<SaveNamedQueueBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid named queue.",
            "BAD_REQUEST",
        );
    };

    if body.name.trim().is_empty()
        || body.name.trim().chars().count() > 200
        || !is_valid_sha256_hex(&body.content_id)
        || body.operation_id.is_empty()
        || body.operation_id.len() > 300
    {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid named queue.",
            "BAD_REQUEST",
        );
    }

    if body.owner_id != auth.user.id {
        return send_error_response(
            StatusCode::CONFLICT,
            "Your signed-in account changed.",
            "CONFLICT",
        );
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };
    let service = state.queue_sync_service(db.clone());
    let now_ms = Utc::now().timestamp_millis();

    match service
        .save_named_at(
            &auth.user.id,
            &body.name,
            &body.content_id,
            &body.checkpoint,
            &body.operation_id,
            now_ms,
        )
        .await
    {
        Ok(id) => (StatusCode::CREATED, Json(json!({ "id": id }))).into_response(),
        Err(err) => map_queue_error(err),
    }
}

async fn delete_named_queue_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(queue_id): Path<String>,
    payload_res: Result<Json<DeleteNamedQueueBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid named queue revision.",
            "BAD_REQUEST",
        );
    };

    if body.owner_id != auth.user.id {
        return send_error_response(
            StatusCode::CONFLICT,
            "Your signed-in account changed.",
            "CONFLICT",
        );
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };
    let service = state.queue_sync_service(db.clone());

    match service
        .remove_named(&auth.user.id, &queue_id, body.revision)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => map_queue_error(err),
    }
}

async fn post_queue_as_playlist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<Json<SaveQueueAsPlaylistBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid queue playlist save.",
            "BAD_REQUEST",
        );
    };

    if body.name.trim().is_empty()
        || body.name.trim().chars().count() > 200
        || !is_valid_sha256_hex(&body.content_id)
        || body.operation_id.is_empty()
        || body.operation_id.len() > 300
    {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid queue playlist save.",
            "BAD_REQUEST",
        );
    }

    if body.owner_id != auth.user.id {
        return send_error_response(
            StatusCode::CONFLICT,
            "Your signed-in account changed.",
            "CONFLICT",
        );
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };
    let service = state.queue_sync_service(db.clone());

    match service
        .save_as_playlist(
            &auth.user.id,
            &body.name,
            &body.content_id,
            &body.operation_id,
        )
        .await
    {
        Ok(playlist_id) => (
            StatusCode::CREATED,
            Json(json!({ "playlistId": playlist_id })),
        )
            .into_response(),
        Err(err) => map_queue_error(err),
    }
}
