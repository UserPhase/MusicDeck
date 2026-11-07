use super::*;
use crate::db::run_migrations;
use crate::services::privacy::{PrivacyManager, PrivacySettings};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;

async fn fixture() -> (DbPool, PrivacyManager, ArtistFollowService) {
    let db = DbPool::connect_memory().await.unwrap();
    run_migrations(&db, None).await.unwrap();
    sqlx::raw_sql(
        "INSERT INTO roles VALUES ('user', 'Listener');
        INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
        VALUES ('listener', 'listener', 'unused', 'Listener', 'user', '2026-01-01', '2026-01-01');",
    )
    .execute(db.inner())
    .await
    .unwrap();
    let privacy = PrivacyManager::default();
    let service = ArtistFollowService::new(Some(db.clone()), ExternalArtworkTokenStore::new())
        .with_privacy(privacy.clone());
    service
        .follow(
            "listener",
            FollowArtistInput {
                artist_id: "27".into(),
                artist_name: "Daft Punk".into(),
                provider: FollowProvider::Deezer,
            },
        )
        .await
        .unwrap();
    (db, privacy, service)
}

#[tokio::test]
async fn local_only_skips_due_release_scan_and_direct_store_lookup() {
    let (db, privacy, service) = fixture().await;
    privacy
        .update(PrivacySettings {
            local_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(service.scan_due_artists().await, (0, 0));
    assert!(
        service
            .throttled_store_request("deezer", "artist/27", &[])
            .await
            .is_err()
    );
    let lease: i64 = sqlx::query_scalar("SELECT lease_until FROM followed_artist_catalog")
        .fetch_one(db.inner())
        .await
        .unwrap();
    assert_eq!(lease, 0);
    let requests: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM release_provider_throttle")
        .fetch_one(db.inner())
        .await
        .unwrap();
    assert_eq!(requests, 0);
    db.close().await;
}

#[tokio::test]
async fn policy_change_cancels_active_release_request_and_releases_artist_lease() {
    let (db, privacy, mut service) = fixture().await;
    let started = Arc::new(Notify::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let signal = started.clone();
    let count = calls.clone();
    let app = axum::Router::new().fallback(move || {
        let signal = signal.clone();
        let count = count.clone();
        async move {
            count.fetch_add(1, Ordering::SeqCst);
            signal.notify_one();
            std::future::pending::<axum::Json<Value>>().await
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    service.store_base_url = Some(format!("http://{}/", listener.local_addr().unwrap()));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let scan = tokio::spawn(async move { service.scan_due_artists().await });
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    privacy
        .update(PrivacySettings {
            local_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), scan)
            .await
            .unwrap()
            .unwrap(),
        (0, 0)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let (lease, failures): (i64, i64) =
        sqlx::query_as("SELECT lease_until, failures FROM followed_artist_catalog")
            .fetch_one(db.inner())
            .await
            .unwrap();
    assert_eq!((lease, failures), (0, 0));
    server.abort();
    let _ = server.await;
    db.close().await;
}
