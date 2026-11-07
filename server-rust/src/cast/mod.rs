//! # Google Cast Cryptographic Ticket & Stream Proxy Gateway (`cast`)
//!
//! Complete Rust port of `server/src/routes/cast.ts`.
//!
//! ## Security & Capability Lease Architecture
//! 1. **Track-Scoped Cryptographic Capability Tokens (`/api/v1/cast/ticket`)**:
//!    - Cast hardware receivers never receive a user's `musicdeck_session` cookie or raw
//!      Navidrome/Jellyfin upstream URLs.
//!    - [`CastGateway::create_ticket`] generates a 256-bit HMAC-SHA256 signed capability
//!      token (`64` lowercase hex characters) derived from the server's `session_secret`,
//!      a CSPRNG nonce, the user's `session_id`, `track_id`, and expiration timestamp, and
//!      stores only `sha256(token)` as the lookup key in the bounded lease table.
//! 2. **Strict Concurrency & Lease Quotas**:
//!    - Maximum [`MAX_LEASES_PER_SESSION`] (`8`) active Cast tickets per login session.
//!    - Maximum [`MAX_GLOBAL_CAST_LEASES`] (`4096`) active Cast tickets server-wide.
//!    - Maximum [`MAX_RECEIVER_CONNECTIONS_PER_LEASE`] (`4`) simultaneous HTTP stream
//!      connections per ticket (`429 Too Many Requests`).
//! 3. **Codec Verification (`422 CAST_FORMAT_UNKNOWN`)**:
//!    - When `maxBitRate` (`128`, `256`, or `320` kbps) is specified, the stream is
//!      transcoded to `audio/mpeg`.
//!    - When `maxBitRate` is omitted (direct play), the track's codec and container are
//!      inspected via [`crate::inspector::source_properties`], mapping to `audio/flac`,
//!      `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/wav`, `audio/aiff`, `audio/webm`,
//!      or `audio/ogg`. If the source format is unknown, ticket creation fails early with
//!      `HTTP 422 Unprocessable Entity` (`CAST_FORMAT_UNKNOWN`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use argon2::password_hash::rand_core::{OsRng, RngCore};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;

use crate::inspector::source_properties;
use crate::providers::AudioMetadataSummary;

type HmacSha256 = Hmac<Sha256>;

/// Default Cast ticket lease lifetime (`24` hours in milliseconds), matching `LEASE_MS` in `cast.ts`.
pub const CAST_LEASE_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// Maximum active Cast tickets allowed per login session (`8`).
pub const MAX_LEASES_PER_SESSION: usize = 8;

/// Maximum active Cast tickets allowed globally across the server (`4096`).
pub const MAX_GLOBAL_CAST_LEASES: usize = 4096;

/// Maximum concurrent HTTP stream connections per Cast ticket (`4`).
pub const MAX_RECEIVER_CONNECTIONS_PER_LEASE: usize = 4;

/// Request payload for `POST /api/v1/cast/ticket` (`ticketSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CastTicketRequest {
    /// Library track ID (`md_...`, `1..=300` chars).
    pub track_id: String,
    /// Optional transcode bitrate cap (`128`, `256`, or `320` kbps).
    pub max_bit_rate: Option<u32>,
}

/// Response payload returned by `POST /api/v1/cast/ticket`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastTicketResponse {
    /// 64-character hex capability token.
    pub token: String,
    /// Full absolute Cast stream URL (`<publicUrl>/api/v1/cast/stream?token=<token>`).
    pub url: String,
    /// Resolved MIME content type (`audio/flac`, `audio/mpeg`, `audio/mp4`, etc.).
    pub content_type: String,
    /// ISO-8601 expiration timestamp.
    pub expires_at: String,
}

/// Active Cast capability lease tracked in memory.
#[derive(Debug, Clone)]
pub struct CastLease {
    /// Owning login session ID (`musicdeck_session`).
    pub session_id: String,
    /// Owning user ID.
    pub user_id: String,
    /// Target library track ID.
    pub track_id: String,
    /// Optional bitrate cap in kbps (`128`, `256`, `320`).
    pub max_bit_rate: Option<u32>,
    /// Resolved MIME content type.
    pub content_type: String,
    /// Expiration timestamp in epoch milliseconds.
    pub expires_at_ms: i64,
    /// Number of currently open receiver stream connections using this lease.
    pub active_connections: usize,
}

/// Error taxonomy for Google Cast ticket and stream operations.
#[derive(Debug, Error)]
pub enum CastError {
    /// Invalid request body or token syntax (`400 Bad Request`, `VALIDATION_ERROR`).
    #[error("{0}")]
    Validation(String),

