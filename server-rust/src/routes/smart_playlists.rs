//! # Smart Playlists & Guided Mixes HTTP Routes (`routes::smart_playlists`)
//!
//! Complete Rust port of `server/src/routes/smart-playlists.ts`.
//!
//! ## Endpoints Mounted
//! - `GET /api/v1/smart-playlists/seeds`: Bounded seed track search (`<= 12` results).
//! - `GET /api/v1/smart-playlists`: Lists all smart playlists owned by the authenticated user.
//! - `POST /api/v1/smart-playlists/preview`: Evaluates a rule tree and optional `MixOptions`
//!   without saving (`64 KiB` body limit).
//! - `POST /api/v1/smart-playlists/snapshot`: Saves a previewed smart mix as a static
//!   MusicDeck playlist after verifying `selectionToken` (`409 MIX_CHANGED` on drift).
//! - `POST /api/v1/smart-playlists`: Creates a persistent smart playlist (`201 Created`).
//! - `GET /api/v1/smart-playlists/:id`: Fetches a single smart playlist definition.
//! - `PUT /api/v1/smart-playlists/:id`: Updates a smart playlist's name, rules, and mix options.
//! - `DELETE /api/v1/smart-playlists/:id`: Deletes a smart playlist (`204 No Content`).
//! - `GET /api/v1/smart-playlists/:id/tracks`: Evaluates a saved smart playlist with pagination.

use std::collections::HashMap;

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header::CACHE_CONTROL;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

use crate::auth::AuthenticatedUser;
use crate::catalog::{CatalogService, LibraryService, SourceResolver};
use crate::db::{DbPool, create_id};
use crate::error::{ApiErrorBody, ApiErrorEnvelope, ServerError};
use crate::playlists::smart::{
    MixOptions, SmartPlaylistDefinition, SmartPlaylistError, SmartPlaylistEvaluator,
    parse_smart_playlist_rule,
};
use crate::playlists::{PlaylistBatchEdit, PlaylistService};
use crate::state::AppState;
use crate::streaming::send_error_response;

