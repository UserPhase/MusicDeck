//! # Real-Time Session Events & SSE Stream Guard (`auth::events`)
//!
//! Ports `server/src/auth/session-events.ts` and `server/src/auth/session-stream.ts`
//! using `tokio::sync::broadcast` and `tokio_stream::wrappers::BroadcastStream`.
//!
//! ## Lifecycle & Security Guarantees
//! - Mutations that alter user authorization (logout, password change, admin password
//!   reset, account disable, role downgrade, or user deletion) emit a [`SessionEvent`]
//!   **only after** the underlying SQLite transaction has committed.
//! - Long-lived SSE streams (`/api/acquisitions/events`, `/api/admin/logs/stream`,
//!   `/api/auth/session/events`) subscribe to [`SessionEventBus`] and re-verify the
//!   caller's session every [`STREAM_AUTH_CHECK_MS`] (`5,000` ms) as well as immediately
//!   upon receiving any [`SessionEvent`], terminating the stream the instant the
//!   session expires or loses required privileges.

use std::convert::Infallible;
use std::time::Duration;

use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio_stream::Stream;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

use crate::auth::sessions::{SessionStore, SessionUser};

/// Periodic session revalidation interval (`5,000` ms) for active SSE streams,
/// matching `STREAM_AUTH_CHECK_MS` in `server/src/auth/session-stream.ts`.
pub const STREAM_AUTH_CHECK_MS: u64 = 5_000;

/// Real-time authorization state change event broadcast across the server instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    /// A single session ID was explicitly logged out or deleted.
    SessionRevoked {
        /// Revoked session ID.
        session_id: String,
    },
    /// All sessions for `user_id` (optionally excluding `except_session_id`) were revoked.
    UserSessionsRevoked {
        /// Target user ID.
        user_id: String,
        /// Optional session ID retained during self-service password change.
        except_session_id: Option<String>,
    },
    /// A user's role, disabled flag, or profile permissions changed.
    UserUpdated {
        /// Target user ID.
        user_id: String,
    },
    /// General notification matching `notifySessionChanges(db)` in `session-events.ts`.
    SessionChanged {
        /// UTC millisecond timestamp of the notification.
        timestamp_ms: i64,
    },
}

/// Asynchronous broadcast bus for session and authorization state changes.
#[derive(Debug, Clone)]
pub struct SessionEventBus {
    tx: broadcast::Sender<SessionEvent>,
}

impl Default for SessionEventBus {
    fn default() -> Self {
        Self::new(256)
    }
}

impl SessionEventBus {
    /// Creates a new [`SessionEventBus`] with the specified ring capacity.
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity.max(16));
        Self { tx }
    }

    /// Publishes a [`SessionEvent`] to all active WebSocket and SSE listeners.
    pub fn publish(&self, event: SessionEvent) {
        let _ = self.tx.send(event);
    }

    /// Emits a general session change notification (equivalent to `notifySessionChanges(db)`).
    pub fn notify_changes(&self) {
        self.publish(SessionEvent::SessionChanged {
            timestamp_ms: Utc::now().timestamp_millis(),
        });
    }

    /// Subscribes to live [`SessionEvent`] notifications.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.tx.subscribe()
    }
}

/// Active session guard for long-lived SSE streams (`server/src/auth/session-stream.ts`).
///
/// Re-evaluates the session against [`SessionStore`] on demand and checks role constraints.
#[derive(Debug, Clone)]
pub struct SessionStreamGuard {
    store: SessionStore,
    session_id: String,
    requires_admin: bool,
}

impl SessionStreamGuard {
    /// Creates a new [`SessionStreamGuard`] for `session_id`.
    #[must_use]
    pub const fn new(store: SessionStore, session_id: String, requires_admin: bool) -> Self {
        Self {
            store,
            session_id,
            requires_admin,
        }
    }

    /// Revalidates the bound session ID against SQLite / [`SessionStore`] and returns
    /// the current [`SessionUser`] if still active and authorized.
    pub async fn current_user(&self) -> Option<SessionUser> {
        match self.store.get_session_user_by_id(&self.session_id).await {
            Ok(Some(user)) if !self.requires_admin || user.is_admin() => Some(user),
            _ => None,
        }
    }
}

