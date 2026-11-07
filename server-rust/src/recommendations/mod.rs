//! # Recommendation Engine & Personalized Discovery (`recommendations`)
//!
//! Exports [`RecommendationEngine`], [`AffinityVector`], [`TasteProfile`],
//! [`RecommendationScore`], [`LocalRecommendation`], [`RecommendationService`],
//! [`RecommendationRegistry`], and [`recommend_for_playlist`].

pub mod engine;
pub mod service;

pub use engine::{
    AffinityVector, CACHE_LIMIT, CACHE_TTL_MS, LocalRecommendation, POOL_SIZE,
    RECENT_PLAY_WINDOW_MS, RecommendationEngine, RecommendationSeedNotFoundError,
    RecommendationScore, SonicMatch, TasteProfile, bounded_affinity, tag_jaccard_overlap,
};
pub use service::{
    DiscoverySeed, FeedbackAction, RecommendationContext, RecommendationKind,
    RecommendationProvider, RecommendationRegistry, RecommendationSection, RecommendationSeed,
    RecommendationService, diversify_results, playlist_recording_key, recommend_for_playlist,
};

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use crate::catalog::{Availability, AvailabilityState, Available};
    use crate::db::{DbPool, run_migrations};
    use crate::profile::{TasteProfileManager, taste_artist_id, taste_recording_key};
    use crate::providers::Track;

    fn sample_available_track(
        id: &str,
        title: &str,
        artist_id: &str,
        artist_name: &str,
        genres: &[&str],
        year: i32,
        bpm: f64,
    ) -> Available<Track> {
        Available {
            item: Track {
                id: id.to_owned(),
                provider_id: id.to_owned(),
                title: title.to_owned(),
                artist_id: Some(artist_id.to_owned()),
                artist_name: artist_name.to_owned(),
                artist_credits: None,
                album_id: Some(format!("alb_{id}")),
                album_name: String::from("Album"),
                duration_seconds: Some(210),
                track_number: Some(1),
                disc_number: Some(1),
                year: Some(year),
                original_release_year: None,
                genres: Some(genres.iter().map(|s| (*s).to_owned()).collect()),
                moods: Some(vec![String::from("energetic")]),
                bpm: Some(bpm),
                play_count: Some(5),
                last_played_at: None,
                added_at: None,
                artwork_id: Some(format!("art_{id}")),
                artwork_url: Some(format!("/api/artwork/art_{id}")),
                stream_url: format!("/api/tracks/{id}/stream"),
                source_server: Some(String::from("navidrome")),
                audio_metadata: None,
                replay_gain: None,
                normalization_gain_db: None,
                loudness: None,
                related_artist_ids: None,
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

    #[test]
    fn computes_jaccard_overlap_and_bounded_affinity() {
        let a: HashSet<String> = ["rock", "shoegaze"].into_iter().map(str::to_owned).collect();
        let b: HashSet<String> = ["shoegaze", "dream pop"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        assert!((tag_jaccard_overlap(&a, &b) - (1.0 / 3.0)).abs() < 1e-6);
        assert_eq!(bounded_affinity(50.0), 3.0);
        assert_eq!(bounded_affinity(-50.0), -3.0);
        assert!(taste_artist_id("My Bloody Valentine").starts_with("artist_name_"));
        assert_eq!(
            taste_recording_key("Only Shallow (Remastered)", "My Bloody Valentine"),
            "[\"my bloody valentine\",\"only shallow remastered\",\"remastered\"]"
        );
    }

    #[tokio::test]
    async fn selects_ranked_recommendations_and_respects_taste_privacy_controls() {
        let pool = DbPool::connect_memory().await.expect("open memory db");
        run_migrations(&pool, None).await.expect("run migrations");

        sqlx::raw_sql(
            r"
            INSERT INTO roles VALUES ('user', 'Listener');
            INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
            VALUES ('u1', 'alice', 'hash', 'Alice', 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
            ",
        )
        .execute(pool.inner())
        .await
        .expect("seed user");

        let manager = TasteProfileManager::new(pool.clone());
        let state_0 = manager.state("u1").await;
        assert!(!state_0.private_listening);
        assert_eq!(state_0.revision, 0);

        let state_1 = manager
            .set_private("u1", true, 0)
            .await
            .expect("enable private listening");
        assert!(state_1.private_listening);
        assert_eq!(state_1.revision, 1);

        let engine = RecommendationEngine::new(Some(pool.clone()));
        engine.replace_catalog(&[
            sample_available_track(
                "t1",
                "Only Shallow",
                "a1",
                "My Bloody Valentine",
                &["shoegaze", "noise pop"],
                1991,
                130.0,
            ),
            sample_available_track(
                "t2",
                "When You Sleep",
                "a1",
                "My Bloody Valentine",
                &["shoegaze", "noise pop"],
                1991,
                132.0,
            ),
            sample_available_track(
                "t3",
                " Alison",
                "a2",
                "Slowdive",
                &["shoegaze", "dream pop"],
                1993,
                118.0,
            ),
        ]);

        let recs = engine
            .select("u1", "t1", 5, &[], &[], 0.0)
            .await
            .expect("select recommendations");
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].track.item.id, "t2");

        pool.close().await;
    }
}
