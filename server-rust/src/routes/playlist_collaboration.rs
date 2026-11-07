//! # Playlist Organization, Sharing & Live Party Collaboration Routes (`routes::playlist_collaboration`)
//!
//! Complete Rust port of `server/src/routes/playlist-organization.ts` and
//! `server/src/routes/playlist-collaboration.ts`, plus the live party WebSocket
//! endpoint (`GET /api/v1/playlists/:playlist_id/party/ws`).

use std::collections::HashMap;

use axum::Json;
use axum::Router;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::StatusCode;
use axum::http::header::{CACHE_CONTROL, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::{AuthenticatedUser, SessionUser};
use crate::catalog::{CatalogService, LibraryService, SourceResolver};
use crate::error::{ApiErrorBody, ApiErrorEnvelope};
use crate::playlists::collaboration::{
    CollaborationError, CommandDirection, OrganizationError, OrganizationOperation,
    PartyHostAction, PartyWsClientFrame, PartyWsServerFrame, PlaylistCollaborationService,
    PlaylistGrant, PlaylistOrganizationService, ReversiblePlaylistEdit,
};
use crate::playlists::{PlaylistService, PlaylistVisibility};
use crate::state::AppState;
use crate::streaming::send_error_response;

/// Maximum request body size (`3 MiB`) for reversible playlist command endpoints.
pub const MAX_COMMAND_BODY_BYTES: usize = 3 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OrganizeRequestBody {
    #[serde(rename = "ownerId")]
    owner_id: String,
    revision: i64,
    operation: OrganizationOperation,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecuteCommandBody {
    #[serde(rename = "ownerId")]
    owner_id: String,
    revision: i64,
    edit: ReversiblePlaylistEdit,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReverseCommandBody {
    #[serde(rename = "ownerId")]
    owner_id: String,
    revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateSharingBody {
    #[serde(rename = "ownerId")]
    owner_id: String,
    revision: i64,
    mode: PlaylistVisibility,
    grants: Vec<PlaylistGrant>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateLinkBody {
    #[serde(rename = "ownerId")]
    owner_id: String,
    #[serde(rename = "recipientUserId")]
    recipient_user_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActorOnlyBody {
    #[serde(rename = "ownerId")]
    owner_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveShareTokenBody {
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StartPartyBody {
    #[serde(rename = "ownerId")]
    owner_id: String,
    #[serde(rename = "deviceId")]
    device_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PartyTrackRequestBody {
    #[serde(rename = "ownerId")]
    owner_id: String,
    #[serde(rename = "trackId")]
    track_id: String,
    #[serde(rename = "idempotencyKey")]
    idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PartyControlBody {
    #[serde(rename = "ownerId")]
    owner_id: String,
    #[serde(rename = "deviceId")]
    device_id: String,
    action: PartyHostAction,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
}

/// Registers all playlist organization, reversible command, sharing, invitation link,
/// and live party routes.
pub fn playlist_collaboration_routes() -> Router<AppState> {
    let command_routes = Router::new()
        .route(
            "/api/v1/playlists/:playlist_id/commands",
            post(execute_playlist_command_handler),
        )
        .route(
            "/api/v1/playlists/:playlist_id/tracks",
            put(collaborative_edit_tracks_handler),
        )
        .layer(DefaultBodyLimit::max(MAX_COMMAND_BODY_BYTES));

    Router::new()
        // Organization & reversible commands
        .route(
            "/api/v1/playlist-organization",
            get(get_organization_tree_handler).post(post_organization_operation_handler),
        )
        .route("/api/v1/playlists/trash", get(get_playlist_trash_handler))
        .route(
            "/api/v1/playlists/:playlist_id/edit-state",
            get(get_playlist_edit_state_handler),
        )
        .route(
            "/api/v1/playlist-commands/:command_id/:direction",
            post(reverse_playlist_command_handler),
        )
        // Sharing & invitation links
        .route(
            "/api/v1/playlists/:playlist_id/sharing",
            get(get_playlist_sharing_handler).put(put_playlist_sharing_handler),
        )
        .route(
            "/api/v1/playlists/:playlist_id/access-state",
            get(get_playlist_access_state_handler),
        )
        .route(
            "/api/v1/playlists/:playlist_id/sharing/users",
            get(search_sharing_users_handler),
        )
        .route(
            "/api/v1/playlists/:playlist_id/sharing/links",
            post(create_share_link_handler),
        )
        .route(
            "/api/v1/playlists/:playlist_id/sharing/links/:link_id",
            delete(revoke_share_link_handler),
        )
        .route(
            "/api/v1/playlist-shares/resolve",
            post(resolve_share_link_handler),
        )
        // Live Party Sessions (REST + WebSocket)
        .route(
            "/api/v1/playlists/:playlist_id/party",
            get(get_party_state_handler).post(start_party_session_handler),
        )
        .route(
            "/api/v1/playlists/:playlist_id/party/requests",
            post(post_party_track_request_handler),
        )
        .route(
            "/api/v1/playlists/:playlist_id/party/control",
            post(post_party_control_handler),
        )
        .route(
            "/api/v1/playlists/:playlist_id/party/ws",
            get(party_websocket_upgrade_handler),
        )
        .merge(command_routes)
}

fn build_services(
    state: &AppState,
) -> Result<
    (
        PlaylistOrganizationService,
        PlaylistCollaborationService,
        PlaylistService,
    ),
    Response,
> {
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

    let org = PlaylistOrganizationService::new(db.clone(), library.clone());
    let collab = PlaylistCollaborationService::with_hub(db.clone(), state.party_hub().clone());
    let playlists = PlaylistService::new(db, catalog, library, resolver);

    Ok((org, collab, playlists))
}

fn with_no_store(mut response: Response) -> Response {
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

fn map_org_error(err: OrganizationError) -> Response {
    let status = StatusCode::from_u16(err.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let code = if status == StatusCode::CONFLICT {
        "PLAYLIST_CONFLICT"
    } else {
        "PLAYLIST_ACCESS_ERROR"
    };
    with_no_store(
        (
            status,
            Json(ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: String::from(code),
                    message: err.to_string(),
                },
            }),
        )
            .into_response(),
    )
}

fn map_collab_error(err: CollaborationError) -> Response {
    let status = StatusCode::from_u16(err.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    with_no_store(
        (
            status,
            Json(ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: String::from("PLAYLIST_ACCESS_ERROR"),
                    message: err.to_string(),
                },
            }),
        )
            .into_response(),
    )
}

// ============================================================================
// Organization & Reversible Command Handlers
// ============================================================================

async fn get_organization_tree_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let (org, _, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match org.tree(&auth.user).await {
        Ok(tree) => with_no_store(Json(tree).into_response()),
        Err(err) => map_org_error(err),
    }
}

async fn post_organization_operation_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<Json<OrganizeRequestBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid folder or playlist placement.",
            "BAD_REQUEST",
        ));
    };

    if body.owner_id != auth.user.id {
        return with_no_store(send_error_response(
            StatusCode::CONFLICT,
            "The signed-in account changed. Reload before editing.",
            "CONFLICT",
        ));
    }

    let (org, _, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match org.organize(&auth.user, body.revision, body.operation).await {
        Ok(tree) => with_no_store(Json(tree).into_response()),
        Err(err) => map_org_error(err),
    }
}

async fn get_playlist_trash_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let (org, _, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match org.trash(&auth.user).await {
        Ok(playlists) => with_no_store(
            Json(json!({
                "playlists": playlists,
                "retentionDays": 30,
            }))
            .into_response(),
        ),
        Err(err) => map_org_error(err),
    }
}

async fn get_playlist_edit_state_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
) -> Response {
    let (org, _, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match org.edit_state(&auth.user, &playlist_id).await {
        Ok((revision, item_ids, deleted_at)) => with_no_store(
            Json(json!({
                "revision": revision,
                "itemIds": item_ids,
                "deletedAt": deleted_at,
            }))
            .into_response(),
        ),
        Err(err) => map_org_error(err),
    }
}

async fn execute_playlist_command_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    payload_res: Result<Json<ExecuteCommandBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid playlist command.",
            "BAD_REQUEST",
        ));
    };

    if body.owner_id != auth.user.id {
        return with_no_store(send_error_response(
            StatusCode::CONFLICT,
            "The signed-in account changed. Reload before editing.",
            "CONFLICT",
        ));
    }

    let (org, _, playlists) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match org
        .execute(&auth.user, &playlist_id, body.revision, body.edit)
        .await
    {
        Ok(result) => {
            let hydrated = playlists.get(&playlist_id, &auth.user).await.ok().flatten();
            with_no_store(
                Json(json!({
                    "command": result.command,
                    "revision": result.revision,
                    "deletedAt": result.deleted_at,
                    "playlist": hydrated,
                }))
                .into_response(),
            )
        }
        Err(err) => map_org_error(err),
    }
}

async fn reverse_playlist_command_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path((command_id, direction_str)): Path<(String, String)>,
    payload_res: Result<Json<ReverseCommandBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let direction = match direction_str.as_str() {
        "undo" => CommandDirection::Undo,
        "redo" => CommandDirection::Redo,
        _ => {
            return with_no_store(send_error_response(
                StatusCode::BAD_REQUEST,
                "Invalid undo or redo request.",
                "BAD_REQUEST",
            ));
        }
    };

    let Ok(Json(body)) = payload_res else {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid undo or redo request.",
            "BAD_REQUEST",
        ));
    };

    if body.owner_id != auth.user.id {
        return with_no_store(send_error_response(
            StatusCode::CONFLICT,
            "The signed-in account changed. Reload before editing.",
            "CONFLICT",
        ));
    }

    let (org, _, playlists) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match org
        .reverse(&auth.user, &command_id, body.revision, direction)
        .await
    {
        Ok(result) => {
            let playlist_id = result
                .command
                .as_ref()
                .map_or("", |c| c.playlist_id.as_str());
            let hydrated = playlists.get(playlist_id, &auth.user).await.ok().flatten();
            with_no_store(
                Json(json!({
                    "command": result.command,
                    "revision": result.revision,
                    "deletedAt": result.deleted_at,
                    "playlist": hydrated,
                }))
                .into_response(),
            )
        }
        Err(err) => map_org_error(err),
    }
}

