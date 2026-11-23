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

use crate::error::ApiJson;
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
    AcquisitionCreateOptions, AcquisitionJobError, AcquisitionJobStatus, ImportJob,
    PlaylistImportTimeout, parse_spotify_playlist_url,
};
use crate::auth::AuthenticatedUser;
use crate::error::ServerError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartSpotifyImportBody {
    pub playlist_url: String,
    #[serde(default)]
    pub timeout: PlaylistImportTimeout,
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
        .route(
            "/api/v1/playlists/import-spotify/:job_id/cancel",
            post(cancel_spotify_playlist_import_handler),
        )
}

async fn create_acquisition_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload: Result<ApiJson<AcquisitionCreateOptions>, crate::error::ApiJsonRejection>,
) -> Result<Response, ServerError> {
    if !auth.user.is_admin() && !auth.user.external_playback_enabled {
        return Err(ServerError::Forbidden(String::from(
            "On-demand acquisitions are not enabled for this user",
        )));
    }

    let ApiJson(mut body) = match payload {
        Ok(body) => body,
        Err(rejection) => return Ok(rejection.into_response()),
    };
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
        Err(err) if err.starts_with("CAPACITY:") => Ok(capacity_response(&err)),
        Err(err) if err.starts_with("STORAGE:") => Err(ServerError::Internal(err)),
        Err(err) => Err(ServerError::BadRequest(err)),
    }
}

