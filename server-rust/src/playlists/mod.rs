//! # Playlist Management & Dynamic 2x2 Mosaic Artwork Subsystem (`playlists`)
//!
//! Exports [`PlaylistService`], [`PlaylistArtworkService`], [`PlaylistRecord`],
//! [`PlaylistBatchEdit`], and 2x2 collage composition helpers.

pub mod artwork;
pub mod collaboration;
pub mod service;
pub mod smart;

pub use artwork::{
    COLLAGE_SIZE, COLLAGE_TILE_COUNT, CustomPlaylistArtwork, MAX_ARTWORK_REQUEST_BYTES,
    MAX_CACHED_COLLAGES, MAX_CUSTOM_ARTWORK_BYTES, MAX_TILE_BYTES, PLAYLIST_ARTWORK_PREFIX,
    PLAYLIST_ARTWORK_SIZES, PlaylistArtworkDescriptor, PlaylistArtworkMode,
    PlaylistArtworkService, RenderedArtwork, build_playlist_artwork_id,
    compose_raster_2x2_collage, compose_svg_2x2_collage, parse_image_data_url,
    parse_playlist_artwork_id, resolve_artwork_size, signature_of,
};
pub use collaboration::{
    CollaboratorRole, CollaborationError, CommandDirection, CommandExecutionResult, CommandSummary,
    HouseholdUserItem, HydratedPlaylistGrant, MAX_ACTIVE_SHARE_LINKS, MAX_FOLDER_DEPTH,
    MAX_PARTY_PENDING_PER_USER, MAX_PARTY_PENDING_TOTAL, MAX_PLAYLIST_ITEMS, MAX_RETAINED_COMMANDS,
    OrganizationError, OrganizationOperation, OrganizationTree, PARTY_LEASE_MS, PartyBroadcastHub,
    PartyHostAction, PartyRequestState, PartySessionInfo, PartySessionState, PartyTrackRequestItem,
    PartyWsClientFrame, PartyWsServerFrame, PinItem, PlaylistCollaborationService, PlaylistFolder,
    PlaylistGrant, PlaylistOrganizationService, PlaylistTreeItem, ReversiblePlaylistEdit,
    SHARE_LINK_TTL_MS, ShareLinkSummary, ShareToken, SharingSnapshot, TRASH_RETENTION_MS,
    TrashPlaylistSummary,
};
pub use service::{
    PlaylistBatchEdit, PlaylistError, PlaylistPermissions, PlaylistRecord, PlaylistService,
    PlaylistTrack, PlaylistUpdatePayload, PlaylistVisibility, TrackAddedByUser,
};
pub use crate::providers::Playlist;
pub use smart::{
    CompiledRule, FieldOperator, LeafRule, LogicalOperator, MAX_RULE_DEPTH, MAX_RULE_NODES,
    MixOptions, MixOrder, RuleNode, RuleValue, SeedTrackSummary, SmartEvaluationResult,
    SmartPlaylistDefinition, SmartPlaylistError, SmartPlaylistEvaluator, SmartPlaylistField,
    SqlParam, compile_smart_playlist_rule, fnv1a_mix_rank, parse_and_compile_rule,
    parse_smart_playlist_rule,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{SessionUser, UserRole};
    use crate::catalog::{CatalogService, LibraryService, SourceResolver};
    use crate::config::AppConfig;
    use crate::db::{DbPool, run_migrations, seed_initial_data};
    use crate::providers::BackendRegistry;
    use sqlx::Row;

    async fn test_fixture() -> (DbPool, PlaylistService, SessionUser) {
        let pool = DbPool::connect_memory().await.expect("open memory pool");
        run_migrations(&pool, None).await.expect("run migrations");

        let mut cfg = AppConfig::default();
        cfg.database.database_path = String::from(":memory:");
        cfg.auth.first_admin.password = String::from("admin-password");
        seed_initial_data(&pool, &cfg).await.expect("seed admin");

        let admin_id: String = sqlx::query("SELECT id FROM users WHERE username = 'admin';")
            .fetch_one(pool.inner())
            .await
            .expect("query admin")
            .try_get("id")
            .unwrap();

        let user = SessionUser {
            id: admin_id,
            username: String::from("admin"),
            display_name: String::from("admin"),
            role: UserRole::Admin,
            avatar_ref: None,
            avatar_url: None,
            disabled: false,
            is_master_admin: true,
            external_search_enabled: true,
            external_playback_enabled: true,
            last_login_at: None,
            last_playback_at: None,
            created_at: String::from("2026-01-01T00:00:00Z"),
            updated_at: String::from("2026-01-01T00:00:00Z"),
        };

        let registry = BackendRegistry::default();
        let library = LibraryService::new(pool.clone(), None);
        let catalog = CatalogService::new(registry.clone(), library.clone());
        let resolver = SourceResolver::new(registry, library.clone());
        let service = PlaylistService::new(pool.clone(), catalog, library, resolver);

        (pool, service, user)
    }

    #[tokio::test]
    async fn manages_playlist_lifecycle_cas_reorder_and_batch_edits() {
        let (pool, service, user) = test_fixture().await;

        // 1. Create playlist
        let created = service
            .create("Late Night Coding", &user, Some("Synth & Ambient"))
            .await
            .expect("create playlist");
        assert_eq!(created.name, "Late Night Coding");
        assert_eq!(created.song_count, 0);

        // 2. Batch add 3 tracks
        let after_add = service
            .edit_tracks(
                &created.id,
                PlaylistBatchEdit::Add {
                    track_ids: vec![
                        String::from("tr_1"),
                        String::from("tr_2"),
                        String::from("tr_3"),
                    ],
                },
                &user,
            )
            .await
            .expect("batch add")
            .expect("playlist exists");

        assert_eq!(after_add.song_count, 3);
        let item_ids = after_add.item_ids.expect("item_ids populated");
        assert_eq!(item_ids.len(), 3);
        assert_eq!(after_add.artwork_mode, Some(PlaylistArtworkMode::Collage));
        assert!(
            after_add
                .artwork_id
                .as_deref()
                .is_some_and(|id| id.starts_with(PLAYLIST_ARTWORK_PREFIX))
        );

        // 3. Compare-And-Swap reorder (`[2, 0, 1]`)
        let reordered_ids = vec![
            item_ids[2].clone(),
            item_ids[0].clone(),
            item_ids[1].clone(),
        ];
        let after_reorder = service
            .reorder_items(&created.id, &reordered_ids, &item_ids, &user)
            .await
            .expect("CAS reorder")
            .expect("playlist exists");
        assert_eq!(after_reorder.item_ids, Some(reordered_ids.clone()));

        // Stale `expected_item_ids` must fail with `PlaylistError::Conflict` (`409`)
        let conflict_err = service
            .reorder_items(&created.id, &item_ids, &item_ids, &user)
            .await
            .unwrap_err();
        assert!(matches!(conflict_err, PlaylistError::Conflict(_)));

        // 4. Batch remove middle item with CAS check
        let after_remove = service
            .edit_tracks(
                &created.id,
                PlaylistBatchEdit::Remove {
                    item_ids: vec![reordered_ids[1].clone()],
                    expected_item_ids: reordered_ids.clone(),
                },
                &user,
            )
            .await
            .expect("batch remove")
            .expect("playlist exists");
        assert_eq!(
            after_remove.item_ids,
            Some(vec![reordered_ids[0].clone(), reordered_ids[2].clone()])
        );

        pool.close().await;
    }

    #[test]
    fn composes_raster_and_svg_2x2_collages_across_0_to_4_tiles() {
        // 0 tiles -> valid PNG & SVG
        let empty_raster = compose_raster_2x2_collage(&[], 160).expect("empty raster collage");
        assert_eq!(empty_raster.content_type, "image/png");
        assert!(empty_raster.body.starts_with(&[0x89, 0x50, 0x4E, 0x47]));

        let svg_two = compose_svg_2x2_collage(
            &[
                String::from("data:image/png;base64,AAAA"),
                String::from("data:image/png;base64,BBBB"),
            ],
            300,
        );
        assert_eq!(svg_two.content_type, "image/svg+xml");
        let svg_str = String::from_utf8(svg_two.body).expect("utf8 svg");
        // Cycling 2 tiles across 4 quadrants produces 4 `<image ` elements
        assert_eq!(svg_str.matches("<image ").count(), 4);
    }
}
