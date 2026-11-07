//! # Dynamic Smart Playlist AST, SQL Compiler & Evaluator (`playlists::smart`)

pub mod ast;
pub mod evaluator;

pub use ast::{
    FieldOperator, LeafRule, LogicalOperator, MAX_RULE_DEPTH, MAX_RULE_NODES, MixOptions, MixOrder,
    RuleNode, RuleValue, SmartPlaylistDefinition, SmartPlaylistError, SmartPlaylistField,
    parse_smart_playlist_rule,
};
pub use evaluator::{
    CompiledRule, SeedTrackSummary, SmartEvaluationResult, SmartPlaylistEvaluator, SqlParam,
    compile_smart_playlist_rule, fnv1a_mix_rank, parse_and_compile_rule,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{Availability, AvailabilityState, Available, CatalogListResult};
    use crate::db::{DbPool, run_migrations};
    use crate::providers::Track;
    use serde_json::{Value, json};

    fn sample_track(
        id: &str,
        title: &str,
        artist: &str,
        genres: Option<Vec<&str>>,
        year: Option<i32>,
        orig_year: Option<i32>,
        bpm: Option<f64>,
    ) -> Available<Track> {
        Available {
            item: Track {
                id: id.to_owned(),
                provider_id: id.to_owned(),
                title: title.to_owned(),
                artist_id: Some(format!("art_{artist}")),
                artist_name: artist.to_owned(),
                artist_credits: None,
                album_id: Some(String::from("alb_1")),
                album_name: String::from("Album"),
                duration_seconds: Some(200),
                genres: genres.map(|g| g.into_iter().map(str::to_owned).collect()),
                moods: None,
                year,
                original_release_year: orig_year,
                bpm,
                play_count: None,
                last_played_at: None,
                added_at: None,
                track_number: Some(1),
                disc_number: None,
                artwork_id: None,
                artwork_url: None,
                stream_url: format!("/api/tracks/{id}/stream"),
                source_server: None,
                audio_metadata: None,
                replay_gain: None,
                normalization_gain_db: None,
                loudness: None,
                related_artist_ids: None,
                identity_hints: None,
            },
            availability: Availability {
                state: AvailabilityState::Available,
                connection_id: String::from("test"),
                source_count: 1,
                available_source_count: 1,
                library_available: true,
            },
            sources: None,
        }
    }

    #[tokio::test]
    async fn compiles_ast_without_sql_injection_and_evaluates_similar_era_and_rediscover_rules() {
        let pool = DbPool::connect_memory().await.expect("open memory pool");
        run_migrations(&pool, None).await.expect("run migrations");

        sqlx::raw_sql(
            r"
            INSERT INTO roles VALUES ('user', 'Listener');
            INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
            VALUES ('alice', 'alice', 'hash', 'Alice', 'user', '2026-10-17T12:00:00Z', '2026-10-17T12:00:00Z');
            ",
        )
        .execute(pool.inner())
        .await
        .expect("seed alice");

        let evaluator = SmartPlaylistEvaluator::new(pool.clone());
        let snapshot = CatalogListResult {
            degraded: false,
            items: vec![
                sample_track(
                    "seed",
                    "seed",
                    "Neon",
                    Some(vec!["Synthwave"]),
                    Some(1984),
                    None,
                    Some(120.0),
                ),
                sample_track(
                    "same-artist",
                    "same-artist",
                    "Neon",
                    Some(vec!["Rock"]),
                    Some(2015),
                    Some(1984),
                    Some(180.0),
                ),
                sample_track(
                    "near-tempo",
                    "near-tempo",
                    "Another",
                    Some(vec!["synthwave"]),
                    Some(2020),
                    None,
                    Some(130.0),
                ),
                sample_track(
                    "unknown-tempo",
                    "unknown-tempo",
                    "Third",
                    Some(vec!["Synthwave"]),
                    Some(1987),
                    None,
                    None,
                ),
                sample_track(
                    "far-tempo",
                    "far-tempo",
                    "Fourth",
                    Some(vec!["Synthwave"]),
                    Some(2022),
                    None,
                    Some(190.0),
                ),
            ],
        };
        evaluator
            .replace_catalog(&snapshot)
            .await
            .expect("replace catalog");

        let now_ms = 1_792_238_400_000i64;

        // 1. Verify SQL injection attempt stays strictly inside bound parameters
        let hostile_json = json!({
            "field": "similar_to",
            "operator": "matches",
            "value": "' OR 1=1 --"
        });
        let compiled_hostile =
            parse_and_compile_rule(&hostile_json, now_ms).expect("parse hostile rule");
        assert!(!compiled_hostile.where_sql.contains("1=1"));
        assert_eq!(
            compiled_hostile.params,
            vec![SqlParam::Text(String::from("' OR 1=1 --"))]
        );

        let hostile_ast = parse_smart_playlist_rule(&hostile_json).unwrap();
        let hostile_res = evaluator
            .evaluate_at("alice", &hostile_ast, 50, 0, None, now_ms)
            .await
            .expect("evaluate hostile");
        assert!(hostile_res.tracks.is_empty());

        // 2. Verify `similar_to` matches shared genre within 15% BPM tolerance and excludes seed
        let sim_ast = parse_smart_playlist_rule(&json!({
            "field": "similar_to",
            "operator": "matches",
            "value": "seed"
        }))
        .unwrap();
        let sim_res = evaluator
            .evaluate_at("alice", &sim_ast, 50, 0, None, now_ms)
            .await
            .expect("evaluate similar_to");
        let sim_ids: Vec<&str> = sim_res
            .tracks
            .iter()
            .filter_map(|t| t.get("id").and_then(Value::as_str))
            .collect();
        assert_eq!(sim_ids, vec!["near-tempo", "unknown-tempo"]);

        // 3. Verify `era_year` prefers `original_year` (`COALESCE(t.original_year, t.year)`)
        let era_ast = parse_smart_playlist_rule(&json!({
            "operator": "AND",
            "rules": [
                { "field": "era_year", "operator": "greater_than", "value": 1980 },
                { "field": "era_year", "operator": "less_than", "value": 1990 }
            ]
        }))
        .unwrap();
        let era_res = evaluator
            .evaluate_at("alice", &era_ast, 50, 0, None, now_ms)
            .await
            .expect("evaluate era_year");
        let era_ids: Vec<&str> = era_res
            .tracks
            .iter()
            .filter_map(|t| t.get("id").and_then(serde_json::Value::as_str))
            .collect();
        assert_eq!(era_ids, vec!["same-artist", "seed", "unknown-tempo"]);

        pool.close().await;
    }
}
