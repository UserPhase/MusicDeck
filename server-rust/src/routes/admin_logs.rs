//! # Administrative Audit Log Inspection & SSE Streaming Routes (`routes::admin_logs`)
//!
//! Complete Rust port of `server/src/routes/admin-logs-routes.ts`.
//!
//! ## Endpoints & Safeguards
//! - `GET /api/admin/logs`: Admin-only query endpoint accepting `level` (`error`, `warn`,
//!   `info`, `debug`), `limit` (`1..=1000`, default `200`), and `after` (`>= 0`). Returns
//!   `{ "entries": [...], "stats": {...} }`.
//! - `DELETE /api/admin/logs`: Admin-only endpoint that clears the in-memory [`LogBuffer`],
//!   records an audit log entry (`"server log buffer cleared"` with `adminId`), and returns
//!   `204 No Content`.
//! - `GET /api/admin/logs/stream`: Admin-only Server-Sent Events (SSE) stream:
//!   - Caps concurrent open log streams at [`MAX_LOG_STREAMS`] (`10`), returning
//!     `HTTP 429 Too Many Requests` (`TOO_MANY_STREAMS`) when saturated.
//!   - Replays missed entries in batches of `200` (`STREAM_BATCH_MAX`) based on
//!     `Last-Event-ID` or `?after=<seq>`.
//!   - Periodically revalidates the administrator's session via [`SessionStreamGuard`]
//!     so revoking or demoting the admin immediately closes the log stream.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::{Query, State};
use axum::http::header::{CACHE_CONTROL, HeaderMap};
use axum::http::{HeaderValue, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Serialize;
use serde_json::json;
use tokio_stream::Stream;
use tokio_stream::wrappers::ReceiverStream;

use crate::auth::{RequireAdmin, STREAM_AUTH_CHECK_MS, SessionStreamGuard};
use crate::error::{ApiErrorBody, ApiErrorEnvelope};
use crate::logger::{
    LogBufferStats, LogEntry, LogInput, LogLevel, LogListOptions, LogSource, LogStreamEvent,
};
use crate::state::AppState;

/// Maximum number of concurrent `/api/admin/logs/stream` SSE connections permitted.
pub const MAX_LOG_STREAMS: usize = 10;

/// Maximum number of log entries sent in a single SSE `logs` batch frame.
pub const STREAM_BATCH_MAX: usize = 200;

/// Response payload for `GET /api/admin/logs`.
#[derive(Debug, Serialize)]
pub struct AdminLogsListResponse {
    /// Filtered slice of redacted log entries (oldest to newest).
    pub entries: Vec<LogEntry>,
    /// Current ring buffer capacity and byte utilization stats.
    pub stats: LogBufferStats,
}

struct StreamSlotGuard {
    counter: Arc<AtomicUsize>,
}

impl Drop for StreamSlotGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Registers `/api/admin/logs` (`GET`, `DELETE`) and `/api/admin/logs/stream` (`GET`).
pub fn admin_logs_routes() -> Router<AppState> {
    Router::new()
        .route("/api/admin/logs", get(list_admin_logs).delete(clear_admin_logs))
        .route("/api/admin/logs/stream", get(stream_admin_logs))
}

/// `GET /api/admin/logs` (admin only)
async fn list_admin_logs(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let invalid = || {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: String::from("VALIDATION_ERROR"),
                    message: String::from(
                        "level must be error, warn, info or debug and limit 1-1000",
                    ),
                },
            }),
        )
            .into_response()
    };

    let level = if let Some(raw_level) = params.get("level") {
        let Some(parsed) = LogLevel::parse_str(raw_level) else {
            return invalid();
        };
        if !matches!(
            raw_level.trim(),
            "error" | "warn" | "info" | "debug"
        ) {
            return invalid();
        }
        Some(parsed)
    } else {
        None
    };

    let limit = if let Some(raw_limit) = params.get("limit") {
        let Ok(parsed) = raw_limit.trim().parse::<usize>() else {
            return invalid();
        };
        if !(1..=1_000).contains(&parsed) {
            return invalid();
        }
        parsed
    } else {
        200
    };

    let after = if let Some(raw_after) = params.get("after") {
        let Ok(parsed) = raw_after.trim().parse::<u64>() else {
            return invalid();
        };
        Some(parsed)
    } else {
        None
    };

    let logs = state.logs();
    let entries = logs
        .list_async(LogListOptions {
            level,
            limit: Some(limit),
            after,
        })
        .await;
    let stats = logs.stats_async().await;

    Json(AdminLogsListResponse { entries, stats }).into_response()
}

