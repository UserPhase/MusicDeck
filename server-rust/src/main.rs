//! # MusicDeck Rust Server Binary (`musicdeck-server`)
//!
//! Production entry point for the MusicDeck backend server.
//!
//! ## Lifecycle Stages
//! 1. **Tracing Initialization**: Configures structured logging immediately upon
//!    process entry via [`musicdeck_server::logger::init_tracing`].
//! 2. **Configuration Resolution**: Reads host, port, CORS origin, and database
//!    settings from environment variables (`MUSICDECK_HOST`, `MUSICDECK_PORT`,
//!    `HOST`, `PORT`, `MUSICDECK_BIND_ADDR`) before recovering the database and loading configuration.
//! 3. **Application State & Router Assembly**: Constructs the thread-safe
//!    [`AppState`] and mounts the full [`axum::Router`] middleware hierarchy.
//! 4. **Asynchronous Socket Binding**: Binds a non-blocking [`tokio::net::TcpListener`]
//!    to the configured address (loopback for the native binary and all IPv4
//!    interfaces in Docker by default).
//! 5. **Graceful Shutdown Orchestration**: Serves incoming HTTP/1.1, HTTP/2, SSE, and
//!    WebSocket connections until `SIGINT` (`Ctrl+C`) or `SIGTERM` is received,
//!    draining active in-flight streams cleanly before exiting.

#![forbid(unsafe_code)]

use std::net::SocketAddr;
use std::process::ExitCode;

use musicdeck_server::db::open_database;
use musicdeck_server::providers::create_provider_registry;
use musicdeck_server::{AppConfig, AppState, ServerError, create_router, logger};
use tokio::net::TcpListener;

/// Asynchronous process entry point backed by Tokio's multi-threaded work-stealing scheduler.
#[tokio::main]
async fn main() -> ExitCode {
    logger::init_tracing();

    if let Err(error) = run_server().await {
        tracing::error!(error = %error, "MusicDeck Server terminated with a fatal startup or runtime error");
        return ExitCode::FAILURE;
    }

    tracing::info!("MusicDeck Server shutdown complete");
    ExitCode::SUCCESS
}

/// Executes the primary server lifecycle from configuration parsing through graceful termination.
async fn run_server() -> Result<(), ServerError> {
    let _ = dotenvy::dotenv();
    let deployment = AppConfig::parse_deployment_env(&musicdeck_server::config::ProcessEnv)?;
    if deployment.is_production {
        deployment.validate_core()?;
    }
    if deployment.database.is_persistent() {
        musicdeck_server::recovery::recover_interrupted_restore(deployment.database_path())
            .map_err(|err| ServerError::Internal(format!("Restore recovery failed: {err}")))?;
    }
    let config = musicdeck_server::config::apply_system_configuration(deployment)?
        .with_evaluated_setup_state();
    let bind_addr = config.socket_addr();

    tracing::info!(
        host = %config.host(),
        port = config.port(),
        local_only_mode = config.local_only_mode(),
        setup_required = config.setup_required,
        database_path = %config.database_path(),
        "Initializing MusicDeck Rust server"
    );

    let db = open_database(&config).await?;
    tracing::info!("MusicDeck database is ready");

    let state = AppState::with_database_dispatch(config, db.clone(), false)
        .await
        .map_err(|err| ServerError::Internal(err.to_string()))?;
    if !state.config().setup_required {
        let active_cfg = state.config();
        match create_provider_registry(&db, &active_cfg).await {
            Ok(registry) => state.providers().replace_all(registry.list()),
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    "Could not initialize upstream music provider on startup; continuing in setup/recovery mode"
                );
            }
        }
    }

    recover_background_work(&state).await;

    let listener = TcpListener::bind(bind_addr)
        .await
        .map_err(|source| ServerError::Bind {
            addr: bind_addr,
            source,
        })?;

    let local_addr = listener.local_addr()?;
    state.tasks().enable_dispatch();
    let scrobbles = state.scrobble_queue().clone();
    let tasks = state.tasks().clone();
    let retention = tokio::spawn(
        state
            .acquisitions()
            .clone()
            .run_retention(state.tasks().clone()),
    );
    let router = create_router(state);
    tracing::info!(
        address = %local_addr,
        "MusicDeck Server listening and ready to accept connections"
    );

    let worker = scrobbles.start_worker();
    let tasks_on_signal = tasks.clone();
    let serving = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        tasks_on_signal.close();
    })
    .await;
    tasks.shutdown(std::time::Duration::from_secs(6)).await;
    retention.abort();
    let _ = retention.await;
    scrobbles.close();
    if let Some(worker) = worker {
        worker
            .await
            .map_err(|err| ServerError::Internal(format!("Scrobble worker failed: {err}")))?;
    }
    serving.map_err(ServerError::Io)?;

    Ok(())
}

