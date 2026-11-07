//! # Admin Health, Library Health Scan, System Health Wizard & Media Deletion Routes (`routes::admin_health_media`)
//!
//! Ports:
//! - `GET /api/admin/health` (`server/src/routes/admin-routes.ts`)
//! - `GET /api/admin/backend-connections`
//! - `GET /api/admin/acquisitions`
//! - `POST /api/admin/acquisitions/cleanup`
//! - `POST /api/admin/acquisitions/scan`
//! - `GET /api/admin/downloader/diagnostics`
//! - `GET /api/admin/library/health/scan` (`server/src/routes/admin/health.ts`)
//! - `POST /api/admin/library/health/scan`
//! - `POST /api/admin/library/health/repair/artwork`
//! - `POST /api/admin/library/health/repair/prune-orphans`
//! - `GET /api/admin/diagnostics/wizard` & `POST /api/admin/diagnostics/wizard` (`SystemHealthWizard.ts`)
//! - `DELETE /api/v1/admin/tracks/:track_id` (`server/src/routes/admin-media-routes.ts`)
//! - `DELETE /api/v1/admin/albums/:album_id`

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use axum::Router;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{delete, get, post};
use serde_json::{Value, json};
use sqlx::Row;

use crate::AppState;
use crate::acquisition::SpotDLDownloaderAdapter;
use crate::admin::{
    LibraryHealthScanBusy, LibraryHealthScanState, MediaPathError, SystemHealthWizard,
    remove_album_directory_if_safe, remove_empty_parents, verified_audio_path,
};
use crate::auth::RequireAdmin;
use crate::catalog::CatalogService;
use crate::error::ServerError;

fn media_path_error_response(err: MediaPathError) -> Response {
    let status = StatusCode::from_u16(err.status).unwrap_or(StatusCode::BAD_REQUEST);
    (
        status,
        Json(json!({
            "error": {
                "code": "MEDIA_PATH_ERROR",
                "message": err.message,
            }
        })),
    )
        .into_response()
}

/// Builds the router for `/api/admin/*` and `/api/v1/admin/{tracks,albums}/*`.
pub fn admin_health_and_media_routes() -> Router<AppState> {
    Router::new()
        .route("/api/admin/health", get(get_admin_health_handler))
        .route(
            "/api/admin/backend-connections",
            get(get_backend_connections_handler),
        )
        .route(
            "/api/admin/library/health/scan",
            get(get_library_health_scan_handler).post(post_library_health_scan_handler),
        )
        .route(
            "/api/admin/library/health/repair/artwork",
            post(post_library_repair_artwork_handler),
        )
        .route(
            "/api/admin/library/health/repair/prune-orphans",
            post(post_library_prune_orphans_handler),
        )
        .route(
            "/api/admin/diagnostics/wizard",
            get(run_system_health_wizard_handler).post(run_system_health_wizard_handler),
        )
        .route(
            "/api/v1/admin/tracks/:track_id",
            delete(delete_admin_track_handler),
        )
        .route(
            "/api/v1/admin/albums/:album_id",
            delete(delete_admin_album_handler),
        )
        .route(
            "/api/admin/acquisitions",
            get(get_admin_acquisitions_summary_handler),
        )
        .route(
            "/api/admin/acquisitions/cleanup",
            post(post_admin_acquisitions_cleanup_handler),
        )
        .route(
            "/api/admin/acquisitions/scan",
            post(post_admin_acquisitions_scan_handler),
        )
        .route(
            "/api/admin/downloader/diagnostics",
            get(get_downloader_diagnostics_handler),
        )
}

async fn get_admin_health_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    let mut users_count = 0_i64;
    let mut sessions_count = 0_i64;
    let mut connections_count = 0_i64;

    if let Some(pool) = state.db() {
        users_count = sqlx::query("SELECT COUNT(*) AS count FROM users")
            .fetch_optional(pool.inner())
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get("count").ok())
            .unwrap_or(0);
        sessions_count = sqlx::query("SELECT COUNT(*) AS count FROM sessions")
            .fetch_optional(pool.inner())
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get("count").ok())
            .unwrap_or(0);
        connections_count = sqlx::query("SELECT COUNT(*) AS count FROM backend_connections")
            .fetch_optional(pool.inner())
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get("count").ok())
            .unwrap_or(0);
    }

    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "service": "musicdeck-server",
            "backend": state.config().backend,
            "database": "sqlite",
            "counts": {
                "users": users_count,
                "sessions": sessions_count,
                "backendConnections": connections_count,
            }
        })),
    )
        .into_response()
}

