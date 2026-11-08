use crate::config::{candidate_server_urls, save_config, DesktopConfig};
use futures_util::StreamExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub struct ProxySharedState {
    pub config: Arc<Mutex<DesktopConfig>>,
    pub ephemeral_cookie: Arc<Mutex<Option<String>>>,
    pub config_dir: PathBuf,
    pub client: reqwest::Client,
}

fn extract_session_cookie_from_set_cookie(header_val: &str) -> Option<(String, bool)> {
    let mut parts = header_val.split(';');
    let first = parts.next()?.trim();
    let value = first.strip_prefix("musicdeck_session=")?;
    let lower = header_val.to_ascii_lowercase();
    let is_persistent = lower.contains("expires=") || lower.contains("max-age=");
    Some((value.to_string(), is_persistent))
}

pub fn apply_response_cookies(
    headers: &reqwest::header::HeaderMap,
    config: &Arc<Mutex<DesktopConfig>>,
    ephemeral_cookie: &Arc<Mutex<Option<String>>>,
    config_dir: & std::path::Path,
) {
    for val in headers.get_all(reqwest::header::SET_COOKIE).iter() {
        if let Ok(raw_cookie) = val.to_str() {
            if let Some((token, is_persistent)) = extract_session_cookie_from_set_cookie(raw_cookie)
            {
                if token.is_empty() {
                    if let Ok(mut eph) = ephemeral_cookie.lock() {
                        *eph = None;
                    }
                    if let Ok(mut guard) = config.lock() {
                        guard.session_cookie = None;
                        let _ = save_config(config_dir, &guard);
                    }
                } else if is_persistent {
                    if let Ok(mut eph) = ephemeral_cookie.lock() {
                        *eph = Some(token.clone());
                    }
                    if let Ok(mut guard) = config.lock() {
                        guard.session_cookie = Some(token);
                        let _ = save_config(config_dir, &guard);
                    }
                } else {
                    if let Ok(mut eph) = ephemeral_cookie.lock() {
                        *eph = Some(token);
                    }
                    if let Ok(mut guard) = config.lock() {
                        guard.session_cookie = None;
                        let _ = save_config(config_dir, &guard);
                    }
                }
            }
        }
    }
}

