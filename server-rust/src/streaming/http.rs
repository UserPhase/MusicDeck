//! # RFC 9110 HTTP Byte-Range Streaming & Upstream Proxy Engine (`streaming::http`)
//!
//! Provides both:
//! 1. **Zero-Copy Local File Byte-Range Streaming ([`serve_file_with_range`], [`parse_byte_range`])**:
//!    - Parses single-range `Range: bytes=<start>-<end>`, open-ended `bytes=<start>-`,
//!      and suffix `bytes=-<suffix_len>` headers according to RFC 9110 §14.1.2.
//!    - Rejects out-of-bounds or inverted ranges with `HTTP 416 Range Not Satisfiable`
//!      and `Content-Range: bytes */<total_size>`.
//!    - Seeks directly to `range.start` using `tokio::fs::File` and streams bounded chunks
//!      (`64 KiB` read buffer) via `tokio_util::io::ReaderStream` without buffering full
//!      audio files in memory.
//! 2. **Upstream Provider Stream Proxy ([`proxy_upstream_stream`])**:
//!    - Streams `reqwest::Response::bytes_stream()` from `NavidromeClient` or `JellyfinClient`,
//!      preserving `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`,
//!      `Cache-Control`, `ETag`, and `Last-Modified` headers.
//!    - Optionally tees passing byte chunks into [`crate::inspector::AudioMetadataInspector`]
//!      when a client supplies `?inspectionId=<id>`.

use std::io::SeekFrom;
use std::path::Path;

use axum::Json;
use axum::body::Body;
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, HeaderName,
    HeaderValue, LAST_MODIFIED,
};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_stream::StreamExt;
use tokio_util::io::ReaderStream;

use crate::error::{ApiErrorBody, ApiErrorEnvelope};
use crate::inspector::{AudioMetadataInspector, DeliveryState};
use crate::providers::StreamResult;

/// Chunk size (`64 KiB`) used when streaming local audio files via `ReaderStream`.
pub const STREAM_CHUNK_SIZE: usize = 64 * 1024;

/// Allowed upstream headers forwarded by [`proxy_upstream_stream`], matching
/// `sendProxyResponse` in `server/src/routes/music-routes.ts`.
pub const ALLOWED_PROXY_HEADERS: [HeaderName; 7] = [
    CONTENT_TYPE,
    CONTENT_LENGTH,
    CONTENT_RANGE,
    ACCEPT_RANGES,
    CACHE_CONTROL,
    ETAG,
    LAST_MODIFIED,
];

/// Inclusive byte range `[start, end]` resolved against a known `total_size`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    /// Inclusive zero-based starting byte offset.
    pub start: u64,
    /// Inclusive zero-based ending byte offset (`start <= end < total_size`).
    pub end: u64,
    /// Total file size in bytes.
    pub total_size: u64,
}

impl ByteRange {
    /// Number of bytes contained in this inclusive range (`end - start + 1`).
    #[must_use]
    pub const fn length(&self) -> u64 {
        if self.total_size == 0 {
            0
        } else {
            self.end.saturating_sub(self.start).saturating_add(1)
        }
    }

    /// Formats the RFC 9110 `Content-Range` response header (`"bytes start-end/total"`).
    #[must_use]
    pub fn content_range_header(&self) -> String {
        format!("bytes {}-{}/{}", self.start, self.end, self.total_size)
    }
}

/// Error returned when an HTTP `Range` header cannot be satisfied (`HTTP 416`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RangeParseError {
    /// Range syntax is malformed or uses a unit other than `bytes`.
    Malformed,
    /// Requested byte offsets fall outside `0..total_size`.
    Unsatisfiable {
        /// Total length of the representation in bytes.
        total_size: u64,
    },
}

impl RangeParseError {
    /// Converts a [`RangeParseError`] into an `HTTP 416 Range Not Satisfiable` response.
    #[must_use]
    pub fn into_response(self, total_size: u64) -> Response {
        let mut res = (
            StatusCode::RANGE_NOT_SATISFIABLE,
            Json(ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: String::from("RANGE_NOT_SATISFIABLE"),
                    message: String::from("Requested byte range is not satisfiable"),
                },
            }),
        )
            .into_response();

        if let Ok(cr) = HeaderValue::from_str(&format!("bytes */{total_size}")) {
            res.headers_mut().insert(CONTENT_RANGE, cr);
        }
        res.headers_mut()
            .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        res
    }
}

