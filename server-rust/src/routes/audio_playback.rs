//! # Loudness Normalization, Preview Proxy & Silence Scan HTTP Routes (`routes::audio_playback`)
//!
//! Ports `server/src/routes/loudness-routes.ts` and `server/src/routes/silence-scan-routes.ts`:
//! - `GET /api/playback/loudness-scan`
//! - `POST /api/playback/loudness-scan`
//! - `GET /api/playback/preview`
//! - `POST /api/playback/normalize`
//! - `GET /api/playback/silence-scan`
//! - `POST /api/playback/silence-scan`
//! - `GET /api/tracks/:track_id/silence`
//! - `POST /api/tracks/:track_id/silence/analyze`

use std::collections::HashMap;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use reqwest::Client;
use reqwest::redirect::Policy;
use serde::Deserialize;
use serde_json::{Value, json};
use url::Url;

use crate::AppState;
use crate::audio::{
    LOUDNESS_TARGET, LibraryAnalysisScanService, LoudnessService, SilenceAnalysisService,
    SilenceParameters, is_allowed_preview, measured_playback_gain, playback_identity,
};
use crate::auth::AuthenticatedUser;
use crate::catalog::{CatalogService, LibraryService};
use crate::error::ServerError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NormalizePlaybackRequestBody {
    pub track_id: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub playable_source: Option<String>,
    #[serde(default)]
    pub preview_url: Option<String>,
    #[serde(default)]
    pub bit_rate: Option<u32>,
    #[serde(default)]
    pub background: Option<bool>,
    #[serde(default)]
    pub target_lufs: Option<i32>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SilenceScanRequestBody {
    #[serde(default)]
    pub threshold_db: Option<f64>,
    #[serde(default)]
    pub min_silence_seconds: Option<f64>,
}

/// Builds the router for `/api/playback/*` and `/api/tracks/:track_id/silence*`.
pub fn audio_playback_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/playback/loudness-scan",
            get(get_loudness_scan_handler).post(post_loudness_scan_handler),
        )
        .route("/api/playback/preview", get(get_playback_preview_handler))
        .route(
            "/api/playback/normalize",
            post(post_playback_normalize_handler),
        )
        .route(
            "/api/playback/normalized/:key",
            get(get_playback_normalized_handler),
        )
        .route(
            "/api/playback/silence-scan",
            get(get_silence_scan_handler).post(post_silence_scan_handler),
        )
        .route(
            "/api/tracks/:track_id/silence",
            get(get_track_silence_handler),
        )
        .route(
            "/api/tracks/:track_id/silence-analysis",
            get(get_track_silence_handler).post(post_track_silence_analyze_handler),
        )
        .route(
            "/api/tracks/:track_id/silence/analyze",
            post(post_track_silence_analyze_handler),
        )
}

async fn get_loudness_scan_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let scan_service = LibraryAnalysisScanService::new(state.db().cloned(), "loudness");
    let status = scan_service
        .status(&auth.user.id, auth.user.is_admin())
        .await;
    (StatusCode::OK, Json(json!({ "scan": status }))).into_response()
}

async fn post_loudness_scan_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<Value>,
) -> Result<Response, ServerError> {
    if !body.as_object().is_some_and(serde_json::Map::is_empty) {
        return Err(ServerError::BadRequest(String::from(
            "Invalid scan request",
        )));
    }
    if state.db().is_none() {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Library analysis is unavailable",
        )));
    }

    let scan_service = LibraryAnalysisScanService::new(state.db().cloned(), "loudness");
    let scan = scan_service
        .start(&auth.user.id, auth.user.is_admin(), HashMap::new())
        .await
        .map_err(|e| ServerError::Conflict(e.to_string()))?;

    Ok((StatusCode::ACCEPTED, Json(json!({ "scan": scan }))).into_response())
}

