//! # Remote Control WebSocket & Google Cast Gateway HTTP Routes (`routes::remote_cast`)
//!
//! Complete Rust port of the HTTP/WebSocket handlers in `server/src/services/RemoteControlHub.ts`
//! and `server/src/routes/cast.ts`.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::Duration;

use crate::error::ApiJson;
use axum::{Extension, Json};
use axum::Router;
use axum::extract::ws::{CloseFrame, Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_EXPOSE_HEADERS, CACHE_CONTROL, HOST, ORIGIN, RANGE, REFERRER_POLICY,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use chrono::Utc;
use serde::Deserialize;
use url::Url;

use crate::auth::{AuthenticatedUser, extract_session_cookie};
use crate::cast::{CastError, CastTicketRequest};
use crate::catalog::{LibraryItemType, LibraryService, SourceResolver};
use crate::config::AppConfig;
use crate::error::{ApiErrorBody, ApiErrorEnvelope, ServerError};
use crate::remote::{
    REGISTRATION_TIMEOUT_MS, REMOTE_WS_PATH, RemoteClientMessage, RemoteControlHub,
};
use crate::services::privacy::{PrivacyCategory, PrivacyError};
use crate::state::AppState;
use crate::streaming::{proxy_upstream_stream, send_error_response};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CastTokenQueryOrBody {
    token: String,
}

/// Registers `/api/v1/remote` and `/api/v1/cast/*` routes.
pub fn remote_and_cast_routes() -> Router<AppState> {
    Router::new()
        .route(REMOTE_WS_PATH, get(remote_ws_or_426_handler))
        .route(
            "/api/v1/cast/ticket",
            post(create_cast_ticket_handler).delete(delete_cast_ticket_handler),
        )
        .route(
            "/api/v1/cast/stream",
            get(cast_stream_handler).options(cast_stream_options_handler),
        )
}

// ============================================================================
// `/api/v1/remote` WebSocket Upgrade & Session Loop
// ============================================================================

// Axum drops the upgrade callback if the client disconnects before upgrading.
// Keep the slot owned by that callback and then by the live socket task.
struct RemoteConnection {
    hub: RemoteControlHub,
    id: String,
}

impl Drop for RemoteConnection {
    fn drop(&mut self) {
        self.hub.disconnect_client(&self.id);
    }
}

async fn remote_ws_or_426_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    ws_opt: Option<WebSocketUpgrade>,
) -> Response {
    // Plain HTTP GET without WebSocket upgrade returns `426 Upgrade Required`
    let Some(ws) = ws_opt else {
        return send_error_response(
            StatusCode::UPGRADE_REQUIRED,
            "Use a WebSocket connection",
            "UPGRADE_REQUIRED",
        );
    };

    // Same-origin clients may use a different hostname or LAN address for this server.
    let origin = headers
        .get(ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let config = state.config();
    let host = headers.get(HOST).and_then(|value| value.to_str().ok());
    if !is_allowed_remote_origin(origin, host, &config.network.public_url, config.cors_origin())
        && !is_local_dev_proxy(origin, host, &config, peer.map(|Extension(ConnectInfo(addr))| addr))
    {
        return send_error_response(
            StatusCode::FORBIDDEN,
            "Remote WebSocket origin is not allowed",
            "REMOTE_ORIGIN_FORBIDDEN",
        );
    }

    let Some(session_id) = extract_session_cookie(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(store) = state.session_store().cloned() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let user = match tokio::time::timeout(REMOTE_PONG_TIMEOUT, store.get_session_user_by_id(&session_id)).await {
        Ok(Ok(Some(user))) => user,
        Ok(Ok(None)) => return StatusCode::UNAUTHORIZED.into_response(),
        Ok(Err(error)) => {
            tracing::warn!(%error, "Remote session lookup failed");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };

    let now_ms = current_epoch_ms();
    let hub = state.remote_hub().clone();
    let (conn_id, rx) = match hub.connect_client(&user.id, &session_id, now_ms) {
        Ok(pair) => pair,
        Err(_) => return StatusCode::TOO_MANY_REQUESTS.into_response(),
    };

    let connection = RemoteConnection { hub, id: conn_id };
    ws.max_message_size(1024 * 1024).on_upgrade(move |socket| {
        drive_remote_websocket(socket, connection, store, user.id, session_id, rx)
    })
}

fn is_allowed_remote_origin(
    origin: &str,
    host: Option<&str>,
    public_url: &str,
    cors_origin: &str,
) -> bool {
    let Ok(parsed_origin) = Url::parse(origin) else {
        return false;
    };
    if !matches!(parsed_origin.scheme(), "http" | "https")
        || parsed_origin.path() != "/"
        || parsed_origin.query().is_some()
        || parsed_origin.fragment().is_some()
        || !parsed_origin.username().is_empty()
        || parsed_origin.password().is_some()
    {
        return false;
    }
    let public_url = Url::parse(public_url).ok();
    let cors_origin = Url::parse(cors_origin).ok();
    if [public_url.as_ref(), cors_origin.as_ref()]
        .into_iter()
        .flatten()
        .any(|allowed| allowed.origin() == parsed_origin.origin())
    {
        return true;
    }
    // Host is the authority the browser connected to. Forwarded host/proto headers
    // cannot expand the origin allowlist. Match the configured public scheme too.
    host.zip(public_url.as_ref()).is_some_and(|(host, public)| {
        public.scheme() == parsed_origin.scheme()
            && host.parse::<http::uri::Authority>().is_ok()
            && !host.contains('@')
            && Url::parse(&format!("{}://{host}", public.scheme()))
                .is_ok_and(|target| target.origin() == parsed_origin.origin())
    })
}

fn is_local_dev_proxy(
    origin: &str,
    host: Option<&str>,
    config: &AppConfig,
    peer: Option<SocketAddr>,
) -> bool {
    // CRA's proxy target in webapp/package.json is 127.0.0.1:4534.
    // On WebSocket upgrades it rewrites Host to the backend and preserves the browser's Origin.
    !config.is_production
        && config.network.host.is_loopback()
        && peer.is_some_and(|addr| addr.ip().is_loopback())
        && matches!(origin, "http://localhost:3000" | "http://127.0.0.1:3000")
        && host.is_some_and(|host| host == format!("127.0.0.1:{}", config.network.port))
}

const REMOTE_PING_INTERVAL: Duration = Duration::from_secs(15);
const REMOTE_PONG_TIMEOUT: Duration = Duration::from_secs(5);
const REMOTE_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
struct RemoteHeartbeat {
    ping_id: u64,
    deadline: Option<tokio::time::Instant>,
}

impl RemoteHeartbeat {
    fn sent_ping(&mut self, now: tokio::time::Instant) {
        self.ping_id = self.ping_id.wrapping_add(1);
        self.deadline = Some(now + REMOTE_PONG_TIMEOUT);
    }

    fn accept_pong(&mut self, data: &[u8], now: tokio::time::Instant) {
        if self.deadline.is_some_and(|deadline| now < deadline)
            && data == self.ping_id.to_be_bytes()
        {
            self.deadline = None;
        }
    }
}

async fn send_remote_frame(socket: &mut WebSocket, frame: WsMessage) -> bool {
    matches!(
        tokio::time::timeout(REMOTE_WRITE_TIMEOUT, socket.send(frame)).await,
        Ok(Ok(()))
    )
}

async fn drive_remote_websocket(
    mut socket: WebSocket,
    connection: RemoteConnection,
    store: crate::auth::SessionStore,
    user_id: String,
    session_id: String,
    mut outbound_rx: tokio::sync::mpsc::Receiver<serde_json::Value>,
) {
    let RemoteConnection { hub, id: conn_id } = &connection;
    let Some(mut disconnected) = hub.disconnect_signal(conn_id) else {
        return;
    };
    let Some(deadline_changed) = hub.deadline_signal(conn_id) else {
        return;
    };
    let reg_deadline = tokio::time::sleep(Duration::from_millis(REGISTRATION_TIMEOUT_MS));
    tokio::pin!(reg_deadline);
    let mut reg_checked = false;

    // The upgrade already validated the session. Let the device register before
    // the first periodic check can wait on session storage.
    let mut ping_ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + REMOTE_PING_INTERVAL,
        REMOTE_PING_INTERVAL,
    );
    ping_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut heartbeat = RemoteHeartbeat::default();

    loop {
        let pong_deadline = heartbeat.deadline;
        let revoked = *disconnected.borrow();
        if revoked || pong_deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline)
        {
            let (code, reason) = if revoked {
                (4002, "Device playback control revoked")
            } else {
                hub.disconnect_client(conn_id);
                (1011, "Device control heartbeat timed out")
            };
            send_remote_frame(
                &mut socket,
                WsMessage::Close(Some(CloseFrame {
                    code,
                    reason: reason.into(),
                })),
            )
            .await;
            break;
        }
        let operation_deadline = hub.operation_deadline(conn_id);
        tokio::select! {
            _ = disconnected.changed() => continue,
            () = deadline_changed.notified() => continue,
            () = async {
                if let Some(deadline) = pong_deadline {
                    tokio::time::sleep_until(deadline).await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => continue,
            () = async {
                if let Some(deadline) = operation_deadline {
                    tokio::time::sleep_until(deadline).await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => hub.expire_operations(conn_id, tokio::time::Instant::now()),
            () = &mut reg_deadline, if !reg_checked => {
                reg_checked = true;
                if !hub.is_registered(conn_id) {
                    send_remote_frame(&mut socket, WsMessage::Close(Some(CloseFrame {
                        code: 4000,
                        reason: "Registration timeout".into(),
                    }))).await;
                    break;
                }
            }
            _ = ping_ticker.tick() => {
                // Do not let a stalled session lookup keep an unreachable device online.
                let session = tokio::time::timeout(
                    REMOTE_PONG_TIMEOUT, store.get_session_user_by_id(&session_id)
                ).await;
                let close = match session {
                    Ok(Ok(Some(user))) if user.id == user_id => None,
                    Ok(Ok(_)) => Some((4001, "Session expired")),
                    _ => Some((1011, "Session storage temporarily unavailable")),
                };
                if let Some((code, reason)) = close {
                    if code == 4001 {
                        hub.revoke_sessions(Some(&user_id), |session| session == session_id);
                    } else {
                        hub.disconnect_client(conn_id);
                    }
                    send_remote_frame(&mut socket, WsMessage::Close(Some(CloseFrame {
                        code,
                        reason: reason.into(),
                    }))).await;
                    break;
                }
                if heartbeat.deadline.is_some() { break; }
                heartbeat.sent_ping(tokio::time::Instant::now());
                if !send_remote_frame(&mut socket, WsMessage::Ping(heartbeat.ping_id.to_be_bytes().to_vec())).await {
                    break;
                }
                if hub.supports_control_watchdog(conn_id) && !send_remote_frame(&mut socket, WsMessage::Text(
                    serde_json::json!({ "type": "REMOTE_HEARTBEAT", "server_time": current_epoch_ms() }).to_string().into()
                )).await {
                    break;
                }
            }
            Some(payload) = outbound_rx.recv() => {
                if let Ok(text) = serde_json::to_string(&payload)
                    && !send_remote_frame(&mut socket, WsMessage::Text(text)).await
                {
                    break;
                }
            }
            inbound = socket.recv() => {
                let Some(Ok(msg)) = inbound else {
                    break;
                };
                match msg {
                    WsMessage::Close(_) => break,
                    WsMessage::Ping(data) => {
                        if !send_remote_frame(&mut socket, WsMessage::Pong(data)).await { break; }
                    }
                    WsMessage::Pong(data) => heartbeat.accept_pong(&data, tokio::time::Instant::now()),
                    WsMessage::Binary(_) => {
                        if !hub.consume_rate_token(conn_id, current_epoch_ms()) {
                            send_remote_frame(&mut socket, WsMessage::Close(Some(CloseFrame {
                                code: 4008,
                                reason: "Remote command rate exceeded".into(),
                            }))).await;
                            break;
                        }
                        let err_json = r#"{"type":"ERROR","message":"Binary messages are not supported"}"#;
                        if !send_remote_frame(&mut socket, WsMessage::Text(err_json.into())).await { break; }
                    }
                    WsMessage::Text(text) => {
                        if !hub.consume_rate_token(conn_id, current_epoch_ms()) {
                            send_remote_frame(&mut socket, WsMessage::Close(Some(CloseFrame {
                                code: 4008,
                                reason: "Remote command rate exceeded".into(),
                            }))).await;
                            break;
                        }

                        let Ok(raw_val) = serde_json::from_str::<serde_json::Value>(&text) else {
                            let err_json = r#"{"type":"ERROR","message":"Malformed remote JSON"}"#;
                            if !send_remote_frame(&mut socket, WsMessage::Text(err_json.into())).await { break; }
                            continue;
                        };

                        let request_id = raw_val.get("requestId").and_then(serde_json::Value::as_str)
                            .filter(|id| !id.is_empty() && id.len() <= 160).map(str::to_owned);
                        let Ok(parsed_msg) = serde_json::from_value::<RemoteClientMessage>(raw_val) else {
                            let error = serde_json::json!({
                                "type": "ERROR", "message": "Invalid remote message", "requestId": request_id,
                            });
                            if !send_remote_frame(&mut socket, WsMessage::Text(error.to_string().into())).await { break; }
                            continue;
                        };

                        hub.handle_message(conn_id, parsed_msg);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::MAX_CLIENTS_PER_USER;

    #[test]
    fn heartbeat_requires_the_current_pong_before_its_deadline() {
        let now = tokio::time::Instant::now();
        let mut heartbeat = RemoteHeartbeat::default();
        heartbeat.sent_ping(now);
        let first_ping = heartbeat.ping_id.to_be_bytes();
        heartbeat.accept_pong(&first_ping, now + Duration::from_secs(1));
        assert_eq!(heartbeat.deadline, None);

        let next_ping = now + REMOTE_PING_INTERVAL;
        heartbeat.sent_ping(next_ping);
        let deadline = next_ping + REMOTE_PONG_TIMEOUT;
        heartbeat.accept_pong(&first_ping, next_ping + Duration::from_secs(1));
        assert_eq!(heartbeat.deadline, Some(deadline));
        heartbeat.accept_pong(&heartbeat.ping_id.to_be_bytes(), deadline);
        assert_eq!(heartbeat.deadline, Some(deadline));
    }

    #[test]
    fn allows_the_lan_authority_and_configured_origins_without_accepting_cross_origin_requests() {
        let public = "http://musicdeck.lan:8080";
        let cors = "http://localhost:3000";
        let host = Some("192.168.2.38:8080");
        assert!(is_allowed_remote_origin(
            "http://192.168.2.38:8080",
            host,
            public,
            cors
        ));
        assert!(is_allowed_remote_origin(public, host, public, cors));
        assert!(is_allowed_remote_origin(cors, host, public, cors));
        for origin in [
            "https://192.168.2.38:8080",
            "http://192.168.2.38",
            "http://unrelated.test:8080",
            "null",
        ] {
            assert!(
                !is_allowed_remote_origin(origin, host, public, cors),
                "{origin}"
            );
        }
    }

    #[test]
    fn restricts_the_cra_origin_to_native_development_on_loopback() {
        let mut config = AppConfig::default();
        config.network.public_url = "http://localhost:8080".into();
        config.network.cors_origin = config.network.public_url.clone();
        let host = Some("127.0.0.1:4534");
        let peer = Some("127.0.0.1:52000".parse().unwrap());
        let origin = "http://localhost:3000";
        assert!(!is_allowed_remote_origin(origin, host, &config.network.public_url, config.cors_origin()));
        assert!(is_local_dev_proxy(origin, host, &config, peer));
        assert!(is_local_dev_proxy("http://127.0.0.1:3000", host, &config, peer));
        for other in ["http://localhost:3001", "https://localhost:3000", "http://localhost.evil.test:3000", "null"] {
            assert!(!is_local_dev_proxy(other, host, &config, peer), "{other}");
        }
        assert!(!is_local_dev_proxy(origin, Some("127.0.0.1:8080"), &config, peer));
        assert!(!is_local_dev_proxy(origin, host, &config, None));
        assert!(!is_local_dev_proxy(origin, host, &config, Some("192.168.1.3:52000".parse().unwrap())));
        config.is_production = true;
        assert!(!is_local_dev_proxy(origin, host, &config, peer));
        config.is_production = false;
        config.network.host = "0.0.0.0".parse().unwrap();
        assert!(!is_local_dev_proxy(origin, host, &config, peer));
    }

    #[tokio::test]
    async fn registers_authenticated_cra_websocket_and_rejects_other_origins() {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        use tokio::net::{TcpListener, TcpStream};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mut config = AppConfig::default();
        config.network.port = addr.port();
        config.network.public_url = "http://localhost:8080".into();
        config.network.cors_origin = config.network.public_url.clone();
        let db = crate::db::DbPool::connect_memory().await.unwrap();
        crate::db::run_migrations(&db, None).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO roles (name, description) VALUES ('user','Listener');
             INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
             VALUES ('listener','listener','unused','Listener','user','now','now');",
        ).execute(db.inner()).await.unwrap();
        let state = AppState::with_database(config, db).await.unwrap();
        let session = state.session_store().unwrap().create_session("listener", true).await.unwrap();
        let app = crate::create_router(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
        });
        for (origin, signed_in, expected) in [
            ("http://localhost:3000", true, "101"),
            ("http://127.0.0.1:3000", true, "101"),
            ("http://localhost:3000", false, "401"),
            ("http://unrelated.test:3000", true, "403"),
            ("http://localhost:3001", true, "403"),
            ("http://localhost:8080", true, "101"),
        ] {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            let cookie = if signed_in { format!("Cookie: {}={}\r\n", crate::auth::SESSION_COOKIE, session.id) } else { String::new() };
            let request = format!(
                "GET {REMOTE_WS_PATH} HTTP/1.1\r\nHost: {addr}\r\nOrigin: {origin}\r\n{cookie}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            );
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut stream = BufReader::new(stream);
            tokio::time::timeout(Duration::from_secs(3), async {
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                assert_eq!(line.split_whitespace().nth(1), Some(expected), "{origin} signed_in={signed_in}: {line}");
                if expected != "101" { return; }

                loop {
                    line.clear();
                    assert!(stream.read_line(&mut line).await.unwrap() > 0);
                    if line == "\r\n" { break; }
                }
                let register = serde_json::json!({
                    "type": "REGISTER", "device_id": "dev-tab", "device_name": "Local Browser",
                    "device_type": "computer", "can_receive": false, "queue_device_id": "browser-tab",
                    "live_sync": true, "command_deadlines": true, "playback_lease": true, "playbackLeaseProtocol": 1,
                    "state": {"current_track": null, "position_ms": 0, "duration_ms": 0, "playing": false, "volume": 1},
                }).to_string();
                let mask = [1, 2, 3, 4];
                let mut frame = vec![0x81, 0xfe]; // Masked text with a two-byte length.
                frame.extend(u16::try_from(register.len()).unwrap().to_be_bytes());
                frame.extend(mask);
                frame.extend(register.bytes().enumerate().map(|(i, byte)| byte ^ mask[i % 4]));
                stream.write_all(&frame).await.unwrap();

                for message_type in ["DEVICES", "INITIAL_STATE"] {
                    assert_eq!(stream.read_u8().await.unwrap(), 0x81, "expected {message_type} before any heartbeat");
                    let len = match stream.read_u8().await.unwrap() {
                        len @ 0..=125 => len as usize,
                        126 => stream.read_u16().await.unwrap() as usize,
                        len => panic!("unexpected WebSocket frame length marker: {len}"),
                    };
                    let mut payload = vec![0; len];
                    stream.read_exact(&mut payload).await.unwrap();
                    let message: serde_json::Value = serde_json::from_slice(&payload).unwrap();
                    assert_eq!(message["type"], message_type);
                    if message_type == "DEVICES" {
                        assert_eq!(message["live_state_protocol"], true);
                        assert_eq!(message["devices"][0]["device_id"], "dev-tab");
                    } else {
                        assert!(message["state"]["revision"].as_u64().is_some_and(|rev| rev > 0));
                        assert_eq!(message["state"]["track"], serde_json::Value::Null);
                        assert_eq!(message["controlTimeoutMs"], 25_000);
                    }
                }
            }).await.unwrap();
        }
        server.abort();
        state.tasks().close();
    }

    #[test]
    fn abandoned_upgrade_releases_its_connection_slot() {
        let hub = RemoteControlHub::new();
        for _ in 0..=MAX_CLIENTS_PER_USER {
            let (id, receiver) = hub.connect_client("user", "session", 0).unwrap();
            let connection = RemoteConnection {
                hub: hub.clone(),
                id,
            };
            let upgrade_callback = move |_: WebSocket| async move {
                drop(connection);
                drop(receiver);
            };
            drop(upgrade_callback);
        }
        assert!(hub.connect_client("user", "session", 0).is_ok());
    }
}

// ============================================================================
// Google Cast Ticket & Stream Proxy Handlers (`/api/v1/cast/*`)
// ============================================================================

fn apply_cast_cors_headers(headers: &mut HeaderMap) {
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    headers.insert(
        ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Range"),
    );
    headers.insert(
        ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Range, Accept-Ranges, Content-Length"),
    );
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
}

fn map_cast_error(err: CastError, include_cast_cors: bool) -> Response {
    let (status, code, msg) = match err {
        CastError::Validation(m) => (StatusCode::BAD_REQUEST, "VALIDATION_ERROR", m),
        CastError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, "AUTHENTICATION_REQUIRED", m),
        CastError::Forbidden(m) => (StatusCode::FORBIDDEN, "FORBIDDEN", m),
        CastError::NotFound => (
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            String::from("Library track not found"),
        ),
        CastError::FormatUnknown => (
            StatusCode::UNPROCESSABLE_ENTITY,
            "CAST_FORMAT_UNKNOWN",
            err.to_string(),
        ),
        CastError::RateLimited(m) => (StatusCode::TOO_MANY_REQUESTS, "CAST_LIMIT", m),
    };

    let mut res = (
        status,
        Json(ApiErrorEnvelope {
            error: ApiErrorBody {
                request_id: crate::error::current_request_id(),
                code: String::from(code),
                message: msg,
            },
        }),
    )
        .into_response();

    if include_cast_cors {
        apply_cast_cors_headers(res.headers_mut());
    }
    res
}

/// `POST /api/v1/cast/ticket`
async fn create_cast_ticket_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<ApiJson<CastTicketRequest>, crate::error::ApiJsonRejection>,
) -> Response {
    if let Err(PrivacyError::Blocked(code)) =
        state.privacy().assert_external_allowed(PrivacyCategory::External)
    {
        return send_error_response(StatusCode::FORBIDDEN, code.message(), code.as_str());
    }

    let ApiJson(req_body) = match payload_res {
        Ok(body) => body,
        Err(rejection) => return rejection.into_response(),
    };

    let Some(db) = state.db().cloned() else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };
    let library = LibraryService::new(db, Some(state.config().music_root.clone()));

    let item_type = library
        .get_item_type(&req_body.track_id)
        .await
        .ok()
        .flatten();
    if item_type != Some(LibraryItemType::Track) {
        return map_cast_error(CastError::NotFound, false);
    }

    let resolver = SourceResolver::new(state.providers().clone(), library);
    let source_meta = if req_body.max_bit_rate.is_none() {
        resolver
            .audio_metadata(&req_body.track_id, None)
            .await
            .ok()
            .flatten()
    } else {
        None
    };

    let now_ms = Utc::now().timestamp_millis();
    match state.cast_gateway().create_ticket(
        &auth.session_id,
        &auth.user.id,
        &state.config().network.public_url,
        &req_body,
        source_meta.as_ref(),
        now_ms,
    ) {
        Ok(ticket) => {
            let mut res = Json(ticket).into_response();
            res.headers_mut().insert(
                CACHE_CONTROL,
                HeaderValue::from_static("private, no-store"),
            );
            res
        }
        Err(err) => map_cast_error(err, false),
    }
}

/// `DELETE /api/v1/cast/ticket`
async fn delete_cast_ticket_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<ApiJson<CastTokenQueryOrBody>, crate::error::ApiJsonRejection>,
) -> Response {
    let ApiJson(body) = match payload_res {
        Ok(body) => body,
        Err(rejection) => return rejection.into_response(),
    };

    match state
        .cast_gateway()
        .revoke_ticket(&body.token, &auth.session_id)
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => map_cast_error(err, false),
    }
}

/// `OPTIONS /api/v1/cast/stream`
async fn cast_stream_options_handler() -> Response {
    let mut res = StatusCode::NO_CONTENT.into_response();
    apply_cast_cors_headers(res.headers_mut());
    res
}

/// `GET /api/v1/cast/stream?token=<hex>`
async fn cast_stream_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Err(PrivacyError::Blocked(code)) =
        state.privacy().assert_external_allowed(PrivacyCategory::External)
    {
        state.cast_gateway().revoke_all();
        let mut res = send_error_response(StatusCode::FORBIDDEN, code.message(), code.as_str());
        apply_cast_cors_headers(res.headers_mut());
        return res;
    }

    let Some(token) = params.get("token").filter(| _| params.len() == 1) else {
        return map_cast_error(
            CastError::Unauthorized(String::from("Valid Cast stream ticket required")),
            true,
        );
    };

    let now_ms = Utc::now().timestamp_millis();
    let (lease, _conn_guard) = match state.cast_gateway().acquire_receiver_stream(token, now_ms) {
        Ok(pair) => pair,
        Err(err) => return map_cast_error(err, true),
    };

    // Revalidate that the issuing user session is still active in SQLite
    let session_still_valid = if let Some(store) = state.session_store() {
        store
            .get_session_user_by_id(&lease.session_id)
            .await
            .ok()
            .flatten()
            .is_some_and(|u| u.id == lease.user_id)
    } else {
        false
    };

    if !session_still_valid {
        let _ = state
            .cast_gateway()
            .revoke_ticket(token, &lease.session_id);
        return map_cast_error(
            CastError::Unauthorized(String::from("Cast stream ticket expired or revoked")),
            true,
        );
    }

    let Some(db) = state.db().cloned() else {
        let mut res = send_error_response(
            StatusCode::BAD_GATEWAY,
            "Cast media stream failed",
            "BACKEND_ERROR",
        );
        apply_cast_cors_headers(res.headers_mut());
        return res;
    };

    let library = LibraryService::new(db, Some(state.config().music_root.clone()));
    let resolver = SourceResolver::new(state.providers().clone(), library);
    let range_hdr = headers.get(RANGE).and_then(|v| v.to_str().ok());

    let stream_key = crate::catalog::resolver::PlaybackStreamKey {
        scope: &lease.user_id,
        session: Some(token),
        track: &lease.track_id,
        preferred_source: None,
        max_bit_rate: lease.max_bit_rate,
    };
    match resolver
        .fetch_pinned_stream(
            &stream_key,
            range_hdr,
            headers
                .get(axum::http::header::IF_RANGE)
                .and_then(|value| value.to_str().ok()),
        )
        .await
    {
        Ok(stream_result) => {
            let mut res = proxy_upstream_stream(stream_result, None);
            apply_cast_cors_headers(res.headers_mut());
            res
        }
        Err(_) => {
            let mut res = send_error_response(
                StatusCode::BAD_GATEWAY,
                "Cast media stream failed",
                "BACKEND_ERROR",
            );
            apply_cast_cors_headers(res.headers_mut());
            res
        }
    }
}

fn current_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}
