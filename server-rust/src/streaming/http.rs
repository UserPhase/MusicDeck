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
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Body;
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, HeaderName,
    HeaderValue, LAST_MODIFIED,
};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_stream::StreamExt;
use tokio_util::io::ReaderStream;

use crate::error::{ApiErrorBody, ApiErrorEnvelope};
use crate::inspector::{AudioMetadataInspector, DeliveryState, MAX_HEADER_INSPECTION_BYTES};
use crate::providers::{StreamResult, UpstreamStreamResponse};

pub(crate) type MediaBody =
    std::pin::Pin<Box<dyn futures_util::Stream<Item = std::io::Result<bytes::Bytes>> + Send>>;
pub(crate) const MAX_EXTERNAL_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;
pub(crate) const MAX_EXTERNAL_MEDIA_BYTES: u64 = 256 * 1024 * 1024;

pub(crate) async fn fetch_external_media(
    raw_url: &str,
    range: Option<&str>,
    if_range: Option<&str>,
    max_bytes: u64,
    allowed: impl Fn(&str) -> bool,
) -> Result<UpstreamStreamResponse, String> {
    static HTTP: std::sync::OnceLock<Result<reqwest::Client, reqwest::Error>> =
        std::sync::OnceLock::new();
    let http = HTTP
        .get_or_init(|| {
            crate::providers::media_http_builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
        })
        .as_ref()
        .map_err(|_| "External media client is unavailable")?;
    tokio::time::timeout(crate::providers::MEDIA_HEADER_BUDGET, async {
        let mut url = url::Url::parse(raw_url).map_err(|_| "Invalid media URL")?;
        for _ in 0..=3 {
            if !allowed(url.as_str()) {
                return Err("Invalid media URL".into());
            }
            let mut request = http.get(url.clone());
            if let Some(range) = range {
                request = request.header(http::header::RANGE, range);
            }
            if let Some(validator) = if_range {
                request = request.header(http::header::IF_RANGE, validator);
            }
            let response = request
                .send()
                .await
                .map_err(|_| "External media is unavailable")?;
            if !response.status().is_redirection() {
                return UpstreamStreamResponse::validate(response, range, max_bytes);
            }
            let location = response
                .headers()
                .get(http::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("External media redirect missing")?;
            url = url.join(location).map_err(|_| "Invalid media redirect")?;
        }
        Err("Too many media redirects".into())
    })
    .await
    .map_err(|_| "External media header deadline exceeded".to_owned())?
}

impl UpstreamStreamResponse {
    /// Validates a playable response before exposing its bounded streaming body.
    pub fn validate(
        response: reqwest::Response,
        range: Option<&str>,
        max_bytes: u64,
    ) -> Result<Self, String> {
        let max_bytes = max_bytes.min(MAX_EXTERNAL_MEDIA_BYTES);
        let status = response.status();
        let headers = response.headers();
        if !matches!(
            status,
            StatusCode::OK | StatusCode::PARTIAL_CONTENT | StatusCode::RANGE_NOT_SATISFIABLE
        ) {
            return Err("External media is unavailable".into());
        }
        if status == StatusCode::PARTIAL_CONTENT
            && !crate::catalog::resolver::valid_partial_response(headers, range)
        {
            return Err("External media returned an invalid byte range".into());
        }
        if status == StatusCode::OK && headers.contains_key(CONTENT_RANGE) {
            return Err("External media returned an invalid byte range".into());
        }
        if response
            .content_length()
            .is_some_and(|size| size > max_bytes)
            || response_range(headers).is_some_and(|range| range.total_size > max_bytes)
        {
            return Err("External media exceeds the size limit".into());
        }
        if status != StatusCode::RANGE_NOT_SATISFIABLE
            && !headers
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| {
                    let mime = value
                        .split(';')
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .to_ascii_lowercase();
                    mime.starts_with("audio/")
                        || mime == "application/octet-stream"
                        || mime == "video/mp4"
                })
        {
            return Err("External media did not return an audio response".into());
        }
        Ok(Self {
            response,
            max_bytes,
        })
    }

    pub(crate) fn status(&self) -> StatusCode {
        self.response.status()
    }

    pub(crate) fn into_body(
        self,
        permit: Option<tokio_util::sync::CancellationToken>,
    ) -> MediaBody {
        let expected = response_range(self.response.headers())
            .filter(|_| self.status() == StatusCode::PARTIAL_CONTENT)
            .map(|range| range.length())
            .or_else(|| self.response.content_length());
        bounded_media_body(
            Box::pin(self.response.bytes_stream()),
            self.max_bytes,
            expected,
            permit,
            crate::providers::MEDIA_BODY_IDLE_TIMEOUT,
        )
    }

    pub(crate) fn into_response(self, permit: tokio_util::sync::CancellationToken) -> Response {
        let status = self.status();
        let mut headers = HeaderMap::new();
        for name in ALLOWED_PROXY_HEADERS {
            if let Some(value) = self.response.headers().get(&name) {
                headers.insert(name, value.clone());
            }
        }
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
        headers.insert(
            http::header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        if status == StatusCode::RANGE_NOT_SATISFIABLE {
            // Retain the range diagnostic, never the upstream error document.
            headers.remove(CONTENT_LENGTH);
            headers.remove(CONTENT_TYPE);
            headers.remove(CONTENT_ENCODING);
            return (status, headers, Body::empty()).into_response();
        }
        (
            status,
            headers,
            Body::from_stream(self.into_body(Some(permit))),
        )
            .into_response()
    }
}

fn response_range(headers: &HeaderMap) -> Option<ByteRange> {
    parse_content_range(headers.get(CONTENT_RANGE)?.to_str().ok()?)
}

/// Bounds each read and the cumulative bytes without collecting the body.
pub(crate) fn bounded_media_body<E: std::fmt::Display + Send + 'static>(
    source: std::pin::Pin<Box<dyn futures_util::Stream<Item = Result<bytes::Bytes, E>> + Send>>,
    max_bytes: u64,
    expected: Option<u64>,
    permit: Option<tokio_util::sync::CancellationToken>,
    idle: Duration,
) -> MediaBody {
    use std::io::{Error, ErrorKind};
    Box::pin(futures_util::stream::try_unfold(
        (source, 0_u64, permit),
        move |(mut source, received, permit)| async move {
            let next = tokio::select! {
                biased;
                _ = async {
                    if let Some(permit) = &permit { permit.cancelled().await }
                    else { std::future::pending().await }
                } => return Err(Error::new(ErrorKind::PermissionDenied, "Media access revoked")),
                next = tokio::time::timeout(idle, source.next()) => next,
            };
            match next {
                Ok(Some(Ok(bytes))) => {
                    let received = received.saturating_add(bytes.len() as u64);
                    if received > max_bytes || expected.is_some_and(|length| received > length) {
                        return Err(Error::new(
                            ErrorKind::InvalidData,
                            "Upstream media exceeded its byte limit",
                        ));
                    }
                    Ok(Some((bytes, (source, received, permit))))
                }
                Ok(Some(Err(_))) => Err(Error::other("Upstream media read failed")),
                Ok(None) if expected.is_none_or(|length| received == length) => Ok(None),
                Ok(None) => Err(Error::new(
                    ErrorKind::UnexpectedEof,
                    "Upstream media ended early",
                )),
                Err(_) => Err(Error::new(
                    ErrorKind::TimedOut,
                    "Upstream media body stalled",
                )),
            }
        },
    ))
}

