//! # Taste Profile, Recommendations, Radio & Library Insights Routes (`routes::taste_recommendations`)
//!
//! Ports `server/src/routes/taste-profile.ts` and the recommendation/insight handlers
//! from `server/src/routes/music-routes.ts`:
//! - `GET /api/v1/taste-profile/state`
//! - `GET /api/v1/taste-profile`
//! - `POST /api/v1/taste-profile/private`
//! - `POST /api/v1/taste-profile/playlist`
//! - `POST /api/v1/taste-profile/track`
//! - `POST /api/v1/taste-profile/restore`
//! - `POST /api/v1/taste-profile/reset`
//! - `GET /api/recommendations`
//! - `POST /api/recommendations/feedback`
//! - `GET /api/radio`
//! - `GET /api/library/health`
//! - `GET /api/library/insights/statistics`

use std::collections::HashMap;

use axum::Router;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;

use crate::AppState;
use crate::auth::AuthenticatedUser;
use crate::catalog::CatalogService;
use crate::error::ServerError;
use crate::profile::{
    LibraryInsightsService, TasteProfileError, TasteProfileManager, TasteTarget,
};
use crate::recommendations::{
    FeedbackAction, RecommendationContext, RecommendationKind, RecommendationSeed,
};

fn taste_error_response(err: TasteProfileError) -> Response {
    let status = StatusCode::from_u16(err.status_code).unwrap_or(StatusCode::BAD_REQUEST);
    (
        status,
        Json(json!({
            "error": {
                "code": "TASTE_PROFILE_ERROR",
                "message": err.message,
            }
        })),
    )
        .into_response()
}

fn no_store_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPrivateBody {
    pub owner_id: String,
    pub enabled: bool,
    pub revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPlaylistBody {
    pub owner_id: String,
    pub playlist_id: String,
    pub excluded: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetTrackBody {
    pub owner_id: String,
    pub track_id: String,
    pub excluded: bool,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreTasteBody {
    pub owner_id: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetTasteBody {
    pub owner_id: String,
    pub revision: i64,
    pub confirmation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecommendationFeedbackBody {
    pub action: String,
    pub item_type: String,
    pub item_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
}

/// Builds the router for `/api/v1/taste-profile/*`, `/api/recommendations/*`, `/api/radio`, and `/api/library/*`.
pub fn taste_and_recommendation_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/taste-profile/state",
            get(get_taste_profile_state_handler),
        )
        .route("/api/v1/taste-profile", get(get_taste_profile_handler))
        .route(
            "/api/v1/taste-profile/private",
            post(post_taste_private_handler),
        )
        .route(
            "/api/v1/taste-profile/playlist",
            post(post_taste_playlist_handler),
        )
        .route(
            "/api/v1/taste-profile/track",
            post(post_taste_track_handler),
        )
        .route(
            "/api/v1/taste-profile/restore",
            post(post_taste_restore_handler),
        )
        .route(
            "/api/v1/taste-profile/reset",
            post(post_taste_reset_handler),
        )
        .route("/api/recommendations", get(get_recommendations_handler))
        .route("/api/discovery/personalized", get(get_recommendations_handler))
        .route(
            "/api/v1/playlists/:playlist_id/recommendations",
            get(get_playlist_recommendations_handler),
        )
        .route(
            "/api/recommendations/feedback",
            post(post_recommendation_feedback_handler),
        )
        .route("/api/radio", get(get_radio_handler))
        .route("/api/recommendations/radio", post(post_radio_handler))
        .route("/api/recommendations/autoplay", post(post_radio_handler))
        .route("/api/library/health", get(get_library_health_handler))
        .route(
            "/api/library/insights/statistics",
            get(get_library_insights_statistics_handler),
        )
        .route(
            "/api/library/statistics",
            get(get_library_insights_statistics_handler),
        )
        .route(
            "/api/library/collections/:kind",
            get(get_library_collection_handler),
        )
        .route(
            "/api/library/saved-filters",
            get(get_saved_filters_handler).post(post_saved_filters_handler),
        )
        .route("/api/library/collector", get(get_library_collector_handler))
}

async fn get_taste_profile_state_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Result<Response, ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };

    let manager = TasteProfileManager::new(pool.clone());
    let taste_state = manager.state(&auth.user.id).await;

    let playlist_rows = sqlx::query(
        r"
        SELECT id FROM playlists
        WHERE exclude_from_taste = 1
          AND deleted_at IS NULL
          AND (owner_user_id = ? OR visibility IN ('public', 'shared'))
        ",
    )
    .bind(&auth.user.id)
    .fetch_all(pool.inner())
    .await
    .unwrap_or_default();

    let excluded_playlist_ids: Vec<String> = playlist_rows
        .into_iter()
        .filter_map(|r| r.try_get("id").ok())
        .collect();

    let track_rows = sqlx::query(
        "SELECT track_id AS id FROM taste_track_exclusions WHERE user_id = ?",
    )
    .bind(&auth.user.id)
    .fetch_all(pool.inner())
    .await
    .unwrap_or_default();

    let excluded_track_ids: Vec<String> = track_rows
        .into_iter()
        .filter_map(|r| r.try_get("id").ok())
        .collect();

    Ok((
        StatusCode::OK,
        no_store_headers(),
        Json(json!({
            "privateListening": taste_state.private_listening,
            "revision": taste_state.revision,
            "resetBefore": taste_state.reset_before,
            "providerHistoryDisabled": taste_state.provider_history_disabled,
            "excludedPlaylistIds": excluded_playlist_ids,
            "excludedTrackIds": excluded_track_ids,
        })),
    )
        .into_response())
}

async fn get_taste_profile_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Result<Response, ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let manager = TasteProfileManager::new(pool.clone());
    let overview = manager.overview(&auth.user.id).await;
    Ok((StatusCode::OK, no_store_headers(), Json(overview)).into_response())
}

