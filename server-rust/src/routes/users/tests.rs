use super::*;
use crate::config::{AppConfig, parse_trusted_proxies};
use crate::db::run_migrations;
use axum::body::Body;
use http::Request as HttpRequest;
use tower::ServiceExt;

async fn login_router(proxies: &str) -> Router {
    let db = DbPool::connect_memory().await.expect("open database");
    run_migrations(&db, None).await.expect("migrate database");
    let mut config = AppConfig::default();
    config.network.trusted_proxies = parse_trusted_proxies(proxies).expect("proxy configuration");
    config.auth.login_rate_limit.ip_max = 1;
    config.auth.login_rate_limit.account_max = 100;
    let state = AppState::with_database(config, db)
        .await
        .expect("initialize state");
    user_routes().with_state(state)
}

async fn attempt(router: &Router, peer: &str, forwarded: &[&str]) -> StatusCode {
    let mut request = HttpRequest::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header(CONTENT_TYPE, "application/json")
        .extension(ConnectInfo(
            peer.parse::<SocketAddr>().expect("peer address"),
        ));
    for value in forwarded {
        request = request.header("x-forwarded-for", *value);
    }
    router
        .clone()
        .oneshot(
            request
                .body(Body::from(
                    r#"{"username":"unknown-user","password":"wrong-password"}"#,
                ))
                .expect("request"),
        )
        .await
        .expect("response")
        .status()
}