/// Body size limit (`64 KiB`) for smart playlist rule JSON payloads.
pub const MAX_SMART_PLAYLIST_BODY_BYTES: usize = 65_536;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SmartPlaylistUpsertBody {
    name: String,
    rules: Value,
    options: Option<MixOptions>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SmartPlaylistPreviewBody {
    rules: Value,
    #[serde(default = "default_preview_limit")]
    limit: usize,
    #[serde(default)]
    offset: usize,
    options: Option<MixOptions>,
}

const fn default_preview_limit() -> usize {
    12
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SmartPlaylistSnapshotBody {
    name: String,
    rules: Value,
    options: MixOptions,
    #[serde(rename = "selectionToken")]
    selection_token: Option<String>,
}

/// Registers all `/api/v1/smart-playlists` routes.
pub fn smart_playlist_routes() -> Router<AppState> {
    let json_write_routes = Router::new()
        .route("/api/v1/smart-playlists", post(create_smart_playlist_handler))
        .route(
            "/api/v1/smart-playlists/preview",
            post(preview_smart_playlist_handler),
        )
        .route(
            "/api/v1/smart-playlists/snapshot",
            post(snapshot_smart_playlist_handler),
        )
        .route(
            "/api/v1/smart-playlists/:id",
            axum::routing::put(update_smart_playlist_handler),
        )
        .layer(DefaultBodyLimit::max(MAX_SMART_PLAYLIST_BODY_BYTES));

    Router::new()
        .route("/api/v1/smart-playlists/seeds", get(find_seeds_handler))
        .route("/api/v1/smart-playlists", get(list_smart_playlists_handler))
        .route(
            "/api/v1/smart-playlists/:id",
            get(get_smart_playlist_handler).delete(delete_smart_playlist_handler),
        )
        .route(
            "/api/v1/smart-playlists/:id/tracks",
            get(evaluate_smart_playlist_tracks_handler),
        )
        .merge(json_write_routes)
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

fn map_smart_error(err: SmartPlaylistError) -> Response {
    match err {
        SmartPlaylistError::InvalidRule(msg) => with_no_store(
            (
                StatusCode::BAD_REQUEST,
                Json(ApiErrorEnvelope {
                    error: ApiErrorBody {
                        code: String::from("VALIDATION_ERROR"),
                        message: msg,
                    },
                }),
            )
                .into_response(),
        ),
        SmartPlaylistError::NotFound => with_no_store(send_error_response(
            StatusCode::NOT_FOUND,
            "Smart playlist not found",
            "NOT_FOUND",
        )),
        SmartPlaylistError::MixChanged(msg) => with_no_store(send_error_response(
            StatusCode::CONFLICT,
            msg,
            "MIX_CHANGED",
        )),
        SmartPlaylistError::ServiceUnavailable(msg) => with_no_store(send_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            msg,
            "SERVICE_UNAVAILABLE",
        )),
        SmartPlaylistError::Db(db_err) => ServerError::Database(db_err).into_response(),
        SmartPlaylistError::Sqlx(sql_err) => {
            tracing::error!(error = %sql_err, "SQLx error in smart playlist route");
            ServerError::Internal(String::from("Smart playlist database error")).into_response()
        }
    }
}

async fn load_owned_definition(
    db: &DbPool,
    id: &str,
    user_id: &str,
) -> Result<Option<SmartPlaylistDefinition>, SmartPlaylistError> {
    let row = sqlx::query(
        "SELECT id, name, rules_json, options_json, created_at, updated_at FROM smart_playlists WHERE id = ? AND user_id = ?;",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(db.inner())
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    deserialize_row(&row).map(Some)
}

fn deserialize_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<SmartPlaylistDefinition, SmartPlaylistError> {
    let id: String = row.try_get("id")?;
    let name: String = row.try_get("name")?;
    let rules_json: String = row.try_get("rules_json")?;
    let options_json: Option<String> = row.try_get("options_json")?;
    let created_at: String = row.try_get("created_at")?;
    let updated_at: String = row.try_get("updated_at")?;

    let raw_val: Value = serde_json::from_str(&rules_json)
        .map_err(|_| SmartPlaylistError::InvalidRule(String::from("Invalid stored rules")))?;
    let rules = parse_smart_playlist_rule(&raw_val)?;

    let options = match options_json {
        Some(ref raw_opt) if !raw_opt.trim().is_empty() => {
            let opt: MixOptions = serde_json::from_str(raw_opt).map_err(|_| {
                SmartPlaylistError::InvalidRule(String::from("Invalid stored mix options"))
            })?;
            opt.validate()?;
            Some(opt)
        }
        _ => None,
    };

    Ok(SmartPlaylistDefinition {
        id,
        name,
        rules,
        created_at,
        updated_at,
        options,
    })
}

/// `GET /api/v1/smart-playlists/seeds`
async fn find_seeds_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if params.keys().any(|k| !matches!(k.as_str(), "q" | "id")) {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid song search",
            "VALIDATION_ERROR",
        ));
    }

    let query = params.get("q").map_or("", String::as_str);
    let seed_id = params.get("id").map(String::as_str);
    if query.chars().count() > 300 || seed_id.is_some_and(|s| s.is_empty() || s.chars().count() > 500) {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid song search",
            "VALIDATION_ERROR",
        ));
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let evaluator = SmartPlaylistEvaluator::new(db.clone());
    match evaluator.find_seeds(query, seed_id).await {
        Ok(tracks) => with_no_store(Json(json!({ "tracks": tracks })).into_response()),
        Err(err) => map_smart_error(err),
    }
}