    /// Missing, expired, or revoked Cast token (`401 Unauthorized`).
    #[error("{0}")]
    Unauthorized(String),

    /// Ticket belongs to a different user session (`403 Forbidden`).
    #[error("{0}")]
    Forbidden(String),

    /// Library track not found (`404 Not Found`).
    #[error("Library track not found")]
    NotFound,

    /// Source audio codec is unknown and no `maxBitRate` transcode was requested (`422 CAST_FORMAT_UNKNOWN`).
    #[error(
        "The source format is unknown. Choose 128, 256 or 320 kbps in Audio Quality before casting."
    )]
    FormatUnknown,

    /// Lease or receiver connection quota exceeded (`429 Too Many Requests`, `CAST_LIMIT`).
    #[error("{0}")]
    RateLimited(String),
}

/// RAII guard that decrements `active_connections` on a Cast lease when the receiver HTTP
/// stream finishes or disconnects.
#[derive(Debug)]
pub struct CastReceiverConnectionGuard {
    leases: Arc<Mutex<HashMap<String, CastLease>>>,
    lease_key: String,
}

impl Drop for CastReceiverConnectionGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.leases.lock()
            && let Some(lease) = guard.get_mut(&self.lease_key)
        {
            lease.active_connections = lease.active_connections.saturating_sub(1);
        }
    }
}

/// Thread-safe Google Cast capability lease manager and HMAC-SHA256 token signer.
#[derive(Debug, Clone)]
pub struct CastGateway {
    leases: Arc<Mutex<HashMap<String, CastLease>>>,
    hmac_secret: Arc<Vec<u8>>,
}

impl Default for CastGateway {
    fn default() -> Self {
        Self::new("default-cast-hmac-secret")
    }
}

impl CastGateway {
    /// Creates a new [`CastGateway`] using `hmac_secret` to sign capability tokens.
    #[must_use]
    pub fn new(hmac_secret: impl AsRef<[u8]>) -> Self {
        Self {
            leases: Arc::new(Mutex::new(HashMap::new())),
            hmac_secret: Arc::new(hmac_secret.as_ref().to_vec()),
        }
    }

    /// Resolves the MIME `contentType` for a Cast track given its [`AudioMetadataSummary`]
    /// and optional `max_bit_rate`, matching `cast.ts`.
    pub fn resolve_cast_content_type(
        source_meta: Option<&AudioMetadataSummary>,
        max_bit_rate: Option<u32>,
    ) -> Result<String, CastError> {
        if let Some(kbps) = max_bit_rate {
            if !matches!(kbps, 128 | 256 | 320) {
                return Err(CastError::Validation(String::from(
                    "Invalid Cast track request",
                )));
            }
            return Ok(String::from("audio/mpeg"));
        }

        let props = source_properties(source_meta);
        let Some(ref codec) = props.codec else {
            return Err(CastError::FormatUnknown);
        };
        let container = props.container.as_deref().unwrap_or("");

        let mime = match codec.as_str() {
            "FLAC" => "audio/flac",
            "MP3" => "audio/mpeg",
            "ALAC" => "audio/mp4",
            "AAC" => {
                if container.contains("MP4") || container.contains("M4A") {
                    "audio/mp4"
                } else {
                    "audio/aac"
                }
            }
            "PCM" => {
                if container == "WAV" {
                    "audio/wav"
                } else {
                    ""
                }
            }
            "AIFF" => "audio/aiff",
            "OPUS" => {
                if container == "WEBM" {
                    "audio/webm"
                } else {
                    "audio/ogg"
                }
            }
            "VORBIS" => "audio/ogg",
            _ => "",
        };

        if mime.is_empty() {
            return Err(CastError::FormatUnknown);
        }
        Ok(mime.to_owned())
    }

