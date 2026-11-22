//! # Playlist CRUD, Reordering, Batch Mutation & Artwork HTTP Routes (`routes::playlists`)
//!
//! Complete Rust port of `server/src/routes/playlist-routes.ts`.
//!
//! ## Endpoints Mounted
//! - `GET /api/playlists`: Lists all playlists visible to the authenticated user.
//! - `GET /api/v1/playlists/recently-played`: Lists the authenticated user's recently played playlists.
//! - `POST /api/playlists`: Creates a new playlist (`201 Created`).
//! - `GET /api/playlists/:playlist_id`: Returns hydrated playlist details and `itemIds`.
//! - `PATCH /api/playlists/:playlist_id`: Updates playlist `name` and/or `description`.
//! - `DELETE /api/playlists/:playlist_id`: Deletes a playlist (`204 No Content`).
//! - `POST /api/playlists/:playlist_id/tracks`: Appends a track (`{ "added": bool }`).
//! - `DELETE /api/playlists/:playlist_id/tracks/:playlist_item_id`: Removes a track occurrence (`204 No Content`).
//! - `PUT /api/playlists/:playlist_id/tracks/reorder`: Reorders tracks by track IDs.
//! - `POST /api/v1/playlists/:playlist_id/reorder`: Compare-And-Swap (`expectedItemIds`) occurrence reorder.
//! - `POST /api/v1/playlists/:playlist_id/tracks/batch`: Atomic batch track add or CAS batch remove.
//! - `GET /api/playlists/:playlist_id/artwork`: Serves custom or generated 2x2 collage artwork.
//! - `PUT /api/playlists/:playlist_id/artwork`: Uploads custom base64 artwork under an 8 MiB limit.
//! - `DELETE /api/playlists/:playlist_id/artwork`: Clears custom artwork (`reverts to collage`).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::error::ApiJson;
use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, X_CONTENT_TYPE_OPTIONS};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_http::CompressionLevel;
use tower_http::compression::CompressionLayer;

use crate::auth::AuthenticatedUser;
use crate::catalog::{CatalogService, LibraryService, SourceResolver};
use crate::error::{ApiErrorBody, ApiErrorEnvelope};
use crate::playlists::{
    MAX_ARTWORK_REQUEST_BYTES, PlaylistBatchEdit, PlaylistError, PlaylistRecord, PlaylistService,
    PlaylistUpdatePayload, parse_image_data_url,
};
use crate::state::AppState;
use crate::streaming::send_error_response;

