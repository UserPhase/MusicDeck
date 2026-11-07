//! # MusicDeck Rust Server Binary (`musicdeck-server`)
//!
//! Production entry point for the MusicDeck backend server.
//!
//! ## Lifecycle Stages
//! 1. **Tracing Initialization**: Configures structured logging immediately upon
//!    process entry via [`musicdeck_server::logger::init_tracing`].
//! 2. **Configuration Resolution**: Reads host, port, CORS origin, and database
//!    settings from environment variables (`MUSICDECK_HOST`, `MUSICDECK_PORT`,
//!    `HOST`, `PORT`, `MUSICDECK_BIND_ADDR`) via [`ServerConfig::from_env`].
//! 3. **Application State & Router Assembly**: Constructs the thread-safe
//!    [`AppState`] and mounts the full [`axum::Router`] middleware hierarchy.
//! 4. **Asynchronous Socket Binding**: Binds a non-blocking [`tokio::net::TcpListener`]
//!    to the configured interface address (`0.0.0.0:4533` by default).
//! 5. **Graceful Shutdown Orchestration**: Serves incoming HTTP/1.1, HTTP/2, SSE, and
//!    WebSocket connections until `SIGINT` (`Ctrl+C`) or `SIGTERM` is received,
//!    draining active in-flight streams cleanly before exiting.

#![forbid(unsafe_code)]

use std::process::ExitCode;
use std::net::SocketAddr;

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
    let config = AppConfig::load()?;
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

    let state = AppState::with_database(config, db.clone())
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

    state.tasks().recover_interrupted_tasks().await;
    state.acquisitions().recover_interrupted_jobs().await;

    let scrobbles = state.scrobble_queue().clone();
    let router = create_router(state);

    let listener = TcpListener::bind(bind_addr)
        .await
        .map_err(|source| ServerError::Bind {
            addr: bind_addr,
            source,
        })?;

    let local_addr = listener.local_addr()?;
    tracing::info!(
        address = %local_addr,
        "MusicDeck Server listening and ready to accept connections"
    );

    let worker = scrobbles.start_worker();
    let serving = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await;
    scrobbles.close();
    if let Some(worker) = worker {
        worker
            .await
            .map_err(|err| ServerError::Internal(format!("Scrobble worker failed: {err}")))?;
    }
    serving.map_err(ServerError::Io)?;

    Ok(())
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
