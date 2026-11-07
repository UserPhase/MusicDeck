//! # Sonic DSP Feature Extraction & Vector Similarity Search (`sonic`)
//!
//! Exports [`extract_sonic_features`], [`fft`], [`encode_unit_vector`],
//! [`decode_unit_vector`], [`unit_cosine_similarity`], [`analyze_audio_file`],
//! and [`SonicRecommendationService`].

pub mod dsp;
pub mod service;

pub use dsp::{
    BANDS, BINS, FFT_SIZE, HOP, PCM_BYTES, SAMPLE_SECONDS, SONIC_DIMENSIONS, SONIC_SAMPLE_RATE,
    SONIC_TASK, analyze_audio_file, decode_unit_vector, encode_unit_vector,
    extract_sonic_features, fft, unit_cosine_similarity,
};
pub use service::{
    MAX_SONIC_CACHE_ENTRIES, SONIC_SCAN_PAGE_SIZE, SONIC_SETTINGS_KEY, SONIC_VECTOR_VERSION,
    SonicCounts, SonicRecommendationService, SonicSettings,
};

#[cfg(test)]
mod tests {
    use std::f32::consts::PI;

    use super::*;
    use crate::db::{DbPool, run_migrations};

    #[test]
    fn extracts_128d_sonic_features_from_synthetic_harmonic_signal() {
        let len = SONIC_SAMPLE_RATE * 2; // 2 seconds @ 12 kHz = 24,000 samples (> 8 frames)
        let samples: Vec<f32> = (0..len)
            .map(|i| {
                let t = (i as f32) / (SONIC_SAMPLE_RATE as f32);
                let envelope = 0.5 + 0.5 * (2.0 * PI * 2.0 * t).sin();
                envelope * (0.6 * (2.0 * PI * 440.0 * t).sin() + 0.3 * (2.0 * PI * 880.0 * t).sin())
            })
            .collect();

        let features = extract_sonic_features(&samples).expect("extract features");
        assert_eq!(features.len(), SONIC_DIMENSIONS);
        assert!(features.iter().all(|v| v.is_finite()));

        let encoded = encode_unit_vector(&features).expect("encode unit vector");
        assert_eq!(encoded.len(), SONIC_DIMENSIONS * 4);

        let decoded = decode_unit_vector(&encoded).expect("decode unit vector");
        let self_sim = unit_cosine_similarity(&decoded, &decoded).expect("self cosine");
        assert!((self_sim - 1.0).abs() < 1e-5);
    }

    #[tokio::test]
    async fn stores_and_queries_nearest_sonic_vectors() {
        let pool = DbPool::connect_memory().await.expect("open memory db");
        run_migrations(&pool, None).await.expect("run migrations");

        sqlx::raw_sql(
            r"
            INSERT INTO library_items (id, type, content_revision, created_at, updated_at)
            VALUES
                ('t1', 'track', 'rev1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
                ('t2', 'track', 'rev1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
                ('t3', 'track', 'rev1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
            ",
        )
        .execute(pool.inner())
        .await
        .expect("seed library_items");

        let service = SonicRecommendationService::new(Some(pool.clone()));
        service
            .configure(
                SonicSettings {
                    enabled: true,
                    threads: 2,
                    weight: 3.0,
                },
                Some("manual"),
            )
            .await
            .expect("configure sonic");

        let mut v1 = [0.1_f32; SONIC_DIMENSIONS];
        v1[0] = 1.0;
        let mut v2 = [0.1_f32; SONIC_DIMENSIONS];
        v2[0] = 0.95;
        let mut v3 = [-0.1_f32; SONIC_DIMENSIONS];
        v3[0] = -1.0;

        assert!(service.put("t1", "f1", Some("rev1"), &v1).await.unwrap());
        assert!(service.put("t2", "f2", Some("rev1"), &v2).await.unwrap());
        assert!(service.put("t3", "f3", Some("rev1"), &v3).await.unwrap());

        let counts = service.counts().await;
        assert_eq!(counts.indexed, 3);
        assert_eq!(counts.catalog, 3);

        let neighbors = service.nearest("t1", 2).await.expect("nearest neighbors");
        assert_eq!(neighbors.len(), 2);
        assert_eq!(neighbors[0].track_id, "t2");
        assert!(neighbors[0].cosine > 0.99);

        pool.close().await;
    }
}