async fn post_taste_private_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<SetPrivateBody>,
) -> Result<Response, ServerError> {
    if body.owner_id != auth.user.id {
        return Err(ServerError::Conflict(String::from(
            "The signed-in account changed. Reopen taste settings.",
        )));
    }
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let manager = TasteProfileManager::new(pool.clone());
    if let Err(err) = manager
        .set_private(&auth.user.id, body.enabled, body.revision)
        .await
    {
        return Ok(taste_error_response(err));
    }
    state
        .recommendations()
        .invalidate_listening_taste(&auth.user.id);
    let overview = manager.overview(&auth.user.id).await;
    Ok((StatusCode::OK, no_store_headers(), Json(overview)).into_response())
}

async fn post_taste_playlist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<SetPlaylistBody>,
) -> Result<Response, ServerError> {
    if body.owner_id != auth.user.id {
        return Err(ServerError::Conflict(String::from(
            "The signed-in account changed. Reopen taste settings.",
        )));
    }
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let manager = TasteProfileManager::new(pool.clone());
    if let Err(err) = manager
        .set_playlist(&auth.user, &body.playlist_id, body.excluded)
        .await
    {
        return Ok(taste_error_response(err));
    }
    state
        .recommendations()
        .invalidate_listening_taste(&auth.user.id);
    let overview = manager.overview(&auth.user.id).await;
    Ok((StatusCode::OK, no_store_headers(), Json(overview)).into_response())
}

async fn post_taste_track_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<SetTrackBody>,
) -> Result<Response, ServerError> {
    if body.owner_id != auth.user.id {
        return Err(ServerError::Conflict(String::from(
            "The signed-in account changed. Reopen taste settings.",
        )));
    }
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let manager = TasteProfileManager::new(pool.clone());
    if let Err(err) = manager
        .set_track(
            &auth.user.id,
            TasteTarget {
                id: body.track_id,
                item_type: Some(String::from("track")),
                title: body.title,
                artist: body.artist,
                album: None,
                artist_id: None,
                album_id: None,
            },
            body.excluded,
        )
        .await
    {
        return Ok(taste_error_response(err));
    }
    state
        .recommendations()
        .invalidate_listening_taste(&auth.user.id);
    let overview = manager.overview(&auth.user.id).await;
    Ok((StatusCode::OK, no_store_headers(), Json(overview)).into_response())
}