#[derive(Debug, Deserialize)]
struct CreatePlaylistBody {
    name: String,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AddTrackBody {
    #[serde(rename = "trackId")]
    track_id: String,
}

#[derive(Debug, Deserialize)]
struct LegacyReorderBody {
    #[serde(rename = "trackIds")]
    track_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CasReorderBody {
    #[serde(rename = "itemIds")]
    item_ids: Vec<String>,
    #[serde(rename = "expectedItemIds")]
    expected_item_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ArtworkUploadBody {
    image: String,
}

#[derive(Serialize)]
struct PlaylistDetailResponse {
    playlist: PlaylistRecord,
}

/// Mounts all `/api/playlists` and `/api/v1/playlists` routes.
pub fn playlist_routes() -> Router<AppState> {
    let artwork_upload_route = Router::new()
        .route(
            "/api/playlists/:playlist_id/artwork",
            put(put_playlist_artwork_handler),
        )
        .layer(DefaultBodyLimit::max(MAX_ARTWORK_REQUEST_BYTES));

    Router::new()
        .route(
            "/api/playlists",
            get(list_playlists_handler).post(create_playlist_handler),
        )
        .route(
            "/api/v1/playlists/recently-played",
            get(list_recently_played_playlists_handler),
        )
        .route(
            "/api/playlists/:playlist_id",
            get(get_playlist_handler)
                .layer(CompressionLayer::new().quality(CompressionLevel::Fastest))
                .patch(patch_playlist_handler)
                .delete(delete_playlist_handler),
        )
        .route(
            "/api/playlists/:playlist_id/tracks",
            post(add_playlist_track_handler),
        )
        .route(
            "/api/playlists/:playlist_id/tracks/:playlist_item_id",
            delete(remove_playlist_item_handler),
        )
        .route(
            "/api/playlists/:playlist_id/tracks/reorder",
            put(reorder_playlist_tracks_handler),
        )
        .route(
            "/api/v1/playlists/:playlist_id/reorder",
            post(cas_reorder_playlist_items_handler),
        )
        .route(
            "/api/v1/playlists/:playlist_id/tracks/batch",
            post(batch_edit_playlist_tracks_handler),
        )
        .route(
            "/api/playlists/:playlist_id/artwork",
            get(get_playlist_artwork_handler).delete(delete_playlist_artwork_handler),
        )
        .merge(artwork_upload_route)
}

pub(super) fn build_playlist_service(state: &AppState) -> Result<PlaylistService, Response> {
    let Some(db) = state.db().cloned() else {
        return Err(send_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Database pool is not initialized",
            "BACKEND_ERROR",
        ));
    };
    let library = LibraryService::new(db.clone(), Some(state.config().music_root.clone()));
    let registry = state.providers().clone();
    let catalog = CatalogService::new(registry.clone(), library.clone());
    let resolver = SourceResolver::new(registry, library.clone());
    Ok(PlaylistService::new(db, catalog, library, resolver))
}

pub(super) fn map_playlist_error(err: PlaylistError) -> Response {
    let (status, code, message) = match err {
        PlaylistError::Validation(msg) => (StatusCode::BAD_REQUEST, "VALIDATION_ERROR", msg),
        PlaylistError::Conflict(msg) => (StatusCode::CONFLICT, "PLAYLIST_CONFLICT", msg),
        PlaylistError::AccessDenied => (
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            String::from("Playlist access denied"),
        ),
        PlaylistError::NotFound => (
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            String::from("Playlist not found"),
        ),
        PlaylistError::Db(db_err) => {
            tracing::error!(error = %db_err, "Database error in playlist route");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                String::from("Playlist database error"),
            )
        }
        PlaylistError::Sqlx(sql_err) => {
            tracing::error!(error = %sql_err, "SQLx error in playlist route");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                String::from("Playlist database error"),
            )
        }
    };

    (
        status,
        Json(ApiErrorEnvelope {
            error: ApiErrorBody {
                request_id: crate::error::current_request_id(),
                code: String::from(code),
                message,
            },
        }),
    )
        .into_response()
}

/// `GET /api/playlists`
async fn list_playlists_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let service = match build_playlist_service(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match service.list(&auth.user).await {
        Ok(playlists) => Json(json!({ "playlists": playlists })).into_response(),
        Err(err) => map_playlist_error(err),
    }
}

async fn list_recently_played_playlists_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let service = match build_playlist_service(&state) {
        Ok(service) => service,
        Err(response) => return response,
    };
    match service.list_recently_played(&auth.user).await {
        Ok(playlists) => (
            [(CACHE_CONTROL, "private, no-store")],
            Json(json!({ "playlists": playlists })),
        )
            .into_response(),
        Err(error) => map_playlist_error(error),
    }
}

