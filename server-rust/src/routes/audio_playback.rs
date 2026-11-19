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

use crate::error::ApiJson;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use url::Url;

use crate::AppState;
use crate::audio::silence::silence_unavailable;
use crate::audio::prepared::{Preparation, PreparationError, PreparedAccess};
use crate::audio::{
    LOUDNESS_TARGET, LoudnessService,
    SilenceParameters, is_allowed_preview, measured_playback_gain, playback_identity,
};
use crate::auth::AuthenticatedUser;
use crate::catalog::{CandidateSource, LibraryService, SourceResolver};
use crate::error::ServerError;
use crate::providers::StreamResult;
use crate::registry::playable_sources::PlayableSourceType;
use crate::registry::source_providers::ResolvedPlayableStream;
use crate::services::privacy::PrivacyCategory;
use crate::streaming::http::{
    MAX_EXTERNAL_PREVIEW_BYTES, MediaBody, bounded_media_body, fetch_external_media,
    serve_file_with_range,
};

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
    pub target_lufs: Option<i32>,
    #[serde(default)]
    pub background: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SilenceScanRequestBody {
    #[serde(default)]
    pub threshold_db: Option<f64>,
    #[serde(default)]
    pub min_silence_seconds: Option<f64>,
    #[serde(default)]
    pub force: bool,
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
) -> Result<Response, ServerError> {
    let scan = state.loudness_scan()
        .ok_or_else(|| ServerError::ServiceUnavailable("Library loudness analysis is unavailable".into()))?
        .status(&auth.user.id, auth.user.is_admin()).await?;
    Ok(Json(json!({ "scan": scan })).into_response())
}

async fn post_loudness_scan_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    ApiJson(body): ApiJson<Value>,
) -> Result<Response, ServerError> {
    if !body.as_object().is_some_and(serde_json::Map::is_empty) {
        return Err(ServerError::BadRequest("Invalid scan request".into()));
    }
    let scan = state.loudness_scan()
        .ok_or_else(|| ServerError::ServiceUnavailable("Library loudness analysis is unavailable".into()))?
        .start(&auth.user.id, auth.user.is_admin(), None).await?;
    Ok((StatusCode::ACCEPTED, Json(json!({ "scan": scan }))).into_response())
}

async fn get_playback_preview_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ServerError> {
    let Some(raw_url) = params
        .get("url")
        .filter(|url| url.len() <= 2048 && is_allowed_preview(url))
    else {
        return Err(ServerError::BadRequest("Untrusted preview URL".into()));
    };
    let permit = match playback_permit(&state, &auth, PreparedAccess::PublicPreview) {
        Ok(Some(permit)) => permit,
        Ok(None) => unreachable!("external preview requires a privacy permit"),
        Err(response) => return Ok(response),
    };
    let fetch = fetch_external_media(
        raw_url,
        request_header(&headers, header::RANGE),
        request_header(&headers, header::IF_RANGE),
        MAX_EXTERNAL_PREVIEW_BYTES,
        is_allowed_preview,
    );
    let guard = state.tasks().acquire_media_stream();
    tokio::select! {
        biased;
        () = permit.cancelled() => Err(ServerError::Forbidden("External playback is disabled".into())),
        response = fetch => Ok(response.map_err(ServerError::BadGateway)?.into_response(permit)
            .map(|body| axum::body::Body::from_stream(body.into_data_stream().map(move |chunk| {
                let _guard = &guard;
                chunk
            })))),
    }
}