/// Parses an RFC 9110 `Range: bytes=...` header value against `total_size`.
///
/// Supports:
/// - Explicit range: `bytes=start-end` (clamping `end` to `total_size - 1`)
/// - Open-ended range: `bytes=start-` (`start..=(total_size - 1)`)
/// - Suffix range: `bytes=-suffix_len` (`(total_size - suffix_len)..=(total_size - 1)`)
pub fn parse_byte_range(raw_header: &str, total_size: u64) -> Result<ByteRange, RangeParseError> {
    if total_size == 0 {
        return Err(RangeParseError::Unsatisfiable { total_size: 0 });
    }

    let trimmed = raw_header.trim();
    let Some(spec) = trimmed
        .strip_prefix("bytes=")
        .or_else(|| trimmed.strip_prefix("BYTES="))
    else {
        return Err(RangeParseError::Malformed);
    };

    // Multi-part ranges (`bytes=0-50, 100-150`) are rejected in favor of single contiguous ranges.
    if spec.contains(',') {
        return Err(RangeParseError::Unsatisfiable { total_size });
    }

    let Some((start_str, end_str)) = spec.trim().split_once('-') else {
        return Err(RangeParseError::Malformed);
    };

    let start_str = start_str.trim();
    let end_str = end_str.trim();

    if start_str.is_empty() {
        // Suffix range: `bytes=-N`
        let suffix_len: u64 = end_str
            .parse()
            .map_err(|_| RangeParseError::Malformed)?;
        if suffix_len == 0 {
            return Err(RangeParseError::Unsatisfiable { total_size });
        }
        let take = suffix_len.min(total_size);
        return Ok(ByteRange {
            start: total_size - take,
            end: total_size - 1,
            total_size,
        });
    }

    let start: u64 = start_str
        .parse()
        .map_err(|_| RangeParseError::Malformed)?;
    if start >= total_size {
        return Err(RangeParseError::Unsatisfiable { total_size });
    }

    let end = if end_str.is_empty() {
        total_size - 1
    } else {
        let parsed_end: u64 = end_str.parse().map_err(|_| RangeParseError::Malformed)?;
        if parsed_end < start {
            return Err(RangeParseError::Unsatisfiable { total_size });
        }
        parsed_end.min(total_size - 1)
    };

    Ok(ByteRange {
        start,
        end,
        total_size,
    })
}

/// Streams a local file from disk with full RFC 9110 `Range` support (`206 Partial Content`
/// when `range_header` is present, or `200 OK` for a full-file read).
pub async fn serve_file_with_range(
    file_path: &Path,
    content_type: &str,
    range_header: Option<&str>,
) -> Response {
    let mut file = match tokio::fs::File::open(file_path).await {
        Ok(f) => f,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return send_error_response(StatusCode::NOT_FOUND, "Track file not found", "NOT_FOUND");
        }
        Err(_) => {
            return send_error_response(
                StatusCode::BAD_GATEWAY,
                "Media file could not be opened",
                "BACKEND_ERROR",
            );
        }
    };

    let metadata = match file.metadata().await {
        Ok(m) if m.is_file() => m,
        _ => {
            return send_error_response(
                StatusCode::BAD_GATEWAY,
                "Media path is not a regular file",
                "BACKEND_ERROR",
            );
        }
    };

    let total_size = metadata.len();

    if let Some(raw_range) = range_header {
        let range = match parse_byte_range(raw_range, total_size) {
            Ok(r) => r,
            Err(err) => return err.into_response(total_size),
        };

        if file.seek(SeekFrom::Start(range.start)).await.is_err() {
            return send_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to seek audio stream",
                "INTERNAL_ERROR",
            );
        }

        let bounded = file.take(range.length());
        let stream = ReaderStream::with_capacity(bounded, STREAM_CHUNK_SIZE);
        let mut response = Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .body(Body::from_stream(stream))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());

        let headers = response.headers_mut();
        if let Ok(ct) = HeaderValue::from_str(content_type) {
            headers.insert(CONTENT_TYPE, ct);
        }
        headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        if let Ok(cl) = HeaderValue::from_str(&range.length().to_string()) {
            headers.insert(CONTENT_LENGTH, cl);
        }
        if let Ok(cr) = HeaderValue::from_str(&range.content_range_header()) {
            headers.insert(CONTENT_RANGE, cr);
        }
        return response;
    }

    let stream = ReaderStream::with_capacity(file, STREAM_CHUNK_SIZE);
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());

    let headers = response.headers_mut();
    if let Ok(ct) = HeaderValue::from_str(content_type) {
        headers.insert(CONTENT_TYPE, ct);
    }
    headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Ok(cl) = HeaderValue::from_str(&total_size.to_string()) {
        headers.insert(CONTENT_LENGTH, cl);
    }
    response
}