async fn get_playback_preview_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ServerError> {
    let Some(raw_url) = params.get("url").filter(|u| u.len() <= 2048) else {
        return Err(ServerError::BadRequest(String::from(
            "Untrusted preview URL",
        )));
    };
    if !is_allowed_preview(raw_url) {
        return Err(ServerError::BadRequest(String::from(
            "Untrusted preview URL",
        )));
    }

    let _stream_guard = state.tasks().acquire_media_stream();
    let http = Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(Policy::none())
        .build()
        .unwrap_or_default();

    let range_header = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    let mut current_url = raw_url.clone();
    let mut final_resp = None;

    for _ in 0..=3 {
        if !is_allowed_preview(&current_url) {
            return Err(ServerError::BadRequest(String::from(
                "Untrusted preview URL",
            )));
        }
        let mut req = http.get(&current_url);
        if let Some(ref r) = range_header {
            req = req.header(header::RANGE, r);
        }
        let Ok(resp) = req.send().await else {
            return Err(ServerError::BadGateway(String::from("Preview unavailable")));
        };
        if resp.status().is_redirection() {
            let Some(loc) = resp
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
            else {
                return Err(ServerError::BadGateway(String::from("Preview unavailable")));
            };
            let Ok(next_url) = Url::parse(&current_url).and_then(|b| b.join(loc)) else {
                return Err(ServerError::BadGateway(String::from("Preview unavailable")));
            };
            current_url = next_url.to_string();
            continue;
        }
        final_resp = Some(resp);
        break;
    }

    let Some(resp) = final_resp else {
        return Err(ServerError::BadGateway(String::from("Preview unavailable")));
    };
    let status_u16 = resp.status().as_u16();
    if !matches!(status_u16, 200 | 206 | 416) {
        return Err(ServerError::BadGateway(String::from("Preview unavailable")));
    }

    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .map(str::trim)
        .filter(|s| s.to_ascii_lowercase().starts_with("audio/"))
        .unwrap_or("application/octet-stream")
        .to_owned();

    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    resp_headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if let Ok(ct_val) = HeaderValue::from_str(&content_type) {
        resp_headers.insert(header::CONTENT_TYPE, ct_val);
    }
    for name in [
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(val) = resp.headers().get(&name) {
            resp_headers.insert(name, val.clone());
        }
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|_| ServerError::BadGateway(String::from("Preview unavailable")))?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(ServerError::BadGateway(String::from(
            "Preview exceeds size limit",
        )));
    }

    let status = StatusCode::from_u16(status_u16).unwrap_or(StatusCode::OK);
    Ok((status, resp_headers, Body::from(bytes)).into_response())
}

