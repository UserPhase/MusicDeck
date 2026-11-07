//! # Playable Source Resolution & Search/Source Provider Admin Routes (`routes::search_sources`)
//!
//! Ports:
//! - `POST /api/sources` (`server/src/routes/music-routes.ts`)
//! - `GET /api/admin/search-providers` (`server/src/routes/admin-routes.ts`)
//! - `PATCH /api/admin/search-providers/:provider_id`
//! - `POST /api/admin/search-providers/:provider_id/test`
//! - `GET /api/admin/source-providers`
//! - `PATCH /api/admin/source-providers/:provider_id`
//! - `POST /api/admin/source-providers/:provider_id/test`

use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, patch, post};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::auth::{AuthenticatedUser, RequireAdmin};
use crate::domain::settings::list_user_settings;
use crate::error::ServerError;
use crate::registry::{SourcePreference, SourceResolutionOptions};
use crate::search::{
    SearchProviderKind, SearchResultMetadata, SearchResultSource, SearchResultType,
    UnifiedSearchResult,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceRequestResultPayload {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: SearchResultType,
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub provider: Option<SearchProviderKind>,
    #[serde(default)]
    pub source: Option<SearchResultSource>,
    #[serde(default)]
    pub metadata: Option<SearchResultMetadata>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceResolutionRequestPayload {
    pub result: SourceRequestResultPayload,
    #[serde(default)]
    pub preference: Option<String>,
    #[serde(default)]
    pub preferred_provider: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchSearchProviderBody {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub config: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchSourceProviderBody {
    pub enabled: bool,
    #[serde(default)]
    pub config: Option<Value>,
}

/// Builds the router for `/api/sources`, `/api/admin/search-providers/*`, and `/api/admin/source-providers/*`.
pub fn search_sources_routes() -> Router<AppState> {
    Router::new()
        .route("/api/sources", post(resolve_playable_sources_handler))
        .route(
            "/api/admin/search-providers",
            get(list_search_providers_handler),
        )
        .route(
            "/api/admin/search-providers/:provider_id",
            patch(patch_search_provider_handler),
        )
        .route(
            "/api/admin/search-providers/:provider_id/test",
            post(test_search_provider_handler),
        )
        .route(
            "/api/admin/source-providers",
            get(list_source_providers_handler),
        )
        .route(
            "/api/admin/source-providers/:provider_id",
            patch(patch_source_provider_handler),
        )
        .route(
            "/api/admin/source-providers/:provider_id/test",
            post(test_source_provider_handler),
        )
}

async fn resolve_playable_sources_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(payload): Json<SourceResolutionRequestPayload>,
) -> Result<Response, ServerError> {
    if payload.result.id.trim().is_empty() || payload.result.title.trim().is_empty() {
        return Err(ServerError::BadRequest(String::from(
            "Invalid source resolution request",
        )));
    }

    let mut preference = SourcePreference::Manual;
    if let Some(pool) = state.db() {
        if let Ok(settings) = list_user_settings(pool, &auth.user.id).await {
            if let Some(pref_setting) = settings
                .iter()
                .find(|s| s.key == "playback.sourcePreference")
            {
                if let Ok(Value::String(raw)) = serde_json::from_str::<Value>(&pref_setting.value) {
                    preference = SourcePreference::parse(&raw);
                } else {
                    preference = SourcePreference::parse(&pref_setting.value);
                }
            }
        }
    }

    if let Some(explicit_pref) = &payload.preference {
        preference = SourcePreference::parse(explicit_pref);
    }

    let result_id = payload.result.id.clone();
    let result_type = payload.result.item_type;

    let search_result = UnifiedSearchResult {
        item_type: result_type,
        id: result_id.clone(),
        title: payload.result.title,
        subtitle: payload.result.subtitle,
        artist: payload.result.artist,
        artist_credits: None,
        album: payload.result.album,
        artwork: None,
        preview_url: None,
        provider: payload
            .result
            .provider
            .unwrap_or(SearchProviderKind::Library),
        source: payload.result.source.unwrap_or(SearchResultSource {
            kind: String::from("library"),
            count: 1,
            options: None,
            external_available: None,
        }),
        availability: None,
        identity: None,
        providers: None,
        in_library: None,
        local_track_id: None,
        local_album_id: None,
        metadata: payload.result.metadata.unwrap_or_default(),
        identity_hints: None,
    };

    let allow_external = (auth.user.is_admin() || auth.user.external_playback_enabled)
        && state
            .privacy()
            .is_external_allowed(crate::services::privacy::PrivacyCategory::External);
    let options = SourceResolutionOptions {
        limit: None,
        allow_external,
        preference: Some(preference),
        preferred_provider: payload.preferred_provider,
    };
    let resolve = state.source_providers().resolve(&search_result, &options);
    let resolved = if allow_external {
        match state
            .privacy()
            .run_external(crate::services::privacy::PrivacyCategory::External, resolve)
            .await
        {
            Ok(resolved) => resolved,
            Err(err) => return Ok(crate::routes::privacy::map_privacy_error(err)),
        }
    } else {
        resolve.await
    };

    Ok((
        StatusCode::OK,
        Json(json!({
            "result": {
                "id": result_id,
                "type": result_type,
            },
            "sources": resolved.sources,
            "selectedSource": resolved.selected_source,
            "degraded": resolved.degraded,
        })),
    )
        .into_response())
}

async fn list_search_providers_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Result<Response, ServerError> {
    let providers = state.search_providers().list().await;
    Ok((StatusCode::OK, Json(json!({ "searchProviders": providers }))).into_response())
}

async fn patch_search_provider_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(provider_id): Path<String>,
    Json(body): Json<PatchSearchProviderBody>,
) -> Result<Response, ServerError> {
    state
        .search_providers()
        .configure(&provider_id, body.enabled, body.config)
        .await
        .map_err(|_| ServerError::NotFound(String::from("Search provider not found")))?;

    let provider = state
        .search_providers()
        .list()
        .await
        .into_iter()
        .find(|p| p.id == provider_id);

    Ok((StatusCode::OK, Json(json!({ "searchProvider": provider }))).into_response())
}

async fn test_search_provider_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(provider_id): Path<String>,
) -> Result<Response, ServerError> {
    let test = state
        .search_providers()
        .test(&provider_id)
        .await
        .map_err(|_| ServerError::NotFound(String::from("Search provider not found")))?;

    Ok((StatusCode::OK, Json(json!({ "test": test }))).into_response())
}

async fn list_source_providers_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Result<Response, ServerError> {
    let providers = state.source_providers().list().await;
    Ok((StatusCode::OK, Json(json!({ "sourceProviders": providers }))).into_response())
}

async fn patch_source_provider_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(provider_id): Path<String>,
    Json(body): Json<PatchSourceProviderBody>,
) -> Result<Response, ServerError> {
    state
        .source_providers()
        .configure(&provider_id, body.enabled, body.config)
        .await
        .map_err(|_| ServerError::NotFound(String::from("Source provider not found")))?;

    let provider = state
        .source_providers()
        .list()
        .await
        .into_iter()
        .find(|p| p.id == provider_id);

    Ok((StatusCode::OK, Json(json!({ "sourceProvider": provider }))).into_response())
}

async fn test_source_provider_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(provider_id): Path<String>,
) -> Result<Response, ServerError> {
    let test = state
        .source_providers()
        .test(&provider_id)
        .await
        .map_err(|_| ServerError::NotFound(String::from("Source provider not found")))?;

    Ok((StatusCode::OK, Json(json!({ "test": test }))).into_response())
}
