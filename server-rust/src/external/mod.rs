//! # External Metadata, Lyrics, Discovery Charts & Saved Discoveries (`external`)

pub mod adapters;
pub mod composite;
pub mod discovery;
pub mod lyrics;

pub use adapters::{
    DeezerAdapter, EXTERNAL_ADAPTER_TIMEOUT_MS, EXTERNAL_ARTWORK_TOKEN_TTL_MS, ExternalArtworkRef,
    ExternalArtworkTokenStore, ExternalError, ExternalProvider, ExternalSearchItem,
    ExternalSourceBadge, ItunesAdapter, MetadataAdapter, SearchGroups, SubsonicAdapter,
};
pub use composite::{
    CompositeExternalSearchResult, CompositeMetadataService, deduplicate_search_groups,
};
pub use discovery::{
    DEEZER_CHART_CACHE_MS, DEEZER_CHART_URL, DeezerDiscoveryService, ExternalCharts,
    SaveDiscoveryInput, SavedDiscoveryRecord, delete_saved_discovery, list_saved_discoveries,
    normalize_deezer_chart, save_discovery,
};
pub use lyrics::{
    FOUND_TTL_MS, LRCLIB_CLIENT_HEADER, LyricsProviderName, LyricsResult, LyricsService,
    LyricsTrackQuery, MISSING_TTL_MS, ParsedLrcLine, SYNC_DURATION_TOLERANCE_SECS, parse_lrc_lines,
    primary_artist_name, sanitize_track_title,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{DbPool, run_migrations};
    use serde_json::json;

    #[test]
    fn parses_lrc_timestamps_offsets_and_sanitizes_titles() {
        let raw = "[offset:500]\n[00:10.50] First line\n[00:20.00][00:30.250] Chorus";
        let lines = parse_lrc_lines(raw);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].time, 10.0);
        assert_eq!(lines[0].text, "First line");
        assert_eq!(lines[1].time, 19.5);
        assert_eq!(lines[2].time, 29.75);

        assert_eq!(
            sanitize_track_title("Instant Crush (feat. Julian Casablancas) [2013 Remastered]"),
            "Instant Crush"
        );
        assert_eq!(
            primary_artist_name("Daft Punk feat. Pharrell Williams & Nile Rodgers"),
            "Daft Punk"
        );
    }

    #[test]
    fn mints_external_artwork_tokens_only_for_allowed_https_hosts() {
        let store = ExternalArtworkTokenStore::new();
        let valid = store.mint_token(
            Some("https://e-cdns-images.dzcdn.net/images/cover/abc/1000x1000.jpg"),
            &["dzcdn.net"],
        );
        assert!(valid.is_some());
        let token = valid.unwrap();
        assert_eq!(
            store.resolve(&token).as_deref(),
            Some("https://e-cdns-images.dzcdn.net/images/cover/abc/1000x1000.jpg")
        );

        // Disallowed host or plain HTTP must return None
        assert!(
            store
                .mint_token(Some("https://evil.example.com/img.jpg"), &["dzcdn.net"])
                .is_none()
        );
        assert!(
            store
                .mint_token(Some("http://e-cdns-images.dzcdn.net/img.jpg"), &["dzcdn.net"])
                .is_none()
        );
    }

    #[tokio::test]
    async fn saves_deduplicates_and_lists_saved_discoveries() {
        let pool = DbPool::connect_memory().await.expect("open memory pool");
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

        let input = SaveDiscoveryInput {
            provider: String::from("deezer"),
            external_id: String::from("external_deezer_track_999"),
            item_type: String::from("track"),
            title: String::from("Veridis Quo"),
            artist: String::from("Daft Punk"),
            cover_url: Some(String::from("https://e-cdns-images.dzcdn.net/cover.jpg")),
            metadata: serde_json::from_value(json!({ "isrc": "GBDUW0000059" })).unwrap(),
        };

        let (created_first, rec_1) = save_discovery(&pool, "u1", input.clone())
            .await
            .expect("save discovery");
        assert!(created_first);
        assert_eq!(rec_1.external_id, "999");

        // Saving with unprefixed ID `"999"` deduplicates against `"external_deezer_track_999"`
        let (created_second, rec_2) = save_discovery(
            &pool,
            "u1",
            SaveDiscoveryInput {
                external_id: String::from("999"),
                ..input
            },
        )
        .await
        .expect("save duplicate discovery");
        assert!(!created_second);
        assert_eq!(rec_1.id, rec_2.id);

        let listed = list_saved_discoveries(&pool, "u1")
            .await
            .expect("list saved discoveries");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status.as_deref(), Some("IDLE"));

        pool.close().await;
    }
}