async fn post_playback_normalize_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<NormalizePlaybackRequestBody>,
) -> Result<Response, ServerError> {
    if body.track_id.trim().is_empty() || body.track_id.len() > 256 {
        return Err(ServerError::BadRequest(String::from(
            "Invalid playback request",
        )));
    }
    if let Some(br) = body.bit_rate {
        if !matches!(br, 128 | 192 | 256 | 320) {
            return Err(ServerError::BadRequest(String::from(
                "Invalid playback request",
            )));
        }
    }
    if let Some(t_lufs) = body.target_lufs {
        if !matches!(t_lufs, -18 | -16 | -14) {
            return Err(ServerError::BadRequest(String::from(
                "Invalid playback request",
            )));
        }
    }
    if (body.preview_url.is_some() && (body.source.is_some() || body.playable_source.is_some()))
        || (body.source.is_some() && body.playable_source.is_some())
    {
        return Err(ServerError::BadRequest(String::from(
            "Choose one audio source",
        )));
    }

    let external = body
        .playable_source
        .as_deref()
        .is_some_and(|ps| state.source_providers().is_external_source(&body.track_id, ps));
    if external && !auth.user.is_admin() && !auth.user.external_playback_enabled {
        return Err(ServerError::Forbidden(String::from(
            "External playback is disabled",
        )));
    }
    if let Some(ref prev) = body.preview_url {
        if !is_allowed_preview(prev) {
            return Err(ServerError::BadRequest(String::from(
                "Untrusted preview URL",
            )));
        }
    }

    let Some(pool) = state.db() else {
        return Ok((StatusCode::OK, Json(json!({ "status": "unavailable" }))).into_response());
    };

    let library = LibraryService::new(pool.clone(), None);
    if body.preview_url.is_none()
        && body.playable_source.is_none()
        && !library.exists(&body.track_id).await.unwrap_or(false)
    {
        return Err(ServerError::NotFound(String::from("Track not found")));
    }

    let target_lufs = f64::from(body.target_lufs.unwrap_or(LOUDNESS_TARGET as i32));
    if body.source.is_none() && body.playable_source.is_none() && body.preview_url.is_none() {
        let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
        if let Some(track) = catalog.get_track(&body.track_id).await {
            if let Some(loudness) = track.item.loudness {
                let gain_db = measured_playback_gain(
                    loudness.integrated_lufs,
                    loudness.true_peak_db,
                    target_lufs,
                );
                return Ok((
                    StatusCode::OK,
                    Json(json!({
                        "status": "measured",
                        "integratedLufs": loudness.integrated_lufs,
                        "truePeakDb": loudness.true_peak_db,
                        "gainDb": gain_db,
                    })),
                )
                    .into_response());
            }
        }
    }

    let loudness_service = LoudnessService::new(Some(pool.clone()));
    let ident = playback_identity(
        &body.track_id,
        None,
        body.source.as_deref(),
        body.playable_source.as_deref(),
        body.preview_url.as_deref(),
    );
    let ext_tag = if body.preview_url.is_some() {
        "preview"
    } else if external {
        "true"
    } else {
        "false"
    };

    if let Some(measured) = loudness_service
        .cached_measurement(&ident, ext_tag, target_lufs)
        .await
    {
        return Ok((
            StatusCode::OK,
            Json(json!({
                "status": "measured",
                "integratedLufs": measured.integrated_lufs,
                "truePeakDb": measured.true_peak_db,
                "gainDb": measured.gain_db,
            })),
        )
            .into_response());
    }

    let fallback_status = if body.background == Some(true) {
        "processing"
    } else {
        "unavailable"
    };
    Ok((StatusCode::OK, Json(json!({ "status": fallback_status }))).into_response())
}

async fn get_silence_scan_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let scan_service = LibraryAnalysisScanService::new(state.db().cloned(), "silence");
    let status = scan_service
        .status(&auth.user.id, auth.user.is_admin())
        .await;
    (StatusCode::OK, Json(json!({ "scan": status }))).into_response()
}

async fn post_silence_scan_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<SilenceScanRequestBody>,
) -> Result<Response, ServerError> {
    let params = SilenceParameters::validate(body.threshold_db, body.min_silence_seconds)
        .map_err(ServerError::BadRequest)?;
    if state.db().is_none() {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Library silence analysis is unavailable",
        )));
    }

    let mut map = HashMap::new();
    map.insert(String::from("thresholdDb"), params.threshold_db);
    map.insert(String::from("minSilenceSeconds"), params.min_silence_seconds);

    let scan_service = LibraryAnalysisScanService::new(state.db().cloned(), "silence");
    let scan = scan_service
        .start(&auth.user.id, auth.user.is_admin(), map)
        .await
        .map_err(|e| ServerError::Conflict(e.to_string()))?;

    Ok((StatusCode::ACCEPTED, Json(json!({ "scan": scan }))).into_response())
}

async fn get_track_silence_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Path(track_id): Path<String>,
) -> Response {
    let service = SilenceAnalysisService::new(state.db().cloned());
    let analysis = service.get_analysis(&track_id, None).await;
    (StatusCode::OK, Json(json!({ "analysis": analysis }))).into_response()
}

async fn post_track_silence_analyze_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Path(track_id): Path<String>,
    Json(body): Json<SilenceScanRequestBody>,
) -> Result<Response, ServerError> {
    let params = SilenceParameters::validate(body.threshold_db, body.min_silence_seconds)
        .map_err(ServerError::BadRequest)?;
    let service = SilenceAnalysisService::new(state.db().cloned());
    let existing = service.get_analysis(&track_id, Some(params)).await;
    Ok((StatusCode::OK, Json(json!({ "analysis": existing }))).into_response())
}

async fn get_playback_normalized_handler(
    _auth: AuthenticatedUser,
    Path(_key): Path<String>,
) -> Result<Response, ServerError> {
    Err(ServerError::NotFound(String::from(
        "Prepared playback expired",
    )))
}
