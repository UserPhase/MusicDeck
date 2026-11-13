//! # MusicDeck Rust Server Library (`musicdeck_server`)
//!
//! This crate provides the core asynchronous HTTP, SSE, and WebSocket application
//! layer for MusicDeck. By exposing the server wiring as a library target alongside
//! the binary entry point (`src/main.rs`), integration tests and benchmarks can
//! construct isolated [`axum::Router`] instances via [`app`] or [`create_router`]
//! and drive them in-memory using `tower::ServiceExt::oneshot` without binding
//! physical network ports.
//!
//! ## Architectural Constraints
//! - **Zero `unsafe`**: Enforced at the crate boundary via `#![forbid(unsafe_code)]`.
//! - **Lock-Free Read Path on Hot State**: [`AppState`] wraps immutable configuration
//!   and thread-safe service handles inside an [`std::sync::Arc`], making router state
//!   cloning $O(1)$ across concurrent Tokio worker tasks.
//! - **Deterministic Error Envelopes**: All domain and transport errors convert into
//!   MusicDeck's canonical `{ "error": { "code": "...", "message": "..." } }` JSON
//!   structure via [`error::ServerError`].

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::Instant;

use axum::Router;
use axum::middleware::from_fn;
use http::header::{HeaderName, HeaderValue};
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::sensitive_headers::SetSensitiveRequestHeadersLayer;
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;

/// Runtime configuration loading, secret file resolution, CIDR proxy validation,
/// and persistent `config.json` system overrides.
pub mod config;

/// Redacting `tracing` layer, credential scrubbing, and bounded `LogBuffer` ring buffer.
pub mod logger;

/// Tower/Axum middleware layers including HTTP browser security header injection.
pub mod middleware;

/// HTTP route handlers and modular sub-routers (`/api/health`, fallback 404).
pub mod routes;

/// Canonical error types and HTTP JSON error response serialization.
pub mod error {
    use axum::Json;
    use axum::response::{IntoResponse, Response};
    use http::StatusCode;
    use serde::{Deserialize, Serialize};
    use thiserror::Error;

    /// Top-level JSON error envelope matching MusicDeck's TypeScript Fastify contract.
    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    pub struct ApiErrorEnvelope {
        /// Inner structured error payload.
        pub error: ApiErrorBody,
    }

    /// Machine-readable error code and human-readable message.
    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    pub struct ApiErrorBody {
        /// Upper-snake-case error identifier (e.g., `NOT_FOUND`, `UNAUTHORIZED`).
        pub code: String,
        /// Safe, redacted description of the failure suitable for client display.
        pub message: String,
    }

