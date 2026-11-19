use crate::config::DesktopConnection;
use futures_util::StreamExt;
use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::tcp::OwnedReadHalf;
use tokio::net::{TcpListener, TcpStream};

const REQUEST_HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const UPSTREAM_HEADER_TIMEOUT: Duration = Duration::from_secs(60);
const RESTORE_HEADER_TIMEOUT: Duration = Duration::from_secs(300);
const UPLOAD_TOTAL_TIMEOUT: Duration = Duration::from_secs(3600);
const MEDIA_HEADER_TIMEOUT: Duration = Duration::from_secs(12);
const UPLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(20);
const PREBUFFER_BYTES: usize = 64 * 1024;

fn upload_limit(path: &str) -> usize {
    const MIB: usize = 1024 * 1024;
    match path {
        "/api/v1/admin/system/restore" => 256 * MIB,
        "/api/v1/user/queue-session/content" => 32 * MIB,
        "/api/users/profile/avatar" | "/api/user/avatar" => 8 * MIB,
        path if path.starts_with("/api/playlists/") && path.ends_with("/artwork") => 8 * MIB,
        path if path.starts_with("/api/v1/playlists/")
            && (path.ends_with("/commands") || path.ends_with("/tracks")) =>
        {
            3 * MIB
        }
        _ => 2 * MIB,
    }
}

fn upload_chunks(
    reader: impl AsyncRead + Unpin,
    prefix: Vec<u8>,
    length: usize,
) -> impl futures_util::Stream<Item = std::io::Result<Vec<u8>>> {
    let remaining = length - prefix.len();
    futures_util::stream::try_unfold(
        (reader, prefix, remaining),
        |(mut reader, prefix, mut remaining)| async move {
            if !prefix.is_empty() {
                return Ok(Some((prefix, (reader, Vec::new(), remaining))));
            }
            if remaining == 0 {
                return Ok(None);
            }
            let mut chunk = vec![0; remaining.min(PREBUFFER_BYTES)];
            let len = tokio::time::timeout(UPLOAD_IDLE_TIMEOUT, reader.read(&mut chunk)).await??;
            if len == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "Desktop upload ended early",
                ));
            }
            remaining -= len;
            chunk.truncate(len);
            Ok(Some((chunk, (reader, Vec::new(), remaining))))
        },
    )
}

async fn request_socket_closed(reader: &mut Option<OwnedReadHalf>) {
    if let Some(reader) = reader {
        let _ = reader.read(&mut [0]).await;
    } else {
        std::future::pending::<()>().await;
    }
}

struct ProxySharedState {
    connection: Arc<Mutex<DesktopConnection>>,
    config_dir: PathBuf,
    path_prefix: String,
    client: reqwest::Client,
}

pub(crate) enum UpstreamFailure {
    Request(reqwest::Error),
    HeaderTimeout,
    UploadTimeout,
}

impl UpstreamFailure {
    pub(crate) fn can_try_alternate(&self) -> bool {
        matches!(self, Self::Request(error) if error.is_connect())
    }

    pub(crate) fn status(&self) -> reqwest::StatusCode {
        match self {
            Self::HeaderTimeout => reqwest::StatusCode::GATEWAY_TIMEOUT,
            Self::UploadTimeout => reqwest::StatusCode::REQUEST_TIMEOUT,
            Self::Request(error) if error.is_timeout() => reqwest::StatusCode::GATEWAY_TIMEOUT,
            Self::Request(_) => reqwest::StatusCode::BAD_GATEWAY,
        }
    }

    pub(crate) fn details(&self) -> (&'static str, &'static str) {
        if matches!(self, Self::UploadTimeout) {
            (
                "DESKTOP_UPLOAD_TIMEOUT",
                "The desktop proxy timed out receiving the upload.",
            )
        } else if self.status() == reqwest::StatusCode::GATEWAY_TIMEOUT {
            (
                "DESKTOP_UPSTREAM_TIMEOUT",
                "The desktop proxy timed out waiting for the MusicDeck server.",
            )
        } else if self.can_try_alternate() {
            ("DESKTOP_UPSTREAM_CONNECT", "The desktop proxy could not connect to the MusicDeck server. Check Server Connection settings.")
        } else {
            ("DESKTOP_UPSTREAM_RESPONSE", "The desktop proxy lost the connection or received an invalid response from the MusicDeck server.")
        }
    }

