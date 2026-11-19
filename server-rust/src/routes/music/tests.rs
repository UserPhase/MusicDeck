use super::*;
use crate::auth::SESSION_COOKIE;
use crate::catalog::{LibraryItemType, SourceRef};
use crate::config::{AppConfig, JellyfinConfig, NavidromeConfig};
use crate::db::run_migrations;
use crate::providers::media_fixture;
use crate::providers::{JellyfinClient, MusicBackend, NavidromeClient, RegisteredProvider};
use crate::routes::playlists::playlist_routes;
use axum::body::Body;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{Duration, Utc};
use http::Request;
use http_body_util::BodyExt;
use sqlx::Row;
use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration as Timeout;
use tower::ServiceExt;

async fn playback_state(local_only: bool) -> (DbPool, AppState, String) {
    let db = DbPool::connect_memory().await.expect("open database");
    playback_state_with_db(db, local_only).await
}

async fn playback_state_with_db(db: DbPool, local_only: bool) -> (DbPool, AppState, String) {
    run_migrations(&db, None).await.expect("migrate database");
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (name, description) VALUES ('user', 'Listener');
        INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
        VALUES ('listener', 'listener', 'unused', 'Listener', 'user', '2026-01-01', '2026-01-01');
        INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
        VALUES ('lastfm', 1, '{"apiKey":"fixture-key","apiSecret":"fixture-secret"}',
                '["history.read","network.request"]', '2026-01-01'),
               ('listenbrainz', 1, '{}', '["history.read","network.request"]', '2026-01-01');
        INSERT INTO scrobble_connections (user_id, provider, credentials_json, username,
            account_key, generation, connected_at, updated_at)
        VALUES ('listener', 'lastfm', '{}', 'listener', 'lastfm-account', 'generation-1', 0, 0),
               ('listener', 'listenbrainz', '{}', 'listener', 'listenbrainz-account', 'generation-1', 0, 0);
        "#,
    ).execute(db.inner()).await.expect("seed scrobble integrations");
    let mut config = AppConfig::default();
    config.network.local_only_mode = local_only;
    let state = AppState::with_database(config, db.clone())
        .await
        .expect("initialize state");
    let session = state
        .session_store()
        .expect("session store")
        .create_session("listener", true)
        .await
        .expect("create session");
    (db, state, session.id)
}

fn playback_event(seconds: f64, finished: bool) -> Value {
    json!({
        "playbackSessionId": "playback-session-1", "trackId": "track-1",
        "ownerUserId": "listener",
        "startedAt": (Utc::now() - Duration::minutes(10)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "listenedSeconds": seconds, "durationSeconds": 180, "finished": finished,
        "track": { "title": "Roygbiv", "artist": "Boards of Canada", "album": "Music Has the Right to Children" }
    })
}

async fn report(state: &AppState, session: &str, event: &Value) -> (StatusCode, Value) {
    json_response(request(state, session, "POST", "/api/listening-events", Some(event)).await).await
}

async fn request(
    state: &AppState,
    session: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Response {
    music_routes()
        .merge(playlist_routes())
        .merge(crate::routes::sonic_mixes::sonic_and_mixes_routes())
        .merge(crate::routes::playlist_collaboration::playlist_collaboration_routes())
        .merge(crate::routes::external_discovery::external_discovery_routes())
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("cookie", format!("{SESSION_COOKIE}={session}"))
                .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .expect("request"),
        )
        .await
        .expect("response")
}

async fn json_response(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("read response")
        .to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).expect("JSON response"),
    )
}