async fn get_backend_connections_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    let mut connections = Vec::new();
    if let Some(pool) = state.db() {
        let rows = sqlx::query(
            "SELECT id, type, name, enabled, created_at, updated_at FROM backend_connections ORDER BY created_at ASC",
        )
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        for r in rows {
            connections.push(json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "type": r.try_get::<String, _>("type").unwrap_or_default(),
                "name": r.try_get::<String, _>("name").unwrap_or_default(),
                "enabled": r.try_get::<i64, _>("enabled").unwrap_or(0),
                "created_at": r.try_get::<String, _>("created_at").unwrap_or_default(),
                "updated_at": r.try_get::<String, _>("updated_at").unwrap_or_default(),
            }));
        }
    }

    (
        StatusCode::OK,
        Json(json!({ "backendConnections": connections })),
    )
        .into_response()
}

async fn get_library_health_scan_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    let status = state.library_health_scan().status();
    (StatusCode::OK, Json(json!({ "status": status }))).into_response()
}

async fn post_library_health_scan_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    let (started, status) = state.library_health_scan().start();
    (
        StatusCode::ACCEPTED,
        Json(json!({
            "started": started,
            "alreadyRunning": !started,
            "status": status,
        })),
    )
        .into_response()
}

async fn post_library_repair_artwork_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    let (started, status) = state.library_health_scan().request_artwork_rescan();
    (
        StatusCode::ACCEPTED,
        Json(json!({
            "started": started,
            "alreadyRunning": !started,
            "status": status,
        })),
    )
        .into_response()
}

async fn post_library_prune_orphans_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    let current = state.library_health_scan().status();
    if current.state == LibraryHealthScanState::Running {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": {
                    "code": "HEALTH_SCAN_RUNNING",
                    "message": LibraryHealthScanBusy.to_string(),
                }
            })),
        )
            .into_response();
    }

    let Some(ref report) = current.report else {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": {
                    "code": "HEALTH_REPORT_REQUIRED",
                    "message": "Run a health check before pruning orphaned tracks.",
                }
            })),
        )
            .into_response();
    };

    if report.summary.orphaned_tracks == 0 {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": {
                    "code": "NOTHING_TO_PRUNE",
                    "message": "The latest health check found no orphaned tracks to prune.",
                }
            })),
        )
            .into_response();
    }

    match state.library_health_scan().start_prune() {
        Ok(status) => (
            StatusCode::ACCEPTED,
            Json(json!({
                "started": true,
                "status": status,
            })),
        )
            .into_response(),
        Err(busy) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": {
                    "code": "HEALTH_SCAN_RUNNING",
                    "message": busy.to_string(),
                }
            })),
        )
            .into_response(),
    }
}

async fn run_system_health_wizard_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Response {
    let wizard = SystemHealthWizard::new(state.db().cloned(), state.shared_config());
    let report = wizard.run().await;
    (StatusCode::OK, Json(report)).into_response()
}

async fn delete_admin_track_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    AxumPath(track_id): AxumPath<String>,
) -> Result<Response, ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
    if catalog.get_track(&track_id).await.is_none() {
        return Err(ServerError::NotFound(String::from("Track not found")));
    }

    let Some(source) = catalog.resolve_track_file(&track_id, None).await else {
        return Err(ServerError::Conflict(String::from(
            "The media provider did not report a real file path. In Navidrome, enable Report Real Path for the MusicDeck File Management player in Settings > Players.",
        )));
    };
    let Some(rel_path) = source.file_path.as_deref().filter(|s| !s.is_empty()) else {
        return Err(ServerError::Conflict(String::from(
            "The media provider did not report a real file path. In Navidrome, enable Report Real Path for the MusicDeck File Management player in Settings > Players.",
        )));
    };

    let cfg = state.config();
    let music_root = Path::new(&cfg.music_root);
    let file_path = match verified_audio_path(rel_path, music_root).await {
        Ok(p) => p,
        Err(err) => return Ok(media_path_error_response(err)),
    };

    tokio::fs::remove_file(&file_path)
        .await
        .map_err(|e| ServerError::Internal(e.to_string()))?;
    remove_empty_parents(&file_path, music_root).await;

    let warning = if catalog
        .request_library_rescan(&source.connection_id)
        .await
        .is_err()
    {
        Some("File deleted, but the library rescan could not be started")
    } else {
        None
    };

    let mut payload = json!({
        "success": true,
        "message": "Track deleted from disk",
        "trackId": track_id,
    });
    if let Some(w) = warning {
        payload["warning"] = json!(w);
    }

    Ok((StatusCode::OK, Json(payload)).into_response())
}