// ============================================================================
// Sharing, Invitations & Collaborative Edit Handlers
// ============================================================================

async fn get_playlist_sharing_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
) -> Response {
    let (_, collab, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match collab.snapshot(&playlist_id, &auth.user).await {
        Ok(snap) => with_no_store(Json(snap).into_response()),
        Err(err) => map_collab_error(err),
    }
}

async fn get_playlist_access_state_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
) -> Response {
    let (_, collab, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    let perms = match collab
        .require_capability(&playlist_id, &auth.user, "canRead")
        .await
    {
        Ok(p) => p,
        Err(err) => return map_collab_error(err),
    };

    let Some(db) = state.db() else {
        return send_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Database unavailable",
            "BACKEND_ERROR",
        );
    };

    let row = sqlx::query(
        "SELECT edit_revision, sharing_revision, sharing_mode FROM playlists WHERE id = ?;",
    )
    .bind(&playlist_id)
    .fetch_optional(db.inner())
    .await
    .ok()
    .flatten();

    let Some(row) = row else {
        return with_no_store(send_error_response(
            StatusCode::NOT_FOUND,
            "Playlist not found",
            "NOT_FOUND",
        ));
    };

    use sqlx::Row;
    let edit_revision: i64 = row.try_get("edit_revision").unwrap_or(0);
    let sharing_revision: i64 = row.try_get("sharing_revision").unwrap_or(0);
    let sharing_mode: String = row
        .try_get("sharing_mode")
        .unwrap_or_else(|_| String::from("PRIVATE"));

    with_no_store(
        Json(json!({
            "editRevision": edit_revision,
            "sharingRevision": sharing_revision,
            "sharingMode": sharing_mode,
            "permissions": perms,
        }))
        .into_response(),
    )
}