fn request_header(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn playback_permit(
    state: &AppState,
    auth: &AuthenticatedUser,
    access: PreparedAccess,
) -> Result<Option<tokio_util::sync::CancellationToken>, Response> {
    if access == PreparedAccess::Library {
        return Ok(None);
    }
    if access == PreparedAccess::External
        && !auth.user.is_admin()
        && !auth.user.external_playback_enabled
    {
        return Err(ServerError::Forbidden("External playback is disabled".into()).into_response());
    }
    state
        .privacy()
        .outbound_permit(PrivacyCategory::External)
        .map(Some)
        .map_err(crate::routes::privacy::map_privacy_error)
}

enum PreparationInput {
    Library(CandidateSource),
    Preview(String),
    Token(String),
}

impl PreparationInput {
    async fn load(self, state: AppState, track: String) -> Result<MediaBody, PreparationError> {
        let load = async {
            match self {
                Self::Library(candidate) => {
                    let stream = candidate
                        .provider
                        .provider
                        .fetch_stream(&candidate.source.provider_item_id, None, None, None)
                        .await
                        .map_err(|_| {
                            PreparationError::Work("Library audio is unavailable".into())
                        })?;
                    preparation_body(stream)
                }
                Self::Preview(url) => {
                    let stream = fetch_external_media(
                        &url,
                        None,
                        None,
                        MAX_EXTERNAL_PREVIEW_BYTES,
                        is_allowed_preview,
                    )
                    .await
                    .map_err(PreparationError::Work)?;
                    if stream.status() != StatusCode::OK {
                        return Err(PreparationError::Work(
                            "Preview audio is unavailable".into(),
                        ));
                    }
                    Ok(stream.into_body(None))
                }
                Self::Token(token) => match state
                    .source_providers()
                    .fetch_stream(&track, &token, None, None)
                    .await
                    .map_err(|error| PreparationError::Work(error.message))?
                {
                    ResolvedPlayableStream::External(stream)
                        if stream.status() == StatusCode::OK =>
                    {
                        Ok(stream.into_body(None))
                    }
                    _ => Err(PreparationError::Work(
                        "External audio is unavailable".into(),
                    )),
                },
            }
        };
        tokio::time::timeout(crate::providers::MEDIA_HEADER_BUDGET, load)
            .await
            .map_err(|_| PreparationError::Work("Audio source header deadline exceeded".into()))?
    }
}

fn preparation_body(stream: StreamResult) -> Result<MediaBody, PreparationError> {
    if stream.status != StatusCode::OK || stream.headers.contains_key(header::CONTENT_RANGE) {
        return Err(PreparationError::Work(
            "Library audio is unavailable".into(),
        ));
    }
    let content_length = stream.response.content_length();
    let max = crate::audio::MAX_LOUDNESS_INPUT_BYTES;
    if content_length.is_some_and(|length| length == 0 || length > max) {
        return Err(PreparationError::Work(
            "Audio source exceeds preparation limit".into(),
        ));
    }
    Ok(bounded_media_body(
        Box::pin(stream.response.bytes_stream()),
        max,
        content_length,
        None,
        crate::providers::MEDIA_BODY_IDLE_TIMEOUT,
    ))
}

fn measured_payload(status: &str, measurement: Option<crate::audio::LoudnessMetadata>) -> Value {
    if let Some(measurement) = measurement {
        json!({ "status": status, "integratedLufs": measurement.integrated_lufs,
            "truePeakDb": measurement.true_peak_db, "gainDb": measurement.gain_db })
    } else {
        json!({ "status": status })
    }
}

fn ready_payload(
    key: &str,
    artifact: &crate::audio::prepared::PreparedArtifact,
    gain: Option<crate::audio::LoudnessMetadata>,
) -> Value {
    json!({ "status": "ready", "streamUrl": format!("/api/playback/normalized/{key}"),
        "integratedLufs": artifact.integrated_lufs, "truePeakDb": artifact.true_peak_db,
        "gainDb": gain.map_or(0.0, |gain| gain.gain_db), "loudness": gain })
}

async fn post_playback_normalize_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    ApiJson(body): ApiJson<NormalizePlaybackRequestBody>,
) -> Result<Response, ServerError> {
    if body.track_id.trim().is_empty()
        || body.track_id.len() > 256
        || body
            .source
            .as_ref()
            .is_some_and(|source| source.is_empty() || source.len() > 256)
        || body
            .playable_source
            .as_ref()
            .is_some_and(|source| source.is_empty() || source.len() > 256)
        || body
            .bit_rate
            .is_some_and(|bitrate| !matches!(bitrate, 128 | 192 | 256 | 320))
        || body
            .target_lufs
            .is_some_and(|target| !matches!(target, -18 | -16 | -14))
        || (body.preview_url.is_some() && (body.source.is_some() || body.playable_source.is_some()))
        || (body.source.is_some() && body.playable_source.is_some())
    {
        return Err(ServerError::BadRequest("Invalid playback request".into()));
    }
    let Some((pool, service)) = state.db().zip(state.prepared_audio()) else {
        return Ok(super::music::stream_database_unavailable());
    };
    let service = service.clone();
    let mut preferred = body.source.clone();
    let mut revision = None;
    let mut source = None;
    let mut token = None;
    let mut preview = None;
    let (access, is_preview, input) = if let Some(url) = body.preview_url.as_deref() {
        if url.len() > 2048 || !is_allowed_preview(url) {
            return Err(ServerError::BadRequest("Untrusted preview URL".into()));
        }
        let url = Url::parse(url)
            .map_err(|_| ServerError::BadRequest("Untrusted preview URL".into()))?
            .to_string();
        preview = Some(url.clone());
        (
            PreparedAccess::PublicPreview,
            true,
            Some(PreparationInput::Preview(url)),
        )
    } else if let Some(id) = body.playable_source.as_deref() {
        if state.providers().get_by_connection_id(id).is_some() {
            preferred = Some(id.to_owned());
            (PreparedAccess::Library, false, None)
        } else {
            match state
                .source_providers()
                .preparation_source(&body.track_id, id)
            {
                Some((PlayableSourceType::Library, connection)) => {
                    preferred = Some(connection);
                    (PreparedAccess::Library, false, None)
                }
                Some((kind, identity)) => {
                    token = Some(identity);
                    (
                        PreparedAccess::External,
                        kind == PlayableSourceType::Preview,
                        Some(PreparationInput::Token(id.into())),
                    )
                }
                None => return Ok(Json(json!({ "status": "unavailable" })).into_response()),
            }
        }
    } else {
        (PreparedAccess::Library, false, None)
    };
    let permit = match playback_permit(&state, &auth, access) {
        Ok(permit) => permit,
        Err(response) => return Ok(response),
    };
    let target = body.target_lufs.unwrap_or(LOUDNESS_TARGET as i32);
    let loudness = LoudnessService::new(Some(pool.clone()));
    let input = if let Some(input) = input {
        input
    } else {
        let library = LibraryService::new(pool.clone(), None);
        let version = match tokio::time::timeout(
            Duration::from_secs(2),
            library.track_content_revision(&body.track_id),
        )
        .await
        {
            Ok(Ok(Some(version))) => version,
            Ok(Ok(None)) => return Err(ServerError::NotFound("Track not found".into())),
            _ => return Ok(super::music::stream_database_unavailable()),
        };
        // Analysis scans store this identity for the default library output.
        if preferred.is_none() && body.bit_rate.is_none() {
            let identity = playback_identity(
                &body.track_id,
                (!version.is_empty()).then_some(version.as_str()),
                None,
                None,
                None,
            );
            if let Some(measurement) = loudness
                .cached_measurement(&identity, "false", f64::from(target))
                .await
            {
                return Ok(Json(measured_payload("measured", Some(measurement))).into_response());
            }
        }
        revision = Some((body.track_id.clone(), version));
        let resolver = SourceResolver::new(state.providers().clone(), library);
        let candidates = match resolver
            .try_candidate_sources(&body.track_id, preferred.as_deref())
            .await
        {
            Ok(candidates) => candidates,
            Err(_) => return Ok(super::music::stream_database_unavailable()),
        };
        let Some(candidate) = candidates.into_iter().find(|candidate| {
            preferred
                .as_ref()
                .is_none_or(|id| candidate.source.connection_id == *id)
        }) else {
            return Ok(Json(json!({ "status": "unavailable" })).into_response());
        };
        source = Some(
            json!([
                candidate.source.connection_id,
                candidate.source.provider_item_id
            ])
            .to_string(),
        );
        PreparationInput::Library(candidate)
    };
    let identity = playback_identity(
        &body.track_id,
        revision.as_ref().map(|(_, value)| value.as_str()),
        source.as_deref(),
        token.as_deref(),
        preview.as_deref(),
    );
    let request = Preparation {
        identity: identity.clone(),
        track_revision: revision,
        access,
        preview: is_preview,
        bitrate: body.bit_rate,
        target,
    };
    let key = request.key();
    let cached = loudness
        .cached_measurement(&identity, access.tag(), f64::from(target))
        .await;
    match service.artifact(&key).await {
        Ok(Some(artifact)) => {
            return Ok(Json(ready_payload(&key, &artifact, cached)).into_response());
        }
        Ok(None) => {}
        Err(_) => return Ok(super::music::stream_database_unavailable()),
    }
    if body.background && service.is_processing(&key) {
        return Ok(Json(measured_payload("processing", cached)).into_response());
    }
    if preferred.is_none()
        && body.bit_rate.is_none()
        && access == PreparedAccess::Library
        && cached.is_none()
        && let PreparationInput::Library(candidate) = &input
        && let Ok(Ok(Some(track))) = tokio::time::timeout(
            Duration::from_secs(2),
            candidate
                .provider
                .provider
                .get_track(&candidate.source.provider_item_id),
        )
        .await
        && let Some(inline) = track.loudness
        && inline.integrated_lufs.is_finite()
        && inline.true_peak_db.is_finite()
    {
        return Ok(Json(measured_payload(
            "measured",
            Some(crate::audio::LoudnessMetadata {
                integrated_lufs: inline.integrated_lufs,
                true_peak_db: inline.true_peak_db,
                gain_db: measured_playback_gain(
                    inline.integrated_lufs,
                    inline.true_peak_db,
                    f64::from(target),
                ),
            }),
        ))
        .into_response());
    }
    let track = body.track_id;
    let Some(mut job) = service.start(request, permit.clone(), move || input.load(state, track))
    else {
        return Ok(Json(measured_payload(
            if cached.is_some() {
                "measured"
            } else {
                "unavailable"
            },
            cached,
        ))
        .into_response());
    };
    if body.background {
        return Ok(Json(measured_payload("processing", cached)).into_response());
    }
    let _ = job.wait_for(|done| *done).await;
    if permit
        .as_ref()
        .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
    {
        return Err(ServerError::Forbidden(
            "External playback is disabled".into(),
        ));
    }
    let cached = loudness
        .cached_measurement(&identity, access.tag(), f64::from(target))
        .await;
    Ok(match service.artifact(&key).await {
        Ok(Some(artifact)) => Json(ready_payload(&key, &artifact, cached)).into_response(),
        Ok(None) => Json(measured_payload(
            if cached.is_some() {
                "measured"
            } else {
                "unavailable"
            },
            cached,
        ))
        .into_response(),
        Err(_) => super::music::stream_database_unavailable(),
    })
}