/// `GET /api/v1/smart-playlists`
async fn list_smart_playlists_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let rows = match sqlx::query(
        "SELECT id, name, rules_json, options_json, created_at, updated_at FROM smart_playlists WHERE user_id = ? ORDER BY updated_at DESC, id ASC;",
    )
    .bind(&auth.user.id)
    .fetch_all(db.inner())
    .await
    {
        Ok(r) => r,
        Err(err) => return map_smart_error(SmartPlaylistError::Sqlx(err)),
    };

    let mut playlists = Vec::with_capacity(rows.len());
    for row in &rows {
        match deserialize_row(row) {
            Ok(def) => playlists.push(def),
            Err(err) => return map_smart_error(err),
        }
    }

    with_no_store(Json(json!({ "playlists": playlists })).into_response())
}

/// `POST /api/v1/smart-playlists/preview`
async fn preview_smart_playlist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<Json<SmartPlaylistPreviewBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid preview request",
            "VALIDATION_ERROR",
        ));
    };

    if !(1..=500).contains(&body.limit) || body.offset > 1_000_000 {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid preview request",
            "VALIDATION_ERROR",
        ));
    }
    if let Some(ref opt) = body.options
        && opt.validate().is_err()
    {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid preview request",
            "VALIDATION_ERROR",
        ));
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let rule = match parse_smart_playlist_rule(&body.rules) {
        Ok(r) => r,
        Err(err) => return map_smart_error(err),
    };

    let evaluator = SmartPlaylistEvaluator::new(db.clone());
    let now_ms = Utc::now().timestamp_millis();
    match evaluator
        .evaluate_at(
            &auth.user.id,
            &rule,
            body.limit,
            body.offset,
            body.options,
            now_ms,
        )
        .await
    {
        Ok(result) => with_no_store(Json(result).into_response()),
        Err(err) => map_smart_error(err),
    }
}