    fn log_transport(
        &self,
        method: &reqwest::Method,
        origin: &str,
        elapsed: Duration,
        retrying: bool,
    ) {
        // Lower-level error strings can contain URLs with capability tokens.
        let io_error = match self {
            Self::Request(error) => {
                std::iter::successors(error.source(), |source| (*source).source())
                    .find_map(|source| source.downcast_ref::<std::io::Error>())
            }
            Self::HeaderTimeout | Self::UploadTimeout => None,
        };
        let io_kind = io_error.map(std::io::Error::kind);
        let os_error = io_error.and_then(std::io::Error::raw_os_error);
        eprintln!(
            "MusicDeck desktop upstream: method={method} origin={origin} code={} io={io_kind:?} os_error={os_error:?} retrying={retrying} elapsed_ms={}",
            self.details().0,
            elapsed.as_millis()
        );
    }
}

pub(crate) async fn send_upstream(
    request: reqwest::RequestBuilder,
    method: &reqwest::Method,
    origin: &str,
    header_timeout: Duration,
) -> Result<reqwest::Response, UpstreamFailure> {
    let retry = matches!(*method, reqwest::Method::GET | reqwest::Method::HEAD)
        .then(|| request.try_clone())
        .flatten();
    let started = std::time::Instant::now();
    // Apply one deadline across both attempts, independently of streaming the body.
    let result = tokio::time::timeout(header_timeout, async {
        match request.send().await {
            // send() has not returned response headers. A truncated body or a
            // valid HTTP error response never enters this retry branch.
            Err(error) if error.is_request() && !error.is_timeout() => {
                if let Some(retry) = retry {
                    UpstreamFailure::Request(error).log_transport(
                        method,
                        origin,
                        started.elapsed(),
                        true,
                    );
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    retry.send().await
                } else {
                    Err(error)
                }
            }
            result => result,
        }
    })
    .await
    .map_err(|_| UpstreamFailure::HeaderTimeout)
    .and_then(|result| result.map_err(UpstreamFailure::Request));
    if let Err(failure) = &result {
        failure.log_transport(method, origin, started.elapsed(), false);
    }
    result
}

async fn send_upload(
    request: reqwest::RequestBuilder,
    upload_status: tokio::sync::oneshot::Receiver<Result<(), std::io::ErrorKind>>,
    header_timeout: Duration,
) -> Result<reqwest::Response, UpstreamFailure> {
    let response = request.send();
    tokio::pin!(response);
    tokio::select! {
        biased;
        status = upload_status => match status {
            Ok(Ok(())) => tokio::time::timeout(header_timeout, response)
                .await.map_err(|_| UpstreamFailure::HeaderTimeout)?
                .map_err(UpstreamFailure::Request),
            Ok(Err(std::io::ErrorKind::TimedOut)) => Err(UpstreamFailure::UploadTimeout),
            _ => response.await.map_err(UpstreamFailure::Request),
        },
        result = &mut response => result.map_err(UpstreamFailure::Request),
        _ = tokio::time::sleep(UPLOAD_TOTAL_TIMEOUT) => Err(UpstreamFailure::UploadTimeout),
    }
}

