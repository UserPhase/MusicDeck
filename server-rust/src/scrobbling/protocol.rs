//! # Scrobble Protocol Primitives, Validation & Bounded HTTP Transport (`scrobbling::protocol`)
//!
//! Ports `server/src/services/scrobble/protocol.ts`:
//! - [`ScrobbleProvider`] (`lastfm | listenbrainz`)
//! - [`ScrobbleListen`] payload validation (`validate_listen`)
//! - [`FailureKind`] & [`ScrobbleError`] with retry-after calculation (`retry_delay`)
//! - [`protocol_request`] enforcing a `15,000 ms` timeout, no HTTP redirects, and a
//!   `1 MiB` response body ceiling while never leaking URLs or credentials in error strings

use std::time::Duration;

use chrono::DateTime;
use futures_util::StreamExt;
use reqwest::header::HeaderMap;
use reqwest::redirect::Policy;
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Maximum scrobble HTTP request timeout (`15,000 ms`).
pub const SCROBBLE_REQUEST_TIMEOUT_MS: u64 = 15_000;
/// Maximum decompressed response body size from a scrobble provider (`1 MiB`).
pub const SCROBBLE_MAX_RESPONSE_BYTES: usize = 1024 * 1024;
/// Maximum retry-after delay (`7 days` in milliseconds).
pub const MAX_RETRY_DELAY_MS: u64 = 7 * 86_400_000;

/// Supported external scrobbling providers (`lastfm | listenbrainz`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrobbleProvider {
    Lastfm,
    Listenbrainz,
}

impl ScrobbleProvider {
    /// All supported scrobble providers in deterministic order.
    pub const ALL: [Self; 2] = [Self::Lastfm, Self::Listenbrainz];

    /// Canonical string identifier (`"lastfm"` or `"listenbrainz"`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Lastfm => "lastfm",
            Self::Listenbrainz => "listenbrainz",
        }
    }

    /// Parses a provider identifier string.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "lastfm" => Some(Self::Lastfm),
            "listenbrainz" => Some(Self::Listenbrainz),
            _ => None,
        }
    }
}

/// Normalized listen payload persisted in `scrobble_queue.payload_json` and sent to providers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrobbleListen {
    pub artist: String,
    pub track: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    /// Unix epoch timestamp in seconds when playback started.
    pub listened_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u32>,
}

/// Classification of a scrobble failure determining queue state transitions and backoff behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FailureKind {
    Transient,
    Auth,
    Configuration,
    Permanent,
    Ignored,
    Paused,
}

/// Structured scrobble error carrying an error code, safe user-facing message, [`FailureKind`],
/// optional HTTP status code, and optional `retry_after_ms`.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ScrobbleError {
    pub code: String,
    pub message: String,
    pub kind: FailureKind,
    pub http_status: Option<u16>,
    pub retry_after_ms: u64,
}

impl ScrobbleError {
    /// Constructs a new [`ScrobbleError`].
    #[must_use]
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        kind: FailureKind,
        http_status: Option<u16>,
        retry_after_ms: u64,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            kind,
            http_status,
            retry_after_ms,
        }
    }
}

fn is_valid_text(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 500 && !value.contains('\0')
}

/// Validates a [`ScrobbleListen`] before enqueueing or transmitting to an external provider.
pub fn validate_listen(listen: &ScrobbleListen) -> Result<(), ScrobbleError> {
    let valid_artist = is_valid_text(&listen.artist);
    let valid_track = is_valid_text(&listen.track);
    let valid_album = listen
        .album
        .as_deref()
        .is_none_or(|a| a.chars().count() <= 500 && !a.contains('\0'));
    let valid_time = listen.listened_at > 0;
    let valid_duration = listen.duration.is_none_or(|d| d > 0 && d <= 86_400);

    if !(valid_artist && valid_track && valid_album && valid_time && valid_duration) {
        return Err(ScrobbleError::new(
            "INVALID_LISTEN",
            "The listen needs a valid artist, title, original timestamp, and duration.",
            FailureKind::Permanent,
            None,
            0,
        ));
    }

    Ok(())
}