/// `POST /api/playlists`
async fn create_playlist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<ApiJson<CreatePlaylistBody>, crate::error::ApiJsonRejection>,
) -> Response {
    let ApiJson(body) = match payload_res {
        Ok(body) => body,
        Err(rejection) => return rejection.into_response(),
    };

    let service = match build_playlist_service(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match service
        .create(&body.name, &auth.user, body.description.as_deref())
        .await
    {
        Ok(playlist) => (StatusCode::CREATED, Json(json!({ "playlist": playlist }))).into_response(),
        Err(PlaylistError::Validation(msg)) => {
            send_error_response(StatusCode::BAD_REQUEST, msg, "BAD_REQUEST")
        }
        Err(err) => map_playlist_error(err),
    }
}

/// `GET /api/playlists/:playlist_id`
async fn get_playlist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
) -> Response {
    let service = match build_playlist_service(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match service.get_with_timing(&playlist_id, &auth.user).await {
        Ok(Some((playlist, timing))) => {
            let started = Instant::now();
            let mut response = Json(PlaylistDetailResponse { playlist }).into_response();
            let millis = |elapsed: Duration| elapsed.as_secs_f64() * 1000.0;
            let header = format!(
                "playlist_db;dur={:.2}, playlist_hydrate;dur={:.2}, playlist_json;dur={:.2}",
                millis(timing.database),
                millis(timing.hydration),
                millis(started.elapsed())
            );
            if let Ok(value) = HeaderValue::from_str(&header) {
                response.headers_mut().insert("server-timing", value);
            }
            response
        }
        Ok(None) => send_error_response(StatusCode::NOT_FOUND, "Playlist not found", "NOT_FOUND"),
        Err(err) => map_playlist_error(err),
    }
}

/// `PATCH /api/playlists/:playlist_id`
async fn patch_playlist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    payload_res: Result<ApiJson<PlaylistUpdatePayload>, crate::error::ApiJsonRejection>,
) -> Response {
    let service = match build_playlist_service(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    let perms = match service.permissions_for(&playlist_id, &auth.user).await {
        Ok(p) => p,
        Err(err) => return map_playlist_error(err),
    };
    if !perms.can_manage {
        return send_error_response(
            StatusCode::FORBIDDEN,
            "Playlist access denied",
            "FORBIDDEN",
        );
    }

    let ApiJson(payload) = match payload_res {
        Ok(body) => body,
        Err(rejection) => return rejection.into_response(),
    };

    match service.update(&playlist_id, payload, &auth.user).await {
        Ok(Some(playlist)) => Json(json!({ "playlist": playlist })).into_response(),
        Ok(None) => send_error_response(StatusCode::NOT_FOUND, "Playlist not found", "NOT_FOUND"),
        Err(PlaylistError::Validation(msg)) => {
            send_error_response(StatusCode::BAD_REQUEST, msg, "BAD_REQUEST")
        }
        Err(err) => map_playlist_error(err),
    }
}

/// `DELETE /api/playlists/:playlist_id`
async fn delete_playlist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
) -> Response {
    let service = match build_playlist_service(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match service.remove(&playlist_id, &auth.user).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => send_error_response(StatusCode::NOT_FOUND, "Playlist not found", "NOT_FOUND"),
        Err(err) => map_playlist_error(err),
    }
}