pub(crate) fn upstream_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            attempt.error("Too many redirects")
        } else if attempt
            .previous()
            .first()
            .is_some_and(|first| first.origin() == attempt.url().origin())
        {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

async fn write_proxy_error(
    stream: &mut (impl AsyncWrite + Unpin),
    status: &str,
    cors: &str,
    code: &str,
    message: String,
) {
    static NEXT_ERROR_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = NEXT_ERROR_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let request_id = format!("desktop-{}-{sequence}", std::process::id());
    let body = serde_json::json!({
        "error": { "code": code, "message": message, "requestId": request_id }
    })
    .to_string();
    let reply = format!(
        "HTTP/1.1 {status}\r\n{cors}Content-Type: application/json\r\nX-Request-Id: {request_id}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(reply.as_bytes()).await;
}

async fn handle_proxy_connection(mut stream: TcpStream, shared: Arc<ProxySharedState>) {
    let mut buf = Vec::with_capacity(8192);
    let mut temp = [0u8; 4096];
    let header_end;
    let incoming_deadline = tokio::time::Instant::now() + REQUEST_HEADER_TIMEOUT;

    loop {
        match tokio::time::timeout_at(incoming_deadline, stream.read(&mut temp)).await {
            Ok(Ok(0)) => return,
            Ok(Ok(n)) => {
                buf.extend_from_slice(&temp[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    header_end = pos + 4;
                    if header_end > PREBUFFER_BYTES {
                        return;
                    }
                    break;
                }
                if buf.len() > PREBUFFER_BYTES {
                    return;
                }
            }
            Ok(Err(_)) | Err(_) => return,
        }
    }

    let header_str = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = header_str.split("\r\n");
    let Some(request_line) = lines.next() else {
        return;
    };
    let mut req_parts = request_line.split_whitespace();
    let Some(method_str) = req_parts.next() else {
        return;
    };
    let Some(path_and_query) = req_parts.next() else {
        return;
    };

    let mut content_length = None;
    let mut invalid_framing = false;
    let mut expect_continue = false;
    let mut request_origin = None;
    let mut request_host = None;
    let mut duplicate_authority_header = false;
    let mut websocket_upgrade = false;
    let mut websocket_headers = Vec::new();
    let mut forwarded_headers: Vec<(String, String)> = Vec::new();

    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, val)) = line.split_once(':') {
            let key = name.trim();
            let value = val.trim();
            let lower = key.to_ascii_lowercase();
            if lower == "content-length" {
                match value.parse::<usize>() {
                    Ok(len) if value.bytes().all(|byte| byte.is_ascii_digit()) => {
                        invalid_framing |= content_length.replace(len).is_some();
                    }
                    _ => invalid_framing = true,
                }
            } else if lower == "transfer-encoding" {
                invalid_framing = true;
            } else if lower == "expect" {
                expect_continue = value.eq_ignore_ascii_case("100-continue");
            } else if lower == "origin" {
                duplicate_authority_header |= request_origin.replace(value).is_some();
            } else if lower == "host" {
                duplicate_authority_header |= request_host.replace(value).is_some();
            } else if lower == "upgrade" {
                websocket_upgrade = value.eq_ignore_ascii_case("websocket");
            } else if matches!(
                lower.as_str(),
                "sec-websocket-key" | "sec-websocket-version"
            ) {
                websocket_headers.push((key.to_string(), value.to_string()));
            } else if matches!(
                lower.as_str(),
                "content-type"
                    | "accept"
                    | "range"
                    | "if-range"
                    | "if-none-match"
                    | "if-modified-since"
                    | "cache-control"
                    | "x-musicdeck-confirm-restore"
            ) {
                forwarded_headers.push((key.to_string(), value.to_string()));
            }
        }
    }

    let content_length = content_length.unwrap_or(0);
    let method = match reqwest::Method::from_bytes(method_str.as_bytes()) {
        Ok(method) => method,
        Err(_) => return,
    };
    let authorized_origin = request_origin.filter(|origin| is_desktop_origin(origin));
    let expected_host = stream.local_addr().ok().map(|address| address.to_string());
    let api_path = path_and_query
        .strip_prefix(&shared.path_prefix)
        .filter(|path| *path == "/api" || path.starts_with("/api/") || path.starts_with("/api?"));
    let origin_required =
        websocket_upgrade || !matches!(method, reqwest::Method::GET | reqwest::Method::HEAD);
    if duplicate_authority_header
        || expected_host.is_none()
        || request_host != expected_host.as_deref()
        || (authorized_origin.is_none() && (origin_required || request_origin.is_some()))
        || api_path.is_none()
        || (websocket_upgrade
            && (method != reqwest::Method::GET
                || api_path != Some("/api/v1/remote")
                || content_length != 0
                || buf.len() != header_end))
    {
        let _ = stream
            .write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            .await;
        return;
    }
    let path_and_query = api_path.expect("authorized API path");
    let path = path_and_query.split('?').next().unwrap_or_default();
    let audio_stream = path.starts_with("/api/stream/")
        || (path.starts_with("/api/tracks/") && path.ends_with("/stream"))
        || path.starts_with("/api/playback/normalized/")
        || matches!(path, "/api/v1/cast/stream" | "/api/playback/preview");
    let mut cors = String::from("Vary: Origin\r\n");
    if let Some(origin) = authorized_origin {
        cors.push_str(&format!(
            "Access-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Credentials: true\r\nAccess-Control-Allow-Private-Network: true\r\n"
        ));
    }

    if method == reqwest::Method::OPTIONS {
        let preflight = format!(
            "HTTP/1.1 204 No Content\r\n\
             {cors}Access-Control-Allow-Methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS\r\n\
             Access-Control-Allow-Headers: Content-Type, Authorization, Range, If-Range, Accept, Cache-Control, If-None-Match, If-Modified-Since, X-MusicDeck-Confirm-Restore\r\n\
             Access-Control-Max-Age: 86400\r\n\
             Content-Length: 0\r\n\
             Connection: close\r\n\r\n"
        );
        let _ = stream.write_all(preflight.as_bytes()).await;
        let _ = stream.flush().await;
        return;
    }

    let body = buf.split_off(header_end);
    if invalid_framing || body.len() > content_length {
        write_proxy_error(
            &mut stream,
            "400 Bad Request",
            &cors,
            "DESKTOP_INVALID_BODY",
            "The desktop request body must specify a valid Content-Length.".into(),
        )
        .await;
        return;
    }
    if content_length > upload_limit(path) {
        write_proxy_error(
            &mut stream,
            "413 Payload Too Large",
            &cors,
            "DESKTOP_UPLOAD_TOO_LARGE",
            "This upload exceeds the size limit for the selected route.".into(),
        )
        .await;
        return;
    }
    if expect_continue
        && content_length > 0
        && stream
            .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            .await
            .is_err()
    {
        return;
    }
    let (reader, mut writer) = stream.into_split();
    let mut reader = Some(reader);
    let mut upload = (content_length > 0).then(|| {
        let (sender, status) = tokio::sync::oneshot::channel();
        let mut sender = Some(sender);
        let mut remaining = content_length;
        let chunks =
            upload_chunks(reader.take().unwrap(), body, content_length).map(move |result| {
                let status = match &result {
                    Ok(chunk) => {
                        remaining -= chunk.len();
                        (remaining == 0).then_some(Ok(()))
                    }
                    Err(err) => Some(Err(err.kind())),
                };
                if let Some(status) = status {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(status);
                    }
                }
                result
            });
        (reqwest::Body::wrap_stream(chunks), status)
    });

    let upstream = shared
        .connection
        .lock()
        .ok()
        .map(|mut guard| guard.begin_request());
    let Some(upstream) = upstream else {
        return;
    };
    let Ok(candidates) = upstream.candidate_urls() else {
        write_proxy_error(
            &mut writer,
            "500 Internal Server Error",
            &cors,
            "DESKTOP_INVALID_SERVER_CONFIG",
            "Check the MusicDeck server URL in Server Connection settings.".into(),
        )
        .await;
        return;
    };

    let mut upstream_response = None;
    let mut active_base_url = upstream.server_url.clone();
    let mut last_failure = None;
    let safe_read =
        matches!(method, reqwest::Method::GET | reqwest::Method::HEAD) && content_length == 0;
    let media_deadline = tokio::time::Instant::now() + MEDIA_HEADER_TIMEOUT;

    for candidate_base in &candidates {
        let Ok(target_url) = reqwest::Url::parse(&format!("{candidate_base}{path_and_query}"))
        else {
            break;
        };
        let origin = target_url.origin().ascii_serialization();
        let mut req_builder = shared
            .client
            .request(method.clone(), target_url)
            .header("Origin", origin.as_str())
            .header("Referer", format!("{candidate_base}/"));
        if !audio_stream {
            req_builder = req_builder.timeout(Duration::from_secs(3600));
        }

        for (k, v) in &forwarded_headers {
            req_builder = req_builder.header(k, v);
        }
        if websocket_upgrade {
            req_builder = req_builder
                .version(reqwest::Version::HTTP_11)
                .header("Connection", "Upgrade")
                .header("Upgrade", "websocket");
            for (key, value) in &websocket_headers {
                req_builder = req_builder.header(key, value);
            }
        }

        if let Some(ref token) = upstream.cookie {
            if !token.is_empty() {
                req_builder = req_builder.header("Cookie", format!("musicdeck_session={token}"));
            }
        }

        let header_timeout = if audio_stream {
            let remaining = media_deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                last_failure = Some(UpstreamFailure::HeaderTimeout);
                break;
            }
            remaining
        } else if path == "/api/v1/admin/system/restore" {
            RESTORE_HEADER_TIMEOUT
        } else {
            UPSTREAM_HEADER_TIMEOUT
        };
        let result = if let Some((body, upload_status)) = upload.take() {
            req_builder = req_builder
                .header(reqwest::header::CONTENT_LENGTH, content_length)
                .body(body);
            send_upload(req_builder, upload_status, header_timeout).await
        } else {
            let send = send_upstream(req_builder, &method, &origin, header_timeout);
            if websocket_upgrade {
                send.await
            } else {
                tokio::select! {
                    biased;
                    _ = request_socket_closed(&mut reader) => return,
                    result = send => result,
                }
            }
        };
        match result {
            Ok(resp) => {
                active_base_url = candidate_base.clone();
                upstream_response = Some(resp);
                break;
            }
            Err(failure) => {
                let can_try_alternate = failure.can_try_alternate();
                last_failure = Some(failure);
                // A connect failure occurred before any request was transmitted.
                // A streaming upload owns its input reader and cannot be replayed.
                if !safe_read || !can_try_alternate {
                    break;
                }
            }
        }
    }

    let Some(resp) = upstream_response else {
        if let Some(failure) = last_failure {
            let status = failure.status();
            let status = format!(
                "{} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            );
            let (code, message) = failure.details();
            write_proxy_error(&mut writer, &status, &cors, code, message.into()).await;
        } else {
            write_proxy_error(
                &mut writer,
                "500 Internal Server Error",
                &cors,
                "DESKTOP_INVALID_SERVER_CONFIG",
                "Could not construct the MusicDeck server request.".into(),
            )
            .await;
        }
        return;
    };

    let accepted = shared
        .connection
        .lock()
        .map_err(|_| "Desktop configuration lock poisoned".to_string())
        .and_then(|mut guard| {
            guard.accept_response(
                &shared.config_dir,
                &upstream,
                &active_base_url,
                resp.headers(),
            )
        });
    if let Err(error) = accepted {
        write_proxy_error(
            &mut writer,
            "409 Conflict",
            &cors,
            "DESKTOP_CONNECTION_CHANGED",
            error,
        )
        .await;
        return;
    }

    if websocket_upgrade && resp.status() == reqwest::StatusCode::SWITCHING_PROTOCOLS {
        let Some(accept) = resp
            .headers()
            .get("sec-websocket-accept")
            .and_then(|value| value.to_str().ok())
        else {
            return;
        };
        let response = format!("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {accept}\r\n\r\n");
        if let Ok(mut upgraded) = resp.upgrade().await {
            let Ok(mut stream) = reader.take().unwrap().reunite(writer) else {
                return;
            };
            if stream.write_all(response.as_bytes()).await.is_ok() {
                let _ = tokio::io::copy_bidirectional(&mut stream, &mut upgraded).await;
            }
        }
        return;
    }

    let status = resp.status();
    let status_code = status.as_u16();
    let reason = status.canonical_reason().unwrap_or("OK");
    let chunked = method != reqwest::Method::HEAD
        && !matches!(status_code, 204 | 205 | 304)
        && !resp.headers().contains_key(reqwest::header::CONTENT_LENGTH);

    let mut response_head = format!(
        "HTTP/1.1 {status_code} {reason}\r\n\
         {cors}Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition, Retry-After, X-Request-Id\r\n\
         Connection: close\r\n"
    );
    if chunked {
        response_head.push_str("Transfer-Encoding: chunked\r\n");
    }

    for (name, value) in resp.headers().iter() {
        let key_lower = name.as_str().to_ascii_lowercase();
        if matches!(
            key_lower.as_str(),
            "content-type"
                | "content-encoding"
                | "content-length"
                | "content-range"
                | "accept-ranges"
                | "cache-control"
                | "etag"
                | "last-modified"
                | "content-disposition"
                | "retry-after"
                | "x-request-id"
        ) {
            if let Ok(v) = value.to_str() {
                response_head.push_str(&format!("{}: {v}\r\n", name.as_str()));
            }
        }
    }
    response_head.push_str("\r\n");

    if writer.write_all(response_head.as_bytes()).await.is_err() {
        return;
    }

    let event_stream = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    let mut body_stream = resp.bytes_stream();
    let mut delivered_bytes = 0_u64;
    loop {
        let next = tokio::select! {
            biased;
            _ = request_socket_closed(&mut reader) => return,
            chunk = async {
                if event_stream {
                    Ok(body_stream.next().await)
                } else {
                    let idle = if audio_stream { Duration::from_secs(45) } else { UPSTREAM_HEADER_TIMEOUT };
                    tokio::time::timeout(idle, body_stream.next()).await
                }
            } => chunk,
        };
        let chunk_res = match next {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                eprintln!("MusicDeck desktop upstream body timed out after headers: status={status_code} delivered_bytes={delivered_bytes}");
                // Leave the response incomplete so the media element can recover.
                return;
            }
        };
        match chunk_res {
            Ok(chunk) => {
                if chunk.is_empty() {
                    continue;
                }
                if chunked
                    && writer
                        .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                        .await
                        .is_err()
                {
                    return;
                }
                if writer.write_all(&chunk).await.is_err() {
                    return;
                }
                delivered_bytes += chunk.len() as u64;
                if chunked && writer.write_all(b"\r\n").await.is_err() {
                    return;
                }
            }
            Err(error) => {
                eprintln!("MusicDeck desktop upstream body failed: status={status_code} delivered_bytes={delivered_bytes} error={:?}", error.without_url());
                return;
            }
        }
    }
    if chunked {
        let _ = writer.write_all(b"0\r\n\r\n").await;
    }
    let _ = writer.flush().await;
    let _ = writer.shutdown().await;
}