    /// Unified server error enumeration covering startup, routing, and domain failures.
    #[derive(Debug, Error)]
    pub enum ServerError {
        /// Invalid startup environment or runtime configuration.
        #[error("Configuration error: {0}")]
        Configuration(#[from] crate::config::ConfigError),

        /// SQLite initialization, permission, or query error.
        #[error("Database error: {0}")]
        Database(#[from] crate::db::DbError),

        /// Failed to bind or configure the underlying TCP socket.
        #[error("Socket bind failure on {addr}: {source}")]
        Bind {
            /// Target socket address that failed to bind.
            addr: std::net::SocketAddr,
            /// Underlying OS I/O error.
            #[source]
            source: std::io::Error,
        },

        /// Unrecoverable I/O failure during server execution.
        #[error("Server I/O failure: {0}")]
        Io(#[from] std::io::Error),

        /// Client request validation failure (`400 Bad Request`).
        #[error("{0}")]
        BadRequest(String),

        /// Missing or expired session credentials (`401 Unauthorized`).
        #[error("{0}")]
        Unauthorized(String),

        /// Authenticated user lacks required role/permission (`403 Forbidden`).
        #[error("{0}")]
        Forbidden(String),

        /// Requested entity or route does not exist (`404 Not Found`).
        #[error("{0}")]
        NotFound(String),

        /// Resource state conflict (`409 Conflict`).
        #[error("{0}")]
        Conflict(String),

        /// Upstream gateway failure (`502 Bad Gateway`).
        #[error("{0}")]
        BadGateway(String),

        /// Subsystem temporarily unavailable (`503 Service Unavailable`).
        #[error("{0}")]
        ServiceUnavailable(String),

        /// Unexpected internal failure (`500 Internal Server Error`).
        #[error("Internal server error: {0}")]
        Internal(String),
    }

    impl ServerError {
        /// Maps each [`ServerError`] variant to its HTTP [`StatusCode`] and error code.
        #[must_use]
        pub const fn status_and_code(&self) -> (StatusCode, &'static str) {
            match self {
                Self::BadRequest(_) => (StatusCode::BAD_REQUEST, "BAD_REQUEST"),
                Self::Unauthorized(_) => (StatusCode::UNAUTHORIZED, "UNAUTHORIZED"),
                Self::Forbidden(_) => (StatusCode::FORBIDDEN, "FORBIDDEN"),
                Self::NotFound(_) => (StatusCode::NOT_FOUND, "NOT_FOUND"),
                Self::Conflict(_) => (StatusCode::CONFLICT, "CONFLICT"),
                Self::BadGateway(_) => (StatusCode::BAD_GATEWAY, "BAD_GATEWAY"),
                Self::ServiceUnavailable(_) => {
                    (StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE")
                }
                Self::Configuration(_)
                | Self::Database(_)
                | Self::Bind { .. }
                | Self::Io(_)
                | Self::Internal(_) => {
                    (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_SERVER_ERROR")
                }
            }
        }
    }

    impl IntoResponse for ServerError {
        fn into_response(self) -> Response {
            let (status, code) = self.status_and_code();
            let message = match &self {
                Self::Internal(_)
                | Self::Io(_)
                | Self::Bind { .. }
                | Self::Configuration(_)
                | Self::Database(_) => {
                    tracing::error!(error = %self, "Unhandled internal server error");
                    String::from("An unexpected internal server error occurred")
                }
                other => other.to_string(),
            };

            let payload = ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: String::from(code),
                    message,
                },
            };

            (status, Json(payload)).into_response()
        }
    }
}

/// Shared, thread-safe application state injected into Axum handlers.
pub mod state {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Instant;
    use tokio::sync::{
        Mutex as AsyncMutex, OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard,
        RwLock as AsyncRwLock,
    };

    use crate::acquisition::{AcquisitionService, SpotifyPlaylistImportService};
    use crate::admin::LibraryHealthScanService;
    use crate::auth::{LoginRateLimiter, SessionStore};
    use crate::cast::CastGateway;
    use crate::config::AppConfig;
    use crate::db::DbPool;
    use crate::external::{DeezerDiscoveryService, ExternalArtworkTokenStore, LyricsService};
    use crate::inspector::AudioMetadataInspector;
    use crate::logger::{LogBuffer, register_log_secret, server_logs};
    use crate::mixes::SimilarMixEngine;
    use crate::playlists::PartyBroadcastHub;
    use crate::plugins::{ExtensionManager, PluginRegistry};
    use crate::providers::BackendRegistry;
    use crate::recommendations::RecommendationService;
    use crate::registry::{SearchProviderRegistry, SourcePipelineRegistry, SourceProviderRegistry};
    use crate::remote::RemoteControlHub;
    use crate::scrobbling::ScrobbleQueueService;
    use crate::services::privacy::{PrivacyError, PrivacyManager, PrivacySettings};
    use crate::social::ArtistFollowService;
    use crate::sonic::SonicRecommendationService;
    use crate::tasks::{
        LibraryScanRunner, NewReleaseScannerRunner, ScannerScheduler, SonicAnalysisRunner,
        SpotdlRunner, TaskManager, TaskType,
    };

    /// Cheaply cloneable handle to the shared server state.
    ///
    /// Wraps [`AppStateInner`] inside an [`Arc`] so cloning across requests and
    /// Tokio tasks only increments an atomic reference count.
    #[derive(Debug, Clone)]
    pub struct AppState {
        inner: Arc<AppStateInner>,
    }

    /// Interior state container holding immutable `Arc<AppConfig>` and shared service handles.
    #[derive(Debug)]
    pub struct AppStateInner {
        /// Initial application configuration context.
        pub config: Arc<AppConfig>,
        /// Live runtime configuration updated by setup completion and backup restoration.
        pub runtime_config: std::sync::RwLock<Arc<AppConfig>>,
        runtime_gate: Arc<AsyncRwLock<()>>,
        runtime_updates: Arc<AsyncMutex<()>>,
        runtime_ready: AtomicBool,
        restore_state: crate::recovery::RestoreState,
        /// Optional SQLite database connection pool.
        pub db: Option<DbPool>,
        /// Optional session store backed by SQLite and an in-memory `RwLock` cache.
        pub sessions: Option<SessionStore>,
        /// Dynamic registry of enabled upstream media providers (`Navidrome`, `Jellyfin`).
        pub providers: BackendRegistry,
        /// Zero-copy binary stream header and throughput inspector.
        pub inspector: AudioMetadataInspector,
        /// Real-time WebSocket broadcast hub for live collaborative playlist party sessions.
        pub party_hub: PartyBroadcastHub,
        /// Real-time WebSocket Remote Control Hub (`/api/v1/remote`).
        pub remote_hub: RemoteControlHub,
        /// Google Cast capability ticket and stream gateway (`/api/v1/cast/*`).
        pub cast_gateway: CastGateway,
        /// Shared token store for external CDN artwork URLs (`extart_...`).
        pub artwork_tokens: ExternalArtworkTokenStore,
        /// Cached Deezer editorial chart discovery service.
        pub deezer_discovery: DeezerDiscoveryService,
        /// Three-tier synchronized/plain lyrics resolution service.
        pub lyrics: LyricsService,
        /// Federated search provider registry (`library`, `musicdeck-playlists`, `deezer`, `spotify`).
        pub search_providers: SearchProviderRegistry,
        /// 3-stage source discovery & candidate resolution pipeline registry.
        pub source_pipeline: SourcePipelineRegistry,
        /// Playable audio source registry & short-lived opaque token cache (`playable_...`).
        pub source_providers: SourceProviderRegistry,
        /// Durable transactional scrobble outbox & worker (`Last.fm` & `ListenBrainz`).
        pub scrobble_queue: ScrobbleQueueService,
        /// Per-user artist follow & release radar service.
        pub artist_follows: ArtistFollowService,
        /// Personalized recommendation engine & taste feed service.
        pub recommendations: RecommendationService,
        /// 128-D Sonic vector similarity service.
        pub sonic: SonicRecommendationService,
        /// Similar Mix graph traversal & Gumbel-max exploration engine.
        pub similar_mixes: SimilarMixEngine,
        /// Cooperative priority background task scheduler (`TaskManager`).
        pub tasks: TaskManager,
        /// Periodic library scan cron scheduler (`ScannerScheduler`).
        pub scanner_scheduler: ScannerScheduler,
        /// On-demand media acquisition coordinator (`AcquisitionService`).
        pub acquisitions: AcquisitionService,
        /// Spotify playlist batch importer (`SpotifyPlaylistImportService`).
        pub spotify_imports: SpotifyPlaylistImportService,
        /// First-party and custom plugin registry (`PluginRegistry`).
        pub plugins: PluginRegistry,
        /// Local server extension manager (`ExtensionManager`).
        pub extensions: ExtensionManager,
        /// Background library health audit and orphan-pruning service (`LibraryHealthScanService`).
        pub library_health_scan: LibraryHealthScanService,
        /// Login rate limiter configured from `config.auth.login_rate_limit`.
        pub login_limiter: LoginRateLimiter,
        /// Runtime privacy governance manager (`LOCAL_ONLY_MODE` + category flags).
        pub privacy: PrivacyManager,
        /// Bounded, redacting circular log buffer for administrative UI tailing.
        pub logs: LogBuffer,
        /// Atomic counter tracking active `/api/admin/logs/stream` SSE connections.
        pub open_log_streams: Arc<AtomicUsize>,
        /// Atomic health flag for the SQLite database subsystem.
        pub database_healthy: AtomicBool,
        /// Monotonic timestamp recorded when the server instance initialized.
        pub started_at: Instant,
    }

    /// Runtime mutations fail closed if cancelled or if refresh cannot complete.
    pub struct RuntimeUpdateGuard {
        state: AppState,
        was_ready: bool,
        _access: OwnedRwLockWriteGuard<()>,
        _serial: OwnedMutexGuard<()>,
    }

    impl RuntimeUpdateGuard {
        pub fn complete(self) {
            self.state.privacy().resume();
            self.state
                .inner
                .runtime_ready
                .store(true, Ordering::Release);
        }

        /// Validation/authentication failure did not change persistent state.
        pub fn unchanged(self) {
            if self.was_ready {
                self.complete();
            }
        }
    }

    impl AppState {
        /// Constructs a new [`AppState`] from the provided [`AppConfig`], registering
        /// deployment secrets with the log redactor.
        #[must_use]
        pub fn new(config: AppConfig) -> Self {
            Self::from_arc_config(Arc::new(config))
        }

        /// Loads persisted privacy policy before constructing database-backed services.
        pub async fn with_database(config: AppConfig, db: DbPool) -> Result<Self, PrivacyError> {
            let privacy = PrivacyManager::from_database(db.clone(), &config).await?;
            let arc_cfg = Arc::new(config);
            let sessions = SessionStore::new(db.clone(), arc_cfg.auth.session_secret.clone());
            let mut state = Self::with_log_buffer(arc_cfg, server_logs());
            if let Some(inner) = Arc::get_mut(&mut state.inner) {
                inner.privacy = privacy;
                let search_providers = SearchProviderRegistry::new(
                    Some(db.clone()),
                    inner.providers.clone(),
                    inner.artwork_tokens.clone(),
                );
                let source_pipeline = SourcePipelineRegistry::new(Some(db.clone()));
                let source_providers = SourceProviderRegistry::new(
                    Some(db.clone()),
                    inner.providers.clone(),
                    Some(source_pipeline.clone()),
                );
                inner.search_providers = search_providers;
                inner.source_pipeline = source_pipeline;
                inner.source_providers = source_providers;
                inner.scrobble_queue =
                    ScrobbleQueueService::new(Some(db.clone()), inner.privacy.clone())
                        .with_runtime_gate(inner.runtime_gate.clone());
                inner.artist_follows =
                    ArtistFollowService::new(Some(db.clone()), inner.artwork_tokens.clone())
                        .with_privacy(inner.privacy.clone())
                        .with_runtime_gate(inner.runtime_gate.clone());
                inner.recommendations = RecommendationService::new(Some(db.clone()));
                inner.sonic = SonicRecommendationService::new(Some(db.clone()));
                inner.similar_mixes = SimilarMixEngine::new(Some(db.clone()));
                let tasks = TaskManager::new(Some(db.clone()));
                tasks.register(
                    TaskType::LibraryScan,
                    Arc::new(LibraryScanRunner::new(
                        Some(db.clone()),
                        inner.providers.clone(),
                    )),
                );
                tasks.register(
                    TaskType::NewReleasesScan,
                    Arc::new(NewReleaseScannerRunner::new(inner.artist_follows.clone())),
                );
                tasks.register(
                    TaskType::SonicAudioAnalysis,
                    Arc::new(SonicAnalysisRunner::new(inner.sonic.clone())),
                );
                let acquisitions = AcquisitionService::new(Some(db.clone()));
                let spotify_imports = SpotifyPlaylistImportService::new(Some(db.clone()));
                let spotdl_runner: Arc<dyn crate::tasks::TaskDefinition> =
                    Arc::new(SpotdlRunner::with_services(
                        Some(db.clone()),
                        acquisitions.clone(),
                        spotify_imports.clone(),
                    ));
                tasks.register(TaskType::SpotdlImport, Arc::clone(&spotdl_runner));
                tasks.register(TaskType::SpotdlDownload, spotdl_runner);
                inner.tasks = tasks;
                inner.scanner_scheduler = ScannerScheduler::new(Some(db.clone()));
                inner.acquisitions = acquisitions;
                inner.spotify_imports = spotify_imports;
                inner.plugins = PluginRegistry::new(Some(db.clone()));
                inner.extensions =
                    ExtensionManager::new(Some(db.clone()), &inner.config.extensions_dir);
                inner.library_health_scan =
                    LibraryHealthScanService::new(Some(db.clone()), inner.providers.clone());
                inner.db = Some(db);
                inner.sessions = Some(sessions);
            }
            Ok(state)
        }

        /// Constructs a new [`AppState`] from an existing [`Arc<AppConfig>`].
        #[must_use]
        pub fn from_arc_config(config: Arc<AppConfig>) -> Self {
            Self::with_log_buffer(config, server_logs())
        }

        /// Constructs a new [`AppState`] with an explicit [`LogBuffer`] instance.
        #[must_use]
        pub fn with_log_buffer(config: Arc<AppConfig>, logs: LogBuffer) -> Self {
            for secret in [
                &config.auth.session_secret,
                &config.navidrome.password,
                &config.jellyfin.api_key,
                &config.auth.first_admin.password,
            ] {
                register_log_secret(secret);
            }

            let login_limiter =
                LoginRateLimiter::new(config.auth.login_rate_limit).unwrap_or_default();
            let privacy = PrivacyManager::new_in_memory(
                config.local_only_mode(),
                Vec::new(),
                PrivacySettings::default(),
            );

            let cast_gateway = CastGateway::new(config.auth.session_secret.as_bytes());

            let runtime_gate = Arc::new(AsyncRwLock::new(()));
            let providers = BackendRegistry::default();
            let artwork_tokens = ExternalArtworkTokenStore::new();
            let search_providers =
                SearchProviderRegistry::new(None, providers.clone(), artwork_tokens.clone());
            let source_pipeline = SourcePipelineRegistry::new(None);
            let source_providers =
                SourceProviderRegistry::new(None, providers.clone(), Some(source_pipeline.clone()));
            let scrobble_queue = ScrobbleQueueService::new(None, privacy.clone())
                .with_runtime_gate(runtime_gate.clone());
            let artist_follows = ArtistFollowService::new(None, artwork_tokens.clone())
                .with_privacy(privacy.clone())
                .with_runtime_gate(runtime_gate.clone());
            let recommendations = RecommendationService::new(None);
            let sonic = SonicRecommendationService::new(None);
            let similar_mixes = SimilarMixEngine::new(None);
            let tasks = TaskManager::new(None);
            tasks.register(
                TaskType::LibraryScan,
                Arc::new(LibraryScanRunner::new(None, providers.clone())),
            );
            tasks.register(
                TaskType::NewReleasesScan,
                Arc::new(NewReleaseScannerRunner::new(artist_follows.clone())),
            );
            tasks.register(
                TaskType::SonicAudioAnalysis,
                Arc::new(SonicAnalysisRunner::new(sonic.clone())),
            );
            tasks.register(TaskType::SpotdlImport, Arc::new(SpotdlRunner::new()));
            tasks.register(TaskType::SpotdlDownload, Arc::new(SpotdlRunner::new()));
            let scanner_scheduler = ScannerScheduler::new(None);
            let acquisitions = AcquisitionService::new(None);
            let spotify_imports = SpotifyPlaylistImportService::new(None);
            let plugins = PluginRegistry::new(None);
            let extensions = ExtensionManager::new(None, &config.extensions_dir);
            let library_health_scan = LibraryHealthScanService::new(None, providers.clone());

            let runtime_config = std::sync::RwLock::new(Arc::clone(&config));
            Self {
                inner: Arc::new(AppStateInner {
                    config,
                    runtime_config,
                    runtime_gate,
                    runtime_updates: Arc::new(AsyncMutex::new(())),
                    runtime_ready: AtomicBool::new(true),
                    restore_state: crate::recovery::RestoreState::default(),
                    db: None,
                    sessions: None,
                    providers,
                    inspector: AudioMetadataInspector::new(),
                    party_hub: PartyBroadcastHub::new(),
                    remote_hub: RemoteControlHub::new(),
                    cast_gateway,
                    artwork_tokens,
                    deezer_discovery: DeezerDiscoveryService::new(),
                    lyrics: LyricsService::new(),
                    search_providers,
                    source_pipeline,
                    source_providers,
                    scrobble_queue,
                    artist_follows,
                    recommendations,
                    sonic,
                    similar_mixes,
                    tasks,
                    scanner_scheduler,
                    acquisitions,
                    spotify_imports,
                    plugins,
                    extensions,
                    library_health_scan,
                    login_limiter,
                    privacy,
                    logs,
                    open_log_streams: Arc::new(AtomicUsize::new(0)),
                    database_healthy: AtomicBool::new(true),
                    started_at: Instant::now(),
                }),
            }
        }

        /// Returns a cloned [`Arc<AppConfig>`] handle to the active runtime configuration.
        #[must_use]
        pub fn config(&self) -> Arc<AppConfig> {
            self.inner
                .runtime_config
                .read()
                .map(|g| Arc::clone(&g))
                .unwrap_or_else(|_| Arc::clone(&self.inner.config))
        }

        /// Returns a cloned [`Arc<AppConfig>`] handle for background tasks and services.
        #[must_use]
        pub fn shared_config(&self) -> Arc<AppConfig> {
            self.config()
        }

        /// Atomically updates the active runtime [`AppConfig`] and registers any updated secrets.
        pub fn update_config(&self, config: AppConfig) {
            for secret in [
                &config.auth.session_secret,
                &config.navidrome.password,
                &config.jellyfin.api_key,
                &config.auth.first_admin.password,
            ] {
                register_log_secret(secret);
            }
            if let Ok(mut guard) = self.inner.runtime_config.write() {
                *guard = Arc::new(config);
            }
        }

        pub(crate) async fn runtime_read(&self) -> OwnedRwLockReadGuard<()> {
            self.inner.runtime_gate.clone().read_owned().await
        }

        pub(crate) fn runtime_ready(&self) -> bool {
            self.inner.runtime_ready.load(Ordering::Acquire)
        }

        pub fn restore_state(&self) -> &crate::recovery::RestoreState {
            &self.inner.restore_state
        }

        pub fn recovery_service(&self) -> crate::recovery::BackupRestoreService {
            crate::recovery::BackupRestoreService::new(self.db().cloned(), self.shared_config())
                .with_restore_state(self.restore_state().clone())
        }

        pub(crate) async fn privacy_update_lock(&self) -> OwnedMutexGuard<()> {
            self.inner.runtime_updates.clone().lock_owned().await
        }

        pub(crate) async fn revalidate_admin(
            &self,
            session: &str,
        ) -> Result<(), crate::error::ServerError> {
            use crate::error::ServerError;
            let store = self
                .session_store()
                .ok_or_else(|| ServerError::Unauthorized("Authentication required".into()))?;
            let user = store
                .get_session_user_by_id(session)
                .await
                .map_err(|err| ServerError::Internal(err.to_string()))?
                .ok_or_else(|| ServerError::Unauthorized("Authentication required".into()))?;
            if !user.is_admin() {
                return Err(ServerError::Forbidden("Admin access required".into()));
            }
            Ok(())
        }

        pub(crate) async fn begin_runtime_update(&self) -> RuntimeUpdateGuard {
            let serial = self.inner.runtime_updates.clone().lock_owned().await;
            let was_ready = self.runtime_ready();
            // Cancel network work before waiting for HTTP handlers to drain.
            self.privacy().suspend();
            self.inner.runtime_ready.store(false, Ordering::Release);
            let access = self.inner.runtime_gate.clone().write_owned().await;
            RuntimeUpdateGuard {
                state: self.clone(),
                was_ready,
                _access: access,
                _serial: serial,
            }
        }

        /// Installs a consistent live policy/provider/configuration generation while gated.
        pub(crate) async fn refresh_runtime(
            &self,
            config: AppConfig,
        ) -> Result<(), crate::error::ServerError> {
            let db = self.db().ok_or_else(|| {
                crate::error::ServerError::Internal("Database unavailable".into())
            })?;
            self.privacy()
                .reload(&config)
                .await
                .map_err(|err| crate::error::ServerError::Internal(err.to_string()))?;
            let providers = crate::providers::create_provider_registry(db, &config)
                .await
                .map_err(|err| crate::error::ServerError::Internal(err.to_string()))?;
            if !self.privacy().configured_snapshot().effective.external {
                self.scrobble_queue()
                    .cancel_privacy_pending()
                    .await
                    .map_err(|err| crate::error::ServerError::Internal(err.to_string()))?;
            }
            self.providers().replace_all(providers.list());
            self.update_config(config);
            Ok(())
        }

        /// Updates the `setup_required` flag on the active runtime configuration.
        pub fn set_setup_required(&self, setup_required: bool) {
            if let Ok(mut guard) = self.inner.runtime_config.write() {
                let mut next = (**guard).clone();
                next.setup_required = setup_required;
                *guard = Arc::new(next);
            }
        }

        /// Returns a reference to the attached [`DbPool`], if initialized.
        #[must_use]
        pub fn db(&self) -> Option<&DbPool> {
            self.inner.db.as_ref()
        }

        /// Returns a reference to the attached [`SessionStore`], if initialized.
        #[must_use]
        pub fn session_store(&self) -> Option<&SessionStore> {
            self.inner.sessions.as_ref()
        }

        /// Returns a reference to the [`BackendRegistry`].
        #[must_use]
        pub fn providers(&self) -> &BackendRegistry {
            &self.inner.providers
        }

        /// Returns a reference to the [`AudioMetadataInspector`].
        #[must_use]
        pub fn inspector(&self) -> &AudioMetadataInspector {
            &self.inner.inspector
        }

        /// Returns a reference to the [`PartyBroadcastHub`].
        #[must_use]
        pub fn party_hub(&self) -> &PartyBroadcastHub {
            &self.inner.party_hub
        }

        /// Returns a reference to the [`RemoteControlHub`].
        #[must_use]
        pub fn remote_hub(&self) -> &RemoteControlHub {
            &self.inner.remote_hub
        }

        /// Returns a reference to the [`CastGateway`].
        #[must_use]
        pub fn cast_gateway(&self) -> &CastGateway {
            &self.inner.cast_gateway
        }

        /// Returns a reference to the [`ExternalArtworkTokenStore`].
        #[must_use]
        pub fn artwork_tokens(&self) -> &ExternalArtworkTokenStore {
            &self.inner.artwork_tokens
        }

        /// Returns a reference to the [`DeezerDiscoveryService`].
        #[must_use]
        pub fn deezer_discovery(&self) -> &DeezerDiscoveryService {
            &self.inner.deezer_discovery
        }

        /// Returns a reference to the [`LyricsService`].
        #[must_use]
        pub fn lyrics(&self) -> &LyricsService {
            &self.inner.lyrics
        }

        /// Returns a reference to the [`SearchProviderRegistry`].
        #[must_use]
        pub fn search_providers(&self) -> &SearchProviderRegistry {
            &self.inner.search_providers
        }

        /// Returns a reference to the [`SourcePipelineRegistry`].
        #[must_use]
        pub fn source_pipeline(&self) -> &SourcePipelineRegistry {
            &self.inner.source_pipeline
        }

        /// Returns a reference to the [`SourceProviderRegistry`].
        #[must_use]
        pub fn source_providers(&self) -> &SourceProviderRegistry {
            &self.inner.source_providers
        }

        /// Returns a reference to the [`ScrobbleQueueService`].
        #[must_use]
        pub fn scrobble_queue(&self) -> &ScrobbleQueueService {
            &self.inner.scrobble_queue
        }

        /// Returns a reference to the [`ArtistFollowService`].
        #[must_use]
        pub fn artist_follows(&self) -> &ArtistFollowService {
            &self.inner.artist_follows
        }

        /// Returns a reference to the [`RecommendationService`].
        #[must_use]
        pub fn recommendations(&self) -> &RecommendationService {
            &self.inner.recommendations
        }

        /// Returns a reference to the [`SonicRecommendationService`].
        #[must_use]
        pub fn sonic(&self) -> &SonicRecommendationService {
            &self.inner.sonic
        }

        /// Returns a reference to the [`SimilarMixEngine`].
        #[must_use]
        pub fn similar_mixes(&self) -> &SimilarMixEngine {
            &self.inner.similar_mixes
        }

        /// Returns a reference to the [`TaskManager`].
        #[must_use]
        pub fn tasks(&self) -> &TaskManager {
            &self.inner.tasks
        }

        /// Returns a reference to the [`ScannerScheduler`].
        #[must_use]
        pub fn scanner_scheduler(&self) -> &ScannerScheduler {
            &self.inner.scanner_scheduler
        }

        /// Returns a reference to the [`AcquisitionService`].
        #[must_use]
        pub fn acquisitions(&self) -> &AcquisitionService {
            &self.inner.acquisitions
        }

        /// Returns a reference to the [`SpotifyPlaylistImportService`].
        #[must_use]
        pub fn spotify_imports(&self) -> &SpotifyPlaylistImportService {
            &self.inner.spotify_imports
        }

        /// Returns a reference to the [`PluginRegistry`].
        #[must_use]
        pub fn plugins(&self) -> &PluginRegistry {
            &self.inner.plugins
        }

        /// Returns a reference to the [`ExtensionManager`].
        #[must_use]
        pub fn extensions(&self) -> &ExtensionManager {
            &self.inner.extensions
        }

        /// Returns a reference to the [`LibraryHealthScanService`].
        #[must_use]
        pub fn library_health_scan(&self) -> &LibraryHealthScanService {
            &self.inner.library_health_scan
        }

        /// Constructs a [`crate::queue::QueueSyncService`] bound to `db`.
        #[must_use]
        pub fn queue_sync_service(&self, db: DbPool) -> crate::queue::QueueSyncService {
            let library = crate::catalog::LibraryService::new(
                db.clone(),
                Some(self.config().music_root.clone()),
            );
            crate::queue::QueueSyncService::new(db, library)
        }

        /// Returns a reference to the [`LoginRateLimiter`].
        #[must_use]
        pub fn login_limiter(&self) -> &LoginRateLimiter {
            &self.inner.login_limiter
        }

        /// Returns a reference to the [`PrivacyManager`].
        #[must_use]
        pub fn privacy(&self) -> &PrivacyManager {
            &self.inner.privacy
        }

        /// Returns a cloned [`Arc<AtomicUsize>`] counter for open admin log SSE streams.
        #[must_use]
        pub fn open_log_streams_counter(&self) -> Arc<AtomicUsize> {
            Arc::clone(&self.inner.open_log_streams)
        }

        /// Returns a reference to the [`LogBuffer`] attached to this server instance.
        #[must_use]
        pub fn logs(&self) -> &LogBuffer {
            &self.inner.logs
        }

        /// Returns `true` if the database subsystem passed its most recent health probe.
        #[must_use]
        pub fn is_database_healthy(&self) -> bool {
            self.inner.database_healthy.load(Ordering::Acquire)
        }

        /// Updates the database connectivity health flag reported by `/api/health`.
        pub fn set_database_healthy(&self, healthy: bool) {
            self.inner
                .database_healthy
                .store(healthy, Ordering::Release);
        }

        /// Returns the elapsed uptime in whole seconds since state initialization.
        #[must_use]
        pub fn uptime_seconds(&self) -> u64 {
            self.inner.started_at.elapsed().as_secs()
        }
    }

    impl Default for AppState {
        fn default() -> Self {
            Self::new(AppConfig::default())
        }
    }
}

// Top-level module namespaces reserved for upcoming migration phases:
/// SQLite connection management, WAL configuration, and file permissions (Phase 1).
pub mod db;
/// Password hashing (`Argon2id` + legacy `Bcrypt`), session management, authorization
/// extractors, login rate limiting, and real-time SSE session streams (Phase 2).
pub mod auth;
/// Avatar validation, decompression-bomb-safe resizing (`256x256`), and BLOB storage (Phase 2).
pub mod avatars;
/// User account CRUD, master-admin & self-lockout guardrails, and profile updates (Phase 2).
pub mod users;
/// Pluggable media backend providers (`NavidromeClient`, `JellyfinClient`, `BackendRegistry`,
/// `LocalUserDataSyncAdapter`, and `MusicBackend` trait) (Phase 3).
pub mod providers;
/// Alias for [`providers`] matching the legacy `server/src/backends` module path.
pub use providers as backends;
/// Deterministic music identity, multi-source catalog merging, SQLite library ID mapping,
/// source resolution, and multi-provider catalog fan-out (Phase 3).
pub mod catalog;
/// Zero-copy binary audio header inspection (`FLAC`, `WAV`, `OGG`, `MP4`, `MP3`, `ADTS`)
/// and live stream delivery telemetry (Phase 3).
pub mod inspector;
/// RFC 9110 HTTP byte-range streaming and upstream stream proxying (Phase 3).
pub mod streaming;
/// Playlist management, Compare-And-Swap reordering, batch edits, and 2x2 collage artwork (Phase 4).
pub mod playlists;
/// Resumable album & playlist playback bookmarks and completion tombstones (Phase 5).
pub mod media;
/// Durable gzipped queue synchronization, 128 MiB storage budgets, and named queues (Phase 5).
pub mod queue;
/// Real-time WebSocket Remote Control Hub and 4-stage playback transfer handshake (Phase 5).
pub mod remote;
/// Google Cast HMAC-SHA256 capability tickets and `/api/v1/cast/stream` proxy (Phase 5).
pub mod cast;
/// External metadata adapters (`DeezerAdapter`, `ItunesAdapter`, `SubsonicAdapter`),
/// `CompositeMetadataService`, `LyricsService`, and saved discoveries (Phase 6).
pub mod external;
/// Unified search models, fuzzy/canonical deduplication, and Spotify client-credentials provider (Phase 6).
pub mod search;
/// Search provider registry, playable source registry, and 3-stage candidate discovery pipeline (Phase 6).
pub mod registry;
/// External scrobbling (`LastFmScrobbler`, `ListenBrainzScrobbler`) and durable SQLite outbox (`ScrobbleQueueService`) (Phase 6).
pub mod scrobbling;
/// Artist follows and release radar scanner (`ArtistFollowService`) (Phase 6).
pub mod social;
/// User taste profile governance (`TasteProfileManager`) and library insights (`LibraryInsightsService`) (Phase 7).
pub mod profile;
/// Local recommendation engine (`RecommendationEngine`) and personalized discovery feeds (`RecommendationService`) (Phase 7).
pub mod recommendations;
/// 128-D Sonic DSP feature extraction and cosine k-NN similarity search (`SonicRecommendationService`) (Phase 7).
pub mod sonic;
/// Similar Mix graph traversal, Gumbel exploration, and transition sequencing (`SimilarMixEngine`) (Phase 7).
pub mod mixes;
/// Background task manager, safe process runner, and cron schedulers (`TaskManager`, `ProcessRunner`) (Phase 8).
pub mod tasks;
/// EBU R128 loudness normalization, silence detection, audio container tagger, and library shrink optimizer (Phase 8).
pub mod audio;
/// Automated media acquisition, spotDL CLI adapter, and Spotify playlist importer (Phase 8).
pub mod acquisition;
/// First-party & custom plugin registry, manifest validator, and extension runtime manager (Phase 8).
pub mod plugins;
/// Administrative library health scanner, system health wizard, and media deletion pipeline (Phase 9).
pub mod admin;
/// System backup/restore archives (`BackupRestoreService`) and GDPR user data exports (`DataExportService`) (Phase 9).
pub mod recovery;
/// Core domain services: settings, catalog, playlists, search, and acquisitions (Phases 2–8).
pub mod domain;
/// Background & governance services: privacy manager, favorites, recently played, and listening activity.
pub mod services;

pub use auth::{
    AdmissionPermit, AdmissionResult, AuthError, AuthenticatedUser, LoginRateLimiter, OptionalUser,
    RateLimiterConfig, RequireAdmin, SESSION_COOKIE, Session, SessionEvent, SessionEventBus,
    SessionStore, SessionStreamGuard, SessionUser, UserClaims, UserRole, build_session_sse_stream,
    hash_password, needs_rehash, verify_password,
};
pub use avatars::{
    AVATAR_THUMBNAIL_DIMENSION, AvatarFormat, AvatarImage, MAX_AVATAR_BYTES,
    MAX_AVATAR_REQUEST_BYTES, avatar_url_for, clear_user_avatar, compute_avatar_etag,
    get_user_avatar, normalize_avatar_thumbnail, parse_avatar_data_url, set_user_avatar,
    validate_raw_avatar_bytes,
};
pub use cast::{
    CAST_LEASE_TTL_MS, CastError, CastGateway, CastLease, CastReceiverConnectionGuard,
    CastTicketRequest, CastTicketResponse, MAX_GLOBAL_CAST_LEASES, MAX_LEASES_PER_SESSION,
    MAX_RECEIVER_CONNECTIONS_PER_LEASE,
};
pub use catalog::{
    Availability, AvailabilityState, Available, CandidateSource, CanonicalIdentity,
    CatalogEntityType, CatalogListResult, CatalogSearchResult, CatalogService,
    ContainerFileMetadata, IdentityStrength, LibraryItemType, LibraryService, SourceOption,
    SourceRef, SourceResolver, SourceUnavailableError, TrackContentHint, UnifiedCatalogItem,
    derive_canonical_identity, extract_track_title_from_path, find_matching_external_album,
    find_matching_external_artist, match_container_file, merge_album_tracks, merge_artist_albums,
    normalize_music_text, recordings_match, version_signature,
};
pub use inspector::{
    AudioMetadata, AudioMetadataInspector, AudioProperties, DeliveryState, InspectionEvidence,
    StreamDeliveryMetrics, StreamInspection, StreamInspectionOutput, StreamOutputMode, codec_name,
    inspect_audio_header, source_properties,
};
pub use users::{
    CreateUserPayload, StoredUserCredentials, UpdateOwnProfilePayload, User, UserError,
    UserPermissionFlags, UserUpdatePayload, check_delete_guard, check_update_guard, create_user,
    delete_user, get_user_by_id, get_user_by_username, list_users, update_own_profile,
    update_user,
};

pub use config::{
    AcquisitionLimits, AppConfig, AuthConfig, ConfigError, DatabaseConfig, FirstAdminConfig,
    JellyfinConfig, LoginRateLimitConfig, MusicBackendKind, NavidromeConfig, NetworkConfig,
    SystemOverrides, SystemPaths, TrustedProxyEntry, apply_system_configuration, durable_json,
};
/// Backwards-compatible alias for [`AppConfig`].
pub type ServerConfig = AppConfig;
pub use db::{
    AppliedMigration, BackfillReport, DbError, DbPool, DbPoolOptions, LATEST_SCHEMA_VERSION,
    Migration, MigrationKind, MigrationReport, SeedReport, SynchronousMode,
    backfill_connection_scope, backfill_library_identities, create_id, list_applied_migrations,
    migrations_registry, open_database, prepare_database_path, protect_database_file,
    protect_database_files, run_migrations, seed_initial_data,
};
pub use error::{ApiErrorBody, ApiErrorEnvelope, ServerError};
pub use logger::{
    LogBuffer, LogBufferStats, LogEntry, LogInput, LogLevel, LogListOptions, LogSource,
    LogStreamEvent, RedactConfigMode, RedactingLayer, RedactingVisitor, redact_config,
    redact_json_value, redact_text, register_log_secret, server_logs,
};
pub use media::{
    MEDIA_SESSION_TTL_MS, MediaCheckpoint, MediaCheckpointInput, MediaCollectionType,
    MediaSessionError, PlaybackSession, ResumableMediaService,
};
pub use middleware::{SecurityHeadersPolicy, security_headers_middleware};
pub use playlists::{
    COLLAGE_SIZE, COLLAGE_TILE_COUNT, CustomPlaylistArtwork, MAX_ARTWORK_REQUEST_BYTES,
    MAX_CACHED_COLLAGES, MAX_CUSTOM_ARTWORK_BYTES, PLAYLIST_ARTWORK_PREFIX,
    PLAYLIST_ARTWORK_SIZES, PlaylistArtworkDescriptor, PlaylistArtworkMode,
    PlaylistArtworkService, PlaylistBatchEdit, PlaylistError, PlaylistPermissions, PlaylistRecord,
    PlaylistService, PlaylistTrack, PlaylistUpdatePayload, PlaylistVisibility, RenderedArtwork,
    TrackAddedByUser, build_playlist_artwork_id, compose_raster_2x2_collage,
    compose_svg_2x2_collage, parse_image_data_url, parse_playlist_artwork_id,
    resolve_artwork_size,
};
pub use providers::{
    Album, Artist, AudioMetadataSummary, AudioStreamInfo, BackendRegistry, IdentityHints,
    JellyfinBackend, JellyfinClient, LibraryScanResult, LocalUserDataSyncAdapter, LoudnessMetadata,
    MusicBackend, NavidromeBackend, NavidromeClient, Playlist, PlaylistUpdateInput, ProviderError,
    ProviderRegistry, RegisteredProvider, ReplayGainMetadata, SearchPagination, SearchResult,
    StoredProviderConfig, StreamResult, Track, TrackArtistCredit, create_provider,
    create_provider_registry, has_user_data_sync, with_local_user_data_sync,
};
pub use queue::{
    CLOCK_SKEW_TOLERANCE_MS, ClockVector, DeviceQueueSession, MAX_ACCOUNT_STORAGE_BUDGET_BYTES,
    MAX_CONCURRENT_UPLOADS, MAX_DEVICES_PER_USER, MAX_NAMED_QUEUES_PER_USER,
    MAX_QUEUE_CONTENT_BYTES, NamedQueueRecord, QueueCheckpoint, QueueContent, QueueContextInfo,
    QueueEntry, QueueShuffleMode, QueueState, QueueSyncError, QueueSyncService, SyncPayload,
};
pub use remote::{
    COMMAND_TIMEOUT_MS, MAX_CLIENTS_PER_USER, MAX_PENDING_COMMANDS_PER_CONTROLLER, PlaybackState,
    REGISTRATION_TIMEOUT_MS, REMOTE_WS_PATH, RemoteClientMessage, RemoteCommand, RemoteControlHub,
    RemoteDeviceType, RemotePlaybackState, RemoteTrackSummary, TRANSFER_TIMEOUT_MS,
    TransferQueueEntry, TransferQueueState, TransferSnapshot, TransferStage,
};
pub use routes::{HealthResponse, HealthStatus, ServiceHealthState};
pub use state::{AppState, AppStateInner};

/// Constructs a fully wired [`axum::Router`] using default [`AppState`].
///
/// Designed for unit and integration tests that need a ready-to-use router
/// instance without spinning up a TCP listener or custom environment configuration.
#[must_use]
pub fn app() -> Router {
    create_router(AppState::default())
}

/// Constructs the primary [`axum::Router`] hierarchy with all middleware layers
/// and shared [`AppState`] attached.
///
/// ### Middleware Stack (outermost to innermost)
/// 1. **Panic Recovery (`CatchPanicLayer`)**: Converts unexpected handler panics into
///    `500 Internal Server Error` responses instead of dropping the worker thread.
/// 2. **Sensitive Header Redaction (`SetSensitiveRequestHeadersLayer`)**: Marks
///    `Authorization` and `Cookie` headers as sensitive so they are never emitted
///    in `tracing` spans.
/// 3. **Structured Request Tracing (`TraceLayer`)**: Emits request/response spans with
///    HTTP method, matched route, status code, and latency.
/// 4. **Security Response Headers ([`security_headers_middleware`])**: Enforces
///    `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
///    `X-XSS-Protection: 1; mode=block`, `Referrer-Policy: strict-origin-when-cross-origin`,
///    `Content-Security-Policy`, and `Permissions-Policy` on every outbound response
///    without clobbering route-level overrides.
/// 5. **CORS Policy (`CorsLayer`)**: Configures cross-origin access with credential
///    support matching [`AppConfig::cors_origin`].
#[must_use]
pub fn create_router(state: AppState) -> Router {
    let cors_layer = build_cors_layer(state.config().cors_origin());

    let sensitive_headers: Arc<[HeaderName]> =
        Arc::new([http::header::AUTHORIZATION, http::header::COOKIE]);

    let trace_layer = TraceLayer::new_for_http()
        .make_span_with(DefaultMakeSpan::new().level(Level::INFO))
        .on_response(DefaultOnResponse::new().level(Level::INFO));

    let _startup_marker = Instant::now();

    Router::new()
        .merge(routes::health_routes())
        .merge(routes::user_routes())
        .merge(routes::privacy_routes())
        .merge(routes::settings_routes())
        .merge(routes::config_routes())
        .merge(routes::admin_logs_routes())
        .merge(routes::music_routes())
        .merge(routes::playlist_routes())
        .merge(routes::playlist_collaboration_routes())
        .merge(routes::smart_playlist_routes())
        .merge(routes::queue_and_media_session_routes())
        .merge(routes::remote_and_cast_routes())
        .merge(routes::external_discovery_routes())
        .merge(routes::search_sources_routes())
        .merge(routes::scrobbling_and_social_routes())
        .merge(routes::taste_and_recommendation_routes())
        .merge(routes::sonic_and_mixes_routes())
        .merge(routes::admin_tasks_routes())
        .merge(routes::audio_playback_routes())
        .merge(routes::acquisition_routes())
        .merge(routes::plugins_and_extensions_routes())
        .merge(routes::admin_health_and_media_routes())
        .merge(routes::recovery_and_export_routes())
        .fallback(routes::not_found_handler)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            routes::privacy_guard_middleware,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            recovery::state::admission_middleware,
        ))
        .layer(cors_layer)
        .layer(from_fn(middleware::security::security_headers_middleware))
        .layer(trace_layer)
        .layer(SetSensitiveRequestHeadersLayer::from_shared(
            sensitive_headers,
        ))
        .layer(CatchPanicLayer::new())
        .with_state(state)
}

fn build_cors_layer(origin: &str) -> CorsLayer {
    let mut allowed: Vec<HeaderValue> = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://localhost:4534",
        "http://127.0.0.1:4534",
    ]
    .iter()
    .filter_map(|s| s.parse::<HeaderValue>().ok())
    .collect();