#[tokio::test]
async fn media_checkpoint_json_contract_preserves_axum_statuses_and_request_ids() {
    let (_db, state, session) = playback_state(true).await;
    let now = Utc::now().timestamp_millis();
    let fixture = json!({
        "type": "album", "mediaId": "album-fixture", "trackId": "track-fixture", "title": "Fixture",
        "trackIndex": 0, "trackCount": 1, "positionSeconds": 12.5, "capturedAt": now
    });
    let mut nullable = fixture.clone();
    nullable["durationSeconds"] = Value::Null;
    nullable["occurrenceId"] = Value::Null;
    let router = crate::create_router(state);
    let send = |body: String, content_type: Option<&str>| {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/v1/user/media-sessions")
            .header("cookie", format!("{SESSION_COOKIE}={session}"));
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        router
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
    };
    for body in [&fixture, &nullable] {
        let (status, out) = json_response(
            send(body.to_string(), Some("application/json"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{out}");
        assert_eq!(out["checkpoint"]["capturedAt"], now);
        assert_eq!(out["checkpoint"]["positionSeconds"], 12.5);
    }

    let mut cases = vec![
        (
            "{".into(),
            Some("application/json"),
            StatusCode::BAD_REQUEST,
            "INVALID_JSON",
        ),
        (
            fixture.to_string(),
            None,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "UNSUPPORTED_MEDIA_TYPE",
        ),
        (
            " ".repeat(2 * 1024 * 1024 + 1),
            Some("application/json"),
            StatusCode::PAYLOAD_TOO_LARGE,
            "PAYLOAD_TOO_LARGE",
        ),
    ];
    for (field, value, status, code) in [
        (
            "type",
            json!("folder"),
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_JSON_DATA",
        ),
        (
            "trackId",
            json!(123),
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_JSON_DATA",
        ),
        (
            "completed",
            Value::Null,
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_JSON_DATA",
        ),
        (
            "capturedAt",
            json!(now / 1000),
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
        ),
        (
            "positionSeconds",
            json!(125_000),
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
        ),
        ("mediaId", json!(""), StatusCode::BAD_REQUEST, "BAD_REQUEST"),
    ] {
        let mut invalid = fixture.clone();
        invalid[field] = value;
        cases.push((invalid.to_string(), Some("application/json"), status, code));
    }
    for (body, content_type, expected_status, code) in cases {
        let response = send(body, content_type).await.unwrap();
        let request_id = response.headers()["x-request-id"]
            .to_str()
            .unwrap()
            .to_owned();
        let (status, out) = json_response(response).await;
        assert_eq!(status, expected_status, "{out}");
        assert_eq!(out["error"]["code"], code);
        assert_eq!(out["error"]["requestId"], request_id);
        assert!(uuid::Uuid::parse_str(&request_id).is_ok());
    }
}

fn catalog_test_track(id: &str, title: &str) -> crate::providers::Track {
    serde_json::from_value(json!({
        "id": id, "providerId": id, "title": title, "artistName": "Fixture Artist",
        "albumName": "Fixture Album", "streamUrl": "", "durationSeconds": 180,
    }))
    .unwrap()
}

fn catalog_test_album(id: &str, name: &str) -> crate::providers::Album {
    serde_json::from_value(json!({
        "id": id, "providerId": id, "name": name, "artistName": "Fixture Artist", "songCount": 1,
    }))
    .unwrap()
}

fn set_catalog_fixture(
    state: &AppState,
    tracks: Vec<crate::providers::Track>,
    albums: Vec<crate::providers::Album>,
) -> Arc<std::sync::RwLock<media_fixture::CatalogFixture>> {
    let fixture = Arc::new(std::sync::RwLock::new(media_fixture::CatalogFixture {
        tracks,
        albums,
    }));
    state
        .providers()
        .replace_all(vec![media_fixture::catalog_provider(
            "fixture",
            fixture.clone(),
        )]);
    fixture
}

#[tokio::test]
async fn library_pages_cover_albums_past_500_and_revise_when_same_count_rows_shift() {
    let (_, state, session) = playback_state(true).await;
    let albums = (0..504)
        .map(|index| catalog_test_album(&format!("album-{index}"), &format!("Album {index:03}")))
        .collect();
    let fixture = set_catalog_fixture(
        &state,
        vec![
            catalog_test_track("a", "First"),
            catalog_test_track("b", "Second"),
        ],
        albums,
    );
    let read = |path| {
        let state = &state;
        let session = &session;
        async move {
            let (status, body) =
                json_response(request(state, session, "GET", path, None).await).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            body
        }
    };
    let first = read("/api/albums?offset=0&limit=1").await;
    let late = read("/api/albums?offset=500&limit=2").await;
    assert_eq!(late["total"], 504);
    assert_eq!(late["albums"][0]["providerId"], "album-500");
    assert_eq!(late["albums"][1]["providerId"], "album-501");
    assert_eq!(late["revision"], first["revision"]);
    assert_eq!(late["degraded"], false);
    assert_eq!(
        read("/api/albums?offset=504&limit=2").await["albums"],
        json!([])
    );

    let first_track = read("/api/tracks?offset=0&limit=1").await;
    fixture.write().unwrap().tracks.swap(0, 1);
    fixture.write().unwrap().albums.swap(0, 1);
    let cached = read("/api/tracks?offset=1&limit=1").await;
    assert_eq!(cached["tracks"][0]["providerId"], "b");
    assert_eq!(cached["revision"], first_track["revision"]);

    state.catalog_snapshots().invalidate().await;
    let shifted = read("/api/tracks?offset=1&limit=1").await;
    assert_eq!(shifted["tracks"][0]["providerId"], "a");
    assert_eq!(shifted["total"], first_track["total"]);
    assert_ne!(shifted["revision"], first_track["revision"]);
    assert_ne!(
        read("/api/albums?offset=500&limit=2").await["revision"],
        late["revision"]
    );
    state.catalog_snapshots().invalidate().await;
    assert_eq!(
        read("/api/tracks?offset=0&limit=1").await["revision"],
        shifted["revision"]
    );
}

#[tokio::test]
async fn library_track_filters_apply_before_paging_and_revisions_are_user_scoped() {
    let (db, state, session) = playback_state(true).await;
    set_catalog_fixture(
        &state,
        ["a", "b", "c", "d", "e"]
            .into_iter()
            .map(|id| catalog_test_track(id, "Shared title"))
            .collect(),
        vec![],
    );
    let (_, listing) =
        json_response(request(&state, &session, "GET", "/api/tracks", None).await).await;
    let rows = listing["tracks"].as_array().unwrap();
    let id = |index: usize| rows[index]["id"].as_str().unwrap();
    sqlx::query("INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
        VALUES ('other', 'other', 'unused', 'Other', 'user', '2026-01-01', '2026-01-01')")
        .execute(db.inner()).await.unwrap();
    for (user, index) in [
        ("other", 0),
        ("listener", 1),
        ("listener", 2),
        ("listener", 3),
    ] {
        crate::services::favorites::set_track_favorite(&db, user, id(index), true)
            .await
            .unwrap();
    }
    crate::services::favorites::set_media_favorite(&db, "listener", "track", id(4), true, None)
        .await
        .unwrap();
    add_recently_played(&db, "listener", id(1), None, false, None, None)
        .await
        .unwrap();
    add_recently_played(&db, "other", id(2), None, false, None, None)
        .await
        .unwrap();
    let body = |offset| {
        json!({ "offset": offset, "limit": 1, "filters": [
        {"field": "favorite", "op": "boolean", "value": true},
        {"field": "played", "op": "boolean", "value": false},
        {"field": "durationSeconds", "op": "gte", "value": 100}
    ] })
    };
    let read = |offset| {
        let body = body(offset);
        let state = &state;
        let session = &session;
        async move {
            let (status, response) = json_response(
                request(
                    state,
                    session,
                    "POST",
                    "/api/library/tracks/filter",
                    Some(&body),
                )
                .await,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{response}");
            response
        }
    };
    let first = read(0).await;
    let second = read(1).await;
    assert_eq!(first["total"], 3);
    assert_eq!(first["tracks"][0]["id"], id(2));
    assert_eq!(first["tracks"][0]["favorite"], true);
    assert_eq!(first["tracks"][0]["played"], false);
    assert_eq!(second["tracks"][0]["id"], id(3));
    assert_eq!(second["revision"], first["revision"]);
    assert_eq!(read(2).await["tracks"][0]["id"], id(4));
    add_recently_played(&db, "listener", id(2), None, false, None, None)
        .await
        .unwrap();
    crate::services::favorites::set_track_favorite(&db, "listener", id(0), true)
        .await
        .unwrap();
    let shifted = read(0).await;
    assert_eq!(shifted["tracks"][0]["id"], id(0));
    assert_eq!(shifted["total"], first["total"]);
    assert_ne!(shifted["revision"], first["revision"]);
}

#[tokio::test]
async fn album_window_follows_navidrome_and_jellyfin_provider_pagination() {
    let (_, state, session) = playback_state(true).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .route(
            "/Items",
            get(|Query(params): Query<HashMap<String, String>>| async move {
                assert_eq!(params["IncludeItemTypes"], "MusicAlbum");
                assert_eq!(params["Limit"], "500");
                let start: usize = params["StartIndex"].parse().unwrap();
                let items: Vec<_> = (start..(start + 500).min(502)).map(|index| json!({
                "Id": format!("jellyfin-{index}"), "Name": format!("Jellyfin Album {index}"),
                "Type": "MusicAlbum"
            })).collect();
                Json(json!({ "Items": items, "TotalRecordCount": 502 }))
            }),
        )
        .route(
            "/rest/getAlbumList2.view",
            get(|Query(params): Query<HashMap<String, String>>| async move {
                assert_eq!(params["size"], "500");
                let start: usize = params["offset"].parse().unwrap();
                let items: Vec<_> = (start..(start + 500).min(503)).map(|index| json!({
                "id": format!("navidrome-{index}"), "name": format!("Navidrome Album {index}")
            })).collect();
                Json(json!({ "subsonic-response": {
                "status": "ok", "albumList2": { "album": items }
            } }))
            }),
        );
    let upstream = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let providers: [(&str, Arc<dyn MusicBackend>); 2] = [
        (
            "jellyfin",
            Arc::new(
                JellyfinClient::new(JellyfinConfig {
                    url: url.clone(),
                    api_key: "fixture".into(),
                })
                .unwrap(),
            ),
        ),
        (
            "navidrome",
            Arc::new(
                NavidromeClient::new(NavidromeConfig {
                    url,
                    username: "fixture".into(),
                    password: "fixture".into(),
                })
                .unwrap(),
            ),
        ),
    ];
    state.providers().replace_all(
        providers
            .into_iter()
            .map(|(id, provider)| RegisteredProvider {
                connection_id: id.into(),
                provider_type: id.into(),
                name: id.into(),
                enabled: true,
                provider,
            })
            .collect(),
    );

    let (status, page) = json_response(
        request(
            &state,
            &session,
            "GET",
            "/api/albums?offset=500&limit=2",
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["total"], 1005);
    assert_eq!(page["albums"][0]["providerId"], "jellyfin-500");
    assert_eq!(page["albums"][1]["providerId"], "jellyfin-501");

    let (status, tail) = json_response(
        request(
            &state,
            &session,
            "GET",
            "/api/albums?offset=1002&limit=3",
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{tail}");
    assert_eq!(tail["albums"][0]["providerId"], "navidrome-500");
    assert_eq!(tail["albums"][2]["providerId"], "navidrome-502");
    assert_eq!(tail["revision"], page["revision"]);
    assert_eq!(tail["degraded"], false);
    upstream.abort();
}

#[tokio::test]
async fn library_matches_preserve_input_order_and_recording_identity() {
    let (_, state, session) = playback_state(true).await;
    let mut track = catalog_test_track("studio", "The Song");
    track.identity_hints = Some(crate::providers::IdentityHints {
        isrc: Some("USAAA1234567".into()),
        music_brainz_id: None,
        upc: None,
    });
    track.artist_credits = Some(vec![crate::providers::TrackArtistCredit {
        id: None,
        name: "Guest Artist".into(),
    }]);
    set_catalog_fixture(
        &state,
        vec![track],
        vec![catalog_test_album("album", "The Album")],
    );
    let payload = json!({ "items": [
        {"id":"album","type":"album","title":"the album","artist":"Fixture Artist"},
        {"id":"live","type":"track","title":"The Song (Live)","artist":"Fixture Artist"},
        {"id":"conflict","type":"track","title":"The Song","artist":"Fixture Artist","isrc":"USAAA1234568"},
        {"id":"strong","type":"track","title":"Alternate title","artist":"Another Artist","isrc":"usaaa1234567"},
        {"id":"guest","type":"track","title":"The Song","artist":"Guest Artist","durationSeconds":182},
        {"id":"long","type":"track","title":"The Song","artist":"Guest Artist","durationSeconds":210},
        {"id":"album","type":"album","title":"The Album","artist":"Another Artist"}
    ] });
    let (status, response) = json_response(
        request(
            &state,
            &session,
            "POST",
            "/api/library/matches",
            Some(&payload),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    let matches = response["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 7);
    let album_id = matches[0]["localAlbumId"].as_str().unwrap();
    let track_id = matches[3]["localTrackId"].as_str().unwrap();
    assert!(album_id.starts_with("md_"));
    assert!(track_id.starts_with("md_"));
    assert_eq!(
        response["matches"],
        json!([
            {"id":"album", "inLibrary":true, "localTrackId":null, "localAlbumId":album_id},
            {"id":"live", "inLibrary":false, "localTrackId":null, "localAlbumId":null},
            {"id":"conflict", "inLibrary":false, "localTrackId":null, "localAlbumId":null},
            {"id":"strong", "inLibrary":true, "localTrackId":track_id, "localAlbumId":null},
            {"id":"guest", "inLibrary":true, "localTrackId":track_id, "localAlbumId":null},
            {"id":"long", "inLibrary":false, "localTrackId":null, "localAlbumId":null},
            {"id":"album", "inLibrary":false, "localTrackId":null, "localAlbumId":null}
        ])
    );
    let oversized = json!({ "items": vec![payload["items"][0].clone(); 101] });
    let response = request(
        &state,
        &session,
        "POST",
        "/api/library/matches",
        Some(&oversized),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn catalog_album_lookup_continues_past_an_unregistered_connection() {
    let (db, state, _) = playback_state(true).await;
    set_catalog_fixture(
        &state,
        vec![],
        vec![catalog_test_album("fallback-album", "Available Album")],
    );
    let (catalog, _, library) = build_catalog_and_resolver(&state).unwrap();
    let id = library
        .ensure_id(
            LibraryItemType::Album,
            &SourceRef {
                connection_id: "removed".into(),
                provider_item_id: "old-album".into(),
            },
            None,
        )
        .await
        .unwrap();
    sqlx::query("UPDATE library_item_sources SET created_at='2025-01-01' WHERE library_item_id=?")
        .bind(&id)
        .execute(db.inner())
        .await
        .unwrap();
    library
        .add_source(
            &id,
            &SourceRef {
                connection_id: "fixture".into(),
                provider_item_id: "fallback-album".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        library.get_sources(&id).await.unwrap()[0].connection_id,
        "removed"
    );

    let album = catalog.get_album(&id).await.unwrap();
    assert_eq!(album.item.id, id);
    assert_eq!(album.item.name, "Available Album");
}

#[tokio::test]
async fn similar_mix_save_rolls_back_partial_writes_and_reads_back_in_order() {
    let (db, state, session) = playback_state(true).await;
    let tracks = [
        catalog_test_track("first", "First"),
        catalog_test_track("last", "Last"),
    ];
    set_catalog_fixture(&state, tracks.to_vec(), vec![]);
    let (catalog, _, _) = build_catalog_and_resolver(&state).unwrap();
    let first = catalog
        .stamp_track(tracks[0].clone(), "fixture")
        .await
        .unwrap();
    let last = catalog
        .stamp_track(tracks[1].clone(), "fixture")
        .await
        .unwrap();
    let external = state
        .similar_mixes()
        .register_external_seed("Discovery", "Guest")
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO smart_playlist_catalog_state (singleton, refreshed_at, degraded, mix_revision)
        VALUES (1, '2026-01-01', 0, 1)",
    )
    .execute(db.inner())
    .await
    .unwrap();
    for track in [&first, &last] {
        sqlx::query(
            "INSERT INTO smart_playlist_tracks (id, title, artist, album, revision)
            VALUES (?, ?, 'Fixture Artist', 'Fixture Album', 'fixture')",
        )
        .bind(&track.item.id)
        .bind(&track.item.title)
        .execute(db.inner())
        .await
        .unwrap();
        sqlx::query("INSERT INTO smart_playlist_track_payloads VALUES (?, ?)")
            .bind(&track.item.id)
            .bind(serde_json::to_string(track).unwrap())
            .execute(db.inner())
            .await
            .unwrap();
    }
    let selection = [
        last.item.id.as_str(),
        external.id.as_str(),
        first.item.id.as_str(),
    ];
    let now = Utc::now().timestamp_millis();
    sqlx::query(
        "INSERT INTO similar_mix_previews (id, user_id, candidate_ids_json, created_at, expires_at)
        VALUES ('preview', 'listener', ?, ?, ?)",
    )
    .bind(serde_json::to_string(&selection).unwrap())
    .bind(now)
    .bind(now + 60_000)
    .execute(db.inner())
    .await
    .unwrap();
    let payload = json!({ "ownerId": "listener", "previewId": "preview", "trackIds": selection, "name": "Mix" });
    let save = || {
        request(
            &state,
            &session,
            "POST",
            "/api/v1/similar-mixes/save",
            Some(&payload),
        )
    };
    sqlx::query(
        "CREATE TRIGGER refuse_mix_item BEFORE INSERT ON playlist_items WHEN NEW.position = 1
        BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END",
    )
    .execute(db.inner())
    .await
    .unwrap();
    assert_eq!(save().await.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM playlists")
        .fetch_one(db.inner())
        .await
        .unwrap();
    assert_eq!(count, 0);
    let claimed =
        sqlx::query_scalar::<_, Option<String>>("SELECT playlist_id FROM similar_mix_previews")
            .fetch_one(db.inner())
            .await
            .unwrap();
    assert_eq!(claimed, None);
    sqlx::query("DROP TRIGGER refuse_mix_item")
        .execute(db.inner())
        .await
        .unwrap();

    let (left, right) = tokio::join!(save(), save());
    let (created, replay) = if left.status() == StatusCode::CREATED {
        (left, right)
    } else {
        (right, left)
    };
    let (status, created) = json_response(created).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let (status, replay) = json_response(replay).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["alreadySaved"], true);
    assert_eq!(created["playlist"], replay["playlist"]);

    let pid = created["playlist"]["id"].as_str().unwrap();
    let (status, response) = json_response(
        request(
            &state,
            &session,
            "GET",
            &format!("/api/playlists/{pid}"),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    let tracks = response["playlist"]["tracks"].as_array().unwrap();
    assert_eq!(
        tracks
            .iter()
            .map(|track| track["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        selection
    );
    assert_eq!(tracks[0]["providerId"], "last");
    assert_eq!(tracks[1]["external"], true);
    assert_eq!(tracks[2]["providerId"], "first");
}

#[tokio::test]
async fn library_search_returns_tracks_from_navidrome_and_jellyfin() {
    let (db, state, session) = playback_state(true).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .route(
            "/rest/search3.view",
            get(|Query(params): Query<HashMap<String, String>>| async move {
                assert_eq!(params["query"], "Fixture Track");
                assert_eq!(params["artistCount"], "20");
                assert_eq!(params["albumCount"], "20");
                assert_ne!(params["songCount"], "0");
                Json(json!({
                    "subsonic-response": { "status": "ok", "searchResult3": {
                        "song": [{ "id": "navidrome-track", "title": "Fixture Track" }]
                    }}
                }))
            }),
        )
        .route(
            "/Items",
            get(
                |headers: HeaderMap, Query(params): Query<HashMap<String, String>>| async move {
                    let authorization = headers[http::header::AUTHORIZATION].to_str().unwrap();
                    assert!(authorization.starts_with("MediaBrowser Client=\"MusicDeck\""));
                    assert!(authorization.ends_with("Token=\"fixture\""));
                    assert_eq!(params["searchTerm"], "Fixture Track");
                    assert_eq!(params["IncludeItemTypes"], "MusicArtist,MusicAlbum,Audio");
                    Json(json!({ "Items": [{
                    "Id": "jellyfin-track", "Name": "Fixture Track", "Type": "Audio"
                }] }))
                },
            ),
        );
    let upstream = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let providers: [(&str, Arc<dyn MusicBackend>); 2] = [
        (
            "navidrome",
            Arc::new(
                NavidromeClient::new(NavidromeConfig {
                    url: url.clone(),
                    username: "fixture".into(),
                    password: "fixture".into(),
                })
                .unwrap(),
            ),
        ),
        (
            "jellyfin",
            Arc::new(
                JellyfinClient::new(JellyfinConfig {
                    url,
                    api_key: "fixture".into(),
                })
                .unwrap(),
            ),
        ),
    ];
    for (kind, provider) in providers {
        sqlx::query(
            "INSERT INTO backend_connections (id, type, name, config_json, enabled, created_at, updated_at)
             VALUES (?, ?, 'Fixture', '{}', 1, '2026-01-01', '2026-01-01')",
        )
        .bind(kind)
        .bind(kind)
        .execute(db.inner())
        .await
        .unwrap();
        state.providers().replace_all(vec![RegisteredProvider {
            connection_id: kind.into(),
            provider_type: kind.into(),
            name: "Fixture".into(),
            enabled: true,
            provider,
        }]);

        let path = "/api/search?q=Fixture%20Track&types=track&mode=library&phase=local";
        let (status, body) =
            json_response(request(&state, &session, "GET", path, None).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["degraded"], false, "{kind}: {body}");
        assert_eq!(
            body["tracks"][0]["title"], "Fixture Track",
            "{kind}: {body}"
        );
    }
    upstream.abort();
}

fn fixture_cover(color: u8) -> Vec<u8> {
    let image = image::RgbaImage::from_pixel(1, 1, image::Rgba([color, 80, 150, 255]));
    let mut bytes = Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .expect("encode fixture cover");
    bytes.into_inner()
}

async fn add_fixture_library(db: &DbPool, state: &AppState) -> tokio::task::JoinHandle<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind library fixture");
    let url = format!("http://{}", listener.local_addr().expect("fixture address"));
    sqlx::query(
        "INSERT INTO backend_connections (id, type, name, config_json, enabled, created_at, updated_at)
         VALUES ('fixture-library', 'navidrome', 'Fixture', '{}', 1, '2026-01-01', '2026-01-01')",
    )
    .execute(db.inner())
    .await
    .expect("store fixture connection");
    let provider = NavidromeClient::new(NavidromeConfig {
        url,
        username: String::from("fixture"),
        password: String::from("fixture"),
    })
    .expect("create fixture provider");
    state.providers().replace_all(vec![RegisteredProvider {
        connection_id: String::from("fixture-library"),
        provider_type: String::from("navidrome"),
        name: String::from("Fixture"),
        enabled: true,
        provider: Arc::new(provider),
    }]);

    tokio::spawn(async move {
        let stream_attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let router = Router::new()
            .route(
                "/rest/stream.view",
                get(move |Query(params): Query<HashMap<String, String>>, headers: HeaderMap| {
                    let stream_attempts = stream_attempts.clone();
                    async move {
                    if params["id"] == "stream-error" {
                        return Json(json!({"subsonic-response": {"status": "failed", "error": {"code": 70}}})).into_response();
                    }
                    if params["id"] == "stream-retry" {
                        if headers[RANGE] == "bytes=12-" {
                            return (StatusCode::RANGE_NOT_SATISFIABLE, [(http::header::CONTENT_RANGE, "bytes */12")]).into_response();
                        }
                        assert_eq!(headers[RANGE], "bytes=4-11");
                        assert_eq!(headers[http::header::IF_RANGE], "\"fixture\"");
                        assert_eq!(headers[http::header::ACCEPT_ENCODING], "identity");
                        if stream_attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                            return StatusCode::BAD_GATEWAY.into_response();
                        }
                        let chunks = tokio_stream::StreamExt::chain(
                            tokio_stream::once(Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"fLaC"))),
                            tokio_stream::pending(),
                        );
                        return (StatusCode::PARTIAL_CONTENT, [
                            (http::header::CONTENT_TYPE, "audio/flac"),
                            (http::header::CONTENT_RANGE, "bytes 4-11/12"),
                            (http::header::CONTENT_LENGTH, "8"),
                        ], Body::from_stream(chunks)).into_response();
                    }
                    ([(http::header::CONTENT_TYPE, "audio/flac")], "fLaC").into_response()
                    }
                }),
            )
            .route(
                "/rest/getArtist.view",
                get(|Query(params): Query<HashMap<String, String>>| async move {
                    let id = &params["id"];
                    let mut artist = json!({"id": id, "name": "Fixture Artist", "album": []});
                    if id == "local-portrait" {
                        artist["coverArt"] = json!("5");
                    }
                    Json(json!({"subsonic-response": {"status": "ok", "artist": artist}}))
                }),
            )
            .route(
                "/rest/getArtistInfo2.view",
                get(|| async {
                    Json(json!({"subsonic-response": {"status": "ok", "artistInfo2": {
                        "mediumImageUrl": "https://fixture.example/artist/fixture.jpg"
                    }}}))
                }),
            )
            .route(
                "/rest/getSong.view",
                get(|Query(params): Query<HashMap<String, String>>| async move {
                    let id = &params["id"];
                    Json(json!({"subsonic-response": {"status": "ok", "song": {
                        "id": id, "title": format!("Song {id}"), "artist": "Fixture Artist",
                        "album": "Fixture Album", "duration": 205, "coverArt": id
                    }}}))
                }),
            )
            .route(
                "/rest/getCoverArt.view",
                get(|Query(params): Query<HashMap<String, String>>| async move {
                    let color = params["id"].parse().expect("fixture cover ID");
                    (
                        [(http::header::CONTENT_TYPE, "image/png")],
                        fixture_cover(color),
                    )
                }),
            );
        axum::serve(listener, router)
            .await
            .expect("serve fixture library");
    })
}

#[tokio::test]
async fn library_stream_skips_a_success_status_with_a_subsonic_error_body() {
    let (db, state, session) = playback_state(false).await;
    let provider = add_fixture_library(&db, &state).await;
    let library = LibraryService::new(db, None);
    let source = |id: &str| SourceRef {
        connection_id: "fixture-library".into(),
        provider_item_id: id.into(),
    };
    let id = library
        .ensure_id(LibraryItemType::Track, &source("stream-error"), None)
        .await
        .unwrap();
    let path = format!("/api/tracks/{id}/stream");
    assert_eq!(
        request(&state, &session, "GET", &path, None).await.status(),
        StatusCode::BAD_GATEWAY
    );

    library
        .add_source(&id, &source("stream-audio"))
        .await
        .unwrap();
    let response = request(&state, &session, "GET", &path, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(http::header::CONTENT_RANGE));
    assert_eq!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        b"fLaC"
    );
    provider.abort();
}

#[tokio::test]
async fn stream_routes_distinguish_missing_tracks_and_unavailable_lookups() {
    let (db, state, session) = playback_state(false).await;
    let path = "/api/tracks/md_missing/stream";
    let status = || async { request(&state, &session, "GET", path, None).await.status() };
    assert_eq!(status().await, StatusCode::NOT_FOUND);

    sqlx::query("ALTER TABLE library_items RENAME TO unavailable_library_items")
        .execute(db.inner())
        .await
        .unwrap();
    assert_eq!(status().await, StatusCode::SERVICE_UNAVAILABLE);
}

async fn request_playback_range(
    state: &AppState,
    session: &str,
    url: &str,
    range: Option<&str>,
    if_range: Option<&str>,
) -> Response {
    let mut request = Request::builder()
        .uri(url)
        .header("cookie", format!("{SESSION_COOKIE}={session}"));
    if let Some(range) = range {
        request = request.header(RANGE, range);
    }
    if let Some(if_range) = if_range {
        request = request.header(http::header::IF_RANGE, if_range);
    }
    music_routes()
        .with_state(state.clone())
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn playback_storage_errors_are_retryable_and_only_missing_tracks_are_404() {
    let (db, state, session) = playback_state(true).await;
    let library = LibraryService::new(db.clone(), None);
    let track = library
        .ensure_id(
            LibraryItemType::Track,
            &SourceRef {
                connection_id: "fixture".into(),
                provider_item_id: "mapped-song".into(),
            },
            None,
        )
        .await
        .unwrap();
    sqlx::query("DROP TABLE library_item_sources")
        .execute(db.inner())
        .await
        .unwrap();

    for path in [
        format!("/api/tracks/{track}"),
        format!("/api/tracks/{track}/stream"),
    ] {
        let response = request(&state, &session, "GET", &path, None).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[http::header::RETRY_AFTER], "1");
    }
    let missing = request(&state, &session, "GET", "/api/tracks/no-track/stream", None).await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn playback_failover_requires_a_fresh_url_and_initial_byte_zero() {
    use http::header::{CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    let (db, state, session) = playback_state(true).await;
    let primary_online = Arc::new(AtomicBool::new(true));
    let alternate_requests = Arc::new(AtomicUsize::new(0));
    let online = primary_online.clone();
    let primary = media_fixture::provider("primary", move |id, range, _, bitrate| {
        assert_eq!(id, "original");
        assert_eq!(bitrate, Some(192));
        let response = if !online.load(Ordering::Relaxed) {
            media_fixture::response(StatusCode::SERVICE_UNAVAILABLE, [], "")
        } else if range == Some("bytes=2-") {
            media_fixture::response(
                StatusCode::PARTIAL_CONTENT,
                [
                    (CONTENT_TYPE, "audio/mpeg"),
                    (CONTENT_RANGE, "bytes 2-3/4"),
                    (CONTENT_LENGTH, "2"),
                ],
                "cd",
            )
        } else {
            media_fixture::response(
                StatusCode::OK,
                [(CONTENT_TYPE, "audio/mpeg"), (CONTENT_LENGTH, "4")],
                "abcd",
            )
        };
        (Timeout::ZERO, response)
    });
    let requests = alternate_requests.clone();
    let alternate = media_fixture::provider("alternate", move |id, range, if_range, bitrate| {
        assert_eq!(id, "fallback");
        assert_eq!(bitrate, Some(192));
        assert!(if_range.is_none());
        requests.fetch_add(1, Ordering::Relaxed);
        let response = match range {
            Some("bytes=0-1") => media_fixture::response(
                StatusCode::PARTIAL_CONTENT,
                [
                    (CONTENT_TYPE, "audio/flac"),
                    (CONTENT_RANGE, "bytes 0-1/8"),
                    (CONTENT_LENGTH, "2"),
                ],
                "AB",
            ),
            Some("bytes=5-") => media_fixture::response(
                StatusCode::PARTIAL_CONTENT,
                [
                    (CONTENT_TYPE, "audio/flac"),
                    (CONTENT_RANGE, "bytes 5-7/8"),
                    (CONTENT_LENGTH, "3"),
                ],
                "FGH",
            ),
            other => panic!("unexpected alternate range: {other:?}"),
        };
        (Timeout::ZERO, response)
    });
    state.providers().replace_all(vec![primary, alternate]);
    let library = LibraryService::new(db, None);
    let id = library
        .ensure_id(
            LibraryItemType::Track,
            &SourceRef {
                connection_id: "primary".into(),
                provider_item_id: "original".into(),
            },
            None,
        )
        .await
        .unwrap();
    library
        .add_source(
            &id,
            &SourceRef {
                connection_id: "alternate".into(),
                provider_item_id: "fallback".into(),
            },
        )
        .await
        .unwrap();
    let old = format!("/api/tracks/{id}/stream?source=primary&maxBitRate=192&inspectionId=old");
    let fresh = format!(
        "/api/tracks/{id}/stream?source=primary&maxBitRate=192&inspectionId=fresh&retryFrom=old"
    );
    assert_eq!(
        request_playback_range(&state, &session, &old, None, None)
            .await
            .status(),
        StatusCode::OK
    );
    let range = request_playback_range(&state, &session, &old, Some("bytes=2-"), None).await;
    assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(range.headers()[CONTENT_TYPE], "audio/mpeg");

    primary_online.store(false, Ordering::Relaxed);
    assert_eq!(
        request_playback_range(&state, &session, &old, Some("bytes=2-"), None)
            .await
            .status(),
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(alternate_requests.load(Ordering::Relaxed), 0);
    assert_eq!(
        request_playback_range(&state, &session, &fresh, Some("bytes=2-"), None)
            .await
            .status(),
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(alternate_requests.load(Ordering::Relaxed), 0);

    // Even after the first provider recovers, a replacement prefers the alternate.
    primary_online.store(true, Ordering::Relaxed);
    let metadata =
        request_playback_range(&state, &session, &fresh, Some("bytes=0-1"), Some("\"old\"")).await;
    assert_eq!(metadata.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(metadata.headers()[CONTENT_TYPE], "audio/flac");
    assert_eq!(metadata.headers()[CONTENT_RANGE], "bytes 0-1/8");
    let seek = request_playback_range(&state, &session, &fresh, Some("bytes=5-"), None).await;
    assert_eq!(seek.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        seek.into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        b"FGH"
    );
    assert_eq!(alternate_requests.load(Ordering::Relaxed), 2);
    assert_eq!(
        request_playback_range(&state, &session, &old, Some("bytes=2-"), None)
            .await
            .headers()[CONTENT_TYPE],
        "audio/mpeg"
    );
}

#[tokio::test]
async fn playback_rejects_mismatched_partial_layout_and_preserves_full_responses() {
    use http::header::{CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG};

    let (db, state, session) = playback_state(true).await;
    state.providers().replace_all(vec![media_fixture::provider(
        "pinned",
        |_, range, if_range, _| {
            let stream = match (range, if_range) {
                (None, _) => media_fixture::response(
                    StatusCode::OK,
                    [
                        (CONTENT_TYPE, "audio/flac; codecs=flac"),
                        (ETAG, "\"original\""),
                    ],
                    "abcd",
                ),
                (Some("bytes=1-"), Some("\"original\"")) => media_fixture::response(
                    StatusCode::OK,
                    [
                        (CONTENT_TYPE, "audio/flac"),
                        (ETAG, "\"replacement\""),
                        (CONTENT_LENGTH, "6"),
                    ],
                    "abcdef",
                ),
                (Some("bytes=0-1"), _) => media_fixture::response(
                    StatusCode::PARTIAL_CONTENT,
                    [
                        (CONTENT_TYPE, "audio/flac"),
                        (CONTENT_RANGE, "bytes 0-1/4"),
                        (CONTENT_LENGTH, "2"),
                        (ETAG, "\"original\""),
                    ],
                    "ab",
                ),
                (Some("bytes=1-"), _) => media_fixture::response(
                    StatusCode::PARTIAL_CONTENT,
                    [
                        (CONTENT_TYPE, "audio/flac"),
                        (CONTENT_RANGE, "bytes 1-5/6"),
                        (CONTENT_LENGTH, "5"),
                    ],
                    "bcdef",
                ),
                (Some("bytes=2-"), _) => media_fixture::response(
                    StatusCode::PARTIAL_CONTENT,
                    [
                        (CONTENT_TYPE, "audio/flac"),
                        (CONTENT_RANGE, "bytes 1-3/4"),
                        (CONTENT_LENGTH, "3"),
                    ],
                    "bcd",
                ),
                (Some("bytes=1-2"), _) => media_fixture::response(
                    StatusCode::PARTIAL_CONTENT,
                    [
                        (CONTENT_TYPE, "audio/flac"),
                        (CONTENT_RANGE, "bytes 1-2/4"),
                        (CONTENT_LENGTH, "3"),
                    ],
                    "bcd",
                ),
                (Some("bytes=2-2"), _) => media_fixture::response(
                    StatusCode::PARTIAL_CONTENT,
                    [
                        (CONTENT_TYPE, "audio/flac; codecs=opus"),
                        (CONTENT_RANGE, "bytes 2-2/4"),
                        (CONTENT_LENGTH, "1"),
                    ],
                    "c",
                ),
                (Some("bytes=3-"), _) => media_fixture::response(
                    StatusCode::OK,
                    [
                        (CONTENT_TYPE, "audio/flac"),
                        (ETAG, "\"original\""),
                        (CONTENT_LENGTH, "4"),
                    ],
                    "abcd",
                ),
                other => panic!("unexpected stream request: {other:?}"),
            };
            (Timeout::ZERO, stream)
        },
    )]);
    let id = LibraryService::new(db, None)
        .ensure_id(
            LibraryItemType::Track,
            &SourceRef {
                connection_id: "pinned".into(),
                provider_item_id: "track".into(),
            },
            None,
        )
        .await
        .unwrap();
    let url = format!("/api/tracks/{id}/stream?inspectionId=layout");
    assert_eq!(
        request_playback_range(&state, &session, &url, None, None)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        request_playback_range(&state, &session, &url, Some("bytes=0-1"), None)
            .await
            .status(),
        StatusCode::PARTIAL_CONTENT
    );
    for request in ["bytes=1-", "bytes=2-", "bytes=1-2", "bytes=2-2"] {
        assert_eq!(
            request_playback_range(&state, &session, &url, Some(request), None)
                .await
                .status(),
            StatusCode::BAD_GATEWAY,
            "{request}"
        );
    }
    assert_eq!(
        request_playback_range(&state, &session, &url, Some("bytes=0-1"), Some("\"stale\""))
            .await
            .status(),
        StatusCode::BAD_GATEWAY
    );
    let full = request_playback_range(
        &state,
        &session,
        &url,
        Some("bytes=1-"),
        Some("\"original\""),
    )
    .await;
    assert_eq!(full.status(), StatusCode::OK);
    assert_eq!(
        full.into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        b"abcdef"
    );
    assert_eq!(
        request_playback_range(&state, &session, &url, Some("bytes=1-"), None)
            .await
            .status(),
        StatusCode::BAD_GATEWAY
    );
    let ignored_range =
        request_playback_range(&state, &session, &url, Some("bytes=3-"), None).await;
    assert_eq!(ignored_range.status(), StatusCode::OK);
    assert_eq!(
        ignored_range
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        b"abcd"
    );
}

#[tokio::test]
async fn playback_ranges_survive_concurrent_wal_writes() {
    use http::header::{CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, COOKIE};

    let directory = tempfile::tempdir().unwrap();
    let db = DbPool::connect(&directory.path().join("playback.sqlite"))
        .await
        .unwrap();
    let (db, state, session) = playback_state_with_db(db, false).await;
    let provider = media_fixture::provider("media", |track, range, _, _| {
        let response = match (track, range) {
            ("normal" | "stall", None) => media_fixture::response(
                StatusCode::OK,
                [(CONTENT_TYPE, "audio/mpeg"), (CONTENT_LENGTH, "8")],
                "abcdefgh",
            ),
            ("normal", Some("bytes=2-5")) => media_fixture::response(
                StatusCode::PARTIAL_CONTENT,
                [
                    (CONTENT_TYPE, "audio/mpeg"),
                    (CONTENT_RANGE, "bytes 2-5/8"),
                    (CONTENT_LENGTH, "4"),
                ],
                "cdef",
            ),
            ("normal", Some("bytes=8-")) => media_fixture::response(
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(CONTENT_RANGE, "bytes */8")],
                "",
            ),
            ("mismatch", Some("bytes=2-5")) => media_fixture::response(
                StatusCode::PARTIAL_CONTENT,
                [(CONTENT_TYPE, "audio/mpeg"), (CONTENT_RANGE, "bytes 3-6/8")],
                "defg",
            ),
            ("truncated", Some("bytes=2-5")) => media_fixture::response(
                StatusCode::PARTIAL_CONTENT,
                [
                    (CONTENT_TYPE, "audio/mpeg"),
                    (CONTENT_RANGE, "bytes 2-5/8"),
                    (CONTENT_LENGTH, "4"),
                ],
                "cd",
            ),
            _ => panic!("unexpected media fixture request"),
        };
        let header_delay = if track == "stall" {
            Timeout::from_secs(20)
        } else {
            Timeout::ZERO
        };
        (header_delay, response)
    });
    state.providers().replace_all(vec![provider]);
    let library = LibraryService::new(db.clone(), None);
    let mut tracks = HashMap::new();
    for native_id in ["normal", "mismatch", "truncated", "stall"] {
        let id = library
            .ensure_id(
                LibraryItemType::Track,
                &SourceRef {
                    connection_id: "media".into(),
                    provider_item_id: native_id.into(),
                },
                None,
            )
            .await
            .unwrap();
        tracks.insert(native_id, id);
    }
    let router = crate::create_router(state.clone());
    let cookie = format!("{SESSION_COOKIE}={session}");
    let send = |method: &str, uri: &str, payload: Option<Value>, range: Option<&str>| {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(COOKIE, &cookie);
        if payload.is_some() {
            request = request.header(CONTENT_TYPE, "application/json");
        }
        if let Some(range) = range {
            request = request.header(RANGE, range);
        }
        router.clone().oneshot(
            request
                .body(payload.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .unwrap(),
        )
    };
    let track = &tracks["normal"];
    let (status, content) = json_response(
        send(
            "POST",
            "/api/v1/user/queue-session/content?ownerId=listener",
            Some(json!({"version": 2, "entries": [{"entryId": "entry", "track": {"id": track}}]})),
            None,
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{content}");

    let queue = |device: u8, sequence: i64| {
        json!({
            "ownerId": "listener", "deviceId": format!("device-{device}"), "deviceName": "Fixture",
            "contentId": content["contentId"], "sequence": sequence,
            "checkpoint": {"index": 0, "position": sequence, "repeatOne": false, "shuffle": false,
                "shuffleMode": "standard", "albumAware": false, "volume": 1, "wasPlaying": true,
                "capturedAt": Utc::now().timestamp_millis()},
        })
    };
    let started = Utc::now() - Duration::minutes(1);
    let listening = |device: u8, sequence: i64| {
        let mut event = playback_event(sequence as f64, false);
        event["playbackSessionId"] = json!(format!("playback-{device}"));
        event["trackId"] = json!(track);
        event["startedAt"] = json!(started.to_rfc3339());
        event
    };
    let stream_path =
        |track: &str| format!("/api/tracks/{}/stream?inspectionId=wal-test", tracks[track]);
    let normal = stream_path("normal");
    let ranges = [
        (None, StatusCode::OK, None, "abcdefgh"),
        (
            Some("bytes=2-5"),
            StatusCode::PARTIAL_CONTENT,
            Some("bytes 2-5/8"),
            "cdef",
        ),
        (
            Some("bytes=8-"),
            StatusCode::RANGE_NOT_SATISFIABLE,
            Some("bytes */8"),
            "",
        ),
    ];
    for (index, (range, status, content_range, expected)) in
        ranges.into_iter().cycle().take(9).enumerate()
    {
        let sequence = (index + 1) as i64;
        let (stream, queue_one, queue_two, listen_one, listen_two) = tokio::join!(
            send("GET", &normal, None, range),
            send(
                "PUT",
                "/api/v1/user/queue-session",
                Some(queue(1, sequence)),
                None
            ),
            send(
                "PUT",
                "/api/v1/user/queue-session",
                Some(queue(2, sequence)),
                None
            ),
            send(
                "POST",
                "/api/listening-events",
                Some(listening(1, sequence)),
                None
            ),
            send(
                "POST",
                "/api/listening-events",
                Some(listening(2, sequence)),
                None
            ),
        );
        let stream = stream.unwrap();
        assert_eq!(stream.status(), status);
        assert_eq!(
            stream
                .headers()
                .get(CONTENT_RANGE)
                .map(|value| value.to_str().unwrap()),
            content_range
        );
        assert_eq!(
            stream.into_body().collect().await.unwrap().to_bytes(),
            expected
        );
        for response in [queue_one, queue_two] {
            let (status, body) = json_response(response.unwrap()).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body, json!({"saved": true, "sequence": sequence}));
        }
        for response in [listen_one, listen_two] {
            let (status, body) = json_response(response.unwrap()).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["listenedSeconds"].as_f64(), Some(sequence as f64));
        }
    }

    let mismatch = send("GET", &stream_path("mismatch"), None, Some("bytes=2-5"))
        .await
        .unwrap();
    assert_eq!(mismatch.status(), StatusCode::BAD_GATEWAY);
    let truncated = send("GET", &stream_path("truncated"), None, Some("bytes=2-5"))
        .await
        .unwrap();
    assert_eq!(truncated.status(), StatusCode::PARTIAL_CONTENT);
    let mut body = truncated.into_body();
    assert_eq!(
        body.frame().await.unwrap().unwrap().into_data().unwrap(),
        "cd"
    );
    assert!(body.frame().await.unwrap().is_err());

    let stall = stream_path("stall");
    let stalled = tokio::time::timeout(Timeout::from_secs(10), send("GET", &stall, None, None))
        .await
        .expect("the resolver must time out before the fixture sends headers")
        .unwrap();
    assert_eq!(stalled.status(), StatusCode::BAD_GATEWAY);

    state.tasks().close();
    db.close().await;
}

#[tokio::test]
async fn selected_library_source_retries_gateway_failure_and_streams_a_validated_range() {
    let (db, state, session) = playback_state(false).await;
    let provider = add_fixture_library(&db, &state).await;
    let library = LibraryService::new(db, None);
    let id = library
        .ensure_id(
            LibraryItemType::Track,
            &SourceRef {
                connection_id: "fixture-library".into(),
                provider_item_id: "stream-retry".into(),
            },
            None,
        )
        .await
        .unwrap();
    // Legacy clients send selected connection IDs in playableSource.
    let uri = format!("/api/tracks/{id}/stream?playableSource=fixture-library");
    let router = music_routes().with_state(state);
    let send_range = |range| {
        router.clone().oneshot(
            Request::builder()
                .uri(&uri)
                .header(http::header::COOKIE, format!("{SESSION_COOKIE}={session}"))
                .header(RANGE, range)
                .header(http::header::IF_RANGE, "\"fixture\"")
                .body(Body::empty())
                .unwrap(),
        )
    };

    let response = tokio::time::timeout(Timeout::from_secs(3), send_range("bytes=4-11"))
        .await
        .expect("stream header arrived while the body was still pending")
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        response.headers()[http::header::CONTENT_RANGE],
        "bytes 4-11/12"
    );
    assert_eq!(response.headers()[http::header::CONTENT_LENGTH], "8");
    let first = tokio::time::timeout(Timeout::from_secs(3), response.into_body().frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data()
        .unwrap();
    assert_eq!(first.as_ref(), b"fLaC");

    let response = send_range("bytes=12-").await.unwrap();
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        response.headers()[http::header::CONTENT_RANGE],
        "bytes */12"
    );
    provider.abort();
}

#[tokio::test]
async fn background_normalization_returns_unavailable_without_a_playable_source() {
    let (db, state, session) = playback_state(false).await;
    let id = LibraryService::new(db, None)
        .ensure_id(
            LibraryItemType::Track,
            &SourceRef {
                connection_id: "fixture-library".into(),
                provider_item_id: "stream-audio".into(),
            },
            None,
        )
        .await
        .unwrap();
    let response = crate::routes::audio_playback::audio_playback_routes()
        .with_state(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/playback/normalize")
                .header(http::header::COOKIE, format!("{SESSION_COOKIE}={session}"))
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"trackId": id, "background": true, "targetLufs": -16}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body) = json_response(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "unavailable");
}

#[tokio::test]
async fn artist_portraits_use_the_library_and_respect_local_only_mode() {
    for local_only in [false, true] {
        let (db, state, session) = playback_state(local_only).await;
        let provider = add_fixture_library(&db, &state).await;
        for native_id in ["local-portrait", "extended-portrait"] {
            let artist_id = LibraryService::new(db.clone(), None)
                .ensure_id(
                    LibraryItemType::Artist,
                    &SourceRef {
                        connection_id: "fixture-library".into(),
                        provider_item_id: native_id.into(),
                    },
                    None,
                )
                .await
                .expect("map artist");
            let path = format!("/api/artists/{artist_id}/portrait");
            let (status, body) =
                json_response(request(&state, &session, "GET", &path, None).await).await;
            assert_eq!(status, StatusCode::OK);
            if native_id == "local-portrait" {
                let url = body["imageUrl"].as_str().expect("local portrait URL");
                assert!(url.starts_with("/api/artwork/mdart_"));
                assert_eq!(body["imageKind"], "artist");
                let image = request(&state, &session, "GET", url, None).await;
                assert_eq!(image.status(), StatusCode::OK);
                let bytes = image
                    .into_body()
                    .collect()
                    .await
                    .expect("image body")
                    .to_bytes();
                assert_eq!(bytes.as_ref(), fixture_cover(5));
            } else if local_only {
                assert!(body["imageUrl"].is_null());
            } else {
                assert_eq!(
                    body["imageUrl"],
                    "https://fixture.example/artist/fixture.jpg"
                );
            }
            if native_id == "extended-portrait" {
                let cached_url = "https://upload.wikimedia.org/wikipedia/commons/a/ab/fixture.jpg";
                sqlx::query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
                    .bind(format!("artist_avatar_mb:{artist_id}"))
                    .bind(json!({"name": "Fixture Artist", "url": cached_url}).to_string())
                    .execute(db.inner()).await.expect("cache fixture portrait");
                let (status, body) = json_response(
                    request(
                        &state,
                        &session,
                        "GET",
                        &format!("{path}/musicbrainz"),
                        None,
                    )
                    .await,
                )
                .await;
                assert_eq!(status, StatusCode::OK);
                if local_only {
                    assert!(body["imageUrl"].is_null());
                } else {
                    assert_eq!(body["imageUrl"], cached_url);
                    assert_eq!(body["imageSource"], "musicbrainz");
                }
            }
        }
        provider.abort();
    }
}

#[tokio::test]
async fn recently_played_returns_track_details_for_recorded_and_legacy_plays() {
    let (db, state, session) = playback_state(false).await;
    let provider = add_fixture_library(&db, &state).await;
    let legacy_id = LibraryService::new(db.clone(), None)
        .ensure_id(
            LibraryItemType::Track,
            &SourceRef {
                connection_id: String::from("fixture-library"),
                provider_item_id: String::from("1"),
            },
            None,
        )
        .await
        .expect("map legacy song");
    let legacy_time = (Utc::now() - Duration::days(1)).to_rfc3339();
    add_recently_played(
        &db,
        "listener",
        &legacy_id,
        Some(&legacy_time),
        false,
        None,
        None,
    )
    .await
    .expect("store legacy song");
    let mut event = playback_event(180.0, true);
    event["track"]["coverArt"] = json!("mdart_fixture");
    assert_eq!(report(&state, &session, &event).await.0, StatusCode::OK);
    let latest_play = Utc::now().to_rfc3339();
    add_recently_played(
        &db,
        "listener",
        "track-1",
        Some(&latest_play),
        false,
        None,
        None,
    )
    .await
    .expect("store duplicate play");
    add_recently_played(&db, "listener", "private-song", None, true, None, None)
        .await
        .expect("store private play");

    let (status, result) = json_response(
        request(
            &state,
            &session,
            "GET",
            "/api/recently-played?tasteOnly=1",
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let tracks = result["tracks"].as_array().expect("recent tracks");
    assert_eq!(tracks.len(), 2);
    assert_eq!(tracks[0]["id"], "track-1");
    assert_eq!(tracks[0]["title"], "Roygbiv");
    assert_eq!(tracks[0]["artist"], "Boards of Canada");
    assert_eq!(tracks[0]["coverArt"], "mdart_fixture");
    assert_eq!(tracks[0]["duration"], 180.0);
    assert_eq!(tracks[0]["playedAt"], latest_play);
    assert_eq!(tracks[1]["trackId"], legacy_id);
    assert_eq!(tracks[1]["title"], "Song 1");
    assert_eq!(tracks[1]["artistName"], "Fixture Artist");
    assert_eq!(tracks[1]["durationSeconds"], 205);
    assert!(tracks[1]["artworkId"].is_string());
    assert_eq!(tracks[1]["playedAt"], legacy_time);
    provider.abort();
}

#[tokio::test]
async fn playlist_artwork_uses_the_first_four_tracks_and_keeps_custom_covers() {
    let (db, state, session) = playback_state(false).await;
    let provider = add_fixture_library(&db, &state).await;
    let (status, result) = json_response(
        request(
            &state,
            &session,
            "POST",
            "/api/playlists",
            Some(&json!({"name": "Fixture playlist"})),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{result}");
    let id = result["playlist"]["id"].as_str().expect("playlist ID");
    let (status, result) = json_response(
        request(
            &state,
            &session,
            "POST",
            &format!("/api/v1/playlists/{id}/tracks/batch"),
            Some(&json!({"action": "add", "trackIds": ["3", "1", "4", "2", "5"]})),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let token = result["playlist"]["artworkId"]
        .as_str()
        .expect("artwork ID");
    let (status, tree) = json_response(
        request(
            &state,
            &session,
            "GET",
            "/api/v1/playlist-organization",
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tree["playlists"][0]["id"], id);
    assert_eq!(tree["playlists"][0]["artworkId"], token);
    let response = request(
        &state,
        &session,
        "GET",
        &format!("/api/artwork/{token}?size=64"),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[http::header::CONTENT_TYPE],
        "image/svg+xml"
    );
    let body = response
        .into_body()
        .collect()
        .await
        .expect("read collage")
        .to_bytes();
    let svg = std::str::from_utf8(&body).expect("SVG document");
    let expected = [3, 1, 4, 2].map(|color| {
        format!(
            "data:image/png;base64,{}",
            STANDARD.encode(fixture_cover(color))
        )
    });
    let tiles: Vec<_> = svg
        .split("href=\"")
        .skip(1)
        .map(|tile| tile.split('"').next().unwrap())
        .collect();
    assert_eq!(tiles, expected);

    let custom = fixture_cover(99);
    crate::playlists::PlaylistArtworkService::new(db)
        .set_custom(id, &custom, "image/png")
        .await
        .expect("store custom cover");
    let (status, tree) = json_response(
        request(
            &state,
            &session,
            "GET",
            "/api/v1/playlist-organization",
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let custom_token = tree["playlists"][0]["artworkId"]
        .as_str()
        .expect("custom cover ID");
    assert_ne!(custom_token, token);
    let response = request(
        &state,
        &session,
        "GET",
        &format!("/api/artwork/{custom_token}?size=64"),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[http::header::CONTENT_TYPE], "image/png");
    assert_eq!(
        response
            .into_body()
            .collect()
            .await
            .expect("read custom artwork")
            .to_bytes(),
        custom
    );
    provider.abort();
}

async fn queue_count(db: &DbPool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM scrobble_queue")
        .fetch_one(db.inner())
        .await
        .expect("queue count")
}

#[tokio::test]
async fn completed_playback_enqueues_one_canonical_listen_per_provider_and_retries_deduplicate() {
    let (db, state, session) = playback_state(false).await;
    let mut event = playback_event(180.0, true);
    let (status, recorded) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(queue_count(&db).await, 2);
    event["track"]["title"] = json!("Changed retry metadata");
    event["durationSeconds"] = Value::Null;
    assert_eq!(report(&state, &session, &event).await.0, StatusCode::OK);
    assert_eq!(queue_count(&db).await, 2);
    let rows =
        sqlx::query("SELECT user_id, listening_event_id, payload_json, state FROM scrobble_queue")
            .fetch_all(db.inner())
            .await
            .expect("queued listens");
    for row in rows {
        assert_eq!(row.get::<String, _>("user_id"), "listener");
        assert_eq!(
            row.get::<String, _>("listening_event_id"),
            recorded["id"].as_str().expect("event ID")
        );
        assert_eq!(row.get::<String, _>("state"), "pending");
        let payload: Value =
            serde_json::from_str(&row.get::<String, _>("payload_json")).expect("listen payload");
        assert_eq!(payload["track"], "Roygbiv");
        assert_eq!(payload["artist"], "Boards of Canada");
        assert_eq!(payload["duration"], 180);
    }
}

#[tokio::test]
async fn later_progress_enqueues_after_the_provider_threshold_even_after_initial_scrobble_point() {
    let (db, state, session) = playback_state(false).await;
    let mut event = playback_event(20.0, false);
    let (status, first) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["scrobbleDue"], true);
    assert_eq!(queue_count(&db).await, 0);
    event["listenedSeconds"] = json!(90.0);
    let (status, later) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(later["scrobbleDue"], false);
    assert_eq!(later["id"], first["id"]);
    assert_eq!(queue_count(&db).await, 2);
}

#[tokio::test]
async fn reported_seconds_are_clamped_before_scrobble_qualification() {
    let (db, state, session) = playback_state(false).await;
    let mut event = playback_event(180.0, true);
    event["startedAt"] = json!(Utc::now().to_rfc3339());
    let (status, outcome) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        outcome["listenedSeconds"]
            .as_f64()
            .expect("listened seconds")
            < 90.0
    );
    assert_eq!(queue_count(&db).await, 0);
}

#[tokio::test]
async fn provider_specific_rules_and_disabled_integrations_are_preserved() {
    let (db, state, session) = playback_state(false).await;
    let mut event = playback_event(30.0, true);
    event["durationSeconds"] = json!(30.0);
    assert_eq!(report(&state, &session, &event).await.0, StatusCode::OK);
    let providers: Vec<String> = sqlx::query_scalar("SELECT provider FROM scrobble_queue")
        .fetch_all(db.inner())
        .await
        .expect("provider names");
    assert_eq!(providers, vec![String::from("listenbrainz")]);
    sqlx::query("UPDATE plugin_configs SET enabled = 0")
        .execute(db.inner())
        .await
        .expect("disable plugins");
    event["playbackSessionId"] = json!("playback-session-2");
    assert_eq!(report(&state, &session, &event).await.0, StatusCode::OK);
    assert_eq!(queue_count(&db).await, 1);
}

#[tokio::test]
async fn local_only_preserves_local_history_and_blocks_external_queueing() {
    let (db, state, session) = playback_state(true).await;
    assert_eq!(
        report(&state, &session, &playback_event(180.0, true))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(queue_count(&db).await, 0);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM listening_events")
        .fetch_one(db.inner())
        .await
        .expect("listening events");
    assert_eq!(count, 1);
}

#[tokio::test]
async fn playback_owner_mismatch_is_rejected_before_recording_or_queueing() {
    let (db, state, session) = playback_state(false).await;
    let mut event = playback_event(180.0, true);
    event["ownerUserId"] = json!("another-user");
    let (status, error) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["error"]["code"], "USER_MISMATCH");
    assert_eq!(queue_count(&db).await, 0);
}

#[tokio::test]
async fn outbox_failure_rolls_back_the_listen_and_both_provider_jobs_before_retry() {
    let (db, state, session) = playback_state(false).await;
    sqlx::raw_sql(
        "CREATE TRIGGER reject_scrobble BEFORE INSERT ON scrobble_queue
        WHEN NEW.provider = 'listenbrainz' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
    )
    .execute(db.inner())
    .await
    .expect("install write failure");
    let event = playback_event(180.0, true);
    assert_eq!(
        report(&state, &session, &event).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(queue_count(&db).await, 0);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM listening_events")
        .fetch_one(db.inner())
        .await
        .expect("listening events");
    assert_eq!(count, 0);
    sqlx::query("DROP TRIGGER reject_scrobble")
        .execute(db.inner())
        .await
        .expect("restore writes");
    assert_eq!(report(&state, &session, &event).await.0, StatusCode::OK);
    assert_eq!(queue_count(&db).await, 2);
}

#[tokio::test]
async fn background_worker_processes_pending_listens_and_shuts_down_without_network_calls() {
    let (db, state, session) = playback_state(false).await;
    sqlx::query("UPDATE plugin_configs SET enabled = 0 WHERE plugin_id = 'lastfm'")
        .execute(db.inner())
        .await
        .expect("enable only ListenBrainz");
    assert_eq!(
        report(&state, &session, &playback_event(180.0, true))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(queue_count(&db).await, 1);
    // Empty fixture credentials fail validation before an HTTP request can be sent.
    let queue = state.scrobble_queue();
    let worker = queue.start_worker().expect("start worker");
    assert!(queue.start_worker().is_none());
    let processed = tokio::time::timeout(Timeout::from_secs(5), async {
        loop {
            let status: String = sqlx::query_scalar("SELECT state FROM scrobble_queue")
                .fetch_one(db.inner())
                .await
                .expect("delivery status");
            if status == "blocked" {
                break;
            }
            tokio::time::sleep(Timeout::from_millis(10)).await;
        }
    })
    .await;
    queue.close();
    tokio::time::timeout(Timeout::from_secs(5), worker)
        .await
        .expect("shutdown deadline")
        .expect("worker exited");
    processed.expect("worker processed pending listen");
    let attempts: i64 = sqlx::query_scalar("SELECT attempts FROM scrobble_queue")
        .fetch_one(db.inner())
        .await
        .expect("delivery attempts");
    assert_eq!(attempts, 1);
    assert!(queue.start_worker().is_none());
}
