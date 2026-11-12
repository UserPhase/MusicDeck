//! # Remote Control WebSocket & Google Cast Gateway HTTP Routes (`routes::remote_cast`)
//!
//! Complete Rust port of the HTTP/WebSocket handlers in `server/src/services/RemoteControlHub.ts`
//! and `server/src/routes/cast.ts`.

use std::collections::HashMap;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::ws::{CloseFrame, Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
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
use crate::error::{ApiErrorBody, ApiErrorEnvelope, ServerError};
use crate::remote::{REGISTRATION_TIMEOUT_MS, REMOTE_WS_PATH, RemoteClientMessage, RemoteControlHub};
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
    if !is_allowed_remote_origin(
        origin,
        headers.get(HOST).and_then(|value| value.to_str().ok()),
        &state.config().network.public_url,
        state.config().cors_origin(),
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }

    let Some(session_id) = extract_session_cookie(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(store) = state.session_store().cloned() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Ok(Some(user)) = store.get_session_user_by_id(&session_id).await else {
        return StatusCode::UNAUTHORIZED.into_response();
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

async fn drive_remote_websocket(
    mut socket: WebSocket,
    connection: RemoteConnection,
    store: crate::auth::SessionStore,
    user_id: String,
    session_id: String,
    mut outbound_rx: tokio::sync::mpsc::Receiver<serde_json::Value>,
) {
    let RemoteConnection { hub, id: conn_id } = &connection;
    let reg_deadline = tokio::time::sleep(Duration::from_millis(REGISTRATION_TIMEOUT_MS));
    tokio::pin!(reg_deadline);
    let mut reg_checked = false;

    let mut ping_ticker = tokio::time::interval(Duration::from_secs(15));
    ping_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        let transfer_deadline = hub.transfer_deadline(conn_id);
        tokio::select! {
            () = async {
                if let Some(deadline) = transfer_deadline {
                    tokio::time::sleep_until(deadline).await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => hub.expire_transfer(conn_id, tokio::time::Instant::now()),
            () = &mut reg_deadline, if !reg_checked => {
                reg_checked = true;
                if !hub.is_registered(conn_id) {
                    let _ = socket.send(WsMessage::Close(Some(CloseFrame {
                        code: 4000,
                        reason: "Registration timeout".into(),
                    }))).await;
                    break;
                }
            }
            _ = ping_ticker.tick() => {
                let valid = store
                    .get_session_user_by_id(&session_id)
                    .await
                    .ok()
                    .flatten()
                    .is_some_and(|u| u.id == user_id);
                if !valid {
                    let _ = socket.send(WsMessage::Close(Some(CloseFrame {
                        code: 4001,
                        reason: "Session expired".into(),
                    }))).await;
                    break;
                }
                if socket.send(WsMessage::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
            Some(payload) = outbound_rx.recv() => {
                if let Ok(text) = serde_json::to_string(&payload)
                    && socket.send(WsMessage::Text(text)).await.is_err()
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
                        let _ = socket.send(WsMessage::Pong(data)).await;
                    }
                    WsMessage::Pong(_) => {}
                    WsMessage::Binary(_) => {
                        if !hub.consume_rate_token(conn_id, current_epoch_ms()) {
                            let _ = socket.send(WsMessage::Close(Some(CloseFrame {
                                code: 4008,
                                reason: "Remote command rate exceeded".into(),
                            }))).await;
                            break;
                        }
                        let err_json = r#"{"type":"ERROR","message":"Binary messages are not supported"}"#;
                        let _ = socket.send(WsMessage::Text(err_json.into())).await;
                    }
                    WsMessage::Text(text) => {
                        if !hub.consume_rate_token(conn_id, current_epoch_ms()) {
                            let _ = socket.send(WsMessage::Close(Some(CloseFrame {
                                code: 4008,
                                reason: "Remote command rate exceeded".into(),
                            }))).await;
                            break;
                        }

                        let Ok(raw_val) = serde_json::from_str::<serde_json::Value>(&text) else {
                            let err_json = r#"{"type":"ERROR","message":"Malformed remote JSON"}"#;
                            let _ = socket.send(WsMessage::Text(err_json.into())).await;
                            continue;
                        };

                        let Ok(parsed_msg) = serde_json::from_value::<RemoteClientMessage>(raw_val) else {
                            let err_json = r#"{"type":"ERROR","message":"Invalid remote message"}"#;
                            let _ = socket.send(WsMessage::Text(err_json.into())).await;
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
    payload_res: Result<Json<CastTicketRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if let Err(PrivacyError::Blocked(code)) =
        state.privacy().assert_external_allowed(PrivacyCategory::External)
    {
        return send_error_response(StatusCode::FORBIDDEN, code.message(), code.as_str());
    }

    let Ok(Json(req_body)) = payload_res else {
        return map_cast_error(
            CastError::Validation(String::from("Invalid Cast track request")),
            false,
        );
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
    payload_res: Result<Json<CastTokenQueryOrBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return map_cast_error(
            CastError::Validation(String::from("Invalid Cast ticket")),
            false,
        );
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

    match resolver
        .fetch_stream(&lease.track_id, range_hdr, None, lease.max_bit_rate)
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
