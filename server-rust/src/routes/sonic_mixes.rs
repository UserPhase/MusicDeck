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

use crate::error::ApiJson;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Sqlite;
use uuid::Uuid;

use crate::AppState;
use crate::auth::{AuthenticatedUser, RequireAdmin};
use crate::db::begin_sqlite_write;
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
    ApiJson(body): ApiJson<PutSonicSettingsBody>,
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
    ApiJson(body): ApiJson<PostSonicActionBody>,
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
    ApiJson(body): ApiJson<RegisterExternalSeedBody>,
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
    ApiJson(body): ApiJson<SimilarMixPreviewRequestBody>,
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

async fn verify_preview_selection<'e>(
    executor: impl sqlx::Executor<'e, Database = Sqlite>,
    user_id: &str,
    preview_id: &str,
    track_ids: &[String],
) -> Result<Option<String>, SimilarMixError> {
    let unique: HashSet<&String> = track_ids.iter().collect();
    if track_ids.is_empty() || track_ids.len() > 25 || unique.len() != track_ids.len() {
        return Err(SimilarMixError::new("Invalid mix selection.", 400, None));
    }

    let row = sqlx::query_as::<_, (String, i64, Option<String>)>(
        r"
        SELECT candidate_ids_json, expires_at, playlist_id
        FROM similar_mix_previews
        WHERE id = ? AND user_id = ?
        ",
    )
    .bind(preview_id)
    .bind(user_id)
    .fetch_optional(executor)
    .await
    .map_err(preview_storage_error)?;

    let now = Utc::now().timestamp_millis();
    let Some((candidates, expires_at, playlist_id)) = row else {
        return Err(SimilarMixError::new(
            "This mix preview expired. Refresh it before saving or queueing.",
            409,
            None,
        ));
    };

    if expires_at <= now {
        return Err(SimilarMixError::new(
            "This mix preview expired. Refresh it before saving or queueing.",
            409,
            None,
        ));
    }

    let allowed: HashSet<String> = serde_json::from_str::<Vec<String>>(&candidates)
        .map_err(preview_storage_error)?
        .into_iter()
        .collect();

    if track_ids.iter().any(|id| !allowed.contains(id)) {
        return Err(SimilarMixError::new(
            "The selection no longer matches this preview. Refresh the mix.",
            409,
            None,
        ));
    }

    Ok(playlist_id)
}

fn preview_storage_error(error: impl std::fmt::Display) -> SimilarMixError {
    tracing::error!(%error, "Failed to read Similar Mix preview");
    SimilarMixError::new("The mix preview could not be read. Try again.", 503, None)
}

