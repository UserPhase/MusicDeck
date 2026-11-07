//! Application-wide, non-blocking admission for backup and restore mutations.

use super::RecoveryError;
use axum::{
    extract::{Request, State},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Debug, Clone, Default)]
pub struct RestoreState {
    active: Arc<AtomicBool>,
}

/// The reservation is released only when its last owner (including detached work) exits.
#[derive(Debug, Clone)]
pub struct RestoreGuard(Arc<Reservation>);

#[derive(Debug)]
struct Reservation {
    active: Arc<AtomicBool>,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

impl RestoreState {
    pub fn try_acquire(&self) -> Result<RestoreGuard, RecoveryError> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                RecoveryError::new("Another backup or restore is already running.", 409)
            })?;
        Ok(RestoreGuard(Arc::new(Reservation {
            active: self.active.clone(),
        })))
    }

    #[must_use]
    pub fn is_busy(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub(crate) fn validate(&self, guard: &RestoreGuard) -> Result<(), RecoveryError> {
        if !Arc::ptr_eq(&self.active, &guard.0.active) {
            return Err(RecoveryError::new(
                "Invalid backup/restore reservation.",
                500,
            ));
        }
        Ok(())
    }
}

/// Reserve before the runtime read/write gate, so overlapping requests never queue.
pub(crate) async fn admission_middleware(
    State(state): State<crate::AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    if request.method() == http::Method::POST
        && matches!(
            request.uri().path(),
            "/api/v1/admin/system/restore" | "/api/v1/admin/system/backups"
        )
    {
        let guard = match state.restore_state().try_acquire() {
            Ok(guard) => guard,
            Err(error) => return (
                http::StatusCode::CONFLICT,
                axum::Json(
                    serde_json::json!({"error":{"code":"RECOVERY_ERROR", "message":error.message}}),
                ),
            )
                .into_response(),
        };
        request.extensions_mut().insert(guard);
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_reservation_is_released_only_after_the_last_owner_exits() {
        let state = RestoreState::default();
        let other = state.clone();
        let guard = state.try_acquire().unwrap();
        let detached = guard.clone();
        assert_eq!(other.try_acquire().unwrap_err().status_code, 409);
        drop(guard);
        assert!(state.is_busy());
        drop(detached);
        assert!(!state.is_busy());
        assert!(other.try_acquire().is_ok());
    }
}