    if let Ok(configured) = origin.parse::<HeaderValue>() {
        if !allowed.contains(&configured) {
            allowed.push(configured);
        }
    }

    let allow_origin = if origin.trim() == "*" {
        AllowOrigin::mirror_request()
    } else {
        AllowOrigin::list(allowed)
    };

    CorsLayer::new()
        .allow_origin(allow_origin)
        .allow_credentials(true)
        .allow_methods([
            http::Method::GET,
            http::Method::POST,
            http::Method::PUT,
            http::Method::PATCH,
            http::Method::DELETE,
            http::Method::OPTIONS,
        ])
        .allow_headers([
            http::header::CONTENT_TYPE,
            http::header::AUTHORIZATION,
            http::header::ACCEPT,
            http::header::RANGE,
        ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_endpoint_returns_ok_and_security_headers() {
        let router = app();
        let request = Request::builder()
            .method(http::Method::GET)
            .uri("/api/health")
            .body(axum::body::Body::empty())
            .expect("valid request");

        let response = router
            .oneshot(request)
            .await
            .expect("infallible router response");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(http::header::X_CONTENT_TYPE_OPTIONS)
                .and_then(|v| v.to_str().ok()),
            Some("nosniff")
        );
        assert_eq!(
            response
                .headers()
                .get(http::header::X_FRAME_OPTIONS)
                .and_then(|v| v.to_str().ok()),
            Some("SAMEORIGIN")
        );
        assert_eq!(
            response
                .headers()
                .get(http::header::REFERRER_POLICY)
                .and_then(|v| v.to_str().ok()),
            Some("strict-origin-when-cross-origin")
        );

        let body_bytes = response
            .into_body()
            .collect()
            .await
            .expect("collect response body")
            .to_bytes();
        let payload: routes::HealthStatus =
            serde_json::from_slice(&body_bytes).expect("valid health JSON");

        assert!(payload.ok);
        assert_eq!(payload.service, "musicdeck-server");
        assert!(payload.database.connected);
    }

    #[tokio::test]
    async fn health_endpoint_returns_503_when_database_is_unhealthy() {
        let state = AppState::default();
        state.set_database_healthy(false);
        let router = create_router(state);

        let request = Request::builder()
            .method(http::Method::GET)
            .uri("/api/health")
            .body(axum::body::Body::empty())
            .expect("valid request");

        let response = router
            .oneshot(request)
            .await
            .expect("infallible router response");

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body_bytes = response
            .into_body()
            .collect()
            .await
            .expect("collect response body")
            .to_bytes();
        let payload: routes::HealthStatus =
            serde_json::from_slice(&body_bytes).expect("valid health JSON");

        assert!(!payload.ok);
        assert_eq!(payload.status, routes::ServiceHealthState::Unhealthy);
        assert!(!payload.database.connected);
    }

    #[tokio::test]
    async fn unknown_route_returns_structured_404_envelope() {
        let router = app();
        let request = Request::builder()
            .method(http::Method::GET)
            .uri("/api/nonexistent")
            .body(axum::body::Body::empty())
            .expect("valid request");

        let response = router
            .oneshot(request)
            .await
            .expect("infallible router response");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body_bytes = response
            .into_body()
            .collect()
            .await
            .expect("collect response body")
            .to_bytes();
        let envelope: ApiErrorEnvelope =
            serde_json::from_slice(&body_bytes).expect("valid error envelope");

        assert_eq!(envelope.error.code, "NOT_FOUND");
    }
}
