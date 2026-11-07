//! # Authentication, Session Lifecycle, Rate Limiting & SSE Events (`auth`)
//!
//! Complete Rust port of `server/src/auth/*`:
//! - `passwords`: `Argon2id` password hashing + dual-scheme (`Argon2id` & legacy `Bcrypt`)
//!   verification on Tokio's blocking pool.
//! - `sessions`: SQLite + `Arc<RwLock<...>>` cached session lifecycle, sliding 30-day
//!   persistent cookies vs. 24-hour ephemeral cookies, and transactional session revocation.
//! - `authorization`: Axum `FromRequestParts` extractors ([`AuthenticatedUser`],
//!   [`RequireAdmin`], [`OptionalUser`]).
//! - `rate_limiter`: Fixed-window IP + NFKC-hashed username login rate limiter with
//!   non-evicting capacity bounds and concurrency permits.
//! - `events`: Real-time [`SessionEventBus`] and [`SessionStreamGuard`] for SSE streams.

pub mod authorization;
pub mod events;
pub mod passwords;
pub mod rate_limiter;
pub mod sessions;

use thiserror::Error;

pub use authorization::{AuthenticatedUser, OptionalUser, RequireAdmin};
pub use events::{
     STREAM_AUTH_CHECK_MS, SessionEvent, SessionEventBus, SessionStreamGuard,
    build_session_sse_stream,
};
pub use passwords::{
    ARGON2_ITERATIONS, ARGON2_MEMORY_KIB, ARGON2_PARALLELISM, LEGACY_BCRYPT_COST, hash_password,
    hash_password_sync, needs_rehash, verify_password, verify_password_sync,
};
pub use rate_limiter::{
    AdmissionPermit, AdmissionResult, LoginRateLimiter, RateLimiterConfig,
    hash_normalized_username,
};
pub use sessions::{
    EPHEMERAL_SESSION_HOURS, SESSION_COOKIE, SESSION_DAYS, Session, SessionStore, SessionUser,
    UserClaims, UserRole, append_set_cookie, create_session_on_conn, extract_session_cookie,
    format_clear_session_cookie, format_set_session_cookie, revoke_user_sessions_tx,
    row_to_session_user,
};

/// Type alias for authenticated user session records (`UserRecord` == `SessionUser`).
pub type UserRecord = SessionUser;

/// Unified error type for authentication, password hashing, session storage, and rate limiting.
#[derive(Debug, Error)]
pub enum AuthError {
    /// Cryptographic hashing or JWT signing/verification failure.
    #[error("Cryptographic operation failed: {0}")]
    Crypto(String),

    /// Invalid credentials or empty password input.
    #[error("{0}")]
    InvalidCredentials(String),

    /// Invalid rate-limiter configuration bounds.
    #[error("{0}")]
    InvalidRateLimitConfig(String),

    /// Unauthenticated or expired session/token.
    #[error("{0}")]
    Unauthorized(String),

    /// Insufficient role permissions.
    #[error("{0}")]
    Forbidden(String),

    /// Underlying SQLite query error.
    #[error("Session database error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AppConfig, LoginRateLimitConfig};
    use crate::db::{DbPool, run_migrations, seed_initial_data};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[tokio::test]
    async fn hashes_with_argon2id_and_verifies_both_argon2id_and_legacy_bcrypt() {
        let argon_hash = hash_password("correct-horse-battery-staple")
            .await
            .expect("hash password with Argon2id");
        assert!(argon_hash.starts_with("$argon2id$"));
        assert!(!needs_rehash(&argon_hash));

        assert!(
            verify_password("correct-horse-battery-staple", &argon_hash)
                .await
                .expect("verify valid Argon2id")
        );
        assert!(
            !verify_password("wrong-password", &argon_hash)
                .await
                .expect("reject invalid Argon2id")
        );

        // Verify legacy Bcrypt ($2b$12$...) compatibility
        let legacy_hash = bcrypt::hash("legacy-navidrome-pass", 4).expect("hash bcrypt");
        assert!(needs_rehash(&legacy_hash));
        assert!(
            verify_password("legacy-navidrome-pass", &legacy_hash)
                .await
                .expect("verify legacy bcrypt hash")
        );
        assert!(
            !verify_password("wrong-pass", &legacy_hash)
                .await
                .expect("reject wrong legacy bcrypt")
        );
    }

