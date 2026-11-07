//! # Adaptive Fixed-Window Login Rate Limiter (`auth::rate_limiter`)
//!
//! Complete Rust port of `server/src/auth/login-rate-limiter.ts`.
//!
//! ## Security & Memory-Safety Invariants
//! 1. **Dual-Key Tracking (`ip:<addr>` + `account:<sha256(normalized_username)>`)**:
//!    - Every login attempt is accounted against both the client IP address and the
//!      SHA-256 digest of `username.trim().nfkc().to_lowercase()`.
//!    - Hashing the normalized username prevents attackers from exhausting heap memory
//!      by submitting multi-megabyte username strings (`"a".repeat(100_000)`).
//! 2. **Non-Evicting Capacity Ceiling (`max_entries`)**:
//!    - When the bucket map reaches `max_entries`, expired buckets are swept first.
//!    - If `buckets.len() + missing > max_entries` still holds after cleanup, the
//!      limiter **fails closed** (returning `AdmissionResult::Denied` with `retry_after`
//!      computed from the earliest bucket expiration) rather than evicting live buckets,
//!      so rotating IPs/usernames can never reset an active lockout.
//! 3. **Bounded Concurrent Verification (`max_concurrent`)**:
//!    - Caps simultaneous in-flight password verifications (`Argon2id` / `Bcrypt`) to
//!      protect CPU cores and the blocking thread pool.
//!    - [`AdmissionPermit`] releases the concurrency slot idempotently on `Drop` or
//!      explicit `.release()`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::auth::AuthError;
use crate::config::{LoginRateLimitConfig, MAX_SAFE_INTEGER};

/// Type alias matching the prompt's `RateLimiterConfig` specification.
pub type RateLimiterConfig = LoginRateLimitConfig;

#[derive(Debug, Clone, Copy)]
struct Bucket {
    attempts: u64,
    expires_at_ms: u64,
}

#[derive(Debug)]
struct RateLimiterInner {
    config: LoginRateLimitConfig,
    buckets: HashMap<String, Bucket>,
    active_concurrent: u64,
    next_cleanup_ms: u64,
}

/// Outcome of [`LoginRateLimiter::admit`].
#[derive(Debug)]
pub enum AdmissionResult {
    /// Request is admitted; caller holds an [`AdmissionPermit`] that decrements
    /// `active_concurrent` when dropped or explicitly released.
    Allowed(AdmissionPermit),
    /// Request is rate-limited; caller must return `HTTP 429 Too Many Requests`
    /// with `Retry-After: <retry_after_secs>`.
    Denied {
        /// Seconds until the client may retry (`\ge 1`).
        retry_after_secs: u64,
    },
}

impl AdmissionResult {
    /// Returns `true` if the login attempt was admitted.
    #[must_use]
    pub const fn is_allowed(&self) -> bool {
        matches!(self, Self::Allowed(_))
    }

    /// Returns the `retry_after_secs` value when denied, or `None` when allowed.
    #[must_use]
    pub const fn retry_after(&self) -> Option<u64> {
        match self {
            Self::Allowed(_) => None,
            Self::Denied { retry_after_secs } => Some(*retry_after_secs),
        }
    }
}

/// RAII concurrency guard returned when [`LoginRateLimiter::admit`] succeeds.
///
/// Releasing the permit is idempotent: calling [`AdmissionPermit::release`] or
/// dropping the guard decrements `active_concurrent` at most once.
#[derive(Debug, Clone)]
pub struct AdmissionPermit {
    inner: Arc<Mutex<RateLimiterInner>>,
    released: Arc<AtomicBool>,
}

impl AdmissionPermit {
    /// Explicitly releases the in-flight concurrency slot. Idempotent.
    pub fn release(&self) {
        if !self.released.swap(true, Ordering::AcqRel)
            && let Ok(mut guard) = self.inner.lock()
        {
            guard.active_concurrent = guard.active_concurrent.saturating_sub(1);
        }
    }
}

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        self.release();
    }
}

/// Thread-safe login rate limiter keyed by IP address and NFKC-normalized username hash.
#[derive(Clone)]
pub struct LoginRateLimiter {
    inner: Arc<Mutex<RateLimiterInner>>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl std::fmt::Debug for LoginRateLimiter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginRateLimiter")
            .field("entry_count", &self.entry_count())
            .finish()
    }
}

impl Default for LoginRateLimiter {
    fn default() -> Self {
        Self::new(LoginRateLimitConfig::default()).expect("default LoginRateLimitConfig is valid")
    }
}

impl LoginRateLimiter {
    /// Constructs a [`LoginRateLimiter`] using the system UTC clock.
    pub fn new(config: LoginRateLimitConfig) -> Result<Self, AuthError> {
        Self::with_clock(config, Arc::new(default_now_ms))
    }