async fn get_silence_scan_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Result<Response, ServerError> {
    let scan = state.silence_scan().ok_or_else(silence_unavailable)?
        .status(&auth.user.id, auth.user.is_admin()).await?;
    Ok(Json(json!({ "scan": scan })).into_response())
}

async fn post_silence_scan_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    ApiJson(body): ApiJson<SilenceScanRequestBody>,
) -> Result<Response, ServerError> {
    let params = SilenceParameters::validate(body.threshold_db, body.min_silence_seconds)
        .map_err(ServerError::BadRequest)?;
    let scan = state.silence_scan().ok_or_else(silence_unavailable)?
        .start(&auth.user.id, auth.user.is_admin(), Some(params)).await?;
    Ok((StatusCode::ACCEPTED, Json(json!({ "scan": scan }))).into_response())
}

async fn get_track_silence_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Path(track_id): Path<String>,
    Query(query): Query<SilenceScanRequestBody>,
) -> Result<Response, ServerError> {
    let params = if query.threshold_db.is_some() || query.min_silence_seconds.is_some() {
        Some(SilenceParameters::validate(query.threshold_db, query.min_silence_seconds)
            .map_err(ServerError::BadRequest)?)
    } else {
        None
    };
    let scan = state.silence_scan().ok_or_else(silence_unavailable)?;
    let analysis = scan.silence().ok_or_else(silence_unavailable)?.get_analysis(&track_id, params).await?;
    Ok(Json(json!({ "analysis": analysis })).into_response())
}