async fn delete_admin_album_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    AxumPath(album_id): AxumPath<String>,
) -> Result<Response, ServerError> {
    let Some(pool) = state.db() else {
        return Err(ServerError::ServiceUnavailable(String::from(
            "Database is unavailable",
        )));
    };
    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
    if catalog.get_album(&album_id).await.is_none() {
        return Err(ServerError::NotFound(String::from("Album not found")));
    }

    let Some(connection_id) = catalog.get_source_connection_id(&album_id).await else {
        return Err(ServerError::Conflict(String::from(
            "The album's library source is unavailable",
        )));
    };

    let tracks = catalog.get_album_tracks(&album_id, false).await;
    if tracks.is_empty() {
        return Err(ServerError::Conflict(String::from(
            "Album has no server tracks to delete",
        )));
    }

    let cfg = state.config();
    let music_root = Path::new(&cfg.music_root);
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut seen = HashSet::new();

    for track in &tracks {
        let Some(source) = catalog
            .resolve_track_file(&track.item.id, Some(&connection_id))
            .await
        else {
            return Err(ServerError::Conflict(String::from(
                "The media provider did not report a real file path for an album track. In Navidrome, enable Report Real Path for the MusicDeck File Management player in Settings > Players.",
            )));
        };
        let Some(rel_path) = source.file_path.as_deref().filter(|s| !s.is_empty()) else {
            return Err(ServerError::Conflict(String::from(
                "The media provider did not report a real file path for an album track. In Navidrome, enable Report Real Path for the MusicDeck File Management player in Settings > Players.",
            )));
        };
        let verified = match verified_audio_path(rel_path, music_root).await {
            Ok(p) => p,
            Err(err) => return Ok(media_path_error_response(err)),
        };
        if seen.insert(verified.clone()) {
            paths.push(verified);
        }
    }

    let mut deleted = 0_usize;
    let mut unlink_err = None;
    for path in &paths {
        match tokio::fs::remove_file(path).await {
            Ok(()) => deleted += 1,
            Err(e) => {
                unlink_err = Some(e);
                break;
            }
        }
    }

    let warning = if deleted > 0
        && catalog
            .request_library_rescan(&connection_id)
            .await
            .is_err()
    {
        Some("File deleted, but the library rescan could not be started")
    } else {
        None
    };

    if let Some(err) = unlink_err {
        return Err(ServerError::Internal(err.to_string()));
    }

    remove_album_directory_if_safe(&paths, music_root).await;
    for path in &paths {
        remove_empty_parents(path, music_root).await;
    }

    let track_ids: Vec<&str> = tracks.iter().map(|t| t.item.id.as_str()).collect();
    let mut payload = json!({
        "success": true,
        "message": "Album deleted from disk",
        "albumId": album_id,
        "trackIds": track_ids,
    });
    if let Some(w) = warning {
        payload["warning"] = json!(w);
    }

    Ok((StatusCode::OK, Json(payload)).into_response())
}

async fn get_admin_acquisitions_summary_handler(
    State(state): State<AppState>,
    admin: RequireAdmin,
) -> Response {
    let recent_jobs = state
        .acquisitions()
        .list_jobs(&admin.user.id, true)
        .await;
    let active_jobs = recent_jobs
        .iter()
        .filter(|j| j.status.is_active())
        .count();
    let queued_jobs = recent_jobs
        .iter()
        .filter(|j| j.status == crate::acquisition::AcquisitionJobStatus::Queued)
        .count();
    let completed_jobs = recent_jobs
        .iter()
        .filter(|j| j.status == crate::acquisition::AcquisitionJobStatus::Completed)
        .count();
    let failed_jobs = recent_jobs
        .iter()
        .filter(|j| j.status == crate::acquisition::AcquisitionJobStatus::Failed)
        .count();

    (
        StatusCode::OK,
        Json(json!({
            "activeJobs": active_jobs,
            "queuedJobs": queued_jobs,
            "completedJobs": completed_jobs,
            "failedJobs": failed_jobs,
            "totalJobs": recent_jobs.len(),
            "storageUsedBytes": 0,
            "tempStorageUsedBytes": 0,
            "musicRoot": state.config().music_root,
            "downloadDirectory": state.config().music_root,
            "maxConcurrentDownloads": 1,
            "autoScanLibrary": true,
            "cleanupPolicy": "on_completion",
            "recentJobs": recent_jobs,
        })),
    )
        .into_response()
}

async fn post_admin_acquisitions_cleanup_handler(_admin: RequireAdmin) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "filesRemoved": 0, "bytesFreed": 0 })),
    )
        .into_response()
}

async fn post_admin_acquisitions_scan_handler(_admin: RequireAdmin) -> Response {
    (StatusCode::OK, Json(json!({ "scanned": true }))).into_response()
}

async fn get_downloader_diagnostics_handler(_admin: RequireAdmin) -> Response {
    let adapter = SpotDLDownloaderAdapter::new();
    let diag = adapter.detect_binaries().await;
    let downloaders: Vec<Value> = vec![json!({
        "id": "spotdl",
        "name": "spotDL Downloader",
        "diagnostics": diag,
    })];
    (StatusCode::OK, Json(json!({ "downloaders": downloaders }))).into_response()
}
