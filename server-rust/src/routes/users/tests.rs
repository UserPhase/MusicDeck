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