/// `DELETE /api/admin/logs` (admin only)
async fn clear_admin_logs(
    State(state): State<AppState>,
    admin: RequireAdmin,
) -> Response {
    state.logs().clear_async().await;

    let mut meta = serde_json::Map::new();
    meta.insert(
        String::from("adminId"),
        serde_json::Value::String(admin.user.id),
    );
    state
        .logs()
        .push_async(LogInput {
            level: LogLevel::Info,
            source: LogSource::Server,
            message: String::from("server log buffer cleared"),
            stack: None,
            meta: Some(meta),
            time: None,
        })
        .await;

    StatusCode::NO_CONTENT.into_response()
}

/// `GET /api/admin/logs/stream` (admin only SSE)
async fn stream_admin_logs(
    State(state): State<AppState>,
    admin: RequireAdmin,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let query_after = if let Some(raw_after) = params.get("after") {
        let Ok(parsed) = raw_after.trim().parse::<u64>() else {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiErrorEnvelope {
                    error: ApiErrorBody {
                        code: String::from("VALIDATION_ERROR"),
                        message: String::from("after must be a log sequence number"),
                    },
                }),
            )
                .into_response();
        };
        Some(parsed)
    } else {
        None
    };

    let header_after = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok());
    let after = header_after.or(query_after);

    // Enforce `MAX_LOG_STREAMS` concurrency cap
    let counter = state.open_log_streams_counter();
    let previous = counter.fetch_add(1, Ordering::AcqRel);
    if previous >= MAX_LOG_STREAMS {
        counter.fetch_sub(1, Ordering::AcqRel);
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: String::from("TOO_MANY_STREAMS"),
                    message: String::from("Too many open log streams"),
                },
            }),
        )
            .into_response();
    }
    let slot_guard = StreamSlotGuard { counter };

    let logs = state.logs().clone();
    let session_guard = state
        .session_store()
        .cloned()
        .map(|store| SessionStreamGuard::new(store, admin.session_id, true));

    let sse = build_admin_logs_sse(logs, after, session_guard, slot_guard);
    let mut response = sse.into_response();
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-transform"),
    );
    response.headers_mut().insert(
        axum::http::header::HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    response
}

fn build_admin_logs_sse(
    logs: crate::logger::LogBuffer,
    after: Option<u64>,
    session_guard: Option<SessionStreamGuard>,
    slot_guard: StreamSlotGuard,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<SseEvent, Infallible>>(32);
    let mut log_rx = logs.subscribe();

    tokio::spawn(async move {
        let _keep_slot_alive = slot_guard;

        // 1. Send initial `ready` event with buffer stats
        let initial_stats = logs.stats_async().await;
        let ready_ev = SseEvent::default()
            .event("ready")
            .data(json!({ "stats": initial_stats }).to_string());
        if tx.send(Ok(ready_ev)).await.is_err() {
            return;
        }

        // 2. Replay missed entries if `after` (or `Last-Event-ID`) was supplied
        if let Some(after_seq) = after {
            let missed = logs
                .list_async(LogListOptions {
                    after: Some(after_seq),
                    ..Default::default()
                })
                .await;

            for batch in missed.chunks(STREAM_BATCH_MAX) {
                if let Some(last) = batch.last() {
                    let batch_ev = SseEvent::default()
                        .id(last.id.clone())
                        .event("logs")
                        .data(json!({ "entries": batch }).to_string());
                    if tx.send(Ok(batch_ev)).await.is_err() {
                        return;
                    }
                }
            }
        }

        // 3. Stream live events and periodically revalidate admin session
        let mut auth_ticker = tokio::time::interval(Duration::from_millis(STREAM_AUTH_CHECK_MS));
        auth_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                _ = auth_ticker.tick() => {
                    if let Some(ref guard) = session_guard
                        && guard.current_user().await.is_none()
                    {
                        break;
                    }
                }
                recv_res = log_rx.recv() => {
                    match recv_res {
                        Ok(LogStreamEvent::Entry(entry)) => {
                            if let Some(ref guard) = session_guard
                                && guard.current_user().await.is_none()
                            {
                                break;
                            }
                            let ev = SseEvent::default()
                                .id(entry.id.clone())
                                .event("logs")
                                .data(json!({ "entries": [entry] }).to_string());
                            if tx.send(Ok(ev)).await.is_err() {
                                break;
                            }
                        }
                        Ok(LogStreamEvent::Cleared) => {
                            let ev = SseEvent::default()
                                .event("cleared")
                                .data("{}");
                            if tx.send(Ok(ev)).await.is_err() {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    });

    Sse::new(ReceiverStream::new(rx)).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(25))
            .event(SseEvent::default().event("ping").data("{}")),
    )
}
