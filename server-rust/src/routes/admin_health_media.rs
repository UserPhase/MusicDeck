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
) -> Result<Response, ServerError> {
    let recent_jobs = state.acquisitions().list_jobs(&admin.user.id, true).await;
    let active_jobs = recent_jobs.iter().filter(|j| j.status.is_active()).count();
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

    let config = state.config();
    let staging_root = canonical_staging_root(
        Path::new(&config.acquisition_tmp_dir),
        Path::new(&config.music_root),
    )
    .await?;
    let bytes = if let Some(root) = staging_root {
        staging_usage(&root, false).await.map_err(staging_error)?.1
    } else {
        0
    };

    Ok((
        StatusCode::OK,
        Json(json!({
            "activeJobs": active_jobs,
            "queuedJobs": queued_jobs,
            "completedJobs": completed_jobs,
            "failedJobs": failed_jobs,
            "totalJobs": recent_jobs.len(),
            "storageUsedBytes": bytes,
            "tempStorageUsedBytes": bytes,
            "musicRoot": state.config().music_root,
            "downloadDirectory": config.acquisition_tmp_dir,
            "maxConcurrentDownloads": 1,
            "autoScanLibrary": true,
            "cleanupPolicy": "on_completion",
            "recentJobs": recent_jobs,
        })),
    )
        .into_response())
}

async fn post_admin_acquisitions_cleanup_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Result<Json<Value>, ServerError> {
    let config = state.config();
    let Some(root) = canonical_staging_root(
        Path::new(&config.acquisition_tmp_dir),
        Path::new(&config.music_root),
    )
    .await?
    else {
        return Ok(Json(json!({ "filesRemoved": 0, "bytesFreed": 0 })));
    };
    let db = state.db().ok_or_else(|| {
        ServerError::ServiceUnavailable("Acquisition storage is unavailable".into())
    })?;
    // Completed jobs are immutable. Failed, partial and cancelled attempts can
    // still have inputs needed for a retry, including stages from older attempts.
    let completed: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM acquisition_jobs WHERE status='completed'
           AND NOT EXISTS (SELECT 1 FROM background_tasks
                WHERE id=acquisition_jobs.active_task_id AND state IN ('QUEUED','PROCESSING','PAUSED'))
         UNION ALL
         SELECT id FROM import_jobs WHERE status='COMPLETED'
           AND NOT EXISTS (SELECT 1 FROM background_tasks
                WHERE type='SPOTDL_IMPORT' AND state IN ('QUEUED','PROCESSING','PAUSED')
                  AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json END, '$.jobId')=import_jobs.id)",
    )
    .fetch_all(db.inner()).await.map_err(|err| {
        tracing::warn!(error = %err, "Could not verify eligibility for staging cleanup");
        ServerError::ServiceUnavailable("Acquisition storage is unavailable".into())
    })?;
    let (files, bytes) = cleanup_staging_usage(&root, &completed.into_iter().collect())
        .await
        .map_err(staging_error)?;
    Ok(Json(json!({ "filesRemoved": files, "bytesFreed": bytes })))
}

fn staging_error(err: std::io::Error) -> ServerError {
    tracing::warn!(error = %err, "Could not access acquisition staging");
    ServerError::ServiceUnavailable("Acquisition staging is unavailable".into())
}

async fn canonical_staging_root(
    staging: &Path,
    music: &Path,
) -> Result<Option<PathBuf>, ServerError> {
    let root = match tokio::fs::canonicalize(staging).await {
        Ok(root) => root,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(staging_error(err)),
    };
    match tokio::fs::canonicalize(music).await {
        Ok(music) if music.starts_with(&root) => {
            return Err(ServerError::ServiceUnavailable(
                "The staging directory overlaps the music library".into(),
            ));
        }
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(staging_error(err)),
    }
    if root.parent().is_none() {
        return Err(ServerError::ServiceUnavailable(
            "The staging directory must be a dedicated directory".into(),
        ));
    }
    Ok(Some(root))
}

fn staging_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    metadata.is_symlink()
}

async fn cleanup_staging_usage(
    root: &Path,
    completed: &HashSet<String>,
) -> std::io::Result<(u64, u64)> {
    let mut entries = tokio::fs::read_dir(root).await?;
    let (mut files, mut bytes) = (0_u64, 0_u64);
    while let Some(entry) = entries.next_entry().await? {
        let basename = entry.file_name();
        let Some(name) = basename.to_str() else {
            continue;
        };
        let job = if name.starts_with("spimp_") {
            name
        } else if name.starts_with("acq_") {
            let Some((job, task)) = name.rsplit_once("-task_") else {
                continue;
            };
            if task.len() != 16 {
                continue;
            }
            job
        } else {
            continue;
        };
        if !completed.contains(job) {
            continue;
        }
        let path = entry.path();
        let metadata = match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err),
        };
        if metadata.is_dir() && !staging_link(&metadata) {
            let (removed, reclaimed) = staging_usage(&path, true).await?;
            files = files.saturating_add(removed);
            bytes = bytes.saturating_add(reclaimed);
        }
    }
    Ok((files, bytes))
}