async fn search_sharing_users_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let query = params.get("q").cloned().unwrap_or_default();
    if query.chars().count() > 100 || params.keys().any(|k| k != "q") {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid household member search.",
            "BAD_REQUEST",
        ));
    }

    let (_, collab, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match collab
        .search_household_users(&playlist_id, &auth.user, &query)
        .await
    {
        Ok(users) => with_no_store(Json(json!({ "users": users })).into_response()),
        Err(err) => map_collab_error(err),
    }
}

async fn put_playlist_sharing_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    payload_res: Result<Json<UpdateSharingBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid sharing settings.",
            "BAD_REQUEST",
        ));
    };

    if body.owner_id != auth.user.id {
        return with_no_store(send_error_response(
            StatusCode::CONFLICT,
            "The signed-in account changed. Reopen sharing settings.",
            "CONFLICT",
        ));
    }

    let (_, collab, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match collab
        .update_sharing(
            &playlist_id,
            &auth.user,
            body.revision,
            body.mode,
            &body.grants,
        )
        .await
    {
        Ok(snap) => with_no_store(Json(snap).into_response()),
        Err(err) => map_collab_error(err),
    }
}

async fn create_share_link_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    payload_res: Result<Json<CreateLinkBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Choose a valid link recipient.",
            "BAD_REQUEST",
        ));
    };

    if body.owner_id != auth.user.id {
        return with_no_store(send_error_response(
            StatusCode::CONFLICT,
            "Your signed-in account changed.",
            "CONFLICT",
        ));
    }

    let (_, collab, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match collab
        .create_link(
            &playlist_id,
            &auth.user,
            body.recipient_user_id.as_deref(),
        )
        .await
    {
        Ok(token) => with_no_store((StatusCode::CREATED, Json(token)).into_response()),
        Err(err) => map_collab_error(err),
    }
}