fn is_desktop_origin(origin: &str) -> bool {
    matches!(
        origin,
        "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost"
    ) || (cfg!(debug_assertions) && origin == "http://localhost:3000")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DesktopConfig;

    #[test]
    fn only_exact_desktop_origins_are_allowed() {
        for origin in [
            "http://tauri.localhost",
            "https://tauri.localhost",
            "tauri://localhost",
        ] {
            assert!(is_desktop_origin(origin));
        }
        for origin in [
            "null",
            "",
            "https://example.invalid",
            "http://tauri.localhost:8080",
        ] {
            assert!(!is_desktop_origin(origin));
        }
        assert_eq!(
            is_desktop_origin("http://localhost:3000"),
            cfg!(debug_assertions)
        );
    }

    async fn read_head(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            bytes.push(stream.read_u8().await.unwrap());
        }
        String::from_utf8(bytes).unwrap()
    }

    #[tokio::test]
    async fn retries_a_read_after_early_upstream_eof_but_preserves_single_attempt_for_writes() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", upstream.local_addr().unwrap());
            let endpoint = format!("{origin}/api/checkpoint");
            let client = reqwest::Client::builder()
                .no_proxy()
                .pool_max_idle_per_host(0)
                .build()
                .unwrap();
            let backend = tokio::spawn(async move {
                for (expected, respond) in [("GET ", false), ("GET ", true), ("POST ", false)] {
                    let (mut stream, _) = upstream.accept().await.unwrap();
                    assert!(read_head(&mut stream).await.starts_with(expected));
                    if respond {
                        stream
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                            .await
                            .unwrap();
                    }
                    stream.shutdown().await.unwrap();
                }
                assert!(tokio::time::timeout(Duration::from_millis(400), upstream.accept()).await.is_err());
            });
            let response = send_upstream(
                client.get(&endpoint),
                &reqwest::Method::GET,
                &origin,
                Duration::from_secs(2),
            )
            .await
            .ok()
            .expect("GET recovers on a fresh connection");
            assert_eq!(response.text().await.unwrap(), "ok");

            let result = send_upstream(
                client.post(&endpoint),
                &reqwest::Method::POST,
                &origin,
                Duration::from_secs(2),
            )
            .await;
            assert!(matches!(result, Err(UpstreamFailure::Request(error)) if !error.is_timeout()));
            backend.await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn upstream_request_has_a_deadline_for_response_headers() {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", upstream.local_addr().unwrap());
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        // Keep the listener alive without serving a response.
        let result = send_upstream(
            client.get(format!("{origin}/api/health")),
            &reqwest::Method::GET,
            &origin,
            Duration::from_millis(100),
        )
        .await;
        let Err(failure) = result else {
            panic!("expected the request to time out")
        };
        assert!(matches!(failure, UpstreamFailure::HeaderTimeout));
        assert_eq!(failure.status(), reqwest::StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(failure.details().0, "DESKTOP_UPSTREAM_TIMEOUT");
        drop(upstream);
    }

    #[tokio::test]
    async fn remote_socket_tunnels_the_session_only_for_the_desktop_origin() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy_addr = proxy.local_addr().unwrap();
            let server_url = format!("http://{}", upstream.local_addr().unwrap());
            let shared = Arc::new(ProxySharedState {
                connection: Arc::new(Mutex::new(DesktopConnection::new(DesktopConfig {
                    server_url: server_url.clone(),
                    session_cookie: Some("fixture-session".into()),
                    ..Default::default()
                }))),
                config_dir: std::env::temp_dir(),
                path_prefix: "/fixture".into(),
                client: reqwest::Client::new(),
            });
            let proxy_task = tokio::spawn(async move {
                for _ in 0..2 {
                    let (stream, _) = proxy.accept().await.unwrap();
                    handle_proxy_connection(stream, shared.clone()).await;
                }
            });
            let request = |origin: &str| format!("GET /fixture/api/v1/remote HTTP/1.1\r\nHost: {proxy_addr}\r\nOrigin: {origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
            let mut rejected = TcpStream::connect(proxy_addr).await.unwrap();
            rejected.write_all(request("https://outside.example").as_bytes()).await.unwrap();
            assert!(read_head(&mut rejected).await.starts_with("HTTP/1.1 403"));

            let mut desktop = TcpStream::connect(proxy_addr).await.unwrap();
            desktop.write_all(request("http://tauri.localhost").as_bytes()).await.unwrap();
            let (mut server, _) = upstream.accept().await.unwrap();
            let headers = read_head(&mut server).await.to_ascii_lowercase();
            assert!(headers.starts_with("get /api/v1/remote http/1.1\r\n"));
            assert!(headers.contains(&format!("origin: {server_url}\r\n")));
            assert!(headers.contains("cookie: musicdeck_session=fixture-session\r\n"));
            server.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n").await.unwrap();
            assert!(read_head(&mut desktop).await.starts_with("HTTP/1.1 101"));
            desktop.write_all(b"ping").await.unwrap();
            let mut payload = [0; 4];
            server.read_exact(&mut payload).await.unwrap();
            assert_eq!(&payload, b"ping");
            server.write_all(b"pong").await.unwrap();
            desktop.read_exact(&mut payload).await.unwrap();
            assert_eq!(&payload, b"pong");
            drop(server);
            drop(desktop);
            proxy_task.await.unwrap();
        }).await.unwrap();
    }

    #[tokio::test]
    async fn upload_chunks_forwards_prefix_and_rejects_early_end() {
        let (mut browser, proxy) = tokio::io::duplex(64);
        let chunks = upload_chunks(proxy, b"head".to_vec(), 10);
        futures_util::pin_mut!(chunks);
        assert_eq!(chunks.next().await.unwrap().unwrap(), b"head");
        browser.write_all(b"body").await.unwrap();
        browser.shutdown().await.unwrap();
        assert_eq!(chunks.next().await.unwrap().unwrap(), b"body");
        assert_eq!(
            chunks.next().await.unwrap().unwrap_err().kind(),
            std::io::ErrorKind::UnexpectedEof
        );
    }

    #[tokio::test]
    async fn archive_upload_streams_before_the_full_body_arrives_and_rejects_over_limit() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy_addr = proxy.local_addr().unwrap();
            let shared = Arc::new(ProxySharedState {
                connection: Arc::new(Mutex::new(DesktopConnection::new(DesktopConfig {
                    server_url: format!("http://{}", upstream.local_addr().unwrap()),
                    session_cookie: Some("fixture-session".into()),
                    ..DesktopConfig::default()
                }))),
                config_dir: std::env::temp_dir(),
                path_prefix: "/fixture".into(),
                client: reqwest::Client::new(),
            });
            let proxy_task = tokio::spawn(async move {
                for _ in 0..2 {
                    let (stream, _) = proxy.accept().await.unwrap();
                    handle_proxy_connection(stream, shared.clone()).await;
                }
            });
            let request_head = |length| format!(
                "POST /fixture/api/v1/admin/system/restore HTTP/1.1\r\nHost: {proxy_addr}\r\nOrigin: http://tauri.localhost\r\nContent-Length: {length}\r\n\r\n"
            );
            let mut rejected = TcpStream::connect(proxy_addr).await.unwrap();
            rejected.write_all(request_head(upload_limit("/api/v1/admin/system/restore") + 1).as_bytes()).await.unwrap();
            assert!(read_head(&mut rejected).await.starts_with("HTTP/1.1 413"));

            let length = PREBUFFER_BYTES + 17;
            let mut client = TcpStream::connect(proxy_addr).await.unwrap();
            client.write_all(request_head(length).as_bytes()).await.unwrap();
            client.write_all(b"fixture").await.unwrap();
            let (mut server, _) = upstream.accept().await.unwrap();
            let headers = read_head(&mut server).await.to_ascii_lowercase();
            assert!(headers.contains(&format!("content-length: {length}\r\n")));
            let mut prefix = [0; 7];
            server.read_exact(&mut prefix).await.unwrap();
            assert_eq!(&prefix, b"fixture");

            let remaining = vec![42; length - prefix.len()];
            client.write_all(&remaining).await.unwrap();
            let mut forwarded = vec![0; remaining.len()];
            server.read_exact(&mut forwarded).await.unwrap();
            assert_eq!(forwarded, remaining);
            server.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            assert!(read_head(&mut client).await.starts_with("HTTP/1.1 202"));
            proxy_task.await.unwrap();
        }).await.unwrap();
    }

    #[tokio::test]
    async fn serves_trusted_http_requests_and_originless_media_on_the_private_path() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy_addr = proxy.local_addr().unwrap();
            let config = DesktopConfig {
                server_url: format!("http://{}", upstream.local_addr().unwrap()),
                session_cookie: Some("fixture-session".into()),
                ..DesktopConfig::default()
            };
            let shared = Arc::new(ProxySharedState {
                connection: Arc::new(Mutex::new(DesktopConnection::new(config))),
                config_dir: std::env::temp_dir(),
                path_prefix: "/fixture".into(),
                client: reqwest::Client::new(),
            });
            let proxy_task = tokio::spawn(async move {
                for _ in 0..9 {
                    let (stream, _) = proxy.accept().await.unwrap();
                    handle_proxy_connection(stream, shared.clone()).await;
                }
            });
            for (path, origin) in [
                ("/fixture/api/artwork/cover", "Origin: https://example.invalid\r\n"),
                ("/fixture/api/artwork/cover", "Origin: null\r\n"),
                ("/api/artwork/cover", ""),
            ] {
                let mut rejected = TcpStream::connect(proxy_addr).await.unwrap();
                rejected.write_all(format!(
                    "GET {path} HTTP/1.1\r\nHost: {proxy_addr}\r\n{origin}\r\n"
                ).as_bytes()).await.unwrap();
                let response = read_head(&mut rejected).await;
                assert!(response.starts_with("HTTP/1.1 403"));
                assert!(!response.contains("Access-Control-Allow-Origin:"));
            }
            let mut preflight = TcpStream::connect(proxy_addr).await.unwrap();
            preflight.write_all(format!(
                "OPTIONS /fixture/api/auth/session HTTP/1.1\r\nHost: {proxy_addr}\r\nOrigin: http://tauri.localhost\r\n\r\n"
            ).as_bytes()).await.unwrap();
            let response = read_head(&mut preflight).await;
            assert!(response.starts_with("HTTP/1.1 204"));
            assert!(response.contains("Access-Control-Allow-Origin: http://tauri.localhost\r\n"));

            for origin in ["Origin: http://tauri.localhost\r\n", ""] {
                let mut desktop = TcpStream::connect(proxy_addr).await.unwrap();
                desktop.write_all(format!(
                    "GET /fixture/api/artwork/cover HTTP/1.1\r\nHost: {proxy_addr}\r\n{origin}\r\n"
                ).as_bytes()).await.unwrap();
                let (mut server, _) = upstream.accept().await.unwrap();
                let request = read_head(&mut server).await.to_ascii_lowercase();
                assert!(request.starts_with("get /api/artwork/cover http/1.1\r\n"));
                assert!(request.contains("cookie: musicdeck_session=fixture-session\r\n"));
                server.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nart").await.unwrap();
                let response = read_head(&mut desktop).await;
                assert!(response.starts_with("HTTP/1.1 200"));
                assert_eq!(response.contains("Access-Control-Allow-Origin: http://tauri.localhost\r\n"), !origin.is_empty());
                let mut body = [0; 3];
                desktop.read_exact(&mut body).await.unwrap();
                assert_eq!(&body, b"art");
            }
            let truncated = tokio::spawn(async move {
                let response = reqwest::get(format!("http://{proxy_addr}/fixture/api/artwork/cover"))
                    .await
                    .unwrap();
                assert!(response.status().is_success());
                assert!(response.bytes().await.is_err());
            });
            let (mut server, _) = upstream.accept().await.unwrap();
            read_head(&mut server).await;
            server.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nart\r\n")
                .await.unwrap();
            server.shutdown().await.unwrap();
            truncated.await.unwrap();

            let mut cancelled = TcpStream::connect(proxy_addr).await.unwrap();
            cancelled.write_all(format!(
                "GET /fixture/api/artwork/cover HTTP/1.1\r\nHost: {proxy_addr}\r\n\r\n"
            ).as_bytes()).await.unwrap();
            let (mut server, _) = upstream.accept().await.unwrap();
            read_head(&mut server).await;
            drop(cancelled);
            assert!(server.read_u8().await.is_err());

            // A 502 from the backend must retain its body and must not be
            // handled as a local connect error or retried.
            let forwarded = tokio::spawn(async move {
                let response = reqwest::get(format!("http://{proxy_addr}/fixture/api/artwork/cover"))
                    .await
                    .unwrap();
                assert_eq!(response.status(), reqwest::StatusCode::BAD_GATEWAY);
                assert_eq!(response.text().await.unwrap(), "backend error");
            });
            let (mut server, _) = upstream.accept().await.unwrap();
            read_head(&mut server).await;
            server.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 13\r\nConnection: close\r\n\r\nbackend error").await.unwrap();
            forwarded.await.unwrap();
            proxy_task.await.unwrap();
        }).await.unwrap();
    }
}

