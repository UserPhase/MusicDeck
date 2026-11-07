//! # HTTP Route Modules (`routes`)
//!
//! Aggregates modular route handlers for health monitoring, authentication,
//! catalog browsing, media streaming, playlists, and administration.

pub mod acquisitions;
pub mod admin_health_media;
pub mod admin_logs;
pub mod admin_tasks;
pub mod audio_playback;
pub mod config;
pub mod external_discovery;
pub mod health;
pub mod music;
pub mod playlist_collaboration;
pub mod playlists;
pub mod plugins_extensions;
pub mod privacy;
pub mod queue_media;
pub mod recovery_export;
pub mod remote_cast;
pub mod scrobbling_social;
pub mod search_sources;
pub mod settings;
pub mod smart_playlists;
pub mod sonic_mixes;
pub mod taste_recommendations;
pub mod users;

use crate::error::ServerError;

pub use acquisitions::acquisition_routes;
pub use admin_health_media::admin_health_and_media_routes;
pub use admin_logs::{
    AdminLogsListResponse, MAX_LOG_STREAMS, STREAM_BATCH_MAX, admin_logs_routes,
};
pub use admin_tasks::admin_tasks_routes;
pub use audio_playback::audio_playback_routes;
pub use config::config_routes;
pub use external_discovery::external_discovery_routes;
pub use health::{
    DatabaseHealth, HealthResponse, HealthStatus, MemoryMetrics, SERVICE_NAME, ServiceHealthState,
    health_check, health_routes, sample_process_rss_bytes,
};
pub use music::music_routes;
pub use playlist_collaboration::playlist_collaboration_routes;
pub use playlists::playlist_routes;
pub use plugins_extensions::plugins_and_extensions_routes;
pub use privacy::{classify_integration_request, privacy_guard_middleware, privacy_routes};
pub use queue_media::queue_and_media_session_routes;
pub use recovery_export::recovery_and_export_routes;
pub use remote_cast::remote_and_cast_routes;
pub use scrobbling_social::scrobbling_and_social_routes;
pub use search_sources::search_sources_routes;
pub use settings::{SettingsListEnvelope, SettingsPatchEnvelope, settings_routes};
pub use smart_playlists::smart_playlist_routes;
pub use sonic_mixes::sonic_and_mixes_routes;
pub use taste_recommendations::taste_and_recommendation_routes;
pub use users::{SingleUserResponse, UserListResponse, user_routes};

/// Fallback handler for unmatched routes returning a structured JSON 404.
pub async fn not_found_handler(uri: http::Uri) -> ServerError {
    ServerError::NotFound(format!("Route '{}' was not found", uri.path()))
}