async fn revoke_share_link_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path((playlist_id, link_id)): Path<(String, String)>,
    payload_res: Result<Json<ActorOnlyBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Account identity is required.",
            "BAD_REQUEST",
        ));
    };

    if body.owner_id != auth.user.id {
        return with_no_store(send_error_response(
            StatusCode::CONFLICT,
            "Your signed-in account changed.",
            "CONFLICT",
        ));
    }

    let (_, collab, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match collab.revoke_link(&playlist_id, &auth.user, &link_id).await {
        Ok(()) => with_no_store(StatusCode::NO_CONTENT.into_response()),
        Err(err) => map_collab_error(err),
    }
}

async fn resolve_share_link_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<Json<ResolveShareTokenBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid playlist invitation.",
            "BAD_REQUEST",
        ));
    };

    if body.token.len() != 64
        || !body
            .token
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid playlist invitation.",
            "BAD_REQUEST",
        ));
    }

    let (_, collab, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match collab.resolve_link(&auth.user, &body.token).await {
        Ok(playlist_id) => {
            with_no_store(Json(json!({ "playlistId": playlist_id })).into_response())
        }
        Err(err) => map_collab_error(err),
    }
}

async fn collaborative_edit_tracks_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    payload_res: Result<Json<ExecuteCommandBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let (org, collab, playlists) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    if let Err(err) = collab
        .require_capability(&playlist_id, &auth.user, "canEditTracks")
        .await
    {
        return map_collab_error(err);
    }

    let Ok(Json(body)) = payload_res else {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid collaborative track edit.",
            "BAD_REQUEST",
        ));
    };

    if body.owner_id != auth.user.id {
        return with_no_store(send_error_response(
            StatusCode::CONFLICT,
            "Your signed-in account changed.",
            "CONFLICT",
        ));
    }

    match org
        .execute(&auth.user, &playlist_id, body.revision, body.edit)
        .await
    {
        Ok(result) => {
            let hydrated = playlists.get(&playlist_id, &auth.user).await.ok().flatten();
            with_no_store(
                Json(json!({
                    "command": result.command,
                    "revision": result.revision,
                    "deletedAt": result.deleted_at,
                    "playlist": hydrated,
                }))
                .into_response(),
            )
        }
        Err(err) => map_org_error(err),
    }
}

// ============================================================================
// Live Party Queue REST & WebSocket Handlers
// ============================================================================

async fn get_party_state_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(device_id) = params.get("deviceId") else {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Valid player identity is required.",
            "BAD_REQUEST",
        ));
    };
    if Uuid::parse_str(device_id).is_err() || params.keys().any(|k| k != "deviceId") {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Valid player identity is required.",
            "BAD_REQUEST",
        ));
    }

    let (_, collab, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match collab
        .party_state(&playlist_id, &auth.user, &auth.session_id, device_id)
        .await
    {
        Ok(party_state) => with_no_store(Json(party_state).into_response()),
        Err(err) => map_collab_error(err),
    }
}

async fn start_party_session_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    payload_res: Result<Json<StartPartyBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid party player identity.",
            "BAD_REQUEST",
        ));
    };

    if Uuid::parse_str(&body.device_id).is_err() {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid party player identity.",
            "BAD_REQUEST",
        ));
    }

    if body.owner_id != auth.user.id {
        return with_no_store(send_error_response(
            StatusCode::CONFLICT,
            "Your signed-in account changed.",
            "CONFLICT",
        ));
    }

    let (_, collab, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match collab
        .start_party(&playlist_id, &auth.user, &auth.session_id, &body.device_id)
        .await
    {
        Ok((id, expires_at)) => with_no_store(
            (
                StatusCode::CREATED,
                Json(json!({ "id": id, "expiresAt": expires_at })),
            )
                .into_response(),
        ),
        Err(err) => map_collab_error(err),
    }
}

async fn post_party_track_request_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    payload_res: Result<Json<PartyTrackRequestBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid party track request.",
            "BAD_REQUEST",
        ));
    };

    if Uuid::parse_str(&body.idempotency_key).is_err() || body.track_id.trim().is_empty() {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid party track request.",
            "BAD_REQUEST",
        ));
    }

    if body.owner_id != auth.user.id {
        return with_no_store(send_error_response(
            StatusCode::CONFLICT,
            "Your signed-in account changed.",
            "CONFLICT",
        ));
    }

    let (_, collab, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match collab
        .request_track(
            &playlist_id,
            &auth.user,
            &body.track_id,
            &body.idempotency_key,
        )
        .await
    {
        Ok((id, track_id, req_state)) => with_no_store(
            (
                StatusCode::CREATED,
                Json(json!({
                    "id": id,
                    "trackId": track_id,
                    "state": req_state,
                })),
            )
                .into_response(),
        ),
        Err(err) => map_collab_error(err),
    }
}