/// `POST /api/playlists/:playlist_id/tracks`
async fn add_playlist_track_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    payload_res: Result<ApiJson<AddTrackBody>, crate::error::ApiJsonRejection>,
) -> Response {
    let service = match build_playlist_service(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    let perms = match service.permissions_for(&playlist_id, &auth.user).await {
        Ok(p) => p,
        Err(err) => return map_playlist_error(err),
    };
    if !perms.can_edit_tracks {
        return send_error_response(
            StatusCode::FORBIDDEN,
            "Playlist access denied",
            "FORBIDDEN",
        );
    }

    let ApiJson(body) = match payload_res {
        Ok(body) => body,
        Err(rejection) => return rejection.into_response(),
    };

    match service
        .add_track(&playlist_id, &body.track_id, &auth.user)
        .await
    {
        Ok(added) => Json(json!({ "added": added })).into_response(),
        Err(PlaylistError::Validation(msg)) => {
            send_error_response(StatusCode::BAD_REQUEST, msg, "BAD_REQUEST")
        }
        Err(err) => map_playlist_error(err),
    }
}

/// `DELETE /api/playlists/:playlist_id/tracks/:playlist_item_id`
async fn remove_playlist_item_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path((playlist_id, playlist_item_id)): Path<(String, String)>,
) -> Response {
    let service = match build_playlist_service(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    let perms = match service.permissions_for(&playlist_id, &auth.user).await {
        Ok(p) => p,
        Err(err) => return map_playlist_error(err),
    };
    if !perms.can_edit_tracks {
        return send_error_response(
            StatusCode::FORBIDDEN,
            "Playlist access denied",
            "FORBIDDEN",
        );
    }

    match service
        .remove_item(&playlist_id, &playlist_item_id, &auth.user)
        .await
    {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => send_error_response(StatusCode::NOT_FOUND, "Playlist not found", "NOT_FOUND"),
        Err(err) => map_playlist_error(err),
    }
}

/// `PUT /api/playlists/:playlist_id/tracks/reorder`
async fn reorder_playlist_tracks_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    payload_res: Result<ApiJson<LegacyReorderBody>, crate::error::ApiJsonRejection>,
) -> Response {
    let service = match build_playlist_service(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    let perms = match service.permissions_for(&playlist_id, &auth.user).await {
        Ok(p) => p,
        Err(err) => return map_playlist_error(err),
    };
    if !perms.can_edit_tracks {
        return send_error_response(
            StatusCode::FORBIDDEN,
            "Playlist access denied",
            "FORBIDDEN",
        );
    }

    let ApiJson(body) = match payload_res {
        Ok(body) => body,
        Err(rejection) => return rejection.into_response(),
    };

    if body.track_ids.iter().any(|id| id.trim().is_empty()) {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid playlist reorder request",
            "BAD_REQUEST",
        );
    }

    match service
        .reorder_by_track_ids(&playlist_id, &body.track_ids, &auth.user)
        .await
    {
        Ok(Some(playlist)) => Json(json!({ "playlist": playlist })).into_response(),
        Ok(None) => send_error_response(StatusCode::NOT_FOUND, "Playlist not found", "NOT_FOUND"),
        Err(err) => map_playlist_error(err),
    }
}

/// `POST /api/v1/playlists/:playlist_id/reorder`
async fn cas_reorder_playlist_items_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    payload_res: Result<ApiJson<CasReorderBody>, crate::error::ApiJsonRejection>,
) -> Response {
    let service = match build_playlist_service(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    let perms = match service.permissions_for(&playlist_id, &auth.user).await {
        Ok(p) => p,
        Err(err) => return map_playlist_error(err),
    };
    if !perms.can_edit_tracks {
        return send_error_response(
            StatusCode::FORBIDDEN,
            "Playlist access denied",
            "FORBIDDEN",
        );
    }

    let ApiJson(body) = match payload_res {
        Ok(body) => body,
        Err(rejection) => return rejection.into_response(),
    };

    if body.item_ids.len() > 20_000
        || body.expected_item_ids.len() > 20_000
        || body
            .item_ids
            .iter()
            .chain(body.expected_item_ids.iter())
            .any(|s| s.is_empty() || s.len() > 300)
    {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid playlist entry reorder",
            "VALIDATION_ERROR",
        );
    }

    match service
        .reorder_items(
            &playlist_id,
            &body.item_ids,
            &body.expected_item_ids,
            &auth.user,
        )
        .await
    {
        Ok(Some(playlist)) => Json(json!({ "playlist": playlist })).into_response(),
        Ok(None) => send_error_response(StatusCode::NOT_FOUND, "Playlist not found", "NOT_FOUND"),
        Err(err) => map_playlist_error(err),
    }
}