fn bind_proxy_listener() -> Option<std::net::TcpListener> {
    for port in 4535..=4545 {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            return Some(listener);
        }
    }
    std::net::TcpListener::bind("127.0.0.1:0").ok()
}

pub(crate) fn start_local_api_proxy(
    connection: Arc<Mutex<DesktopConnection>>,
    config_dir: PathBuf,
    client: reqwest::Client,
) -> Option<String> {
    let std_listener = bind_proxy_listener()?;
    std_listener.set_nonblocking(true).ok()?;
    let local_addr = std_listener.local_addr().ok()?;
    // Media elements may omit Origin. A fresh, unguessable path authenticates
    // requests from the desktop webview without exposing the upstream cookie.
    let mut secret = [0u8; 32];
    getrandom::fill(&mut secret).ok()?;
    let path_prefix = format!("/{}", secret.map(|byte| format!("{byte:02x}")).concat());
    let proxy_url = format!("http://{local_addr}{path_prefix}");

    let shared = Arc::new(ProxySharedState {
        connection,
        config_dir,
        path_prefix,
        client,
    });

    tauri::async_runtime::spawn(async move {
        let Ok(listener) = TcpListener::from_std(std_listener) else {
            return;
        };
        while let Ok((stream, _)) = listener.accept().await {
            let state_clone = Arc::clone(&shared);
            tokio::spawn(handle_proxy_connection(stream, state_clone));
        }
    });

    Some(proxy_url)
}