    #[test]
    fn rate_limiter_enforces_nfkc_normalization_concurrency_and_fail_closed_capacity() {
        let now_ms = Arc::new(AtomicU64::new(0));
        let clock_ref = Arc::clone(&now_ms);
        let limits = LoginRateLimitConfig {
            window_ms: 1000,
            ip_max: 3,
            account_max: 2,
            max_concurrent: 2,
            max_entries: 6,
        };

        let limiter =
            LoginRateLimiter::with_clock(limits, Arc::new(move || clock_ref.load(Ordering::SeqCst)))
                .expect("valid limiter");

        // 1. NFKC normalization across distinct IPs (" Alice ", "ＡＬＩＣＥ", "alice")
        {
            let p1 = limiter.admit("1.1.1.1", " Alice ");
            assert!(p1.is_allowed());
        }
        {
            let p2 = limiter.admit("2.2.2.2", "ＡＬＩＣＥ");
            assert!(p2.is_allowed());
        }
        let denied = limiter.admit("3.3.3.3", "alice");
        assert_eq!(denied.retry_after(), Some(1));

        // Advance past window -> allowed again
        now_ms.store(1000, Ordering::SeqCst);
        {
            let p3 = limiter.admit("3.3.3.3", "alice");
            assert!(p3.is_allowed());
        }

        // 2. Fail-closed capacity without evicting active buckets
        let cap_clock = Arc::new(AtomicU64::new(0));
        let cap_clock_ref = Arc::clone(&cap_clock);
        let tight_limiter = LoginRateLimiter::with_clock(
            LoginRateLimitConfig {
                max_entries: 2,
                ..limits
            },
            Arc::new(move || cap_clock_ref.load(Ordering::SeqCst)),
        )
        .expect("tight limiter");

        let long_user = "a".repeat(100_000);
        {
            let first = tight_limiter.admit("10.0.0.1", &long_user);
            assert!(first.is_allowed());
        }
        for idx in 0..50 {
            let attempt = tight_limiter.admit(&format!("10.0.0.{}", idx + 2), &format!("u{idx}"));
            assert!(!attempt.is_allowed());
            assert_eq!(tight_limiter.entry_count(), 2);
        }
    }

    #[tokio::test]
    async fn session_store_manages_persistent_ephemeral_and_revoked_sessions() {
        let pool = DbPool::connect_memory().await.expect("open memory pool");
        run_migrations(&pool, None).await.expect("run migrations");

        let mut cfg = AppConfig::default();
        cfg.database.database_path = String::from(":memory:");
        cfg.auth.first_admin.password = String::from("admin-password");
        seed_initial_data(&pool, &cfg).await.expect("seed admin");

        let store = SessionStore::new(pool.clone(), "session-test-secret");
        let admin_id: String = sqlx::query_scalar("SELECT id FROM users WHERE username = 'admin';")
            .fetch_one(pool.inner())
            .await
            .expect("query admin");

        // Create a persistent session and an ephemeral session
        let persistent = store
            .create_session(&admin_id, true)
            .await
            .expect("create persistent session");
        let ephemeral = store
            .create_session(&admin_id, false)
            .await
            .expect("create ephemeral session");

        assert!(persistent.persistent);
        assert!(!ephemeral.persistent);

        let resolved = store
            .get_session_user_by_id(&persistent.id)
            .await
            .expect("resolve session")
            .expect("user exists");
        assert_eq!(resolved.username, "admin");
        assert!(resolved.is_admin());

        // Persistent session refreshes cookie; ephemeral session does not
        assert!(
            store
                .refresh_session_if_remembered(&persistent.id, false)
                .await
                .expect("refresh persistent")
                .is_some()
        );
        assert!(
            store
                .refresh_session_if_remembered(&ephemeral.id, false)
                .await
                .expect("refresh ephemeral")
                .is_none()
        );

        // Self-service revocation retains `persistent.id` while revoking `ephemeral.id`
        let mut conn = pool.inner().acquire().await.expect("acquire conn");
        revoke_user_sessions_tx(&mut conn, &admin_id, Some(&persistent.id))
            .await
            .expect("revoke other sessions");
        drop(conn);
        store
            .notify_user_sessions_revoked(&admin_id, Some(&persistent.id))
            .await;

        assert!(
            store
                .get_session_user_by_id(&persistent.id)
                .await
                .expect("check retained")
                .is_some()
        );
        assert!(
            store
                .get_session_user_by_id(&ephemeral.id)
                .await
                .expect("check revoked")
                .is_none()
        );

        pool.close().await;
    }
}