/// `POST /api/v1/playlists/:playlist_id/tracks/batch`
async fn batch_edit_playlist_tracks_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    payload_res: Result<ApiJson<PlaylistBatchEdit>, crate::error::ApiJsonRejection>,
) -> Response {
    let service = match build_playlist_service(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    let perms = match service.permissions_for(&playlist_id, &auth.user).await {
        Ok(p) => p,
        Err(err) => return map_playlist_error(err),
    };
    if !perms.can_edit_tracks {
        return send_error_response(
            StatusCode::FORBIDDEN,
            "Playlist access denied",
            "FORBIDDEN",
        );
    }

    let ApiJson(edit) = match payload_res {
        Ok(body) => body,
        Err(rejection) => return rejection.into_response(),
    };

    match service.edit_tracks(&playlist_id, edit, &auth.user).await {
        Ok(Some(playlist)) => Json(json!({ "playlist": playlist })).into_response(),
        Ok(None) => send_error_response(StatusCode::NOT_FOUND, "Playlist not found", "NOT_FOUND"),
        Err(err) => map_playlist_error(err),
    }
}

/// `GET /api/playlists/:playlist_id/artwork`
async fn get_playlist_artwork_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let service = match build_playlist_service(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    let size = params.get("size").and_then(|s| s.parse::<u32>().ok());
    match service.render_artwork(&playlist_id, &auth.user, size).await {
        Ok(Some(rendered)) => {
            let mut res = (StatusCode::OK, rendered.body).into_response();
            let headers = res.headers_mut();
            if let Ok(ct) = HeaderValue::from_str(&rendered.content_type) {
                headers.insert(CONTENT_TYPE, ct);
            }
            if let Ok(etag_val) = HeaderValue::from_str(&rendered.etag) {
                headers.insert(ETAG, etag_val);
            }
            headers.insert(
                CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=300"),
            );
            headers.insert(
                X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            res
        }
        Ok(None) => send_error_response(StatusCode::NOT_FOUND, "Artwork not found", "NOT_FOUND"),
        Err(err) => map_playlist_error(err),
    }
}

/// `PUT /api/playlists/:playlist_id/artwork`
async fn put_playlist_artwork_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    request: Request,
) -> Response {
    let service = match build_playlist_service(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    let perms = match service.permissions_for(&playlist_id, &auth.user).await {
        Ok(p) => p,
        Err(err) => return map_playlist_error(err),
    };
    if !perms.can_manage {
        return send_error_response(
            StatusCode::FORBIDDEN,
            "Playlist access denied",
            "FORBIDDEN",
        );
    }

    let Ok(body_bytes): Result<Bytes, _> =
        axum::body::to_bytes(request.into_body(), MAX_ARTWORK_REQUEST_BYTES).await
    else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid playlist artwork upload",
            "VALIDATION_ERROR",
        );
    };

    let Ok(parsed_body) = serde_json::from_slice::<ArtworkUploadBody>(&body_bytes) else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid playlist artwork upload",
            "VALIDATION_ERROR",
        );
    };

    let Some((data, content_type)) = parse_image_data_url(&parsed_body.image) else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid playlist artwork upload",
            "VALIDATION_ERROR",
        );
    };

    match service
        .set_custom_artwork(&playlist_id, &data, &content_type, &auth.user)
        .await
    {
        Ok(Some(playlist)) => Json(json!({ "playlist": playlist })).into_response(),
        Ok(None) => send_error_response(StatusCode::NOT_FOUND, "Playlist not found", "NOT_FOUND"),
        Err(err) => map_playlist_error(err),
    }
}

/// `DELETE /api/playlists/:playlist_id/artwork`
async fn delete_playlist_artwork_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
) -> Response {
    let service = match build_playlist_service(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    let perms = match service.permissions_for(&playlist_id, &auth.user).await {
        Ok(p) => p,
        Err(err) => return map_playlist_error(err),
    };
    if !perms.can_manage {
        return send_error_response(
            StatusCode::FORBIDDEN,
            "Playlist access denied",
            "FORBIDDEN",
        );
    }

    match service.clear_custom_artwork(&playlist_id, &auth.user).await {
        Ok(Some(playlist)) => Json(json!({ "playlist": playlist })).into_response(),
        Ok(None) => send_error_response(StatusCode::NOT_FOUND, "Playlist not found", "NOT_FOUND"),
        Err(err) => map_playlist_error(err),
    }
}