async fn staging_usage(root: &Path, remove: bool) -> std::io::Result<(u64, u64)> {
    let mut pending = vec![root.to_path_buf()];
    let mut dirs = Vec::new();
    let (mut files, mut bytes) = (0_u64, 0_u64);
    while let Some(path) = pending.pop() {
        match tokio::fs::canonicalize(&path).await {
            Ok(canonical) if canonical == path => {}
            Ok(_) => continue,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err),
        }
        let children = tokio::fs::read_dir(&path).await;
        let mut children = match children {
            Ok(children) => children,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err),
        };
        if remove {
            dirs.push(path);
        }
        while let Some(entry) = children.next_entry().await? {
            let path = entry.path();
            let metadata = match tokio::fs::symlink_metadata(&path).await {
                Ok(metadata) => metadata,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                Err(err) => return Err(err),
            };
            if staging_link(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                if remove {
                    match tokio::fs::remove_file(&path).await {
                        Ok(()) => {}
                        Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(err) => {
                            tracing::warn!(error = %err, "Could not remove a completed staging file");
                            continue;
                        }
                    }
                    files = files.saturating_add(1);
                }
                bytes = bytes.saturating_add(metadata.len());
            }
        }
    }
    for path in dirs.into_iter().rev() {
        // Any retained symlink or concurrent file leaves its parent in place.
        let _ = tokio::fs::remove_dir(path).await;
    }
    Ok((files, bytes))
}

async fn post_admin_acquisitions_scan_handler(State(state): State<AppState>, _admin: RequireAdmin) -> Result<Response, ServerError> {
    let backend = state.providers().get_primary().map_err(|err| ServerError::ServiceUnavailable(err.to_string()))?;
    let scan = backend.provider.scan_library().await.map_err(|err| ServerError::BadGateway(err.to_string()))?;
    Ok(Json(json!({ "scanned": !scan.scanning, "count": scan.count })).into_response())
}

async fn get_downloader_diagnostics_handler(State(state): State<AppState>, _admin: RequireAdmin) -> Result<Response, ServerError> {
    let adapter = SpotDLDownloaderAdapter::new().with_saved_settings(state.db()).await;
    adapter.tool_paths().map_err(|err| ServerError::ServiceUnavailable(err.to_owned()))?;
    let diag = adapter.detect_binaries().await;
    let downloaders: Vec<Value> = vec![json!({
        "id": "spotdl",
        "name": "spotDL Downloader",
        "diagnostics": diag,
    })];
    Ok(Json(json!({ "downloaders": downloaders })).into_response())
}

#[cfg(test)]
mod staging_tests {
    use super::*;

    #[tokio::test]
    async fn staging_counts_and_cleanup_keep_active_inputs_and_skip_links() {
        let staging = tempfile::tempdir().unwrap();
        let music = tempfile::tempdir().unwrap();
        let root = canonical_staging_root(staging.path(), music.path())
            .await
            .unwrap()
            .unwrap();
        for (name, bytes) in [
            ("spimp_finished", 20),
            ("spimp_active", 31),
            ("acq_failed-task_0123456789abcdef", 43),
            ("ordinary-folder", 59),
        ] {
            let nested = root.join(name).join("nested");
            tokio::fs::create_dir_all(&nested).await.unwrap();
            tokio::fs::write(nested.join("audio.flac"), vec![0; bytes])
                .await
                .unwrap();
        }
        let outside_file = music.path().join("original.flac");
        tokio::fs::write(&outside_file, [1, 2, 3]).await.unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(music.path(), root.join("spimp_finished").join("outside"))
            .unwrap();

        assert_eq!(staging_usage(&root, false).await.unwrap().1, 153);
        let completed = HashSet::from(["spimp_finished".to_owned(), "ordinary-folder".to_owned()]);
        assert_eq!(
            cleanup_staging_usage(&root, &completed).await.unwrap(),
            (1, 20)
        );
        assert_eq!(
            cleanup_staging_usage(&root, &completed).await.unwrap(),
            (0, 0)
        );
        assert_eq!(staging_usage(&root, false).await.unwrap().1, 133);
        assert_eq!(tokio::fs::read(outside_file).await.unwrap(), [1, 2, 3]);
        assert!(
            canonical_staging_root(music.path(), music.path())
                .await
                .is_err()
        );
    }
}
