//! # Health & Liveness Monitoring Endpoint (`routes::health`)
//!
//! Provides the low-latency `GET /api/health` endpoint used by Docker Compose
//! healthchecks, reverse proxies, and administrative readiness probes.
//!
//! ## Wire Compatibility & Telemetry
//! Preserves top-level `{ "ok": true, "service": "musicdeck-server" }` fields required
//! by existing MusicDeck healthcheck scripts and acceptance tests, while enriching the
//! payload with database connectivity state, process uptime, setup status, and memory
//! telemetry (`HealthStatus`). If a registered subsystem probe (such as SQLite) reports
//! an unhealthy state, the handler returns `HTTP 503 Service Unavailable` with `ok: false`.

use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use chrono::Utc;
use http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::state::AppState;

const DATABASE_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Canonical service identifier returned by `GET /api/health`.
pub const SERVICE_NAME: &str = "musicdeck-server";

/// High-level readiness state of the server or an individual subsystem.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceHealthState {
    /// All required subsystems are operational.
    #[default]
    Healthy,
    /// Server is accepting requests in setup/degraded mode.
    Degraded,
    /// A critical subsystem (such as the SQLite database) failed its probe.
    Unhealthy,
}

/// Database connectivity probe result included in [`HealthStatus`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseHealth {
    /// Whether the SQLite connection/pool probe succeeded.
    pub connected: bool,
    /// Mode of the configured database (`"wal"` or `"memory"`).
    pub mode: String,
    /// Optional diagnostic message when the probe fails.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Process memory & log buffer telemetry included in [`HealthStatus`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMetrics {
    /// Approximate Resident Set Size (RSS) in bytes when available from the OS (`0` if unsupported).
    pub resident_set_bytes: u64,
    /// Bytes currently used by the in-memory [`crate::logger::LogBuffer`].
    pub log_buffer_bytes: usize,
    /// Number of entries currently stored in [`crate::logger::LogBuffer`].
    pub log_buffer_entries: usize,
}

/// Structured JSON payload returned by `GET /api/health`.
///
/// Includes `ok` and `service` at the root so legacy probes expecting
/// `{ "ok": true, "service": "musicdeck-server" }` continue to pass unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    /// `true` when the server is healthy and able to serve requests (`HTTP 200 OK`).
    pub ok: bool,
    /// Canonical service name (`"musicdeck-server"`).
    pub service: String,
    /// Detailed readiness state (`"healthy"`, `"degraded"`, `"unhealthy"`).
    pub status: ServiceHealthState,
    /// Process uptime in whole seconds.
    pub uptime_seconds: u64,
    /// Whether interactive initial setup is required.
    pub setup_required: bool,
    /// ISO-8601 UTC timestamp of the probe.
    pub timestamp: String,
    /// Database subsystem connectivity report.
    pub database: DatabaseHealth,
    /// Process and buffer memory metrics.
    pub memory: MemoryMetrics,
}

/// Backward-compatible type alias for callers referencing `HealthResponse`.
pub type HealthResponse = HealthStatus;

/// Mounts the `/api/health` route onto an [`axum::Router`].
pub fn health_routes() -> Router<AppState> {
    Router::new().route("/api/health", get(health_check))
}

/// `GET /api/health` handler returning `200 OK` when healthy or `503 Service Unavailable`
/// if the database health check fails.
pub async fn health_check(State(state): State<AppState>) -> Response {
    let config = state.config();
    let db_probe = match state.db() {
        Some(db) => match tokio::time::timeout(DATABASE_PROBE_TIMEOUT, db.ping()).await {
            Ok(Ok(())) => None,
            Ok(Err(_)) => Some("Database connectivity check failed"),
            Err(_) => Some("Database connectivity check timed out"),
        },
        None => None, // The standalone router used in tests has no pool.
    };
    let db_message = db_probe.or_else(|| {
        (!state.is_database_healthy()).then_some("Database connectivity check failed")
    });
    let db_healthy = db_message.is_none();
    let db_mode = if config.database.is_persistent() {
        String::from("wal")
    } else {
        String::from("memory")
    };

    let (http_status, status) = if !db_healthy {
        (StatusCode::SERVICE_UNAVAILABLE, ServiceHealthState::Unhealthy)
    } else if config.setup_required {
        (StatusCode::OK, ServiceHealthState::Degraded)
    } else {
        (StatusCode::OK, ServiceHealthState::Healthy)
    };

    let log_stats = tokio::time::timeout(Duration::from_millis(100), state.logs().stats_async())
        .await
        .ok();
    let payload = HealthStatus {
        ok: db_healthy,
        service: String::from(SERVICE_NAME),
        status,
        uptime_seconds: state.uptime_seconds(),
        setup_required: config.setup_required,
        timestamp: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        database: DatabaseHealth {
            connected: db_healthy,
            mode: db_mode,
            message: db_message.map(str::to_owned),
        },
        memory: MemoryMetrics {
            resident_set_bytes: sample_process_rss_bytes(),
            log_buffer_bytes: log_stats.map_or(0, |stats| stats.bytes),
            log_buffer_entries: log_stats.map_or(0, |stats| stats.size),
        },
    };

    (
        http_status,
        [(http::header::CACHE_CONTROL, "no-store")],
        Json(payload),
    )
        .into_response()
}

/// Reads the current process RSS from `/proc/self/statm` on Linux containers,
/// returning `0` on non-Linux hosts without requiring `unsafe` FFI calls.
#[must_use]
pub fn sample_process_rss_bytes() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(statm) = std::fs::read_to_string("/proc/self/statm")
            && let Some(rss_pages_str) = statm.split_whitespace().nth(1)
            && let Ok(rss_pages) = rss_pages_str.parse::<u64>()
        {
            return rss_pages.saturating_mul(4096);
        }
        0
    }
    #[cfg(not(target_os = "linux"))]
    {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AppConfig, create_router, db};
    use http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn readiness_recovers_when_the_sqlite_pool_has_capacity_again() {
        let db = db::DbPool::connect_memory().await.unwrap();
        db::run_migrations(&db, None).await.unwrap();
        let state = AppState::with_database(AppConfig::default(), db.clone())
            .await
            .unwrap();
        let router = create_router(state);
        let request = || Request::get("/api/health").body(axum::body::Body::empty()).unwrap();

        let connection = db.inner().acquire().await.unwrap();
        let response = router.clone().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[http::header::CACHE_CONTROL], "no-store");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let health: HealthStatus = serde_json::from_slice(&body).unwrap();
        assert_eq!(health.status, ServiceHealthState::Unhealthy);
        assert!(!health.database.connected);
        assert_eq!(health.database.message.as_deref(), Some("Database connectivity check timed out"));

        drop(connection);
        let response = router.oneshot(request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let health: HealthStatus = serde_json::from_slice(&body).unwrap();
        assert!(health.database.connected);
    }
}