async fn post_track_silence_analyze_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Path(track_id): Path<String>,
    ApiJson(body): ApiJson<SilenceScanRequestBody>,
) -> Result<Response, ServerError> {
    let params = SilenceParameters::validate(body.threshold_db, body.min_silence_seconds)
        .map_err(ServerError::BadRequest)?;
    let scan = state.silence_scan().ok_or_else(silence_unavailable)?;
    let wait = Duration::from_secs(if body.force { 30 } else { 2 });
    let (analysis, _) = scan.silence().ok_or_else(silence_unavailable)?.analyze_track(
        &scan.resolver(), &track_id, params, body.force, wait,
    ).await?;
    Ok(Json(json!({ "analysis": analysis })).into_response())
}

async fn get_playback_normalized_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(key): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ServerError> {
    let Some(service) = state.prepared_audio() else {
        return Ok(super::music::stream_database_unavailable());
    };
    let artifact = match service.artifact(&key).await {
        Ok(Some(artifact)) => artifact,
        Ok(None) => return Err(ServerError::NotFound("Prepared playback expired".into())),
        Err(_) => return Ok(super::music::stream_database_unavailable()),
    };
    let permit = match playback_permit(&state, &auth, artifact.access) {
        Ok(permit) => permit,
        Err(response) => return Ok(response),
    };
    // Prepared keys are immutable representation identifiers. Without a matching
    // If-Range validator, send the complete file.
    let etag = format!("\"{key}\"");
    let range = request_header(&headers, header::RANGE).filter(|_| {
        request_header(&headers, header::IF_RANGE).is_none_or(|validator| validator == etag)
    });
    let mut response = serve_file_with_range(&artifact.path, artifact.content_type, range).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    if let Ok(etag) = HeaderValue::from_str(&etag) {
        response.headers_mut().insert(header::ETAG, etag);
    }
    if let Some(permit) = permit {
        let (parts, body) = response.into_parts();
        let guarded = bounded_media_body(
            Box::pin(body.into_data_stream()),
            u64::MAX,
            None,
            Some(permit),
            crate::providers::MEDIA_BODY_IDLE_TIMEOUT,
        );
        return Ok(Response::from_parts(
            parts,
            axum::body::Body::from_stream(guarded),
        ));
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn normalization_post_returns_cached_gain_or_processing_without_gating_raw_audio() {
        let db = crate::db::DbPool::connect_memory().await.unwrap();
        crate::db::run_migrations(&db, None).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO roles (name, description) VALUES ('user','Listener');
             INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
             VALUES ('listener','listener','unused','Listener','user','now','now');",
        ).execute(db.inner()).await.unwrap();
        let library = LibraryService::new(db.clone(), None);
        let track = library
            .ensure_id(
                crate::catalog::LibraryItemType::Track,
                &crate::catalog::SourceRef {
                    connection_id: "fixture".into(),
                    provider_item_id: "track".into(),
                },
                None,
            )
            .await
            .unwrap();
        let revision = library.get_content_revision(&track).await.unwrap();
        let identity = playback_identity(&track, revision.as_deref(), None, None, None);
        let measurement = json!({
            "input_i":"-23", "input_tp":"-2", "input_lra":"4", "input_thresh":"-29",
            "target_offset":"0", "output_i":"-16", "output_tp":"-2",
        });
        sqlx::query("INSERT INTO playback_loudness_measurements (cache_key, measurement_json, expires_at) VALUES (?, ?, ?)")
            .bind(crate::audio::loudness_measurement_key(&identity, "false"))
            .bind(measurement.to_string())
            .bind(chrono::Utc::now().timestamp_millis() + 60_000)
            .execute(db.inner())
            .await
            .unwrap();
        let state = AppState::with_database(crate::config::AppConfig::default(), db)
            .await
            .unwrap();
        state
            .providers()
            .replace_all(vec![crate::providers::media_fixture::provider(
                "fixture",
                |_, _, _, bitrate| {
                    // Prepared audio fetches the original. A separate live request can open immediately.
                    let delay = if bitrate.is_none() {
                        Duration::from_secs(30)
                    } else {
                        Duration::ZERO
                    };
                    (
                        delay,
                        crate::providers::media_fixture::response(
                            StatusCode::OK,
                            [
                                (header::CONTENT_TYPE, "audio/flac"),
                                (header::CONTENT_LENGTH, "4"),
                            ],
                            "abcd",
                        ),
                    )
                },
            )]);
        let session = state
            .session_store()
            .unwrap()
            .create_session("listener", true)
            .await
            .unwrap()
            .id;
        let app = audio_playback_routes()
            .merge(super::super::music::music_routes())
            .with_state(state);
        let post = |payload: Value| {
            app.clone().oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/playback/normalize")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::COOKIE, format!("musicdeck_session={session}"))
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
        };
        let measured = post(json!({ "trackId": track, "background": true }))
            .await
            .unwrap();
        let measured: Value =
            serde_json::from_slice(&measured.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(measured["status"], "measured");
        assert_eq!(measured["gainDb"], 1.0);
        let processing = post(json!({ "trackId": track, "source": "fixture", "background": true }))
            .await
            .unwrap();
        let processing: Value =
            serde_json::from_slice(&processing.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(processing["status"], "processing");
        let raw = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/tracks/{track}/stream?maxBitRate=128"))
                    .header(header::COOKIE, format!("musicdeck_session={session}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(raw.status(), StatusCode::OK);
        assert_eq!(
            raw.into_body().collect().await.unwrap().to_bytes().as_ref(),
            b"abcd"
        );
    }

    async fn get(
        state: &AppState,
        token: &str,
        key: &str,
        range: Option<&str>,
        if_range: Option<&str>,
    ) -> Response {
        let mut request = Request::builder()
            .uri(format!("/api/playback/normalized/{key}"))
            .header(header::COOKIE, format!("musicdeck_session={token}"));
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        if let Some(if_range) = if_range {
            request = request.header(header::IF_RANGE, if_range);
        }
        audio_playback_routes()
            .with_state(state.clone())
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn prepared_playback_checks_permissions_ranges_and_content_revision() {
        let temp = tempfile::tempdir().unwrap();
        let db = crate::db::DbPool::connect(&temp.path().join("musicdeck.sqlite"))
            .await
            .unwrap();
        crate::db::run_migrations(&db, None).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO roles (name, description) VALUES ('user','Listener');
             INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at, external_playback_enabled)
             VALUES ('local','local','unused','Local','user','now','now',0),
                    ('external','external','unused','External','user','now','now',1);
             INSERT INTO library_items (id,type,created_at,updated_at,content_revision)
             VALUES ('track','track','now','now','version-a');",
        ).execute(db.inner()).await.unwrap();
        let folder = temp.path().join("playback-cache");
        tokio::fs::create_dir(&folder).await.unwrap();
        let library = "a".repeat(64);
        let external = "b".repeat(64);
        let preview = "c".repeat(64);
        for (key, mode, track, revision) in [
            (&library, 0, Some("track"), Some("version-a")),
            (&external, 1, None, None),
            (&preview, 2, None, None),
        ] {
            tokio::fs::write(folder.join(format!("{key}.flac")), b"abcdef")
                .await
                .unwrap();
            sqlx::query("INSERT INTO playback_loudness_cache
                (cache_key,external,format,integrated_lufs,true_peak_db,bytes,expires_at,accessed_at,track_id,content_revision)
                VALUES (?, ?, 'flac', -16, -2, 6, ?, 0, ?, ?)")
                .bind(key).bind(mode).bind(chrono::Utc::now().timestamp_millis() + 60_000)
                .bind(track).bind(revision).execute(db.inner()).await.unwrap();
        }
        let mut config = crate::config::AppConfig::default();
        config.network.local_only_mode = false;
        let state = AppState::with_database(config, db.clone()).await.unwrap();
        let store = state.session_store().unwrap();
        let local_token = store.create_session("local", true).await.unwrap().id;
        let external_token = store.create_session("external", true).await.unwrap().id;
        let partial = get(&state, &local_token, &library, Some("bytes=2-3"), None).await;
        assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(partial.headers()[header::CONTENT_RANGE], "bytes 2-3/6");
        assert_eq!(
            partial.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        assert_eq!(
            partial
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .as_ref(),
            b"cd"
        );
        assert_eq!(
            get(&state, &local_token, &library, Some("bytes=20-"), None)
                .await
                .status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
        let replacement = get(
            &state,
            &local_token,
            &library,
            Some("bytes=2-3"),
            Some("\"stale\""),
        )
        .await;
        assert_eq!(replacement.status(), StatusCode::OK);
        assert_eq!(
            replacement
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .as_ref(),
            b"abcdef"
        );
        assert_eq!(
            get(&state, &local_token, &external, None, None)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            get(&state, &external_token, &external, None, None)
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            get(&state, &local_token, &preview, None, None)
                .await
                .status(),
            StatusCode::OK
        );
        state
            .privacy()
            .update(crate::services::privacy::PrivacySettings {
                local_only: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            get(&state, &external_token, &external, None, None)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            get(&state, &local_token, &preview, None, None)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        sqlx::query("UPDATE library_items SET content_revision='version-b' WHERE id='track'")
            .execute(db.inner())
            .await
            .unwrap();
        assert_eq!(
            get(&state, &local_token, &library, None, None)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );

        sqlx::query("DROP TABLE playback_loudness_cache")
            .execute(db.inner())
            .await
            .unwrap();
        let unavailable = get(&state, &local_token, &library, None, None).await;
        assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(unavailable.headers()[header::RETRY_AFTER], "1");
    }
}
