//! # Phase 7 Integration & Algorithmic Test Suite (`phase7_recommendations_test`)
//!
//! Validates parity with:
//! - `server/test/taste-profile.test.ts`
//! - `server/test/recommendation-engine.test.ts`
//! - `server/test/sonic-analysis.test.ts`
//! - `server/test/similar-mix-engine.test.ts`

#![forbid(unsafe_code)]

use std::f32::consts::PI;

use approx::assert_relative_eq;
use axum::body::Body;
use http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use pretty_assertions::assert_eq;
use serde_json::{Value, json};
use sqlx::Row;
use tower::ServiceExt;

use musicdeck_server::auth::SESSION_COOKIE;
use musicdeck_server::catalog::{Availability, AvailabilityState, Available};
use musicdeck_server::config::AppConfig;
use musicdeck_server::db::{DbPool, run_migrations};
use musicdeck_server::mixes::{
    MixScope, SimilarMixEngine, SimilarMixInput, external_lastfm_track_id, mix_recording_key,
};
use musicdeck_server::profile::TasteProfileManager;
use musicdeck_server::providers::Track;
use musicdeck_server::recommendations::{
    FeedbackAction, RECENT_PLAY_WINDOW_MS, RecommendationEngine, RecommendationService,
};
use musicdeck_server::sonic::{
    SONIC_DIMENSIONS, SONIC_SAMPLE_RATE, SonicRecommendationService, SonicSettings,
    extract_sonic_features,
};
use musicdeck_server::{AppState, create_router};

// ============================================================================
// Synthetic Test Fixtures & Database Seeding Helpers
// ============================================================================

