//! # Similar Mixes & Continuous Transition Engine (`mixes`)
//!
//! Exports [`SimilarMixEngine`], [`MixScope`], [`SimilarMixInput`],
//! [`MixCandidate`], [`SimilarMixPreview`], [`SeedRecording`],
//! and [`SimilarMixError`].

pub mod engine;

pub use engine::{
    MIX_DAY_MS, MIX_VECTOR_STALE_MS, MIX_VECTOR_TTL_MS, MixCandidate, MixScope, SeedRecording,
    SimilarMixEngine, SimilarMixError, SimilarMixInput, SimilarMixPreview,
    external_lastfm_artist_id, external_lastfm_track_id, mix_recording_key,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{DbPool, run_migrations};

    #[tokio::test]
    async fn registers_external_seeds_and_searches_indexed_catalog_seeds() {
        let pool = DbPool::connect_memory().await.expect("open memory db");
        run_migrations(&pool, None).await.expect("run migrations");

        sqlx::raw_sql(
            r#"
            INSERT INTO smart_playlist_catalog_state (singleton, refreshed_at, degraded, mix_revision)
            VALUES (1, '2026-01-01T00:00:00Z', 0, 1);
            INSERT INTO smart_playlist_tracks (id, title, artist, album, genre, year, bpm, revision)
            VALUES ('t1', 'Starlight', 'Muse', 'Black Holes and Revelations', 'rock', 2006, 121.0, 'rev1');
            INSERT INTO smart_playlist_track_payloads (track_id, track_json)
            VALUES (
                't1',
                '{"id":"t1","providerId":"t1","title":"Starlight","artistName":"Muse","albumName":"Black Holes and Revelations","streamUrl":"/api/tracks/t1/stream"}'
            );
            "#,
        )
        .execute(pool.inner())
        .await
        .expect("seed catalog snapshot");

        let engine = SimilarMixEngine::new(Some(pool.clone()));
        let found = engine.search_seeds("muse star").await.expect("search seeds");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "t1");

        let ext = engine
            .register_external_seed("Time Is Running Out", "Muse")
            .await
            .expect("register external seed");
        assert!(ext.id.starts_with("external_lastfm_track_"));

        pool.close().await;
    }
}
