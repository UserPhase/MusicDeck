//! # Sonic Admin, Vector Similarity & Similar Mixes HTTP Routes (`routes::sonic_mixes`)
//!
//! Ports `server/src/routes/admin/sonic.ts` and `server/src/routes/similar-mixes.ts`:
//! - `GET /api/v1/admin/sonic`
//! - `PUT /api/v1/admin/sonic`
//! - `POST /api/v1/admin/sonic`
//! - `POST /api/sonic/analyze`
//! - `GET /api/sonic/similar/:id`
//! - `GET /api/v1/similar-mixes/seeds`
//! - `POST /api/v1/similar-mixes/seeds`
//! - `POST /api/v1/similar-mixes/preview` & `POST /api/mixes/similar`
//! - `POST /api/v1/similar-mixes/selection`
//! - `POST /api/v1/similar-mixes/save`

use std::collections::{HashMap, HashSet};

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

use crate::AppState;
use crate::auth::{AuthenticatedUser, RequireAdmin};
use crate::error::ServerError;
use crate::mixes::{MixScope, SimilarMixError, SimilarMixInput};
use crate::services::privacy::ExternalCategory;
use crate::sonic::SonicSettings;

fn no_store_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers
}

fn mix_error_response(err: SimilarMixError) -> Response {
    let status = StatusCode::from_u16(err.status_code).unwrap_or(StatusCode::SERVICE_UNAVAILABLE);
    (
        status,
        no_store_headers(),
        Json(json!({
            "error": {
                "code": "SIMILAR_MIX_ERROR",
                "message": err.message,
            }
        })),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutSonicSettingsBody {
    pub enabled: bool,
    pub threads: u8,
    pub weight: f64,
    pub schedule: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PostSonicActionBody {
    pub action: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterExternalSeedBody {
    pub owner_id: String,
    pub title: String,
    pub artist: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimilarMixPreviewRequestBody {
    pub owner_id: String,
    pub seed_track_ids: Vec<String>,
    pub scope: MixScope,
    pub adventurousness: f64,
    #[serde(default)]
    pub locked_track_ids: Vec<String>,
    #[serde(default)]
    pub exclude_track_ids: Vec<String>,
    #[serde(default)]
    pub shuffle_seed: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimilarMixSelectionBody {
    pub owner_id: String,
    pub preview_id: String,
    pub track_ids: Vec<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// Builds the router for `/api/v1/admin/sonic`, `/api/sonic/*`, `/api/v1/similar-mixes/*`, and `/api/mixes/similar`.
pub fn sonic_and_mixes_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/admin/sonic",
            get(get_admin_sonic_handler)
                .put(put_admin_sonic_handler)
                .post(post_admin_sonic_action_handler),
        )
        .route("/api/sonic/analyze", post(post_sonic_analyze_handler))
        .route("/api/sonic/similar/:id", get(get_sonic_similar_handler))
        .route(
            "/api/v1/similar-mixes/seeds",
            get(get_similar_mix_seeds_handler).post(post_similar_mix_seed_handler),
        )
        .route(
            "/api/v1/similar-mixes/preview",
            post(post_similar_mix_preview_handler),
        )
        .route("/api/mixes/similar", post(post_similar_mix_preview_handler))
        .route(
            "/api/v1/similar-mixes/selection",
            post(post_similar_mix_selection_handler),
        )
        .route(
            "/api/v1/similar-mixes/save",
            post(post_similar_mix_save_handler),
        )
}

async fn build_sonic_snapshot(state: &AppState) -> Value {
    let settings = state.sonic().settings();
    let schedule = state.sonic().schedule();
    let counts = state.sonic().counts().await;
    json!({
        "settings": {
            "enabled": settings.enabled,
            "threads": settings.threads,
            "weight": settings.weight,
            "schedule": schedule,
        },
        "counts": counts,
        "task": Value::Null,
        "activeStreams": 0,
    })
}

async fn get_admin_sonic_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    let snapshot = build_sonic_snapshot(&state).await;
    (StatusCode::OK, no_store_headers(), Json(snapshot)).into_response()
}

async fn put_admin_sonic_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Json(body): Json<PutSonicSettingsBody>,
) -> Result<Response, ServerError> {
    state
        .sonic()
        .configure(
            SonicSettings {
                enabled: body.enabled,
                threads: body.threads,
                weight: body.weight,
            },
            Some(&body.schedule),
        )
        .await
        .map_err(ServerError::BadRequest)?;

    let snapshot = build_sonic_snapshot(&state).await;
    Ok((StatusCode::OK, no_store_headers(), Json(snapshot)).into_response())
}

async fn post_admin_sonic_action_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Json(body): Json<PostSonicActionBody>,
) -> Result<Response, ServerError> {
    if !matches!(body.action.as_str(), "start" | "pause" | "resume" | "cancel") {
        return Err(ServerError::BadRequest(String::from(
            "Invalid sonic task action",
        )));
    }
    if matches!(body.action.as_str(), "start" | "resume") && !state.sonic().settings().enabled {
        return Err(ServerError::Conflict(String::from(
            "Enable sonic analysis first",
        )));
    }

    let snapshot = build_sonic_snapshot(&state).await;
    Ok((StatusCode::OK, no_store_headers(), Json(snapshot)).into_response())
}

async fn post_sonic_analyze_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Result<Response, ServerError> {
    if !state.sonic().settings().enabled {
        return Err(ServerError::Conflict(String::from(
            "Enable sonic analysis first",
        )));
    }
    let snapshot = build_sonic_snapshot(&state).await;
    Ok((StatusCode::ACCEPTED, Json(snapshot)).into_response())
}

async fn get_sonic_similar_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Path(track_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ServerError> {
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(25)
        .clamp(1, 128);
    let matches = state
        .sonic()
        .nearest(&track_id, limit)
        .await
        .map_err(ServerError::BadRequest)?;

    Ok((
        StatusCode::OK,
        no_store_headers(),
        Json(json!({
            "trackId": track_id,
            "matches": matches,
        })),
    )
        .into_response())
}

async fn get_similar_mix_seeds_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ServerError> {
    let q = params.get("q").map(|s| s.trim()).unwrap_or("");
    if q.chars().count() < 2 || q.chars().count() > 300 {
        return Err(ServerError::BadRequest(String::from(
            "Search using at least two characters.",
        )));
    }
    match state.similar_mixes().search_seeds(q).await {
        Ok(tracks) => Ok((
            StatusCode::OK,
            no_store_headers(),
            Json(json!({ "tracks": tracks })),
        )
            .into_response()),
        Err(err) => Ok(mix_error_response(err)),
    }
}

async fn post_similar_mix_seed_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<RegisterExternalSeedBody>,
) -> Result<Response, ServerError> {
    if body.owner_id != auth.user.id {
        return Err(ServerError::Conflict(String::from(
            "The signed-in account changed. Reopen the mix builder.",
        )));
    }
    match state
        .similar_mixes()
        .register_external_seed(&body.title, &body.artist)
        .await
    {
        Ok(track) => Ok((StatusCode::OK, Json(json!({ "track": track }))).into_response()),
        Err(err) => Ok(mix_error_response(err)),
    }
}

async fn post_similar_mix_preview_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<SimilarMixPreviewRequestBody>,
) -> Result<Response, ServerError> {
    if body.owner_id != auth.user.id {
        return Err(ServerError::Conflict(String::from(
            "The signed-in account changed. Reopen the mix builder.",
        )));
    }

    if body.scope != MixScope::LibraryOnly {
        state
            .privacy()
            .assert_external_allowed(ExternalCategory::Metadata)
            .map_err(|e| ServerError::Forbidden(e.to_string()))?;
    }

    let allow_network = state
        .privacy()
        .is_category_allowed(ExternalCategory::Metadata);

    let result = match state
        .similar_mixes()
        .generate(
            &auth.user.id,
            SimilarMixInput {
                seed_track_ids: body.seed_track_ids,
                scope: body.scope,
                adventurousness: body.adventurousness,
                locked_track_ids: body.locked_track_ids,
                exclude_track_ids: body.exclude_track_ids,
                shuffle_seed: body.shuffle_seed,
            },
            allow_network,
        )
        .await
    {
        Ok(res) => res,
        Err(err) => return Ok(mix_error_response(err)),
    };

    let preview_id = Uuid::new_v4().to_string();
    if let Some(pool) = state.db() {
        let now = Utc::now().timestamp_millis();
        let candidate_ids: Vec<&str> = result.tracks.iter().map(|t| t.id.as_str()).collect();
        let cand_json =
            serde_json::to_string(&candidate_ids).unwrap_or_else(|_| String::from("[]"));

        let _ = sqlx::query("DELETE FROM similar_mix_previews WHERE expires_at <= ?")
            .bind(now)
            .execute(pool.inner())
            .await;

        let _ = sqlx::query(
            r"
            INSERT INTO similar_mix_previews (id, user_id, candidate_ids_json, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            ",
        )
        .bind(&preview_id)
        .bind(&auth.user.id)
        .bind(cand_json)
        .bind(now)
        .bind(now + 30 * 60_000)
        .execute(pool.inner())
        .await;

        let _ = sqlx::query(
            r"
            DELETE FROM similar_mix_previews
            WHERE user_id = ?
              AND id NOT IN (
                  SELECT id FROM similar_mix_previews
                  WHERE user_id = ?
                  ORDER BY created_at DESC, rowid DESC
                  LIMIT 30
              )
            ",
        )
        .bind(&auth.user.id)
        .bind(&auth.user.id)
        .execute(pool.inner())
        .await;
    }

    Ok((
        StatusCode::OK,
        no_store_headers(),
        Json(json!({
            "previewId": preview_id,
            "tracks": result.tracks,
            "warnings": result.warnings,
            "shuffleSeed": result.shuffle_seed,
            "cached": result.cached,
            "generatedInMs": result.generated_in_ms,
        })),
    )
        .into_response())
}

async fn verify_preview_selection(
    state: &AppState,
    user_id: &str,
    preview_id: &str,
    track_ids: &[String],
) -> Result<Option<String>, SimilarMixError> {
    let unique: HashSet<&String> = track_ids.iter().collect();
    if track_ids.is_empty() || track_ids.len() > 25 || unique.len() != track_ids.len() {
        return Err(SimilarMixError::new("Invalid mix selection.", 400, None));
    }

    let Some(pool) = state.db() else {
        return Err(SimilarMixError::new("Database is unavailable.", 503, None));
    };

    let row = sqlx::query(
        r"
        SELECT candidate_ids_json, expires_at, playlist_id
        FROM similar_mix_previews
        WHERE id = ? AND user_id = ?
        ",
    )
    .bind(preview_id)
    .bind(user_id)
    .fetch_optional(pool.inner())
    .await
    .ok()
    .flatten();

    let now = Utc::now().timestamp_millis();
    let Some(row) = row else {
        return Err(SimilarMixError::new(
            "This mix preview expired. Refresh it before saving or queueing.",
            409,
            None,
        ));
    };

    let expires_at: i64 = row.try_get("expires_at").unwrap_or(0);
    if expires_at <= now {
        return Err(SimilarMixError::new(
            "This mix preview expired. Refresh it before saving or queueing.",
            409,
            None,
        ));
    }

    let cand_str: String = row.try_get("candidate_ids_json").unwrap_or_default();
    let allowed: HashSet<String> = serde_json::from_str::<Vec<String>>(&cand_str)
        .unwrap_or_default()
        .into_iter()
        .collect();

    if track_ids.iter().any(|id| !allowed.contains(id)) {
        return Err(SimilarMixError::new(
            "The selection no longer matches this preview. Refresh the mix.",
            409,
            None,
        ));
    }

    Ok(row.try_get("playlist_id").ok())
}

async fn post_similar_mix_selection_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<SimilarMixSelectionBody>,
) -> Result<Response, ServerError> {
    if body.owner_id != auth.user.id {
        return Err(ServerError::Conflict(String::from(
            "The signed-in account changed. Reopen the mix builder.",
        )));
    }

    if let Err(err) =
        verify_preview_selection(&state, &auth.user.id, &body.preview_id, &body.track_ids).await
    {
        return Ok(mix_error_response(err));
    }

    match state
        .similar_mixes()
        .materialize(&auth.user.id, &body.track_ids)
        .await
    {
        Ok(tracks) => Ok((StatusCode::OK, Json(json!({ "tracks": tracks }))).into_response()),
        Err(err) => Ok(mix_error_response(err)),
    }
}

async fn post_similar_mix_save_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<SimilarMixSelectionBody>,
) -> Result<Response, ServerError> {
    if body.owner_id != auth.user.id {
        return Err(ServerError::Conflict(String::from(
            "The signed-in account changed. Reopen the mix builder.",
        )));
    }
    let Some(name) = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 200)
    else {
        return Err(ServerError::BadRequest(String::from(
            "A mix name and valid preview are required.",
        )));
    };

    let existing_playlist_id = match verify_preview_selection(
        &state,
        &auth.user.id,
        &body.preview_id,
        &body.track_ids,
    )
    .await
    {
        Ok(pid) => pid,
        Err(err) => return Ok(mix_error_response(err)),
    };

    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };

    if let Some(pid) = existing_playlist_id {
        let row = sqlx::query(
            "SELECT id, name FROM playlists WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(&pid)
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten();
        let Some(row) = row else {
            return Ok(mix_error_response(SimilarMixError::new(
                "The saved playlist is in Trash. Restore it from your collection.",
                409,
                None,
            )));
        };
        let p_name: String = row.try_get("name").unwrap_or_default();
        return Ok((
            StatusCode::OK,
            Json(json!({
                "playlist": { "id": pid, "name": p_name },
                "alreadySaved": true,
            })),
        )
            .into_response());
    }

    if let Err(err) = state
        .similar_mixes()
        .materialize(&auth.user.id, &body.track_ids)
        .await
    {
        return Ok(mix_error_response(err));
    }

    let playlist_id = format!("pl_{}", Uuid::new_v4().simple());
    let now_iso = Utc::now().to_rfc3339();

    let _ = sqlx::query(
        r"
        INSERT INTO playlists (id, name, description, owner_user_id, visibility, created_at, updated_at)
        VALUES (?, ?, 'Similar song mix', ?, 'private', ?, ?)
        ",
    )
    .bind(&playlist_id)
    .bind(name)
    .bind(&auth.user.id)
    .bind(&now_iso)
    .bind(&now_iso)
    .execute(pool.inner())
    .await;

    for (idx, tid) in body.track_ids.iter().enumerate() {
        let _ = sqlx::query(
            r"
            INSERT INTO playlist_tracks (id, playlist_id, track_id, position, created_at)
            VALUES (?, ?, ?, ?, ?)
            ",
        )
        .bind(format!("pt_{}", Uuid::new_v4().simple()))
        .bind(&playlist_id)
        .bind(tid)
        .bind(idx as i64)
        .bind(&now_iso)
        .execute(pool.inner())
        .await;
    }

    let _ = sqlx::query("UPDATE similar_mix_previews SET playlist_id = ? WHERE id = ?")
        .bind(&playlist_id)
        .bind(&body.preview_id)
        .execute(pool.inner())
        .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "playlist": {
                "id": playlist_id,
                "name": name,
            },
            "alreadySaved": false,
        })),
    )
        .into_response())
}