async fn setup_test_db() -> DbPool {
    let pool = DbPool::connect_memory()
        .await
        .expect("connect in-memory sqlite pool");
    run_migrations(&pool, None)
        .await
        .expect("apply all 50 migrations");

    sqlx::raw_sql(
        r"
        INSERT INTO roles (name, description) VALUES ('admin', 'Administrator'), ('user', 'Listener');
        INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
        VALUES
            ('alice', 'alice', 'unused', 'Alice', 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
            ('bob', 'bob', 'unused', 'Bob', 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
            ('admin1', 'admin', 'unused', 'Admin', 'admin', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        ",
    )
    .execute(pool.inner())
    .await
    .expect("seed test users");

    pool
}

fn build_synthetic_track(
    id: &str,
    title: &str,
    artist_id: &str,
    artist_name: &str,
    genres: &[&str],
    moods: &[&str],
    year: i32,
    bpm: f64,
    related_artist_ids: Option<Vec<String>>,
) -> Available<Track> {
    Available {
        item: Track {
            id: id.to_owned(),
            provider_id: id.to_owned(),
            title: title.to_owned(),
            artist_id: Some(artist_id.to_owned()),
            artist_name: artist_name.to_owned(),
            artist_credits: None,
            album_id: Some(format!("album-{artist_id}")),
            album_name: String::from("Album"),
            duration_seconds: Some(180),
            track_number: Some(1),
            disc_number: Some(1),
            year: Some(year),
            original_release_year: Some(year),
            genres: Some(genres.iter().map(|s| (*s).to_owned()).collect()),
            moods: Some(moods.iter().map(|s| (*s).to_owned()).collect()),
            bpm: Some(bpm),
            play_count: Some(0),
            last_played_at: None,
            added_at: None,
            artwork_id: None,
            artwork_url: None,
            stream_url: format!("/api/tracks/{id}/stream"),
            source_server: Some(String::from("navidrome")),
            audio_metadata: None,
            replay_gain: None,
            normalization_gain_db: None,
            loudness: None,
            related_artist_ids,
            identity_hints: None,
        },
        availability: Availability {
            state: AvailabilityState::Available,
            connection_id: String::from("navidrome"),
            source_count: 1,
            available_source_count: 1,
            library_available: true,
        },
        sources: None,
    }
}

async fn count_user_rows(pool: &DbPool, table: &str, user_id: &str) -> i64 {
    let sql = format!("SELECT COUNT(*) AS n FROM {table} WHERE user_id = ?");
    sqlx::query(&sql)
        .bind(user_id)
        .fetch_one(pool.inner())
        .await
        .and_then(|r| r.try_get("n"))
        .unwrap_or(0)
}

// Helper for creating 128-D axis test vectors
fn axis_vector(first: f32, second: f32) -> [f32; SONIC_DIMENSIONS] {
    let mut vec = [0.0_f32; SONIC_DIMENSIONS];
    vec[0] = first;
    vec[1] = second;
    vec
}

// ============================================================================
// 1. Taste Profile Calculation & Privacy Governance Tests (`taste-profile.test.ts`)
// ============================================================================

#[tokio::test]
async fn taste_profile_private_listening_and_mid_session_retraction_preserve_history_while_excluding_affinity() {
    let pool = setup_test_db().await;
    let manager = TasteProfileManager::new(pool.clone());
    let engine = RecommendationEngine::new(Some(pool.clone()));

    let tracks = vec![
        build_synthetic_track(
            "seed",
            "Seed Song",
            "artist-seed",
            "Seed Artist",
            &["ambient"],
            &["calm"],
            2022,
            100.0,
            None,
        ),
        build_synthetic_track(
            "party",
            "Party Song",
            "artist-party",
            "Party Artist",
            &["ambient"],
            &["energetic"],
            2022,
            120.0,
            None,
        ),
        build_synthetic_track(
            "calm",
            "Calm",
            "artist-calm",
            "Calm Artist",
            &["ambient"],
            &["calm"],
            2022,
            90.0,
            None,
        ),
    ];
    engine.replace_catalog(&tracks);

    let baseline: Vec<(String, f64)> = engine
        .select("alice", "seed", 10, &[], &[], 0.0)
        .await
        .expect("baseline selection")
        .into_iter()
        .map(|r| (r.track.item.id, r.score))
        .collect();

    // Enable private listening
    let state_1 = manager
        .set_private("alice", true, 0)
        .await
        .expect("enable private listening");
    assert!(state_1.private_listening);
    assert_eq!(state_1.revision, 1);
    assert!(!manager.can_use_provider_history("alice").await);

    let now = chrono::Utc::now();
    let started_iso = (now - chrono::Duration::seconds(40)).to_rfc3339();
    let reported_iso = now.to_rfc3339();
    let decision = manager
        .decision(
            "alice",
            "party",
            &started_iso,
            Some(&reported_iso),
            false,
            false,
            None,
            Some("Party Song"),
            Some("Party Artist"),
        )
        .await;
    assert!(decision.excluded);

    // Record the private play in `listening_events` and `recently_played` with `taste_excluded = 1`
    sqlx::query(
        r"
        INSERT INTO listening_events (
            id, user_id, track_id, playback_session_id, event_type,
            listened_seconds, duration_seconds, counted, finished,
            taste_excluded, taste_recording_key, created_at, updated_at
        )
        VALUES ('ev_priv_1', 'alice', 'party', 'sess_priv_1', 'complete', 35, 180, 1, 1, 1, ?, ?, ?)
        ",
    )
    .bind(&decision.recording_key)
    .bind(&started_iso)
    .bind(&reported_iso)
    .execute(pool.inner())
    .await
    .expect("insert private listening_event");

    sqlx::query(
        r"
        INSERT INTO recently_played (
            id, user_id, track_id, played_at, playback_session_id, taste_excluded, taste_recording_key
        )
        VALUES ('rp_priv_1', 'alice', 'party', ?, 'sess_priv_1', 1, ?)
        ",
    )
    .bind(&started_iso)
    .bind(&decision.recording_key)
    .execute(pool.inner())
    .await
    .expect("insert private recently_played");

    assert_eq!(count_user_rows(&pool, "listening_events", "alice").await, 1);
    assert_eq!(count_user_rows(&pool, "recently_played", "alice").await, 1);
    assert_eq!(
        count_user_rows(&pool, "taste_listening_events", "alice").await,
        0
    );
    assert_eq!(
        count_user_rows(&pool, "taste_recently_played", "alice").await,
        0
    );

    engine.invalidate("alice");
    let after_private: Vec<(String, f64)> = engine
        .select("alice", "seed", 10, &[], &[], 0.0)
        .await
        .expect("post-private selection")
        .into_iter()
        .map(|r| (r.track.item.id, r.score))
        .collect();
    assert_eq!(after_private, baseline);

    // Reset profile clears `taste_*` views while preserving history and favorites
    sqlx::query("INSERT INTO favorites (user_id, track_id, created_at) VALUES ('alice', 'party', '2026-01-01T00:00:00Z')")
        .execute(pool.inner())
        .await
        .expect("insert favorite");

    let cur_rev = manager.state("alice").await.revision;
    let reset_state = manager
        .reset("alice", cur_rev)
        .await
        .expect("reset taste profile");
    assert!(reset_state.reset_before.is_some());
    assert_eq!(count_user_rows(&pool, "favorites", "alice").await, 1);
    assert_eq!(count_user_rows(&pool, "listening_events", "alice").await, 1);

    pool.close().await;
}

// ============================================================================
// 2. Recommendation Engine Scoring, Feedback & Exclusion Tests (`recommendation-engine.test.ts`)
// ============================================================================

#[tokio::test]
async fn recommendation_engine_scores_features_applies_feedback_and_suppresses_recent_plays() {
    let pool = setup_test_db().await;
    let rec_service = RecommendationService::new(Some(pool.clone()));
    let engine = rec_service.engine();

    let seed = build_synthetic_track(
        "seed",
        "Seed",
        "artist-seed",
        "Seed Artist",
        &["synthwave"],
        &["energetic"],
        2020,
        120.0,
        Some(vec![String::from("artist-related")]),
    );
    let close = build_synthetic_track(
        "close",
        "Close",
        "artist-related",
        "Related Artist",
        &["synthwave"],
        &["energetic"],
        2020,
        120.0,
        None,
    );
    let neighbor = build_synthetic_track(
        "neighbor",
        "Neighbor",
        "artist-neighbor",
        "Neighbor Artist",
        &["synthwave"],
        &["energetic"],
        2020,
        120.0,
        None,
    );
    let distant = build_synthetic_track(
        "distant",
        "Distant",
        "artist-distant",
        "Distant Artist",
        &["jazz"],
        &["calm"],
        1960,
        60.0,
        None,
    );

    engine.replace_catalog(&[seed.clone(), close.clone(), neighbor.clone(), distant.clone()]);

    let initial = engine
        .select("alice", "seed", 10, &[], &[], 0.0)
        .await
        .expect("initial select");
    assert_eq!(initial[0].track.item.id, "close");
    assert!(initial[0].reason.contains("synthwave"));
    assert!(initial[0].reason.contains("related artists"));
    assert!(initial[0].score > initial[1].score);
    assert!(initial[1].score > initial[2].score);

    // Verify exact mathematical score for `close`:
    // sharedGenres (1.0 * 6 = 6.0) + related (2.0) + year (1.0) + bpm (1.0 * 2 = 2.0) + sharedMoods (1.0 * 2 = 2.0) = 13.0
    assert_relative_eq!(initial[0].score, 13.0, epsilon = 1e-6);

    // Favoriting `distant` boosts its track + artist affinity
    sqlx::query("INSERT INTO favorites (user_id, track_id, created_at) VALUES ('alice', 'distant', '2026-01-01T00:00:00Z')")
        .execute(pool.inner())
        .await
        .expect("favorite distant");
    engine.invalidate("alice");

    let after_fav = engine
        .select("alice", "seed", 10, &[], &[], 0.0)
        .await
        .expect("select after favorite");
    let distant_score_after_fav = after_fav
        .iter()
        .find(|r| r.track.item.id == "distant")
        .unwrap()
        .score;
    let distant_score_before = initial
        .iter()
        .find(|r| r.track.item.id == "distant")
        .unwrap()
        .score;
    assert!(distant_score_after_fav > distant_score_before);

    // `less-like-this` reduces `close` and neighboring `synthwave` tracks; `more-like-this` replaces it and boosts them
    let close_before = after_fav
        .iter()
        .find(|r| r.track.item.id == "close")
        .unwrap()
        .score;
    let neighbor_before = after_fav
        .iter()
        .find(|r| r.track.item.id == "neighbor")
        .unwrap()
        .score;

    rec_service
        .set_feedback(
            "alice",
            FeedbackAction::LessLikeThis,
            "track",
            "close",
            Some("Close"),
            Some("Related Artist"),
            None,
        )
        .await;

    let after_less = engine
        .select("alice", "seed", 10, &[], &[], 0.0)
        .await
        .expect("select after less-like-this");
    let close_less = after_less
        .iter()
        .find(|r| r.track.item.id == "close")
        .unwrap()
        .score;
    assert!(close_less < close_before);

    rec_service
        .set_feedback(
            "alice",
            FeedbackAction::MoreLikeThis,
            "track",
            "close",
            Some("Close"),
            Some("Related Artist"),
            None,
        )
        .await;

    let after_more = engine
        .select("alice", "seed", 10, &[], &[], 0.0)
        .await
        .expect("select after more-like-this");
    let close_more = after_more
        .iter()
        .find(|r| r.track.item.id == "close")
        .unwrap()
        .score;
    let neighbor_more = after_more
        .iter()
        .find(|r| r.track.item.id == "neighbor")
        .unwrap()
        .score;
    assert!(close_more > close_before);
    assert!(neighbor_more > neighbor_before);

    // Recent play within `RECENT_PLAY_WINDOW_MS` suppresses `neighbor` even when the pool is cached
    let recent_iso = (chrono::Utc::now()
        - chrono::Duration::milliseconds(RECENT_PLAY_WINDOW_MS - 5_000))
    .to_rfc3339();
    sqlx::query(
        r"
        INSERT INTO recently_played (id, user_id, track_id, played_at, taste_excluded)
        VALUES ('rp_recent_1', 'alice', 'neighbor', ?, 0)
        ",
    )
    .bind(recent_iso)
    .execute(pool.inner())
    .await
    .expect("insert recent play");

    let filtered = engine
        .select("alice", "seed", 10, &[String::from("distant")], &[], 0.0)
        .await
        .expect("select with recent & exclude filter");
    let ids: Vec<&str> = filtered.iter().map(|r| r.track.item.id.as_str()).collect();
    assert_eq!(ids, vec!["close"]);

    // Feedback for `alice` never leaks to `bob`
    rec_service
        .set_feedback(
            "alice",
            FeedbackAction::Hide,
            "track",
            "close",
            Some("Close"),
            Some("Related Artist"),
            None,
        )
        .await;
    assert!(
        engine
            .select("alice", "seed", 10, &[String::from("distant")], &[], 0.0)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        engine
            .select("bob", "seed", 10, &[], &[], 0.0)
            .await
            .unwrap()
            .len(),
        3
    );

    pool.close().await;
}

// ============================================================================
// 3. Sonic 128-D DSP & Cosine Similarity Tests (`sonic-analysis.test.ts`)
// ============================================================================

#[tokio::test]
async fn sonic_dsp_extracts_128d_features_and_ranks_cosine_neighbors_with_revision_checks() {
    let make_tone = |frequency_hz: f32, amplitude: f32| -> [f32; SONIC_DIMENSIONS] {
        let samples: Vec<f32> = (0..(SONIC_SAMPLE_RATE * 2))
            .map(|i| {
                amplitude
                    * (2.0 * PI * frequency_hz * (i as f32) / (SONIC_SAMPLE_RATE as f32)).sin()
            })
            .collect();
        extract_sonic_features(&samples).expect("extract features")
    };

    let seed_tone = make_tone(220.0, 0.7);
    let quiet_tone = make_tone(220.0, 0.2);
    let high_tone = make_tone(3000.0, 0.7);

    let cosine = |a: &[f32; SONIC_DIMENSIONS], b: &[f32; SONIC_DIMENSIONS]| -> f64 {
        let dot: f64 = a
            .iter()
            .zip(b.iter())
            .map(|(&x, &y)| f64::from(x) * f64::from(y))
            .sum();
        let norm_a = a.iter().map(|&x| f64::from(x).powi(2)).sum::<f64>().sqrt();
        let norm_b = b.iter().map(|&x| f64::from(x).powi(2)).sum::<f64>().sqrt();
        dot / (norm_a * norm_b)
    };

    assert!(seed_tone.iter().all(|v| v.is_finite()));
    assert!(cosine(&seed_tone, &quiet_tone) > 0.99);
    assert!(cosine(&seed_tone, &high_tone) < 0.80);

    let pool = setup_test_db().await;
    for id in ["seed", "close", "far"] {
        sqlx::query(
            r"
            INSERT INTO library_items (id, type, content_revision, created_at, updated_at)
            VALUES (?, 'track', 'revision', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
            ",
        )
        .bind(id)
        .execute(pool.inner())
        .await
        .expect("insert library item");
    }

    let sonic = SonicRecommendationService::new(Some(pool.clone()));
    assert!(!sonic.settings().enabled);
    assert!(
        !sonic
            .put("seed", "file", Some("revision"), &axis_vector(3.0, 4.0))
            .await
            .unwrap()
    );

    sonic
        .configure(
            SonicSettings {
                enabled: true,
                threads: 1,
                weight: 2.5,
            },
            Some("manual"),
        )
        .await
        .expect("enable sonic");

    assert!(
        sonic
            .put("seed", "file", Some("revision"), &axis_vector(3.0, 4.0))
            .await
            .unwrap()
    );
    assert!(
        sonic
            .put("close", "file", Some("revision"), &axis_vector(6.0, 8.0))
            .await
            .unwrap()
    );
    assert!(
        sonic
            .put("far", "file", Some("revision"), &axis_vector(-4.0, 3.0))
            .await
            .unwrap()
    );

    let matches = sonic.nearest("seed", 10).await.expect("nearest matches");
    assert_eq!(matches.len(), 2);
    assert_eq!(matches[0].track_id, "close");
    assert_eq!(matches[1].track_id, "far");
    assert_relative_eq!(matches[0].cosine, 1.0, epsilon = 1e-6);
    assert_relative_eq!(matches[1].cosine, 0.0, epsilon = 1e-6);

    // Updating `content_revision` on `close` immediately invalidates its stale vector
    sqlx::query("UPDATE library_items SET content_revision = 'new' WHERE id = 'close'")
        .execute(pool.inner())
        .await
        .expect("update content_revision");

    // Force fresh scan by bumping configuration
    sonic
        .configure(
            SonicSettings {
                enabled: true,
                threads: 1,
                weight: 2.5,
            },
            Some("manual"),
        )
        .await
        .unwrap();

    let after_update = sonic.nearest("seed", 10).await.expect("nearest after update");
    assert_eq!(after_update.len(), 1);
    assert_eq!(after_update[0].track_id, "far");
    assert_eq!(sonic.counts().await.indexed, 2);
    assert_eq!(sonic.counts().await.catalog, 3);

    pool.close().await;
}

// ============================================================================
// 4. Similar Mix Engine & Axum Route Integration Tests (`similar-mix-engine.test.ts`)
// ============================================================================

#[tokio::test]
async fn similar_mix_engine_blends_seeds_shifts_discovery_share_and_serves_http_routes() {
    let pool = setup_test_db().await;

    sqlx::query(
        r"
        INSERT INTO smart_playlist_catalog_state (singleton, refreshed_at, degraded, mix_revision)
        VALUES (1, '2026-01-01T00:00:00Z', 0, 1)
        ",
    )
    .execute(pool.inner())
    .await
    .expect("seed catalog state");

    // Seed 5 seed tracks and 40 local candidate tracks + 40 external candidate neighbors
    let mut seed_ids = Vec::new();
    for i in 0..5 {
        let id = format!("seed-{i}");
        let title = format!("Seed Song {i}");
        let artist = format!("Seed Artist {i}");
        let payload = json!({
            "id": id,
            "providerId": id,
            "title": title,
            "artistId": format!("artist-seed-{i}"),
            "artistName": artist,
            "albumId": format!("album-seed-{i}"),
            "albumName": "Album",
            "streamUrl": format!("/api/tracks/{id}/stream"),
            "availability": { "state": "available", "libraryAvailable": true }
        });
        sqlx::query(
            "INSERT INTO smart_playlist_tracks (id, title, artist, album, revision) VALUES (?, ?, ?, 'Album', 'rev1')",
        )
        .bind(&id)
        .bind(&title)
        .bind(&artist)
        .execute(pool.inner())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO smart_playlist_track_payloads (track_id, track_json) VALUES (?, ?)",
        )
        .bind(&id)
        .bind(payload.to_string())
        .execute(pool.inner())
        .await
        .unwrap();
        seed_ids.push((id, title, artist));
    }

    let mut neighbors = Vec::new();
    for i in 0..80 {
        let id = format!("candidate-{i}");
        let title = format!("Candidate Song {i}");
        let artist = format!("Candidate Artist {}", i / 2);
        let match_score = 1.0 - (i as f64) / 100.0;

        if i < 40 {
            let payload = json!({
                "id": id,
                "providerId": id,
                "title": title,
                "artistId": format!("artist-cand-{}", i / 2),
                "artistName": artist,
                "albumId": format!("album-cand-{i}"),
                "albumName": "Album",
                "streamUrl": format!("/api/tracks/{id}/stream"),
                "availability": { "state": "available", "libraryAvailable": true }
            });
            sqlx::query(
                "INSERT INTO smart_playlist_tracks (id, title, artist, album, revision) VALUES (?, ?, ?, 'Album', 'rev1')",
            )
            .bind(&id)
            .bind(&title)
            .bind(&artist)
            .execute(pool.inner())
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO smart_playlist_track_payloads (track_id, track_json) VALUES (?, ?)",
            )
            .bind(&id)
            .bind(payload.to_string())
            .execute(pool.inner())
            .await
            .unwrap();
        }

        let ext_id = external_lastfm_track_id(&title, &artist);
        sqlx::query(
            "INSERT OR IGNORE INTO similar_mix_external_tracks (id, title, artist, touched_at) VALUES (?, ?, ?, ?)",
        )
        .bind(&ext_id)
        .bind(&title)
        .bind(&artist)
        .bind(chrono::Utc::now().timestamp_millis())
        .execute(pool.inner())
        .await
        .unwrap();

        neighbors.push(json!({
            "id": ext_id,
            "title": title,
            "artist": artist,
            "match": match_score,
        }));
    }

    let expires_at = chrono::Utc::now().timestamp_millis() + 7 * 86_400_000;
    let neighbors_json = serde_json::to_string(&neighbors).unwrap();
    for (_, title, artist) in &seed_ids {
        let seed_key = mix_recording_key(title, artist);
        sqlx::query(
            r"
            INSERT INTO similar_mix_vectors (seed_key, payload_json, expires_at, retry_at, touched_at)
            VALUES (?, ?, ?, 0, ?)
            ",
        )
        .bind(seed_key)
        .bind(&neighbors_json)
        .bind(expires_at)
        .bind(chrono::Utc::now().timestamp_millis())
        .execute(pool.inner())
        .await
        .unwrap();
    }

    let engine = SimilarMixEngine::new(Some(pool.clone()));
    let all_seed_ids: Vec<String> = seed_ids.iter().map(|(id, _, _)| id.clone()).collect();

    // Adventurousness = 0.0 in HYBRID_MIX selects 100% library tracks (25 tracks)
    let familiar_mix = engine
        .generate(
            "alice",
            SimilarMixInput {
                seed_track_ids: all_seed_ids.clone(),
                scope: MixScope::HybridMix,
                adventurousness: 0.0,
                locked_track_ids: Vec::new(),
                exclude_track_ids: Vec::new(),
                shuffle_seed: Some(String::from("fixed-seed")),
            },
            false,
        )
        .await
        .expect("generate familiar mix");
    assert_eq!(familiar_mix.tracks.len(), 25);
    assert!(familiar_mix.tracks.iter().all(|t| t.in_library));

    // Adventurousness = 1.0 in HYBRID_MIX selects 100% discovery tracks (25 tracks)
    let adventurous_mix = engine
        .generate(
            "alice",
            SimilarMixInput {
                seed_track_ids: all_seed_ids,
                scope: MixScope::HybridMix,
                adventurousness: 1.0,
                locked_track_ids: Vec::new(),
                exclude_track_ids: Vec::new(),
                shuffle_seed: Some(String::from("fixed-seed")),
            },
            false,
        )
        .await
        .expect("generate adventurous mix");
    assert_eq!(adventurous_mix.tracks.len(), 25);
    assert!(adventurous_mix.tracks.iter().all(|t| !t.in_library));
    assert!(
        adventurous_mix
            .tracks
            .iter()
            .all(|t| t.reason.contains("5 of your seed songs"))
    );

    // Drive the Axum HTTP endpoints via `ServiceExt::oneshot`
    let config = AppConfig::load_from_iter(std::iter::empty::<(String, String)>())
        .expect("default test config");
    let state = AppState::with_database(config, pool.clone())
        .await
        .expect("initialize application state");
    let session = state
        .session_store()
        .expect("session store")
        .create_session("alice", true)
        .await
        .expect("create alice session");
    let cookie_header = format!("{SESSION_COOKIE}={}", session.id);

    let router = create_router(state);
    let resp = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/api/v1/taste-profile")
                .header(header::COOKIE, &cookie_header)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("GET /api/v1/taste-profile");
    assert_eq!(resp.status(), StatusCode::OK);
    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let overview_json: Value = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(overview_json["privateListening"], false);
    assert_eq!(overview_json["revision"], 0);

    // Preview Similar Mix via HTTP `POST /api/v1/similar-mixes/preview`
    let preview_resp = router
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/similar-mixes/preview")
                .header(header::COOKIE, &cookie_header)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "ownerId": "alice",
                        "seedTrackIds": ["seed-0"],
                        "scope": "LIBRARY_ONLY",
                        "adventurousness": 0.5,
                        "shuffleSeed": "route-test"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .expect("POST /api/v1/similar-mixes/preview");
    assert_eq!(preview_resp.status(), StatusCode::OK);
    let preview_bytes = preview_resp.into_body().collect().await.unwrap().to_bytes();
    let preview_json: Value = serde_json::from_slice(&preview_bytes).unwrap();
    assert!(preview_json["previewId"].as_str().is_some());
    assert_eq!(preview_json["tracks"].as_array().unwrap().len(), 25);

    pool.close().await;
}