async fn post_party_control_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    payload_res: Result<Json<PartyControlBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid party action.",
            "BAD_REQUEST",
        ));
    };

    if Uuid::parse_str(&body.device_id).is_err() {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid party action.",
            "BAD_REQUEST",
        ));
    }

    if body.owner_id != auth.user.id {
        return with_no_store(send_error_response(
            StatusCode::CONFLICT,
            "Your signed-in account changed.",
            "CONFLICT",
        ));
    }

    let (_, collab, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    match collab
        .host_action(
            &playlist_id,
            &auth.user,
            &auth.session_id,
            &body.device_id,
            body.action,
            body.request_id.as_deref(),
        )
        .await
    {
        Ok(()) => with_no_store(Json(json!({ "ok": true })).into_response()),
        Err(err) => map_collab_error(err),
    }
}

/// `GET /api/v1/playlists/:playlist_id/party/ws` (WebSocket party room upgrade)
async fn party_websocket_upgrade_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(playlist_id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    let (_, collab, _) = match build_services(&state) {
        Ok(s) => s,
        Err(res) => return res,
    };

    if let Err(err) = collab
        .require_capability(&playlist_id, &auth.user, "canEditTracks")
        .await
    {
        return map_collab_error(err);
    }

    ws.max_message_size(64 * 1024).on_upgrade(move |socket| {
        handle_party_websocket(socket, collab, playlist_id, auth.user, auth.session_id)
    })
}

async fn handle_party_websocket(
    mut socket: WebSocket,
    collab: PlaylistCollaborationService,
    playlist_id: String,
    user: SessionUser,
    session_id: String,
) {
    let mut rx = collab.hub().subscribe(&playlist_id);

    loop {
        tokio::select! {
            inbound = socket.recv() => {
                let Some(Ok(msg)) = inbound else {
                    break;
                };
                let WsMessage::Text(text) = msg else {
                    if matches!(msg, WsMessage::Close(_)) {
                        break;
                    }
                    continue;
                };

                let Ok(frame) = serde_json::from_str::<PartyWsClientFrame>(&text) else {
                    let err_frame = PartyWsServerFrame::Error {
                        code: String::from("INVALID_FRAME"),
                        message: String::from("Malformed party WebSocket frame"),
                    };
                    if let Ok(serialized) = serde_json::to_string(&err_frame) {
                        let _ = socket.send(WsMessage::Text(serialized)).await;
                    }
                    continue;
                };

                match frame {
                    PartyWsClientFrame::JoinSession { device_id }
                    | PartyWsClientFrame::SyncState { device_id } => {
                        if let Ok(party_state) = collab
                            .party_state(&playlist_id, &user, &session_id, &device_id)
                            .await
                        {
                            let reply = PartyWsServerFrame::SyncState {
                                playlist_id: playlist_id.clone(),
                                state: party_state,
                            };
                            if let Ok(serialized) = serde_json::to_string(&reply)
                                && socket.send(WsMessage::Text(serialized)).await.is_err()
                            {
                                break;
                            }
                        }
                    }
                    PartyWsClientFrame::QueueAdd {
                        track_id,
                        idempotency_key,
                    } => {
                        if let Err(err) = collab
                            .request_track(&playlist_id, &user, &track_id, &idempotency_key)
                            .await
                        {
                            let err_frame = PartyWsServerFrame::Error {
                                code: String::from("PARTY_REQUEST_REJECTED"),
                                message: err.to_string(),
                            };
                            if let Ok(serialized) = serde_json::to_string(&err_frame) {
                                let _ = socket.send(WsMessage::Text(serialized)).await;
                            }
                        }
                    }
                    PartyWsClientFrame::TrackVote { request_id, upvote } => {
                        collab.hub().publish(
                            &playlist_id,
                            PartyWsServerFrame::TrackVoted {
                                playlist_id: playlist_id.clone(),
                                request_id,
                                voter_user_id: user.id.clone(),
                                upvote,
                            },
                        );
                    }
                }
            }
            broadcast_res = rx.recv() => {
                match broadcast_res {
                    Ok(server_frame) => {
                        if let Ok(serialized) = serde_json::to_string(&server_frame)
                            && socket.send(WsMessage::Text(serialized)).await.is_err()
                        {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}
