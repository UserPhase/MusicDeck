//! # Cryptographic Password Hashing & Verification (`auth::passwords`)
//!
//! Ports `server/src/auth/passwords.ts` to Rust using `argon2` (`Argon2id`) as the
//! primary PHC hashing scheme while retaining transparent verification support for
//! existing `$2a$` / `$2b$` / `$2y$` Bcrypt (cost 12) password hashes stored in
//! migrated SQLite databases.
//!
//! ## Cryptographic Profile & Concurrency Model
//! - **Primary Algorithm**: `Argon2id` (version `0x13`) with OWASP-recommended parameters:
//!   - Memory cost ($m$): `19,456` KiB (~19 MiB)
//!   - Time cost ($t$): `2` iterations
//!   - Parallelism ($p$): `1` lane
//!   - Salt: 128-bit CSPRNG salt via `password_hash::SaltString::generate(&mut OsRng)`
//! - **Legacy Compatibility**: Any stored hash beginning with `$2a$`, `$2b$`, or `$2y$`
//!   is verified via `bcrypt::verify`, and [`needs_rehash`] reports `true` so the
//!   login handler can transparently upgrade the user's record to `Argon2id`.
//! - **Non-Blocking Execution**: Both [`hash_password`] and [`verify_password`] offload
//!   CPU-intensive key derivation onto `tokio::task::spawn_blocking` so Tokio I/O worker
//!   threads are never stalled during concurrent audio streaming.

use argon2::password_hash::rand_core::OsRng;
use argon2::{Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version};
use password_hash::SaltString;

use crate::auth::AuthError;

/// OWASP-recommended Argon2id memory cost in KiB (`19,456` KiB = 19 MiB).
pub const ARGON2_MEMORY_KIB: u32 = 19_456;

/// OWASP-recommended Argon2id iteration count (`2`).
pub const ARGON2_ITERATIONS: u32 = 2;

/// OWASP-recommended Argon2id degree of parallelism (`1`).
pub const ARGON2_PARALLELISM: u32 = 1;

/// Legacy Bcrypt cost factor (`12`) matching `PASSWORD_COST` in `server/src/auth/passwords.ts`.
pub const LEGACY_BCRYPT_COST: u32 = 12;

fn build_argon2() -> Result<Argon2<'static>, AuthError> {
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        None,
    )
    .map_err(|err| AuthError::Crypto(format!("Invalid Argon2id parameters: {err}")))?;

    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// Hashes a plaintext password using `Argon2id` on Tokio's blocking thread pool.
pub async fn hash_password(password: impl Into<String>) -> Result<String, AuthError> {
    let raw = password.into();
    if raw.is_empty() {
        return Err(AuthError::InvalidCredentials(String::from(
            "Password must not be empty",
        )));
    }

    tokio::task::spawn_blocking(move || hash_password_sync(&raw))
        .await
        .map_err(|err| AuthError::Crypto(format!("Password hashing task panicked: {err}")))?
}

/// Synchronous `Argon2id` password hashing helper.
pub fn hash_password_sync(password: &str) -> Result<String, AuthError> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = build_argon2()?;
    let phc = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|err| AuthError::Crypto(format!("Argon2id hashing failed: {err}")))?;
    Ok(phc.to_string())
}

/// Verifies `password` against `stored_hash` on Tokio's blocking thread pool.
///
/// Supports both PHC `$argon2id$...` strings and legacy `$2a$`/`$2b$`/`$2y$` Bcrypt
/// hashes migrated from the Node.js server.
pub async fn verify_password(
    password: impl Into<String>,
    stored_hash: impl Into<String>,
) -> Result<bool, AuthError> {
    let pw = password.into();
    let hash = stored_hash.into();

    tokio::task::spawn_blocking(move || verify_password_sync(&pw, &hash))
        .await
        .map_err(|err| AuthError::Crypto(format!("Password verification task panicked: {err}")))?
}

/// Synchronous dual-scheme (`Argon2id` + legacy `Bcrypt`) password verifier.
pub fn verify_password_sync(password: &str, stored_hash: &str) -> Result<bool, AuthError> {
    let trimmed = stored_hash.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }

    if trimmed.starts_with("$2a$") || trimmed.starts_with("$2b$") || trimmed.starts_with("$2y$") {
        return Ok(bcrypt::verify(password, trimmed).unwrap_or(false));
    }

    let parsed = match PasswordHash::new(trimmed) {
        Ok(h) => h,
        Err(_) => return Ok(false),
    };

    let argon2 = build_argon2()?;
    Ok(argon2
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

/// Returns `true` if `stored_hash` uses the legacy Bcrypt format and should be
/// transparently upgraded to `Argon2id` after a successful login.
#[must_use]
pub fn needs_rehash(stored_hash: &str) -> bool {
    !stored_hash.trim().starts_with("$argon2id$")
}