/// Chunk size (`64 KiB`) used when streaming local audio files via `ReaderStream`.
pub const STREAM_CHUNK_SIZE: usize = 64 * 1024;

/// Allowed upstream headers forwarded by [`proxy_upstream_stream`], matching
/// `sendProxyResponse` in `server/src/routes/music-routes.ts`.
pub const ALLOWED_PROXY_HEADERS: [HeaderName; 8] = [
    CONTENT_TYPE,
    CONTENT_ENCODING,
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
                    request_id: crate::error::current_request_id(),
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
    let Some((_, spec)) = trimmed
        .split_once('=')
        .filter(|(unit, _)| unit.eq_ignore_ascii_case("bytes"))
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
        let suffix_len = parse_decimal(end_str).ok_or(RangeParseError::Malformed)?;
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

    let start = parse_decimal(start_str).ok_or(RangeParseError::Malformed)?;
    if start >= total_size {
        return Err(RangeParseError::Unsatisfiable { total_size });
    }

    let end = if end_str.is_empty() {
        total_size - 1
    } else {
        let parsed_end = parse_decimal(end_str).ok_or(RangeParseError::Malformed)?;
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

fn parse_decimal(raw: &str) -> Option<u64> {
    if raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return raw.parse().ok();
    }
    None
}

pub(crate) fn parse_content_range(raw_header: &str) -> Option<ByteRange> {
    let (unit, value) = raw_header.trim().split_once(' ')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (bounds, total) = value.split_once('/')?;
    let (start, end) = bounds.split_once('-')?;
    let start = parse_decimal(start)?;
    let end = parse_decimal(end)?;
    let total_size = parse_decimal(total)?;
    (start <= end && end < total_size).then_some(ByteRange {
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
            return media_storage_unavailable();
        }
    };

    let metadata = match file.metadata().await {
        Ok(m) if m.is_file() => m,
        _ => return media_storage_unavailable(),
    };

    let total_size = metadata.len();

    if let Some(raw_range) = range_header {
        let range = match parse_byte_range(raw_range, total_size) {
            Ok(r) => r,
            Err(err) => return err.into_response(total_size),
        };

        if file.seek(SeekFrom::Start(range.start)).await.is_err() {
            return media_storage_unavailable();
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

fn media_storage_unavailable() -> Response {
    let mut response = send_error_response(StatusCode::SERVICE_UNAVAILABLE, "Media storage temporarily unavailable", "BACKEND_ERROR");
    response.headers_mut().insert(http::header::RETRY_AFTER, HeaderValue::from_static("1"));
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

    let connection_id = upstream.audio_stream.as_ref().and_then(|info| info.source_connection_id.clone());
    let expected = (status == StatusCode::PARTIAL_CONTENT && upstream.audio_stream.is_some())
        .then(|| {
            content_range_str
                .as_deref()
                .and_then(parse_content_range)
                .map(|range| range.length())
        })
        .flatten();
    let source = Box::pin(upstream.response.bytes_stream());
    let audio = upstream.audio_stream.is_some();
    let byte_stream = futures_util::stream::unfold(
        Some((source, 0_u64, connection_id)),
        move |state| async move {
            let (mut source, delivered, connection_id) = state?;
            let next = if audio {
                tokio::time::timeout(crate::providers::MEDIA_BODY_IDLE_TIMEOUT, source.next()).await
            } else {
                Ok(source.next().await)
            };
            let result = match next {
                Ok(Some(Ok(bytes))) => {
                    let received = delivered.saturating_add(bytes.len() as u64);
                    if expected.is_none_or(|size| received <= size) {
                        return Some((Ok(bytes), Some((source, received, connection_id))));
                    }
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "Upstream partial response exceeded its range",
                    )
                }
                Ok(Some(Err(error))) => std::io::Error::other(error.without_url()),
                Ok(None) if expected.is_none_or(|size| size == delivered) => return None,
                Ok(None) => std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "Upstream partial response ended early",
                ),
                Err(_) => {
                    std::io::Error::new(std::io::ErrorKind::TimedOut, "Upstream audio body stalled")
                }
            };
            tracing::warn!(?connection_id, %status, delivered, error = ?result, "Upstream media response failed after headers");
            Some((Err(result), None))
        },
    );

    let body = if let Some((inspector, user_id, track_id, inspection_id, range_hdr)) = inspection {
        let generation = inspector.begin_observation(
            &user_id,
            &track_id,
            &inspection_id,
            status.as_u16(),
            range_hdr.as_deref(),
            content_range_str.as_deref(),
            upstream.audio_stream,
        );

        let key = (user_id, track_id, inspection_id);
        let mut last_sample: Option<Instant> = None;
        let mut byte_count = 0;
        let mut prefix = Vec::new();
        let mut prefix_bytes = 0;
        let observed_stream = byte_stream.map(move |chunk_res| match chunk_res {
            Ok(bytes) => {
                byte_count += bytes.len() as u64;
                let take = bytes.len().min(MAX_HEADER_INSPECTION_BYTES - prefix_bytes);
                prefix.extend_from_slice(&bytes[..take]);
                prefix_bytes += take;
                let now = Instant::now();
                if last_sample
                    .is_none_or(|last| now.duration_since(last) >= Duration::from_millis(100))
                {
                    inspector.record_sample(&key, Some(generation), byte_count, &prefix);
                    last_sample = Some(now);
                    byte_count = 0;
                    prefix.clear();
                }
                Ok(bytes)
            }
            Err(err) => {
                inspector.record_sample(&key, Some(generation), byte_count, &prefix);
                inspector.finish_generation(&key, Some(generation), DeliveryState::Error);
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
                request_id: crate::error::current_request_id(),
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
    use http_body_util::BodyExt;

    #[tokio::test]
    async fn external_media_stream_enforces_byte_cap_idle_deadline_and_revocation() {
        let chunks = futures_util::stream::iter([
            Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"abc")),
            Ok(bytes::Bytes::from_static(b"def")),
        ]);
        let mut body = bounded_media_body(Box::pin(chunks), 5, None, None, Duration::from_secs(1));
        assert_eq!(body.next().await.unwrap().unwrap().as_ref(), b"abc");
        assert_eq!(body.next().await.unwrap().unwrap_err().kind(), std::io::ErrorKind::InvalidData);
        assert!(body.next().await.is_none());
        let mut stalled = bounded_media_body(Box::pin(futures_util::stream::pending::<std::io::Result<bytes::Bytes>>()),
            100, None, None, Duration::from_millis(10));
        assert_eq!(stalled.next().await.unwrap().unwrap_err().kind(), std::io::ErrorKind::TimedOut);
        let permit = tokio_util::sync::CancellationToken::new();
        let mut revoked = bounded_media_body(Box::pin(futures_util::stream::iter([Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"a"))])),
            100, None, Some(permit.clone()), Duration::from_secs(1));
        permit.cancel();
        assert_eq!(revoked.next().await.unwrap().unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn external_media_rejects_oversized_headers_before_reading_the_body() {
        let response = reqwest::Response::from(http::Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(CONTENT_TYPE, "audio/mpeg")
            .header(CONTENT_RANGE, "bytes 0-1/1024")
            .header(CONTENT_LENGTH, 2)
            .body(reqwest::Body::from("ab")).unwrap());
        assert!(UpstreamStreamResponse::validate(response, Some("bytes=0-1"), 10).is_err());
    }

    #[tokio::test]
    async fn external_media_416_preserves_range_diagnostics_and_discards_origin_error_document() {
        let response = reqwest::Response::from(
            http::Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_TYPE, "text/html")
                .header(CONTENT_RANGE, "bytes */20")
                .body(reqwest::Body::from("<p>Origin error</p>"))
                .unwrap(),
        );
        let response = UpstreamStreamResponse::validate(response, Some("bytes=30-"), 100)
            .unwrap()
            .into_response(tokio_util::sync::CancellationToken::new());
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[CONTENT_RANGE], "bytes */20");
        assert!(!response.headers().contains_key(CONTENT_TYPE));
        assert!(response.into_body().collect().await.unwrap().to_bytes().is_empty());
    }

    #[tokio::test]
    async fn partial_audio_body_checks_its_length_even_without_content_length() {
        for (bytes, valid) in [("four", true), ("few", false), ("extra", false)] {
            let response: reqwest::Response = http::Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(CONTENT_RANGE, "bytes 0-3/8")
                .body(reqwest::Body::wrap_stream(tokio_stream::once(Ok::<_, std::io::Error>(
                    bytes::Bytes::from_static(bytes.as_bytes()),
                ))))
                .unwrap()
                .into();
            let upstream = StreamResult {
                status: response.status(),
                headers: response.headers().clone(),
                response,
                audio_stream: Some(crate::providers::AudioStreamInfo {
                    direct: true,
                    requested_bitrate_kbps: None,
                    source_connection_id: None,
                    source_item_id: None,
                }),
            };
            let proxy = proxy_upstream_stream(upstream, None);
            assert_eq!(proxy.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(proxy.into_body().collect().await.is_ok(), valid);
        }
    }

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