async fn handle_proxy_connection(mut stream: TcpStream, shared: Arc<ProxySharedState>) {
    let mut buf = Vec::with_capacity(8192);
    let mut temp = [0u8; 4096];
    let header_end;

    loop {
        match stream.read(&mut temp).await {
            Ok(0) => return,
            Ok(n) => {
                buf.extend_from_slice(&temp[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    header_end = pos + 4;
                    break;
                }
                if buf.len() > 65536 {
                    return;
                }
            }
            Err(_) => return,
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

    let mut content_length: usize = 0;
    let mut request_origin: Option<String> = None;
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
                content_length = value.parse::<usize>().unwrap_or(0);
            } else if lower == "origin" && !value.is_empty() && value != "null" {
                request_origin = Some(value.to_string());
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
            ) {
                forwarded_headers.push((key.to_string(), value.to_string()));
            }
        }
    }

    let cors_origin = request_origin.as_deref().unwrap_or("*");

    if websocket_upgrade
        && (!method_str.eq_ignore_ascii_case("GET")
            || path_and_query != "/api/v1/remote"
            || !is_desktop_websocket_origin(request_origin.as_deref())
            || content_length != 0
            || buf.len() != header_end)
    {
        let _ = stream
            .write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            .await;
        return;
    }

    if method_str.eq_ignore_ascii_case("OPTIONS") {
        let preflight = format!(
            "HTTP/1.1 204 No Content\r\n\
             Access-Control-Allow-Origin: {cors_origin}\r\n\
             Access-Control-Allow-Credentials: true\r\n\
             Access-Control-Allow-Private-Network: true\r\n\
             Access-Control-Allow-Methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS\r\n\
             Access-Control-Allow-Headers: Content-Type, Authorization, Range, If-Range, Accept, Cache-Control\r\n\
             Access-Control-Max-Age: 86400\r\n\
             Content-Length: 0\r\n\
             Connection: close\r\n\r\n"
        );
        let _ = stream.write_all(preflight.as_bytes()).await;
        let _ = stream.flush().await;
        return;
    }

    let mut body = buf[header_end..].to_vec();
    while body.len() < content_length {
        match stream.read(&mut temp).await {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&temp[..n]),
            Err(_) => return,
        }
    }
    body.truncate(content_length);

    let (configured_url, cookie_token) = {
        let cfg = shared.config.lock().ok().map(|g| g.clone());
        let eph = shared.ephemeral_cookie.lock().ok().and_then(|g| g.clone());
        let server_url = cfg
            .as_ref()
            .map(|c| c.server_url.clone())
            .unwrap_or_else(|| "http://localhost:8080".to_string());
        let token = eph.or_else(|| cfg.and_then(|c| c.session_cookie));
        (server_url, token)
    };

    let Ok(method) = reqwest::Method::from_bytes(method_str.as_bytes()) else {
        return;
    };

    let candidates =
        candidate_server_urls(&configured_url).unwrap_or_else(|_| vec![configured_url.clone()]);

    let mut upstream_response = None;
    let mut active_base_url = configured_url.clone();

    for candidate_base in &candidates {
        let target_url = format!("{candidate_base}{path_and_query}");
        let mut req_builder = shared
            .client
            .request(method.clone(), &target_url)
            .header("Origin", candidate_base)
            .header("Referer", format!("{candidate_base}/"));

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

        if let Some(ref token) = cookie_token {
            if !token.is_empty() {
                req_builder = req_builder.header("Cookie", format!("musicdeck_session={token}"));
            }
        }

        if !body.is_empty() {
            req_builder = req_builder.body(body.clone());
        }

        match req_builder.send().await {
            Ok(resp) => {
                active_base_url = candidate_base.clone();
                upstream_response = Some(resp);
                break;
            }
            Err(_) => continue,
        }
    }

    let Some(resp) = upstream_response else {
        let err_json = serde_json::json!({
            "error": {
                "code": "DESKTOP_SERVER_UNREACHABLE",
                "message": format!("Could not reach MusicDeck server at {configured_url}. Check Server Connection settings.")
            }
        })
        .to_string();
        let reply = format!(
            "HTTP/1.1 502 Bad Gateway\r\n\
             Content-Type: application/json\r\n\
             Access-Control-Allow-Origin: {cors_origin}\r\n\
             Access-Control-Allow-Credentials: true\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\r\n{}",
            err_json.len(),
            err_json
        );
        let _ = stream.write_all(reply.as_bytes()).await;
        let _ = stream.flush().await;
        return;
    };

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
            if stream.write_all(response.as_bytes()).await.is_ok() {
                let _ = tokio::io::copy_bidirectional(&mut stream, &mut upgraded).await;
            }
        }
        return;
    }

    // If an alternate port (e.g. :8080 instead of :4534) succeeded, persist it automatically.
    if active_base_url != configured_url {
        if let Ok(mut guard) = shared.config.lock() {
            guard.server_url = active_base_url;
            let _ = save_config(&shared.config_dir, &guard);
        }
    }

    // Capture Set-Cookie headers from login / session renewal / logout.
    apply_response_cookies(
        resp.headers(),
        &shared.config,
        &shared.ephemeral_cookie,
        &shared.config_dir,
    );

    let status = resp.status();
    let status_code = status.as_u16();
    let reason = status.canonical_reason().unwrap_or("OK");

    let mut response_head = format!(
        "HTTP/1.1 {status_code} {reason}\r\n\
         Access-Control-Allow-Origin: {cors_origin}\r\n\
         Access-Control-Allow-Credentials: true\r\n\
         Access-Control-Allow-Private-Network: true\r\n\
         Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition\r\n\
         Connection: close\r\n"
    );

    for (name, value) in resp.headers().iter() {
        let key_lower = name.as_str().to_ascii_lowercase();
        if matches!(
            key_lower.as_str(),
            "content-type"
                | "content-length"
                | "content-range"
                | "accept-ranges"
                | "cache-control"
                | "etag"
                | "last-modified"
                | "content-disposition"
                | "retry-after"
        ) {
            if let Ok(v) = value.to_str() {
                response_head.push_str(&format!("{}: {v}\r\n", name.as_str()));
            }
        }
    }
    response_head.push_str("\r\n");

    if stream.write_all(response_head.as_bytes()).await.is_err() {
        return;
    }

    let mut body_stream = resp.bytes_stream();
    while let Some(chunk_res) = body_stream.next().await {
        match chunk_res {
            Ok(chunk) => {
                if stream.write_all(&chunk).await.is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}

fn is_desktop_websocket_origin(origin: Option<&str>) -> bool {
    matches!(
        origin,
        Some("http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost")
    ) || (cfg!(debug_assertions) && origin == Some("http://localhost:3000"))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn read_head(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            bytes.push(stream.read_u8().await.unwrap());
        }
        String::from_utf8(bytes).unwrap()
    }

    #[tokio::test]
    async fn remote_socket_tunnels_the_session_only_for_the_desktop_origin() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy_addr = proxy.local_addr().unwrap();
            let server_url = format!("http://{}", upstream.local_addr().unwrap());
            let shared = Arc::new(ProxySharedState {
                config: Arc::new(Mutex::new(DesktopConfig { server_url: server_url.clone(), ..Default::default() })),
                ephemeral_cookie: Arc::new(Mutex::new(Some("fixture-session".into()))),
                config_dir: std::env::temp_dir(),
                client: reqwest::Client::new(),
            });
            let proxy_task = tokio::spawn(async move {
                for _ in 0..2 {
                    let (stream, _) = proxy.accept().await.unwrap();
                    handle_proxy_connection(stream, shared.clone()).await;
                }
            });
            let request = |origin: &str| format!("GET /api/v1/remote HTTP/1.1\r\nHost: {proxy_addr}\r\nOrigin: {origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
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
}

fn bind_proxy_listener() -> Option<std::net::TcpListener> {
    for port in 4535..=4545 {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            return Some(listener);
        }
    }
    std::net::TcpListener::bind("127.0.0.1:0").ok()
}

pub fn start_local_api_proxy(
    config: Arc<Mutex<DesktopConfig>>,
    ephemeral_cookie: Arc<Mutex<Option<String>>>,
    config_dir: PathBuf,
) -> Option<String> {
    let std_listener = bind_proxy_listener()?;
    std_listener.set_nonblocking(true).ok()?;
    let local_addr = std_listener.local_addr().ok()?;
    let proxy_url = format!("http://127.0.0.1:{}", local_addr.port());

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(3600))
        .build()
        .ok()?;

    let shared = Arc::new(ProxySharedState {
        config,
        ephemeral_cookie,
        config_dir,
        client,
    });

    std::thread::spawn(move || {
        let Ok(rt) = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
        else {
            return;
        };

        rt.block_on(async move {
            let Ok(listener) = TcpListener::from_std(std_listener) else {
                return;
            };
            loop {
                if let Ok((stream, _)) = listener.accept().await {
                    let state_clone = Arc::clone(&shared);
                    tokio::spawn(async move {
                        handle_proxy_connection(stream, state_clone).await;
                    });
                }
            }
        });
    });

    Some(proxy_url)
}
