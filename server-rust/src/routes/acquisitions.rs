//! # Media Acquisitions & Spotify Playlist Import HTTP/SSE Routes (`routes::acquisitions`)
//!
//! Ports:
//! - `POST /api/acquisitions` (`server/src/routes/music-routes.ts`)
//! - `GET /api/acquisitions`
//! - `GET /api/acquisitions/events` (SSE)
//! - `GET /api/acquisitions/:id`
//! - `POST /api/acquisitions/:id/cancel`
//! - `POST /api/acquisitions/:id/retry`
//! - `POST /api/v1/playlists/import-spotify` (`server/src/routes/playlist-routes.ts`)
//! - `GET /api/v1/playlists/import-spotify/:job_id`

use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::json;
use tokio_stream::StreamExt as _;
use tokio_stream::wrappers::BroadcastStream;

use crate::AppState;
use crate::acquisition::{
    AcquisitionCreateOptions, AcquisitionJobError, AcquisitionJobStatus,
    parse_spotify_playlist_url,
};
use crate::auth::AuthenticatedUser;
use crate::error::ServerError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartSpotifyImportBody {
    pub playlist_url: String,
}

/// Builds the router for `/api/acquisitions/*` and `/api/v1/playlists/import-spotify*`.
pub fn acquisition_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/acquisitions",
            get(list_acquisitions_handler).post(create_acquisition_handler),
        )
        .route(
            "/api/acquisitions/events",
            get(stream_acquisition_events_handler),
        )
        .route("/api/acquisitions/:id", get(get_acquisition_handler))
        .route(
            "/api/acquisitions/:id/cancel",
            post(cancel_acquisition_handler),
        )
        .route(
            "/api/acquisitions/:id/retry",
            post(retry_acquisition_handler),
        )
        .route(
            "/api/v1/playlists/import-spotify",
            post(start_spotify_playlist_import_handler),
        )
        .route(
            "/api/v1/playlists/import-spotify/:job_id",
            get(get_spotify_playlist_import_handler),
        )
}

async fn create_acquisition_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(mut body): Json<AcquisitionCreateOptions>,
) -> Result<Response, ServerError> {
    if !auth.user.is_admin() && !auth.user.external_playback_enabled {
        return Err(ServerError::Forbidden(String::from(
            "On-demand acquisitions are not enabled for this user",
        )));
    }

    body.user_id = auth.user.id.clone();
    match state
        .acquisitions()
        .create_job(body, Some(state.tasks()))
        .await
    {
        Ok(job) => {
            let status = if job.status == AcquisitionJobStatus::Completed {
                StatusCode::OK
            } else {
                StatusCode::ACCEPTED
            };
            Ok((
                status,
                Json(json!({
                    "jobId": job.id,
                    "status": job.status,
                    "job": job,
                })),
            )
                .into_response())
        }
        Err(err) if err.starts_with("CAPACITY:") => {
            let retry_after = err
                .strip_prefix("CAPACITY:")
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(60);
            let mut headers = HeaderMap::new();
            if let Ok(val) = HeaderValue::from_str(&retry_after.to_string()) {
                headers.insert(header::RETRY_AFTER, val);
            }
            Ok((
                StatusCode::TOO_MANY_REQUESTS,
                headers,
                Json(json!({
                    "error": {
                        "code": "ACQUISITION_CAPACITY",
                        "message": "Acquisition capacity temporarily unavailable; retry later"
                    }
                })),
            )
                .into_response())
        }
        Err(err) => Err(ServerError::BadRequest(err)),
    }
}

async fn list_acquisitions_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let include_all =
        auth.user.is_admin() && params.get("scope").map(String::as_str) != Some("mine");
    let jobs = state
        .acquisitions()
        .list_jobs(&auth.user.id, include_all)
        .await;

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    (StatusCode::OK, headers, Json(json!({ "jobs": jobs }))).into_response()
}

async fn get_acquisition_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Response, ServerError> {
    let Some(job) = state
        .acquisitions()
        .get_job(&id, &auth.user.id, auth.user.is_admin())
        .await
    else {
        return Err(ServerError::NotFound(String::from(
            "Acquisition job not found",
        )));
    };
    Ok((StatusCode::OK, Json(json!({ "job": job }))).into_response())
}

async fn cancel_acquisition_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Response, ServerError> {
    if !state
        .acquisitions()
        .cancel_job(&id, &auth.user.id, auth.user.is_admin())
        .await
    {
        return Err(ServerError::BadRequest(String::from(
            "Could not cancel acquisition job",
        )));
    }
    let job = state
        .acquisitions()
        .get_job(&id, &auth.user.id, auth.user.is_admin())
        .await;
    Ok((StatusCode::OK, Json(json!({ "ok": true, "job": job }))).into_response())
}

async fn retry_acquisition_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Response, ServerError> {
    match state
        .acquisitions()
        .retry_job(&id, &auth.user.id, auth.user.is_admin())
        .await
    {
        Ok(job) => Ok((StatusCode::OK, Json(json!({ "ok": true, "job": job }))).into_response()),
        Err(AcquisitionJobError::NotFound) => {
            Err(ServerError::NotFound(String::from("Job not found")))
        }
        Err(AcquisitionJobError::NotRetryable) => Err(ServerError::Conflict(String::from(
            "Only settled failed or cancelled jobs can be retried",
        ))),
    }
}

async fn stream_acquisition_events_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let is_admin = auth.user.is_admin();
    let user_id = auth.user.id.clone();

    let connected_event = Event::default()
        .event("connected")
        .data(json!({ "connected": true }).to_string());

    let rx = state.acquisitions().subscribe();
    let live_stream = BroadcastStream::new(rx).filter_map(move |res| {
        let ev = res.ok()?;
        if !is_admin && ev.job.user_id != user_id {
            return None;
        }
        let sse = Event::default()
            .event(ev.event)
            .data(serde_json::to_string(&ev.job).unwrap_or_else(|_| String::from("{}")));
        Some(Ok::<Event, Infallible>(sse))
    });

    let combined =
        tokio_stream::once(Ok::<Event, Infallible>(connected_event)).chain(live_stream);

    Sse::new(combined)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(25)))
        .into_response()
}

async fn start_spotify_playlist_import_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Json(body): Json<StartSpotifyImportBody>,
) -> Result<Response, ServerError> {
    if !auth.user.is_admin() && !auth.user.external_playback_enabled {
        return Err(ServerError::Forbidden(String::from(
            "Downloads are not enabled for this user",
        )));
    }
    if body.playlist_url.len() > 2048 || parse_spotify_playlist_url(&body.playlist_url).is_none() {
        return Err(ServerError::BadRequest(String::from(
            "Please enter a valid open.spotify.com/playlist URL",
        )));
    }

    let job = state
        .spotify_imports()
        .start(&body.playlist_url, &auth.user, Some(state.tasks()))
        .await
        .map_err(ServerError::BadRequest)?;

    Ok((StatusCode::ACCEPTED, Json(json!({ "job": job }))).into_response())
}

async fn get_spotify_playlist_import_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(job_id): Path<String>,
) -> Result<Response, ServerError> {
    let Some(job) = state.spotify_imports().get(&job_id, &auth.user.id).await else {
        return Err(ServerError::NotFound(String::from("Import job not found")));
    };
    Ok((StatusCode::OK, Json(json!({ "job": job }))).into_response())
}