/// Builds an Axum [`Sse`] stream backed by `tokio_stream::wrappers::BroadcastStream`
/// that pushes real-time session status updates to the authenticated client and closes
/// automatically if the session is revoked or expires.
pub fn build_session_sse_stream(
    store: SessionStore,
    session_id: String,
    requires_admin: bool,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let guard = SessionStreamGuard::new(store.clone(), session_id.clone(), requires_admin);
    let rx = store.events().subscribe();
    let broadcast_stream = BroadcastStream::new(rx);

    let stream = async_stream_session_events(guard, session_id, broadcast_stream);

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(25))
            .text("ping"),
    )
}

fn async_stream_session_events(
    guard: SessionStreamGuard,
    session_id: String,
    mut broadcast_stream: BroadcastStream<SessionEvent>,
) -> impl Stream<Item = Result<SseEvent, Infallible>> {
    let mut ticker = tokio::time::interval(Duration::from_millis(STREAM_AUTH_CHECK_MS));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // State machine driven via `futures`/`tokio::select!` inside an unfold stream:
    struct StreamState {
        guard: SessionStreamGuard,
        session_id: String,
        broadcast_stream: BroadcastStream<SessionEvent>,
        ticker: tokio::time::Interval,
        initial_sent: bool,
        terminated: bool,
    }

    let init = StreamState {
        guard,
        session_id,
        broadcast_stream: {
            let _ = &mut broadcast_stream;
            broadcast_stream
        },
        ticker,
        initial_sent: false,
        terminated: false,
    };

    futures_unfold(init, |mut state| async move {
        if state.terminated {
            return None;
        }

        if !state.initial_sent {
            state.initial_sent = true;
            if let Some(user) = state.guard.current_user().await {
                let payload = serde_json::json!({
                    "authenticated": true,
                    "user": user,
                });
                let ev = SseEvent::default()
                    .event("session")
                    .data(payload.to_string());
                return Some((Ok(ev), state));
            }
            return None;
        }

        loop {
            tokio::select! {
                _ = state.ticker.tick() => {
                    if state.guard.current_user().await.is_none() {
                        state.terminated = true;
                        let ev = SseEvent::default()
                            .event("revoked")
                            .data(r#"{"authenticated":false,"reason":"session_expired"}"#);
                        return Some((Ok(ev), state));
                    }
                }
                maybe_item = state.broadcast_stream.next() => {
                    match maybe_item {
                        Some(Ok(event)) => {
                            let relevant = match &event {
                                SessionEvent::SessionRevoked { session_id } => {
                                    session_id == &state.session_id
                                }
                                SessionEvent::UserSessionsRevoked { except_session_id, .. } => {
                                    except_session_id.as_deref() != Some(state.session_id.as_str())
                                }
                                SessionEvent::UserUpdated { .. } | SessionEvent::SessionChanged { .. } => true,
                            };

                            if relevant {
                                match state.guard.current_user().await {
                                    Some(user) => {
                                        let payload = serde_json::json!({
                                            "authenticated": true,
                                            "user": user,
                                        });
                                        let ev = SseEvent::default()
                                            .event("session")
                                            .data(payload.to_string());
                                        return Some((Ok(ev), state));
                                    }
                                    None => {
                                        state.terminated = true;
                                        let ev = SseEvent::default()
                                            .event("revoked")
                                            .data(r#"{"authenticated":false,"reason":"session_revoked"}"#);
                                        return Some((Ok(ev), state));
                                    }
                                }
                            }
                        }
                        Some(Err(_lagged)) => {
                            if state.guard.current_user().await.is_none() {
                                state.terminated = true;
                                let ev = SseEvent::default()
                                    .event("revoked")
                                    .data(r#"{"authenticated":false,"reason":"session_revoked"}"#);
                                return Some((Ok(ev), state));
                            }
                        }
                        None => return None,
                    }
                }
            }
        }
    })
}

/// Minimal zero-dependency `Stream` unfold combinator so we do not require `futures-util`
/// solely for `stream::unfold`.
fn futures_unfold<T, St, F, Fut>(init: St, f: F) -> impl Stream<Item = T>
where
    T: Send + 'static,
    St: Send + 'static,
    F: FnMut(St) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Option<(T, St)>> + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel::<T>(16);
    tokio::spawn(async move {
        let mut state = init;
        let mut step = f;
        while let Some((item, next_state)) = step(state).await {
            if tx.send(item).await.is_err() {
                break;
            }
            state = next_state;
        }
    });

    tokio_stream::wrappers::ReceiverStream::new(rx)
}