/// Reconcile persisted job state before starting task dispatch.
async fn recover_background_work(state: &AppState) {
    state.tasks().recover_interrupted_tasks().await;
    if let Err(error) = state.recover_loudness_scan().await {
        tracing::warn!(%error, "Could not resume interrupted loudness scan");
    }
    if let Err(error) = state.recover_silence_scan().await {
        tracing::warn!(%error, "Could not resume interrupted silence scan");
    }
    if let Err(error) = state.acquisitions().recover_interrupted_jobs().await {
        tracing::warn!(%error, "Could not reconcile interrupted acquisition jobs");
    }
    if let Err(error) = state.spotify_imports().recover_interrupted_jobs().await {
        tracing::warn!(%error, "Could not reconcile interrupted Spotify playlist imports");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use musicdeck_server::db::{DbPool, run_migrations};
    use tower::ServiceExt;

    #[tokio::test]
    async fn acquisition_recovery_error_does_not_prevent_playlist_recovery_or_readiness() {
        let db = DbPool::connect_memory().await.unwrap();
        run_migrations(&db, None).await.unwrap();
        let state = AppState::with_database_dispatch(AppConfig::default(), db.clone(), false)
            .await
            .unwrap();
        sqlx::raw_sql(
            "DROP TABLE acquisition_jobs;
             INSERT INTO import_jobs (id, user_id, status, manifest_json, created_at, updated_at)
             VALUES ('broken', 'test-user', 'PROCESSING', 'invalid JSON', '2026-01-01', '2026-01-01');",
        )
        .execute(db.inner())
        .await
        .unwrap();

        recover_background_work(&state).await;

        let status: String =
            sqlx::query_scalar("SELECT status FROM import_jobs WHERE id = 'broken'")
                .fetch_one(db.inner())
                .await
                .unwrap();
        assert_eq!(status, "FAILED");
        let request = Request::get("/api/health").body(Body::empty()).unwrap();
        assert_eq!(
            create_router(state)
                .oneshot(request)
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
}

/// Awaits OS termination signals (`SIGINT` on all platforms and `SIGTERM` on Unix)
/// to trigger a cooperative, zero-dropped-request drain in [`axum::serve`].
///
/// When this future resolves, Axum stops accepting new TCP connections from the
/// listener backlog and waits for in-flight HTTP/SSE/WebSocket handlers to complete.
async fn shutdown_signal() {
    let ctrl_c = async {
        match tokio::signal::ctrl_c().await {
            Ok(()) => tracing::info!("Received SIGINT (Ctrl+C); initiating graceful shutdown"),
            Err(error) => {
                tracing::error!(
                    error = %error,
                    "Failed to install SIGINT (Ctrl+C) signal handler"
                );
            }
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
                tracing::info!("Received SIGTERM; initiating graceful shutdown");
            }
            Err(error) => {
                tracing::error!(
                    error = %error,
                    "Failed to install SIGTERM signal handler; falling back to SIGINT only"
                );
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