async fn post_taste_restore_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<RestoreTasteBody>,
) -> Result<Response, ServerError> {
    if body.owner_id != auth.user.id {
        return Err(ServerError::Conflict(String::from(
            "The signed-in account changed. Reopen taste settings.",
        )));
    }
    if !matches!(body.item_type.as_str(), "track" | "artist" | "album") {
        return Err(ServerError::BadRequest(String::from(
            "Invalid taste preference request.",
        )));
    }
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let manager = TasteProfileManager::new(pool.clone());
    if let Err(err) = manager
        .restore(&auth.user.id, &body.item_type, &body.id)
        .await
    {
        return Ok(taste_error_response(err));
    }
    state
        .recommendations()
        .invalidate_listening_taste(&auth.user.id);
    let overview = manager.overview(&auth.user.id).await;
    Ok((StatusCode::OK, no_store_headers(), Json(overview)).into_response())
}

async fn post_taste_reset_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<ResetTasteBody>,
) -> Result<Response, ServerError> {
    if body.owner_id != auth.user.id {
        return Err(ServerError::Conflict(String::from(
            "The signed-in account changed. Reopen taste settings.",
        )));
    }
    if body.confirmation != "RESET" {
        return Err(ServerError::BadRequest(String::from(
            "Invalid taste preference request.",
        )));
    }
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let manager = TasteProfileManager::new(pool.clone());
    if let Err(err) = manager.reset(&auth.user.id, body.revision).await {
        return Ok(taste_error_response(err));
    }
    state
        .recommendations()
        .invalidate_listening_taste(&auth.user.id);
    let overview = manager.overview(&auth.user.id).await;
    Ok((StatusCode::OK, no_store_headers(), Json(overview)).into_response())
}

async fn get_recommendations_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(12)
        .clamp(1, 30);

    if let Some(kind_str) = params.get("kind") {
        let Some(kind) = RecommendationKind::parse(kind_str) else {
            return Err(ServerError::BadRequest(String::from(
                "Invalid recommendation kind",
            )));
        };
        let items = state
            .recommendations()
            .recommend(
                &catalog,
                &RecommendationContext {
                    user_id: auth.user.id,
                    kind,
                    limit,
                    seed: None,
                },
            )
            .await;
        return Ok((
            StatusCode::OK,
            Json(json!({
                "items": items,
                "degraded": false,
            })),
        )
            .into_response());
    }

    let default_kinds = [
        RecommendationKind::ContinueListening,
        RecommendationKind::FavoritesMix,
        RecommendationKind::ForgottenFavorites,
        RecommendationKind::Discover,
        RecommendationKind::SimilarArtists,
    ];
    let sections = state
        .recommendations()
        .sections(&catalog, &auth.user.id, &default_kinds, limit)
        .await;

    Ok((
        StatusCode::OK,
        Json(json!({
            "sections": sections,
            "degraded": false,
        })),
    )
        .into_response())
}

async fn post_recommendation_feedback_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<RecommendationFeedbackBody>,
) -> Result<Response, ServerError> {
    let Some(action) = FeedbackAction::parse(&body.action) else {
        return Err(ServerError::BadRequest(String::from(
            "Invalid feedback action",
        )));
    };
    if !matches!(body.item_type.as_str(), "track" | "artist" | "album")
        || body.item_id.trim().is_empty()
    {
        return Err(ServerError::BadRequest(String::from(
            "Invalid feedback target",
        )));
    }

    state
        .recommendations()
        .set_feedback(
            &auth.user.id,
            action,
            &body.item_type,
            &body.item_id,
            body.title.as_deref(),
            body.artist.as_deref(),
            body.album.as_deref(),
        )
        .await;

    Ok((StatusCode::OK, Json(json!({ "ok": true }))).into_response())
}

async fn get_radio_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let seed_type = params
        .get("type")
        .map(String::as_str)
        .unwrap_or("track")
        .to_owned();
    let Some(seed_id) = params.get("id").filter(|s| !s.trim().is_empty()).cloned() else {
        return Err(ServerError::BadRequest(String::from(
            "Radio seed id is required",
        )));
    };
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(20)
        .clamp(1, 50);

    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
    let items = state
        .recommendations()
        .radio(
            &catalog,
            &auth.user.id,
            RecommendationSeed {
                seed_type,
                id: seed_id,
                title: params.get("title").cloned(),
                artist: params.get("artist").cloned(),
                album: params.get("album").cloned(),
                artist_id: params.get("artistId").cloned(),
                album_id: params.get("albumId").cloned(),
            },
            limit,
        )
        .await;

    Ok((StatusCode::OK, Json(json!({ "items": items }))).into_response())
}