/// `POST /api/v1/smart-playlists/snapshot`
async fn snapshot_smart_playlist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<Json<SmartPlaylistSnapshotBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "A mix name and valid settings are required",
            "VALIDATION_ERROR",
        ));
    };

    let trimmed_name = body.name.trim();
    if trimmed_name.is_empty()
        || trimmed_name.chars().count() > 200
        || body.options.validate().is_err()
    {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "A mix name and valid settings are required",
            "VALIDATION_ERROR",
        ));
    }

    if let Some(ref token) = body.selection_token
        && (token.len() != 64 || !token.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
    {
        return with_no_store(send_error_response(
            StatusCode::BAD_REQUEST,
            "A mix name and valid settings are required",
            "VALIDATION_ERROR",
        ));
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let rule = match parse_smart_playlist_rule(&body.rules) {
        Ok(r) => r,
        Err(err) => return map_smart_error(err),
    };

    let evaluator = SmartPlaylistEvaluator::new(db.clone());
    let now_ms = Utc::now().timestamp_millis();
    let eval_res = match evaluator
        .evaluate_at(&auth.user.id, &rule, 200, 0, Some(body.options), now_ms)
        .await
    {
        Ok(r) => r,
        Err(err) => return map_smart_error(err),
    };

    if eval_res.refreshed_at.is_none() {
        return map_smart_error(SmartPlaylistError::ServiceUnavailable(String::from(
            "Your library is still loading. Try again shortly.",
        )));
    }
    if eval_res.tracks.is_empty() {
        return map_smart_error(SmartPlaylistError::InvalidRule(String::from(
            "No songs match this mix yet.",
        )));
    }
    if let Some(ref expected_token) = body.selection_token
        && eval_res.selection_token.as_ref() != Some(expected_token)
    {
        return map_smart_error(SmartPlaylistError::MixChanged(String::from(
            "Your library changed. Refresh the mix before saving so its tracklist matches your preview.",
        )));
    }

    let track_ids: Vec<String> = eval_res
        .tracks
        .iter()
        .filter_map(|t| t.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();

    let library = LibraryService::new(db.clone(), Some(state.config().music_root.clone()));
    let registry = state.providers().clone();
    let catalog = CatalogService::new(registry.clone(), library.clone());
    let resolver = SourceResolver::new(registry, library.clone());
    let playlist_service = PlaylistService::new(db.clone(), catalog, library, resolver);

    let created = match playlist_service
        .create(trimmed_name, &auth.user, Some("Generated mix"))
        .await
    {
        Ok(p) => p,
        Err(err) => return send_error_response(StatusCode::BAD_REQUEST, err.to_string(), "VALIDATION_ERROR"),
    };

    let hydrated = match playlist_service
        .edit_tracks(
            &created.id,
            PlaylistBatchEdit::Add { track_ids },
            &auth.user,
        )
        .await
    {
        Ok(Some(p)) => p,
        _ => created,
    };

    (
        StatusCode::CREATED,
        Json(json!({
            "playlist": hydrated,
            "kind": "playlist",
        })),
    )
        .into_response()
}

/// `POST /api/v1/smart-playlists`
async fn create_smart_playlist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<Json<SmartPlaylistUpsertBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "A playlist name and rules are required",
            "VALIDATION_ERROR",
        );
    };

    let trimmed_name = body.name.trim();
    if trimmed_name.is_empty() || trimmed_name.chars().count() > 200 {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "A playlist name and rules are required",
            "VALIDATION_ERROR",
        );
    }
    if let Some(ref opt) = body.options
        && opt.validate().is_err()
    {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "A playlist name and rules are required",
            "VALIDATION_ERROR",
        );
    }

    let rules = match parse_smart_playlist_rule(&body.rules) {
        Ok(r) => r,
        Err(err) => return map_smart_error(err),
    };

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let id = create_id("smart");
    let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let rules_json = serde_json::to_string(&rules).unwrap_or_default();
    let options_json = body
        .options
        .and_then(|o| serde_json::to_string(&o).ok());

    if let Err(err) = sqlx::query(
        r"
        INSERT INTO smart_playlists (id, user_id, name, rules_json, created_at, updated_at, options_json)
        VALUES (?, ?, ?, ?, ?, ?, ?);
        ",
    )
    .bind(&id)
    .bind(&auth.user.id)
    .bind(trimmed_name)
    .bind(&rules_json)
    .bind(&now_iso)
    .bind(&now_iso)
    .bind(&options_json)
    .execute(db.inner())
    .await
    {
        return map_smart_error(SmartPlaylistError::Sqlx(err));
    }

    match load_owned_definition(db, &id, &auth.user.id).await {
        Ok(Some(def)) => (StatusCode::CREATED, Json(json!({ "playlist": def }))).into_response(),
        Ok(None) => map_smart_error(SmartPlaylistError::NotFound),
        Err(err) => map_smart_error(err),
    }
}

/// `GET /api/v1/smart-playlists/:id`
async fn get_smart_playlist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(id): Path<String>,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match load_owned_definition(db, &id, &auth.user.id).await {
        Ok(Some(def)) => Json(json!({ "playlist": def })).into_response(),
        Ok(None) => map_smart_error(SmartPlaylistError::NotFound),
        Err(err) => map_smart_error(err),
    }
}