#[tokio::test]
async fn direct_socket_ip_controls_limits_and_untrusted_headers_are_ignored() {
    let router = login_router("").await;
    assert_eq!(
        attempt(&router, "203.0.113.1:1000", &["198.51.100.1"]).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        attempt(&router, "203.0.113.1:2000", &["198.51.100.2"]).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        attempt(&router, "203.0.113.2:1000", &[]).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        attempt(&router, "203.0.113.2:2000", &[]).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        attempt(&router, "203.0.113.3:1000", &["198.51.100.1"]).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn only_configured_proxies_can_supply_distinct_forwarded_clients() {
    let router = login_router("10.20.0.0/16").await;
    assert_eq!(
        attempt(&router, "10.20.0.1:1000", &["198.51.100.1"]).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        attempt(&router, "10.20.0.1:2000", &["198.51.100.2"]).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        attempt(&router, "10.20.0.1:3000", &["198.51.100.1"]).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        attempt(&router, "10.21.0.1:1000", &["198.51.100.3"]).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        attempt(&router, "10.21.0.1:2000", &["198.51.100.4"]).await,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn missing_or_malformed_proxy_headers_use_the_direct_socket() {
    let router = login_router("10.20.0.0/16").await;
    assert_eq!(
        attempt(&router, "10.20.0.1:1000", &[]).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        attempt(&router, "10.20.0.1:2000", &[]).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        attempt(&router, "10.20.0.2:1000", &["198.51.100.1, invalid"]).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        attempt(&router, "10.20.0.2:2000", &["198.51.100.2, invalid"]).await,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn proxy_chains_and_repeated_headers_stop_at_the_first_untrusted_hop() {
    let router = login_router("10.20.0.0/16").await;
    assert_eq!(
        attempt(
            &router,
            "10.20.0.1:1000",
            &["192.0.2.1", "198.51.100.1, 10.20.0.2"]
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        attempt(
            &router,
            "10.20.0.1:2000",
            &["192.0.2.2", "198.51.100.1, 10.20.0.2"]
        )
        .await,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn ipv6_and_ipv4_mapped_addresses_have_stable_rate_limit_keys() {
    let router = login_router("2001:db8:1::/64").await;
    assert_eq!(
        attempt(&router, "[2001:db8:1::1]:1000", &["2001:db8:2::1"]).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        attempt(&router, "[2001:db8:1::1]:2000", &["2001:db8:2:0:0:0:0:1"]).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        attempt(&router, "[::ffff:203.0.113.1]:1000", &[]).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        attempt(&router, "203.0.113.1:2000", &[]).await,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn missing_connect_info_rejects_the_request_instead_of_trusting_headers() {
    let router = login_router("10.20.0.0/16").await;
    let response = router
        .oneshot(
            HttpRequest::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header(CONTENT_TYPE, "application/json")
                .header("x-forwarded-for", "198.51.100.1")
                .body(Body::from(
                    r#"{"username":"unknown-user","password":"wrong"}"#,
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn axum_connection_service_populates_the_actual_socket_address() {
    let router = login_router("").await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind server");
    let address = listener.local_addr().expect("server address");
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
    });
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .expect("HTTP client");
    let first = client
        .post(format!("http://{address}/api/auth/login"))
        .header("x-forwarded-for", "198.51.100.1")
        .json(&json!({ "username": "unknown-user", "password": "wrong" }))
        .send()
        .await;
    let second = client
        .post(format!("http://{address}/api/auth/login"))
        .header("x-forwarded-for", "198.51.100.2")
        .json(&json!({ "username": "unknown-user", "password": "wrong" }))
        .send()
        .await;
    server.abort();
    let _ = server.await;
    assert_eq!(
        first.expect("first response").status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        second.expect("second response").status(),
        StatusCode::TOO_MANY_REQUESTS
    );
}

async fn auth_fixture() -> (DbPool, AppState, String) {
    let db = DbPool::connect_memory().await.unwrap();
    run_migrations(&db, None).await.unwrap();
    sqlx::query("INSERT OR IGNORE INTO roles (name, description) VALUES ('user', 'Listener')")
        .execute(db.inner())
        .await
        .unwrap();
    let hash = bcrypt::hash("current-password", 4).unwrap();
    sqlx::query(
        "INSERT INTO users (id, username, password_hash, display_name, role, disabled, created_at, updated_at)
         VALUES ('alice', 'alice', ?, 'Alice', 'user', 0, '2026-01-01', '2026-01-01')",
    )
    .bind(&hash)
    .execute(db.inner())
    .await
    .unwrap();
    let state = AppState::with_database(AppConfig::default(), db.clone())
        .await
        .unwrap();
    (db, state, hash)
}

#[tokio::test]
async fn verified_login_rejects_rotated_credentials_and_rolls_back_failed_session_insert() {
    let (db, state, verified_hash) = auth_fixture().await;
    sqlx::query("UPDATE users SET password_hash = 'already-rotated' WHERE id = 'alice'")
        .execute(db.inner())
        .await
        .unwrap();
    assert!(
        commit_verified_login(&db, "alice", &verified_hash, true)
            .await
            .unwrap()
            .is_none()
    );

    sqlx::query("UPDATE users SET password_hash = ?, disabled = 1 WHERE id = 'alice'")
        .bind(&verified_hash)
        .execute(db.inner())
        .await
        .unwrap();
    assert!(
        commit_verified_login(&db, "alice", &verified_hash, true)
            .await
            .unwrap()
            .is_none()
    );

    sqlx::raw_sql(
        "UPDATE users SET disabled = 0 WHERE id = 'alice';
         CREATE TRIGGER refuse_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
    ).execute(db.inner()).await.unwrap();
    let router = user_routes().with_state(state);
    let login = || {
        HttpRequest::post("/api/auth/login")
            .extension(ConnectInfo(
                "127.0.0.1:12345".parse::<SocketAddr>().unwrap(),
            ))
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"username":"alice","password":"current-password"}"#,
            ))
            .unwrap()
    };
    let response = router.clone().oneshot(login()).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        !response
            .headers()
            .contains_key(axum::http::header::SET_COOKIE)
    );
    let last_login: Option<String> =
        sqlx::query_scalar("SELECT last_login_at FROM users WHERE id = 'alice'")
            .fetch_one(db.inner())
            .await
            .unwrap();
    assert!(last_login.is_none());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(db.inner())
        .await
        .unwrap();
    assert_eq!(count, 0);

    sqlx::query("DROP TRIGGER refuse_session")
        .execute(db.inner())
        .await
        .unwrap();
    let response = router.oneshot(login()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()[axum::http::header::SET_COOKIE]
        .to_str()
        .unwrap();
    let session: String = sqlx::query_scalar("SELECT id FROM sessions WHERE user_id = 'alice'")
        .fetch_one(db.inner())
        .await
        .unwrap();
    assert!(cookie.starts_with(&format!("musicdeck_session={session};")));
}

#[tokio::test]
async fn password_change_requires_current_hash_and_live_calling_session() {
    let (db, state, verified_hash) = auth_fixture().await;
    let sessions = state.session_store().unwrap();
    let current = sessions.create_session("alice", false).await.unwrap();
    let expired = sessions.create_session("alice", true).await.unwrap();
    let other = sessions.create_session("alice", false).await.unwrap();
    sqlx::query("UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?")
        .bind(&expired.id)
        .execute(db.inner())
        .await
        .unwrap();
    assert!(
        !commit_password_change(&db, "alice", &expired.id, &verified_hash, "expired")
            .await
            .unwrap()
    );
    assert!(
        !commit_password_change(&db, "alice", "revoked", &verified_hash, "revoked")
            .await
            .unwrap()
    );
    let (first, second) = tokio::join!(
        commit_password_change(&db, "alice", &current.id, &verified_hash, "first"),
        commit_password_change(&db, "alice", &current.id, &verified_hash, "second"),
    );
    let (first, second) = (first.unwrap(), second.unwrap());
    assert_ne!(first, second);
    let actual: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = 'alice'")
        .fetch_one(db.inner())
        .await
        .unwrap();
    assert_eq!(actual, if first { "first" } else { "second" });
    assert!(
        sessions
            .get_session_user_by_id(&other.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        sessions
            .get_session_user_by_id(&current.id)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn password_change_publishes_revocation_only_after_successful_commit() {
    let (db, state, old_hash) = auth_fixture().await;
    let sessions = state.session_store().unwrap().clone();
    let current = sessions.create_session("alice", false).await.unwrap();
    let other = sessions.create_session("alice", false).await.unwrap();
    let mut events = sessions.events().subscribe();
    sqlx::query("CREATE TRIGGER refuse_revocation BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'fixture'); END")
        .execute(db.inner()).await.unwrap();
    let router = user_routes().with_state(state);
    let change = || {
        HttpRequest::post("/api/auth/change-password")
            .header(
                axum::http::header::COOKIE,
                format!("musicdeck_session={}", current.id),
            )
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"currentPassword":"current-password","newPassword":"fresh-password"}"#,
            ))
            .unwrap()
    };

    let response = router.clone().oneshot(change()).await.unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(events.try_recv().is_err());
    let stored = get_user_by_username(&db, "alice").await.unwrap().unwrap();
    assert_eq!(stored.password_hash, old_hash);
    assert!(
        sessions
            .get_session_user_by_id(&other.id)
            .await
            .unwrap()
            .is_some()
    );

    sqlx::query("DROP TRIGGER refuse_revocation")
        .execute(db.inner())
        .await
        .unwrap();
    let response = router.oneshot(change()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        events.try_recv().unwrap(),
        crate::auth::SessionEvent::UserSessionsRevoked {
            user_id: "alice".into(),
            except_session_id: Some(current.id.clone()),
        }
    );
    assert!(
        sessions
            .get_session_user_by_id(&other.id)
            .await
            .unwrap()
            .is_none()
    );
    let stored = get_user_by_username(&db, "alice").await.unwrap().unwrap();
    assert!(
        verify_password("fresh-password", &stored.password_hash)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn logout_failure_retains_cookie_and_session_and_a_retry_revokes_them() {
    let (db, state, _) = auth_fixture().await;
    let sessions = state.session_store().unwrap().clone();
    let session = sessions.create_session("alice", true).await.unwrap();
    let mut events = sessions.events().subscribe();
    sqlx::query("CREATE TRIGGER refuse_logout BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'fixture'); END")
        .execute(db.inner()).await.unwrap();
    let router = user_routes().with_state(state);
    let logout = || {
        HttpRequest::post("/api/auth/logout")
            .header(
                axum::http::header::COOKIE,
                format!("musicdeck_session={}", session.id),
            )
            .body(Body::empty())
            .unwrap()
    };

    let response = router.clone().oneshot(logout()).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()[axum::http::header::RETRY_AFTER], "1");
    assert!(
        !response
            .headers()
            .contains_key(axum::http::header::SET_COOKIE)
    );
    assert!(events.try_recv().is_err());
    assert!(
        sessions
            .get_session_user_by_id(&session.id)
            .await
            .unwrap()
            .is_some()
    );

    sqlx::query("DROP TRIGGER refuse_logout")
        .execute(db.inner())
        .await
        .unwrap();
    let response = router.oneshot(logout()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response
            .headers()
            .contains_key(axum::http::header::SET_COOKIE)
    );
    assert!(
        sessions
            .get_session_user_by_id(&session.id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        events.try_recv().unwrap(),
        crate::auth::SessionEvent::SessionRevoked {
            session_id: session.id
        }
    );
}

#[tokio::test]
async fn refresh_only_emits_a_cookie_for_a_live_remembered_row_that_was_updated() {
    let (db, state, _) = auth_fixture().await;
    let sessions = state.session_store().unwrap().clone();
    let active = sessions.create_session("alice", true).await.unwrap();
    let expired = sessions.create_session("alice", true).await.unwrap();
    sqlx::query("UPDATE sessions SET created_at = '2000-01-01T00:00:00Z', expires_at = '2000-02-01T00:00:00Z' WHERE id = ?")
        .bind(&expired.id).execute(db.inner()).await.unwrap();
    assert!(
        sessions
            .refresh_session_if_remembered(&expired.id, false)
            .await
            .unwrap()
            .is_none()
    );
    let expired_at: String = sqlx::query_scalar("SELECT expires_at FROM sessions WHERE id = ?")
        .bind(&expired.id)
        .fetch_one(db.inner())
        .await
        .unwrap();
    assert_eq!(expired_at, "2000-02-01T00:00:00Z");

    sqlx::query(
        "CREATE TRIGGER ignore_refresh BEFORE UPDATE ON sessions BEGIN SELECT RAISE(IGNORE); END",
    )
    .execute(db.inner())
    .await
    .unwrap();
    let router = user_routes().with_state(state);
    let request = || {
        HttpRequest::get("/api/auth/session")
            .header(
                axum::http::header::COOKIE,
                format!("musicdeck_session={}", active.id),
            )
            .body(Body::empty())
            .unwrap()
    };
    let response = router.clone().oneshot(request()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        !response
            .headers()
            .contains_key(axum::http::header::SET_COOKIE)
    );
    sqlx::query("DROP TRIGGER ignore_refresh")
        .execute(db.inner())
        .await
        .unwrap();
    let response = router.oneshot(request()).await.unwrap();
    assert!(
        response
            .headers()
            .contains_key(axum::http::header::SET_COOKIE)
    );

    sessions.delete_session(Some(&active.id)).await.unwrap();
    assert!(
        sessions
            .refresh_session_if_remembered(&active.id, false)
            .await
            .unwrap()
            .is_none()
    );
}