async fn post_similar_mix_selection_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    ApiJson(body): ApiJson<SimilarMixSelectionBody>,
) -> Result<Response, ServerError> {
    if body.owner_id != auth.user.id {
        return Err(ServerError::Conflict(String::from(
            "The signed-in account changed. Reopen the mix builder.",
        )));
    }

    let pool = state
        .db()
        .ok_or_else(|| ServerError::ServiceUnavailable("Database is unavailable".into()))?;
    if let Err(err) = verify_preview_selection(
        pool.inner(),
        &auth.user.id,
        &body.preview_id,
        &body.track_ids,
    )
    .await
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
    ApiJson(body): ApiJson<SimilarMixSelectionBody>,
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
        .filter(|s| !s.is_empty() && s.chars().count() <= 200)
    else {
        return Err(ServerError::BadRequest(String::from(
            "A mix name and valid preview are required.",
        )));
    };

    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let existing_playlist_id = match verify_preview_selection(
        pool.inner(),
        &auth.user.id,
        &body.preview_id,
        &body.track_ids,
    )
    .await
    {
        Ok(pid) => pid,
        Err(err) => return Ok(mix_error_response(err)),
    };

    // Materialization reads the catalog and taste profile outside the writer lock.
    let tracks = if existing_playlist_id.is_none() {
        Some(
            state
                .similar_mixes()
                .materialize(&auth.user.id, &body.track_ids)
                .await,
        )
    } else {
        None
    };
    let mut tx = begin_sqlite_write(
        pool.inner(),
        "UPDATE similar_mix_previews SET playlist_id = playlist_id WHERE 0",
    )
    .await
    .map_err(crate::db::DbError::from)?;
    let claimed =
        match verify_preview_selection(&mut *tx, &auth.user.id, &body.preview_id, &body.track_ids)
            .await
        {
            Ok(pid) => pid,
            Err(err) => return Ok(mix_error_response(err)),
        };
    if let Some(pid) = claimed {
        let saved_name: Option<String> = sqlx::query_scalar(
            "SELECT name FROM playlists WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL",
        )
        .bind(&pid)
        .bind(&auth.user.id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(crate::db::DbError::from)?;
        let Some(saved_name) = saved_name else {
            return Ok(mix_error_response(SimilarMixError::new(
                "The saved playlist is in Trash. Restore it from your collection.",
                409,
                None,
            )));
        };
        tx.commit().await.map_err(crate::db::DbError::from)?;
        return Ok((
            StatusCode::OK,
            Json(json!({
                "playlist": { "id": pid, "name": saved_name },
                "alreadySaved": true,
            })),
        )
            .into_response());
    }

    let tracks = match tracks {
        Some(Ok(tracks)) => tracks,
        Some(Err(err)) => return Ok(mix_error_response(err)),
        None => {
            return Err(ServerError::Conflict(
                "The saved playlist changed. Refresh the mix.".into(),
            ));
        }
    };

    let playlist_id = format!("mdpl_{}", Uuid::new_v4().simple());
    let now_iso = Utc::now().to_rfc3339();

    let created = sqlx::query(
        r"
        INSERT INTO playlists (id, name, description, owner_user_id, sharing_mode, created_at, updated_at)
        VALUES (?, ?, 'Similar song mix', ?, 'PRIVATE', ?, ?)
        ",
    )
    .bind(&playlist_id)
    .bind(name)
    .bind(&auth.user.id)
    .bind(&now_iso)
    .bind(&now_iso)
    .execute(&mut *tx)
    .await.map_err(crate::db::DbError::from)?;
    if created.rows_affected() != 1 {
        return Err(ServerError::Internal(
            "Similar Mix playlist was not inserted".into(),
        ));
    }

    for (position, track) in tracks.iter().enumerate() {
        let (connection_id, library_track_id, external_json) = if track.stream_url.is_empty() {
            let mut external = serde_json::to_value(track)
                .map_err(|err| ServerError::Internal(err.to_string()))?;
            external["external"] = json!(true);
            (String::new(), None, Some(external.to_string()))
        } else {
            let source = sqlx::query_scalar::<_, String>(
                r"
                SELECT connection_id FROM library_item_sources
                WHERE library_item_id = ? AND provider_item_id = ?
                ORDER BY created_at, connection_id LIMIT 1
                ",
            )
            .bind(&track.id)
            .bind(&track.provider_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(crate::db::DbError::from)?;
            let Some(connection_id) = source else {
                return Ok(mix_error_response(SimilarMixError::new(
                    "A selected library song is unavailable. Refresh the mix.",
                    409,
                    None,
                )));
            };
            (connection_id, Some(track.id.as_str()), None)
        };
        let inserted = sqlx::query(
            r"
            INSERT INTO playlist_items
                (id, playlist_id, position, connection_id, provider_track_id, library_track_id,
                 created_at, external_track_json, added_by_user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(format!("mdpli_{}", Uuid::new_v4().simple()))
        .bind(&playlist_id)
        .bind(position as i64)
        .bind(connection_id)
        .bind(&track.provider_id)
        .bind(library_track_id)
        .bind(&now_iso)
        .bind(external_json)
        .bind(&auth.user.id)
        .execute(&mut *tx)
        .await
        .map_err(crate::db::DbError::from)?;
        if inserted.rows_affected() != 1 {
            return Err(ServerError::Internal(
                "Similar Mix item was not inserted".into(),
            ));
        }
    }

    let claim = sqlx::query(
        "UPDATE similar_mix_previews SET playlist_id = ? WHERE id = ? AND user_id = ? AND playlist_id IS NULL",
    )
        .bind(&playlist_id)
        .bind(&body.preview_id)
        .bind(&auth.user.id)
        .execute(&mut *tx)
        .await.map_err(crate::db::DbError::from)?;
    if claim.rows_affected() != 1 {
        return Err(ServerError::Conflict(
            "The mix preview changed. Refresh the mix.".into(),
        ));
    }
    tx.commit().await.map_err(crate::db::DbError::from)?;

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