/// `PUT /api/v1/smart-playlists/:id`
async fn update_smart_playlist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(id): Path<String>,
    payload_res: Result<Json<SmartPlaylistUpsertBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let existing = match load_owned_definition(db, &id, &auth.user.id).await {
        Ok(Some(def)) => def,
        Ok(None) => return map_smart_error(SmartPlaylistError::NotFound),
        Err(err) => return map_smart_error(err),
    };

    let Ok(Json(body)) = payload_res else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "A playlist name and rules are required",
            "VALIDATION_ERROR",
        );
    };

    let trimmed_name = body.name.trim();
    if trimmed_name.is_empty() || trimmed_name.chars().count() > 200 {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "A playlist name and rules are required",
            "VALIDATION_ERROR",
        );
    }
    if let Some(ref opt) = body.options
        && opt.validate().is_err()
    {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "A playlist name and rules are required",
            "VALIDATION_ERROR",
        );
    }

    let rules = match parse_smart_playlist_rule(&body.rules) {
        Ok(r) => r,
        Err(err) => return map_smart_error(err),
    };

    let next_options = body.options.or(existing.options);
    let rules_json = serde_json::to_string(&rules).unwrap_or_default();
    let options_json = next_options.and_then(|o| serde_json::to_string(&o).ok());
    let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    if let Err(err) = sqlx::query(
        r"
        UPDATE smart_playlists
        SET name = ?, rules_json = ?, updated_at = ?, options_json = ?
        WHERE id = ? AND user_id = ?;
        ",
    )
    .bind(trimmed_name)
    .bind(&rules_json)
    .bind(&now_iso)
    .bind(&options_json)
    .bind(&id)
    .bind(&auth.user.id)
    .execute(db.inner())
    .await
    {
        return map_smart_error(SmartPlaylistError::Sqlx(err));
    }

    match load_owned_definition(db, &id, &auth.user.id).await {
        Ok(Some(def)) => Json(json!({ "playlist": def })).into_response(),
        Ok(None) => map_smart_error(SmartPlaylistError::NotFound),
        Err(err) => map_smart_error(err),
    }
}

/// `DELETE /api/v1/smart-playlists/:id`
async fn delete_smart_playlist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(id): Path<String>,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match sqlx::query("DELETE FROM smart_playlists WHERE id = ? AND user_id = ?;")
        .bind(&id)
        .bind(&auth.user.id)
        .execute(db.inner())
        .await
    {
        Ok(res) if res.rows_affected() > 0 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => map_smart_error(SmartPlaylistError::NotFound),
        Err(err) => map_smart_error(SmartPlaylistError::Sqlx(err)),
    }
}

/// `GET /api/v1/smart-playlists/:id/tracks`
async fn evaluate_smart_playlist_tracks_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let def = match load_owned_definition(db, &id, &auth.user.id).await {
        Ok(Some(d)) => d,
        Ok(None) => return map_smart_error(SmartPlaylistError::NotFound),
        Err(err) => return map_smart_error(err),
    };

    let limit = if let Some(raw_limit) = params.get("limit") {
        let Ok(parsed) = raw_limit.parse::<usize>() else {
            return with_no_store(send_error_response(
                StatusCode::BAD_REQUEST,
                "Invalid smart playlist page",
                "VALIDATION_ERROR",
            ));
        };
        if !(1..=500).contains(&parsed) {
            return with_no_store(send_error_response(
                StatusCode::BAD_REQUEST,
                "Invalid smart playlist page",
                "VALIDATION_ERROR",
            ));
        }
        parsed
    } else {
        100
    };

    let offset = if let Some(raw_offset) = params.get("offset") {
        let Ok(parsed) = raw_offset.parse::<usize>() else {
            return with_no_store(send_error_response(
                StatusCode::BAD_REQUEST,
                "Invalid smart playlist page",
                "VALIDATION_ERROR",
            ));
        };
        if parsed > 1_000_000 {
            return with_no_store(send_error_response(
                StatusCode::BAD_REQUEST,
                "Invalid smart playlist page",
                "VALIDATION_ERROR",
            ));
        }
        parsed
    } else {
        0
    };

    let evaluator = SmartPlaylistEvaluator::new(db.clone());
    let now_ms = Utc::now().timestamp_millis();
    match evaluator
        .evaluate_at(&auth.user.id, &def.rules, limit, offset, def.options, now_ms)
        .await
    {
        Ok(eval_res) => with_no_store(
            Json(json!({
                "playlist": def,
                "total": eval_res.total,
                "available": eval_res.available,
                "selectionToken": eval_res.selection_token,
                "tracks": eval_res.tracks,
                "refreshedAt": eval_res.refreshed_at,
                "warning": eval_res.warning,
            }))
            .into_response(),
        ),
        Err(err) => map_smart_error(err),
    }
}