fn capacity_response(error: &str) -> Response {
    let retry_after = error
        .strip_prefix("CAPACITY:")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(60);
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(&retry_after.to_string()) {
        headers.insert(header::RETRY_AFTER, value);
    }
    (StatusCode::TOO_MANY_REQUESTS, headers, Json(json!({
        "error": { "code": "ACQUISITION_CAPACITY", "message": format!("Downloader capacity temporarily unavailable. Try again in {retry_after} seconds.") }
    }))).into_response()
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
        .cancel_job(&id, &auth.user.id, auth.user.is_admin(), state.tasks())
        .await
        .map_err(|err| ServerError::Internal(err.to_string()))?
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
    if !auth.user.is_admin() && !auth.user.external_playback_enabled {
        return Err(ServerError::Forbidden(
            "On-demand acquisitions are not enabled for this user".into(),
        ));
    }
    match state
        .acquisitions()
        .retry_job(&id, &auth.user.id, auth.user.is_admin(), state.tasks())
        .await
    {
        Ok(job) => Ok((StatusCode::OK, Json(json!({ "ok": true, "job": job }))).into_response()),
        Err(AcquisitionJobError::NotFound) => {
            Err(ServerError::NotFound(String::from("Job not found")))
        }
        Err(AcquisitionJobError::NotRetryable) => Err(ServerError::Conflict(String::from(
            "Only settled failed, cancelled, or partial jobs with a saved download target can be retried",
        ))),
        Err(AcquisitionJobError::Storage(err)) => Err(ServerError::Internal(err)),
        Err(AcquisitionJobError::Capacity(error)) => Ok(capacity_response(&format!(
            "CAPACITY:{}",
            error.retry_after
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

    let combined = tokio_stream::once(Ok::<Event, Infallible>(connected_event)).chain(live_stream);

    Sse::new(combined)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(25)))
        .into_response()
}

async fn start_spotify_playlist_import_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload: Result<ApiJson<StartSpotifyImportBody>, crate::error::ApiJsonRejection>,
) -> Result<Response, ServerError> {
    let ApiJson(body) = match payload {
        Ok(body) => body,
        Err(rejection) => return Ok(rejection.into_response()),
    };
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

    match state
        .spotify_imports()
        .start_with_timeout(
            &body.playlist_url,
            body.timeout,
            &auth.user,
            Some(state.tasks()),
        )
        .await
    {
        Ok(job) => Ok((
            StatusCode::ACCEPTED,
            Json(json!({ "job": public_import_job(job, false) })),
        )
            .into_response()),
        Err(error) if error.starts_with("CAPACITY:") => Ok(capacity_response(&error)),
        Err(error) if error.starts_with("STORAGE:") => Err(ServerError::Internal(error)),
        Err(error) => Err(ServerError::BadRequest(error)),
    }
}

fn public_import_job(mut job: ImportJob, summary: bool) -> serde_json::Value {
    let errors = job.track_issues();
    let code = job.downloader_error_code().map(ToOwned::to_owned);
    if summary {
        job.manifest = None;
    } else {
        for entry in job.manifest.iter_mut().flatten() {
            entry.file_path = None;
            entry.library_path = None;
            entry.error = None;
        }
    }
    let mut value = json!(job);
    if !errors.is_empty() {
        value["trackErrors"] = json!(errors);
    }
    if let Some(code) = code {
        value["errorCode"] = json!(code);
    }
    value
}

async fn get_spotify_playlist_import_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(job_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ServerError> {
    let Some(job) = state.spotify_imports().get(&job_id, &auth.user.id).await else {
        return Err(ServerError::NotFound(String::from("Import job not found")));
    };
    Ok((
        StatusCode::OK,
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(json!({ "job": public_import_job(job, params.get("summary").is_some_and(|value| value == "1")) })),
    )
        .into_response())
}

async fn cancel_spotify_playlist_import_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(job_id): Path<String>,
) -> Result<Response, ServerError> {
    let job = state
        .spotify_imports()
        .cancel(&job_id, &auth.user.id, state.tasks())
        .await
        .map_err(|error| match error {
            crate::tasks::TaskError::NotFound => {
                ServerError::NotFound("Import job not found".into())
            }
            crate::tasks::TaskError::Conflict(message) => ServerError::Conflict(message),
            error => ServerError::Internal(error.to_string()),
        })?;
    Ok(Json(json!({ "job": public_import_job(job, false) })).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use serde_json::Value;
    use tower::ServiceExt;

    use crate::auth::SESSION_COOKIE;
    use crate::config::AppConfig;
    use crate::db::{DbPool, run_migrations};
    use crate::tasks::{TaskDefinition, TaskError, TaskRunContext, TaskType};

    struct FakeDownloader;

    #[tokio::test]
    async fn shared_capacity_and_playlist_cancellation_are_enforced_over_http() {
        let pool = DbPool::connect_memory().await.unwrap();
        run_migrations(&pool, None).await.unwrap();
        sqlx::raw_sql(
            "INSERT OR IGNORE INTO roles VALUES ('admin','Admin');
             INSERT INTO users (id,username,password_hash,display_name,role,created_at,updated_at)
             VALUES ('alice','alice','hash','Alice','admin',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
                    ('bob','bob','hash','Bob','admin',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);",
        )
        .execute(pool.inner())
        .await
        .unwrap();
        let mut config = AppConfig::default();
        config.acquisition_limits.max_pending = 1;
        let state = AppState::with_database_dispatch(config, pool.clone(), false)
            .await
            .unwrap();
        state.tasks().initialize_tables().await;
        let sessions = state.session_store().unwrap();
        let alice = format!(
            "{SESSION_COOKIE}={}",
            sessions.create_session("alice", false).await.unwrap().id
        );
        let bob = format!(
            "{SESSION_COOKIE}={}",
            sessions.create_session("bob", false).await.unwrap().id
        );
        let router = acquisition_routes().with_state(state);
        let send = |path: &str, cookie: &str, body: Value| {
            router.clone().oneshot(
                Request::post(path)
                    .header(header::COOKIE, cookie)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
        };
        let path = "/api/v1/playlists/import-spotify";
        let playlist = json!({"playlistUrl":"https://open.spotify.com/playlist/abc123"});
        let first = send(path, &alice, playlist.clone()).await.unwrap();
        assert_eq!(first.status(), StatusCode::ACCEPTED);
        let first: Value =
            serde_json::from_slice(&to_bytes(first.into_body(), 8192).await.unwrap()).unwrap();
        let id = first["job"]["id"].as_str().unwrap();
        let duplicate = send(path, &alice, playlist).await.unwrap();
        assert_eq!(duplicate.status(), StatusCode::ACCEPTED);
        let duplicate: Value =
            serde_json::from_slice(&to_bytes(duplicate.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(duplicate["job"]["id"], id);

        let track = json!({"spotifyTrackUrl":"https://open.spotify.com/track/abc123"});
        let rejected = send("/api/acquisitions", &alice, track.clone())
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(rejected.headers().contains_key(header::RETRY_AFTER));
        let cancel = format!("{path}/{id}/cancel");
        assert_eq!(
            send(&cancel, &bob, Value::Null).await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        let cancelled = send(&cancel, &alice, Value::Null).await.unwrap();
        assert_eq!(cancelled.status(), StatusCode::OK);
        let cancelled: Value =
            serde_json::from_slice(&to_bytes(cancelled.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(cancelled["job"]["status"], "cancelled");
        let next = send("/api/acquisitions", &alice, track).await.unwrap();
        assert_eq!(next.status(), StatusCode::ACCEPTED);
        let next: Value =
            serde_json::from_slice(&to_bytes(next.into_body(), 8192).await.unwrap()).unwrap();
        let canonical_duplicate = send(
            "/api/acquisitions",
            &alice,
            json!({
                "spotifyTrackUrl": "https://open.spotify.com/track/abc123?si=another"
            }),
        )
        .await
        .unwrap();
        assert_eq!(canonical_duplicate.status(), StatusCode::ACCEPTED);
        let duplicate: Value = serde_json::from_slice(
            &to_bytes(canonical_duplicate.into_body(), 8192)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(duplicate["jobId"], next["jobId"]);
        let other_user = send(
            "/api/acquisitions",
            &bob,
            json!({
                "spotifyTrackUrl": "https://open.spotify.com/track/abc123"
            }),
        )
        .await
        .unwrap();
        assert_eq!(other_user.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[test]
    fn playlist_status_summary_preserves_errors_without_serializing_all_occurrences() {
        let job: ImportJob = serde_json::from_value(json!({
            "id": "summary", "userId": "alice", "status": "partial", "stage": "completed",
            "expectedCount": 2, "manifest": [{
                "position": 2, "status": "FAILED_DOWNLOAD", "errorCode": "no-match",
                "source": {"position": 2, "url": "", "title": "Rare edition", "artist": "Fixture"}
            }]
        }))
        .unwrap();
        let full = public_import_job(job.clone(), false);
        let summary = public_import_job(job, true);
        assert!(full["manifest"].is_array());
        assert!(summary.get("manifest").is_none());
        assert_eq!(summary["expectedCount"], 2);
        assert_eq!(summary["trackErrors"], full["trackErrors"]);
        assert_eq!(summary["trackErrors"][0]["code"], "no-match");
    }

    #[test]
    fn parses_playlist_import_timeout_and_defaults_older_requests_to_auto() {
        let url = "https://open.spotify.com/playlist/abc123";
        let legacy: StartSpotifyImportBody =
            serde_json::from_value(json!({ "playlistUrl": url })).unwrap();
        assert_eq!(legacy.timeout, PlaylistImportTimeout::Auto);
        let manual: StartSpotifyImportBody = serde_json::from_value(json!({
            "playlistUrl": url, "timeout": { "mode": "manual", "minutes": 90 }
        }))
        .unwrap();
        assert_eq!(
            manual.timeout,
            PlaylistImportTimeout::Manual { minutes: 90 }
        );
        for timeout in [
            json!({ "mode": "manual" }),
            json!({ "mode": "manual", "minutes": 1.5 }),
            json!({ "mode": "unexpected" }),
        ] {
            assert!(
                serde_json::from_value::<StartSpotifyImportBody>(
                    json!({ "playlistUrl": url, "timeout": timeout })
                )
                .is_err()
            );
        }
    }

    #[async_trait::async_trait]
    impl TaskDefinition for FakeDownloader {
        fn validate(&self, payload: &Value) -> bool {
            payload["kind"] == "acquisition" && payload["jobId"].is_string()
        }

        async fn run(&self, _: Value, _: TaskRunContext) -> Result<(), TaskError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn track_download_uses_the_signed_in_account() {
        let pool = DbPool::connect_memory().await.unwrap();
        run_migrations(&pool, None).await.unwrap();
        sqlx::raw_sql(
            "INSERT OR IGNORE INTO roles VALUES ('admin', 'Admin');
             INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
             VALUES ('alice', 'alice', 'hash', 'Alice', 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);",
        )
        .execute(pool.inner())
        .await
        .unwrap();
        let config = AppConfig::load_from_iter(std::iter::empty::<(String, String)>()).unwrap();
        let state = AppState::with_database(config, pool).await.unwrap();
        state.tasks().initialize_tables().await;
        state
            .tasks()
            .register(TaskType::SpotdlDownload, Arc::new(FakeDownloader));
        let session = state
            .session_store()
            .unwrap()
            .create_session("alice", false)
            .await
            .unwrap();
        let cookie = format!("{SESSION_COOKIE}={}", session.id);
        let router = acquisition_routes().with_state(state);

        let download = json!({
            "trackId": "external_deezer_track_123",
            "sourceProvider": "spotdl",
            "result": {
                "id": "external_deezer_track_123",
                "type": "track",
                "title": "Fixture Track",
                "artist": "Fixture Artist",
                "provider": "external",
                "source": { "kind": "external", "count": 0 }
            }
        });
        let mut download_with_user = download.clone();
        download_with_user["userId"] = json!("other-user");
        for (body, status) in [
            (download, StatusCode::ACCEPTED),
            (download_with_user, StatusCode::ACCEPTED),
            (json!({ "trackId": 123 }), StatusCode::UNPROCESSABLE_ENTITY),
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::post("/api/acquisitions")
                        .header(header::COOKIE, &cookie)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            let actual_status = response.status();
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            assert_eq!(actual_status, status, "{}", String::from_utf8_lossy(&bytes));
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            if status == StatusCode::ACCEPTED {
                assert_eq!(body["job"]["userId"], "alice");
                assert_eq!(body["job"]["requestedTrackId"], "external_deezer_track_123");
            } else {
                assert_eq!(body["error"]["code"], "INVALID_JSON_DATA");
                assert!(body["error"]["requestId"].as_str().is_some());
            }
        }
    }
}