    /// Constructs a [`LoginRateLimiter`] with an injectable millisecond clock for deterministic testing.
    pub fn with_clock(
        config: LoginRateLimitConfig,
        clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Result<Self, AuthError> {
        validate_rate_limit_config(&config)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(RateLimiterInner {
                config,
                buckets: HashMap::new(),
                active_concurrent: 0,
                next_cleanup_ms: 0,
            })),
            clock,
        })
    }

    /// Returns the number of active rate-limit buckets currently stored.
    #[must_use]
    pub fn entry_count(&self) -> usize {
        self.inner.lock().map_or(0, |g| g.buckets.len())
    }

    /// Sweeps expired buckets using the current clock reading.
    pub fn cleanup(&self) {
        let now = (self.clock)();
        self.cleanup_at(now);
    }

    /// Sweeps expired buckets at a specific millisecond timestamp `now_ms`.
    pub fn cleanup_at(&self, now_ms: u64) {
        if let Ok(mut guard) = self.inner.lock() {
            Self::cleanup_locked(&mut guard, now_ms);
        }
    }

    /// Evaluates whether a login attempt from `ip` for `username` is permitted.
    ///
    /// Executes admission and cleanup on a single clock snapshot so bucket expiry
    /// and capacity checks remain mutually consistent.
    #[must_use]
    pub fn admit(&self, ip: &str, username: &str) -> AdmissionResult {
        let now = (self.clock)();
        let account_hash = hash_normalized_username(username);
        let keys = [format!("ip:{ip}"), format!("account:{account_hash}")];

        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };

        if now >= guard.next_cleanup_ms {
            Self::cleanup_locked(&mut guard, now);
        }

        let limits = [guard.config.ip_max, guard.config.account_max];
        for key in &keys {
            if guard
                .buckets
                .get(key)
                .is_some_and(|bucket| bucket.expires_at_ms <= now)
            {
                guard.buckets.remove(key);
            }
        }

        let mut blocked_until_ms = 0u64;
        for (idx, key) in keys.iter().enumerate() {
            if let Some(bucket) = guard.buckets.get(key)
                && bucket.attempts >= limits[idx]
            {
                blocked_until_ms = blocked_until_ms.max(bucket.expires_at_ms);
            }
        }

        if blocked_until_ms > now {
            let retry_after_secs = blocked_until_ms.saturating_sub(now).div_ceil(1000).max(1);
            return AdmissionResult::Denied { retry_after_secs };
        }

        if guard.active_concurrent >= guard.config.max_concurrent {
            return AdmissionResult::Denied {
                retry_after_secs: 1,
            };
        }

        let missing_keys = keys
            .iter()
            .filter(|k| !guard.buckets.contains_key(*k))
            .count() as u64;
        if (guard.buckets.len() as u64) + missing_keys > guard.config.max_entries {
            Self::cleanup_locked(&mut guard, now);
            let missing_after_cleanup = keys
                .iter()
                .filter(|k| !guard.buckets.contains_key(*k))
                .count() as u64;
            if (guard.buckets.len() as u64) + missing_after_cleanup > guard.config.max_entries {
                // Fail closed without evicting live buckets.
                let earliest_expiry = guard
                    .buckets
                    .values()
                    .map(|b| b.expires_at_ms)
                    .min()
                    .unwrap_or(now + 1000);
                let retry_after_secs = earliest_expiry.saturating_sub(now).div_ceil(1000).max(1);
                return AdmissionResult::Denied { retry_after_secs };
            }
        }

        let window_ms = guard.config.window_ms;
        for key in keys {
            let entry = guard.buckets.entry(key).or_insert(Bucket {
                attempts: 0,
                expires_at_ms: now.saturating_add(window_ms),
            });
            entry.attempts = entry.attempts.saturating_add(1);
        }

        guard.active_concurrent = guard.active_concurrent.saturating_add(1);
        drop(guard);

        AdmissionResult::Allowed(AdmissionPermit {
            inner: Arc::clone(&self.inner),
            released: Arc::new(AtomicBool::new(false)),
        })
    }

    fn cleanup_locked(guard: &mut RateLimiterInner, now_ms: u64) {
        guard
            .buckets
            .retain(|_, bucket| bucket.expires_at_ms > now_ms);
        guard.next_cleanup_ms = now_ms.saturating_add(guard.config.window_ms.min(60_000));
    }
}

/// Normalizes `username` via `trim() -> NFKC -> lowercase` and returns its hex SHA-256 digest.
#[must_use]
pub fn hash_normalized_username(username: &str) -> String {
    let normalized: String = username.trim().nfkc().collect::<String>().to_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    let mut hex_out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex_out, "{byte:02x}");
    }
    hex_out
}

fn validate_rate_limit_config(config: &LoginRateLimitConfig) -> Result<(), AuthError> {
    for (name, val) in [
        ("windowMs", config.window_ms),
        ("ipMax", config.ip_max),
        ("accountMax", config.account_max),
        ("maxConcurrent", config.max_concurrent),
        ("maxEntries", config.max_entries),
    ] {
        if val == 0 || val > MAX_SAFE_INTEGER {
            return Err(AuthError::InvalidRateLimitConfig(format!(
                "Login rate limit {name} must be a positive safe integer"
            )));
        }
    }
    if config.max_entries < 2 {
        return Err(AuthError::InvalidRateLimitConfig(String::from(
            "Login rate limit maxEntries must be at least 2",
        )));
    }
    Ok(())
}

fn default_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}