/// Extracts a bounded retry delay in milliseconds from `Retry-After` or `X-RateLimit-Reset-In` headers.
#[must_use]
pub fn retry_delay(headers: &HeaderMap, now_ms: i64) -> u64 {
    let retry_after_ms = headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .and_then(|raw| {
            if let Ok(seconds) = raw.parse::<f64>() {
                if seconds.is_finite() && seconds > 0.0 {
                    return Some((seconds * 1000.0).ceil() as u64);
                }
            }
            if let Ok(parsed_date) = DateTime::parse_from_rfc2822(raw) {
                let target_ms = parsed_date.timestamp_millis();
                if target_ms > now_ms {
                    return Some((target_ms - now_ms) as u64);
                }
            }
            None
        })
        .unwrap_or(0);

    let reset_in_ms = headers
        .get("x-ratelimit-reset-in")
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|secs| (secs * 1000.0).ceil() as u64)
        .unwrap_or(0);

    retry_after_ms.max(reset_in_ms).min(MAX_RETRY_DELAY_MS)
}

/// Maps an non-2xx HTTP status and response headers into a classified [`ScrobbleError`].
#[must_use]
pub fn http_failure(status: StatusCode, headers: &HeaderMap, now_ms: i64) -> ScrobbleError {
    let code_num = status.as_u16();
    let kind = if code_num == 429 || code_num == 408 || code_num >= 500 {
        FailureKind::Transient
    } else if code_num == 401 || code_num == 403 {
        FailureKind::Auth
    } else {
        FailureKind::Permanent
    };
    ScrobbleError::new(
        format!("HTTP_{code_num}"),
        format!("The scrobbling service returned HTTP {code_num}."),
        kind,
        Some(code_num),
        retry_delay(headers, now_ms),
    )
}

/// Parsed HTTP response returned by [`protocol_request`].
#[derive(Debug)]
pub struct ProtocolResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Option<Value>,
    pub text: String,
}

/// Builds a [`reqwest::Client`] hardened for scrobble requests (`15s` timeout, no redirects).
#[must_use]
pub fn build_scrobble_http_client() -> Client {
    Client::builder()
        .timeout(Duration::from_millis(SCROBBLE_REQUEST_TIMEOUT_MS))
        .redirect(Policy::none())
        .build()
        .unwrap_or_default()
}

/// Executes an HTTP request with bounded time (`15s`) and response size (`1 MiB`),
/// never including URLs, headers, or credentials in any returned [`ScrobbleError`].
pub async fn protocol_request(
    client: &Client,
    method: Method,
    url: &str,
    headers: Vec<(&str, String)>,
    body: Option<String>,
) -> Result<ProtocolResponse, ScrobbleError> {
    let mut req = client.request(method, url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    if let Some(payload) = body {
        req = req.body(payload);
    }

    let response = req.send().await.map_err(|_| {
        ScrobbleError::new(
            "NETWORK_ERROR",
            "Could not reach the scrobbling service. Check connectivity; MusicDeck will retry.",
            FailureKind::Transient,
            None,
            0,
        )
    })?;

    let status = response.status();
    let resp_headers = response.headers().clone();

    let mut buffer = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|_| {
            ScrobbleError::new(
                "NETWORK_ERROR",
                "Could not reach the scrobbling service. Check connectivity; MusicDeck will retry.",
                FailureKind::Transient,
                Some(status.as_u16()),
                0,
            )
        })?;
        if buffer.len().saturating_add(chunk.len()) > SCROBBLE_MAX_RESPONSE_BYTES {
            return Err(ScrobbleError::new(
                "INVALID_RESPONSE",
                "The scrobbling service returned an oversized response.",
                FailureKind::Transient,
                Some(status.as_u16()),
                0,
            ));
        }
        buffer.extend_from_slice(&chunk);
    }

    let text = String::from_utf8_lossy(&buffer).into_owned();
    let parsed_json = serde_json::from_str::<Value>(&text).ok();

    Ok(ProtocolResponse {
        status,
        headers: resp_headers,
        body: parsed_json,
        text,
    })
}