async fn get_library_health_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
) -> Result<Response, ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
    let insights = LibraryInsightsService::new(pool.clone(), catalog);
    Ok((StatusCode::OK, Json(insights.health().await)).into_response())
}

async fn get_library_insights_statistics_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Result<Response, ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
    let insights = LibraryInsightsService::new(pool.clone(), catalog);
    Ok((
        StatusCode::OK,
        Json(insights.statistics(&auth.user.id).await),
    )
        .into_response())
}

async fn get_playlist_recommendations_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    axum::extract::Path(_playlist_id): axum::extract::Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(10)
        .clamp(1, 30);
    let items = state
        .recommendations()
        .recommend(
            &catalog,
            &RecommendationContext {
                user_id: auth.user.id,
                kind: RecommendationKind::Discover,
                limit,
                seed: None,
            },
        )
        .await;
    Ok((
        StatusCode::OK,
        Json(json!({
            "tracks": items,
            "degraded": false,
        })),
    )
        .into_response())
}

async fn post_radio_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<serde_json::Value>,
) -> Result<Response, ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let seed_obj = body.get("seed").unwrap_or(&body);
    let seed_type = seed_obj
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("track")
        .to_owned();
    let seed_id = seed_obj
        .get("id")
        .or_else(|| body.get("trackId"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let limit = body
        .get("limit")
        .and_then(serde_json::Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(20)
        .clamp(1, 50);

    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
    let items = if seed_id.is_empty() {
        state
            .recommendations()
            .recommend(
                &catalog,
                &RecommendationContext {
                    user_id: auth.user.id,
                    kind: RecommendationKind::Discover,
                    limit,
                    seed: None,
                },
            )
            .await
    } else {
        state
            .recommendations()
            .radio(
                &catalog,
                &auth.user.id,
                RecommendationSeed {
                    seed_type,
                    id: seed_id,
                    title: seed_obj.get("title").and_then(serde_json::Value::as_str).map(str::to_owned),
                    artist: seed_obj.get("artist").and_then(serde_json::Value::as_str).map(str::to_owned),
                    album: seed_obj.get("album").and_then(serde_json::Value::as_str).map(str::to_owned),
                    artist_id: seed_obj.get("artistId").and_then(serde_json::Value::as_str).map(str::to_owned),
                    album_id: seed_obj.get("albumId").and_then(serde_json::Value::as_str).map(str::to_owned),
                },
                limit,
            )
            .await
    };

    Ok((
        StatusCode::OK,
        Json(json!({
            "items": items,
            "tracks": items,
        })),
    )
        .into_response())
}

async fn get_library_collection_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    axum::extract::Path(_kind): axum::extract::Path<String>,
) -> Result<Response, ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
    let insights = LibraryInsightsService::new(pool.clone(), catalog);
    Ok((
        StatusCode::OK,
        Json(insights.statistics(&auth.user.id).await),
    )
        .into_response())
}

async fn get_saved_filters_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Result<Response, ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
    let insights = LibraryInsightsService::new(pool.clone(), catalog);
    Ok((
        StatusCode::OK,
        Json(json!({ "filters": insights.list_filters(&auth.user.id).await })),
    )
        .into_response())
}

async fn post_saved_filters_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<serde_json::Value>,
) -> Result<Response, ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let name = body
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim();
    if name.is_empty() {
        return Err(ServerError::BadRequest(String::from(
            "Filter name is required",
        )));
    }
    let filters = body
        .get("filters")
        .or_else(|| body.get("filter"))
        .and_then(|v| serde_json::from_value::<Vec<crate::profile::LibraryFilter>>(v.clone()).ok())
        .unwrap_or_default();
    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
    let insights = LibraryInsightsService::new(pool.clone(), catalog);
    let saved = insights.save_filter(&auth.user.id, name, filters).await;
    Ok((StatusCode::CREATED, Json(json!({ "filter": saved }))).into_response())
}

async fn get_library_collector_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Result<Response, ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
    let insights = LibraryInsightsService::new(pool.clone(), catalog);
    Ok((
        StatusCode::OK,
        Json(insights.statistics(&auth.user.id).await),
    )
        .into_response())
}