    /// Mints a new HMAC-SHA256 signed Cast ticket and stores its hashed lease in memory.
    pub fn create_ticket(
        &self,
        session_id: &str,
        user_id: &str,
        public_url: &str,
        request: &CastTicketRequest,
        source_meta: Option<&AudioMetadataSummary>,
        now_ms: i64,
    ) -> Result<CastTicketResponse, CastError> {
        if request.track_id.trim().is_empty() || request.track_id.len() > 300 {
            return Err(CastError::Validation(String::from(
                "Invalid Cast track request",
            )));
        }

        let content_type =
            Self::resolve_cast_content_type(source_meta, request.max_bit_rate)?;

        let mut guard = self
            .leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.retain(|_, lease| lease.expires_at_ms > now_ms);

        let session_lease_count = guard
            .values()
            .filter(|l| l.session_id == session_id)
            .count();
        if session_lease_count >= MAX_LEASES_PER_SESSION || guard.len() >= MAX_GLOBAL_CAST_LEASES {
            return Err(CastError::RateLimited(String::from(
                "Too many active Cast streams. Stop an existing Cast session first.",
            )));
        }

        let expires_at_ms = now_ms + CAST_LEASE_TTL_MS;
        let token = self.generate_hmac_token(session_id, &request.track_id, expires_at_ms);
        let key = sha256_hex(&token);

        guard.insert(
            key,
            CastLease {
                session_id: session_id.to_owned(),
                user_id: user_id.to_owned(),
                track_id: request.track_id.clone(),
                max_bit_rate: request.max_bit_rate,
                content_type: content_type.clone(),
                expires_at_ms,
                active_connections: 0,
            },
        );
        drop(guard);

        let mut stream_url = Url::parse(&format!(
            "{}/api/v1/cast/stream",
            public_url.trim_end_matches('/')
        ))
        .unwrap_or_else(|_| Url::parse("http://localhost:4534/api/v1/cast/stream").unwrap());
        stream_url.query_pairs_mut().append_pair("token", &token);

        let expires_at_iso = DateTime::from_timestamp_millis(expires_at_ms)
            .unwrap_or_else(Utc::now)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        Ok(CastTicketResponse {
            token,
            url: stream_url.into(),
            content_type,
            expires_at: expires_at_iso,
        })
    }

    /// Revokes a Cast ticket (`DELETE /api/v1/cast/ticket`), verifying that an existing
    /// ticket belongs to `caller_session_id`.
    pub fn revoke_ticket(&self, token: &str, caller_session_id: &str) -> Result<(), CastError> {
        if !is_valid_token_hex(token) {
            return Err(CastError::Validation(String::from("Invalid Cast ticket")));
        }

        let key = sha256_hex(token);
        let mut guard = self
            .leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        if let Some(lease) = guard.get(&key)
            && lease.session_id != caller_session_id
        {
            return Err(CastError::Forbidden(String::from(
                "Cast ticket belongs to another session",
            )));
        }

        guard.remove(&key);
        Ok(())
    }

    /// Validates a Cast stream token and acquires one of the 4 receiver connection slots.
    pub fn acquire_receiver_stream(
        &self,
        token: &str,
        now_ms: i64,
    ) -> Result<(CastLease, CastReceiverConnectionGuard), CastError> {
        if !is_valid_token_hex(token) {
            return Err(CastError::Unauthorized(String::from(
                "Valid Cast stream ticket required",
            )));
        }

        let key = sha256_hex(token);
        let mut guard = self
            .leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let Some(lease) = guard.get_mut(&key) else {
            return Err(CastError::Unauthorized(String::from(
                "Cast stream ticket expired or revoked",
            )));
        };

        if lease.expires_at_ms <= now_ms {
            guard.remove(&key);
            return Err(CastError::Unauthorized(String::from(
                "Cast stream ticket expired or revoked",
            )));
        }

        if lease.active_connections >= MAX_RECEIVER_CONNECTIONS_PER_LEASE {
            return Err(CastError::RateLimited(String::from(
                "Too many receiver connections",
            )));
        }

        lease.active_connections += 1;
        let snapshot = lease.clone();
        drop(guard);

        Ok((
            snapshot,
            CastReceiverConnectionGuard {
                leases: Arc::clone(&self.leases),
                lease_key: key,
            },
        ))
    }

    /// Revokes all active leases when external privacy permissions are disabled.
    pub fn revoke_all(&self) {
        if let Ok(mut guard) = self.leases.lock() {
            guard.clear();
        }
    }

    fn generate_hmac_token(&self, session_id: &str, track_id: &str, expires_at_ms: i64) -> String {
        let mut nonce = [0u8; 32];
        OsRng.fill_bytes(&mut nonce);

        let mut mac = HmacSha256::new_from_slice(&self.hmac_secret)
            .expect("HMAC accepts keys of any size");
        mac.update(&nonce);
        mac.update(session_id.as_bytes());
        mac.update(b":");
        mac.update(track_id.as_bytes());
        mac.update(b":");
        mac.update(&expires_at_ms.to_be_bytes());
        let tag = mac.finalize().into_bytes();

        let mut hex = String::with_capacity(64);
        for b in tag {
            use std::fmt::Write;
            let _ = write!(&mut hex, "{b:02x}");
        }
        hex
    }
}

fn is_valid_token_hex(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}