/// Converts an upstream [`StreamResult`] into an Axum [`Response`], forwarding allowed
/// byte-range and caching headers and optionally observing chunks in [`AudioMetadataInspector`].
pub fn proxy_upstream_stream(
    upstream: StreamResult,
    inspection: Option<(AudioMetadataInspector, String, String, String, Option<String>)>,
) -> Response {
    let status = upstream.status;
    let upstream_headers = upstream.headers;
    let content_range_str = upstream_headers
        .get(CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    let byte_stream = upstream.response.bytes_stream();

    let body = if let Some((inspector, user_id, track_id, inspection_id, range_hdr)) = inspection {
        inspector.begin_observation(
            &user_id,
            &track_id,
            &inspection_id,
            status.as_u16(),
            range_hdr.as_deref(),
            content_range_str.as_deref(),
            upstream.audio_stream,
        );

        let observed_stream = byte_stream.map(move |chunk_res| match chunk_res {
            Ok(bytes) => {
                inspector.record_chunk(&user_id, &track_id, &inspection_id, &bytes);
                Ok::<bytes::Bytes, reqwest::Error>(bytes)
            }
            Err(err) => {
                inspector.finish_observation(
                    &user_id,
                    &track_id,
                    &inspection_id,
                    DeliveryState::Error,
                );
                Err(err)
            }
        });
        Body::from_stream(observed_stream)
    } else {
        Body::from_stream(byte_stream)
    };

    let mut response = Response::builder()
        .status(status)
        .body(body)
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());

    let out_headers = response.headers_mut();
    for header_name in ALLOWED_PROXY_HEADERS {
        if let Some(value) = upstream_headers.get(&header_name) {
            out_headers.insert(header_name, value.clone());
        }
    }

    response
}

/// Builds a JSON error response matching `sendError(reply, statusCode, message, code)`
/// in `server/src/utils/http.ts`.
#[must_use]
pub fn send_error_response(status: StatusCode, message: impl Into<String>, code: &str) -> Response {
    (
        status,
        Json(ApiErrorEnvelope {
            error: ApiErrorBody {
                code: code.to_owned(),
                message: message.into(),
            },
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_byte_ranges_and_rejects_unsatisfiable_ranges() {
        assert_eq!(
            parse_byte_range("bytes=0-499", 1000),
            Ok(ByteRange {
                start: 0,
                end: 499,
                total_size: 1000
            })
        );
        assert_eq!(
            parse_byte_range("bytes=500-", 1000),
            Ok(ByteRange {
                start: 500,
                end: 999,
                total_size: 1000
            })
        );
        assert_eq!(
            parse_byte_range("bytes=-200", 1000),
            Ok(ByteRange {
                start: 800,
                end: 999,
                total_size: 1000
            })
        );
        // End beyond EOF clamps to total_size - 1 per RFC 9110
        assert_eq!(
            parse_byte_range("bytes=900-5000", 1000),
            Ok(ByteRange {
                start: 900,
                end: 999,
                total_size: 1000
            })
        );

        // Unsatisfiable: start >= total_size or start > end
        assert_eq!(
            parse_byte_range("bytes=1000-1200", 1000),
            Err(RangeParseError::Unsatisfiable { total_size: 1000 })
        );
        assert_eq!(
            parse_byte_range("bytes=500-400", 1000),
            Err(RangeParseError::Unsatisfiable { total_size: 1000 })
        );
        assert_eq!(
            parse_byte_range("bytes=-0", 1000),
            Err(RangeParseError::Unsatisfiable { total_size: 1000 })
        );
    }
}
