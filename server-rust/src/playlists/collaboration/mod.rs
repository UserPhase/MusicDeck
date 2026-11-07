//! # Playlist Organization, Hierarchical Folders & Real-Time Collaboration (`playlists::collaboration`)

pub mod organization;
pub mod service;

pub use organization::{
    CommandDirection, CommandExecutionResult, CommandSummary, MAX_FOLDER_DEPTH,
    MAX_PLAYLIST_ITEMS, MAX_RETAINED_COMMANDS, OrganizationError, OrganizationOperation,
    OrganizationTree, PinItem, PlaylistFolder, PlaylistOrganizationService, PlaylistTreeItem,
    ReversiblePlaylistEdit, TRASH_RETENTION_MS, TrashPlaylistSummary,
};
pub use service::{
    CollaboratorRole, CollaborationError, HouseholdUserItem, HydratedPlaylistGrant,
    MAX_ACTIVE_SHARE_LINKS, MAX_PARTY_PENDING_PER_USER, MAX_PARTY_PENDING_TOTAL, PARTY_LEASE_MS,
    PartyBroadcastHub, PartyHostAction, PartyRequestState, PartySessionInfo, PartySessionState,
    PartyTrackRequestItem, PartyWsClientFrame, PartyWsServerFrame, PlaylistCollaborationService,
    PlaylistGrant, SHARE_LINK_TTL_MS, ShareLinkSummary, ShareToken, SharingSnapshot,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{SessionStore, SessionUser, UserRole};
    use crate::catalog::{LibraryItemType, LibraryService, SourceRef};
    use crate::config::AppConfig;
    use crate::db::{DbPool, run_migrations, seed_initial_data};
    use crate::playlists::PlaylistVisibility;
    use sqlx::Row;

    async fn setup_collab_fixture() -> (
        DbPool,
        PlaylistOrganizationService,
        PlaylistCollaborationService,
        SessionUser,
        SessionUser,
        String,
        String,
    ) {
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

        sqlx::query(
            "INSERT INTO users (id, username, password_hash, display_name, role, disabled, created_at, updated_at) VALUES ('user_guest', 'guest', 'hash', 'Guest User', 'user', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');",
        )
        .execute(pool.inner())
        .await
        .expect("insert guest");

        let store = SessionStore::new(pool.clone(), "test-secret");
        let host_session = store
            .create_session(&admin_id, true)
            .await
            .expect("create host session");

        let owner = SessionUser {
            id: admin_id.clone(),
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

        let guest = SessionUser {
            id: String::from("user_guest"),
            username: String::from("guest"),
            display_name: String::from("Guest User"),
            role: UserRole::User,
            avatar_ref: None,
            avatar_url: None,
            disabled: false,
            is_master_admin: false,
            external_search_enabled: true,
            external_playback_enabled: false,
            last_login_at: None,
            last_playback_at: None,
            created_at: String::from("2026-01-01T00:00:00Z"),
            updated_at: String::from("2026-01-01T00:00:00Z"),
        };

        sqlx::query(
            "INSERT INTO playlists (id, owner_user_id, name, description, created_at, updated_at) VALUES ('mdpl_party', ?, 'Party Mix', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');",
        )
        .bind(&admin_id)
        .execute(pool.inner())
        .await
        .expect("insert playlist");

        let library = LibraryService::new(pool.clone(), None);
        let md_track = library
            .ensure_id(
                LibraryItemType::Track,
                &SourceRef {
                    connection_id: String::from("conn_1"),
                    provider_item_id: String::from("prov_tr_1"),
                },
                None,
            )
            .await
            .expect("ensure track id");

        let org = PlaylistOrganizationService::new(pool.clone(), library);
        let collab = PlaylistCollaborationService::new(pool.clone());

        (pool, org, collab, owner, guest, host_session.id, md_track)
    }

    #[tokio::test]
    async fn manages_nested_folders_pin_order_and_reversible_undo_redo_commands() {
        let (pool, org, _collab, owner, _guest, _sid, md_track) = setup_collab_fixture().await;

        // 1. Create root and child folders
        let tree_v1 = org
            .organize(
                &owner,
                0,
                OrganizationOperation::CreateFolder {
                    name: String::from("Synthwave"),
                    parent_id: None,
                },
            )
            .await
            .expect("create root folder");
        assert_eq!(tree_v1.revision, 1);
        assert_eq!(tree_v1.folders.len(), 1);
        let root_folder_id = tree_v1.folders[0].id.clone();

        // 2. Pin playlist into root folder
        let tree_v2 = org
            .organize(
                &owner,
                1,
                OrganizationOperation::Playlist {
                    id: String::from("mdpl_party"),
                    folder_id: Some(Some(root_folder_id.clone())),
                    pinned: Some(true),
                    position: Some(0),
                },
            )
            .await
            .expect("place and pin playlist");
        assert_eq!(tree_v2.revision, 2);
        assert!(tree_v2.playlists[0].pinned);
        assert_eq!(
            tree_v2.playlists[0].folder_id.as_deref(),
            Some(root_folder_id.as_str())
        );

        // 3. Execute reversible Add command, then Undo and Redo
        let exec_res = org
            .execute(
                &owner,
                "mdpl_party",
                0,
                ReversiblePlaylistEdit::Add {
                    track_ids: vec![md_track.clone()],
                },
            )
            .await
            .expect("execute reversible add");
        let cmd = exec_res.command.expect("command recorded");
        let rev_after_add = exec_res.revision;

        let undone = org
            .reverse(&owner, &cmd.id, rev_after_add, CommandDirection::Undo)
            .await
            .expect("undo add");
        let (_, items_after_undo, _) = org.edit_state(&owner, "mdpl_party").await.unwrap();
        assert!(items_after_undo.is_empty());

        let _redone = org
            .reverse(&owner, &cmd.id, undone.revision, CommandDirection::Redo)
            .await
            .expect("redo add");
        let (_, items_after_redo, _) = org.edit_state(&owner, "mdpl_party").await.unwrap();
        assert_eq!(items_after_redo.len(), 1);

        pool.close().await;
    }

    #[tokio::test]
    async fn enforces_share_links_collaborator_roles_and_live_party_requests() {
        let (pool, _org, collab, owner, guest, host_session_id, md_track) =
            setup_collab_fixture().await;

        // 1. Grant guest `COLLABORATOR` role under `COLLABORATIVE` mode
        let snap = collab
            .update_sharing(
                "mdpl_party",
                &owner,
                0,
                PlaylistVisibility::Collaborative,
                &[PlaylistGrant {
                    user_id: guest.id.clone(),
                    role: CollaboratorRole::Collaborator,
                }],
            )
            .await
            .expect("update sharing to collaborative");
        assert_eq!(snap.mode, PlaylistVisibility::Collaborative);
        assert_eq!(snap.grants.len(), 1);

        // 2. Mint cryptographic share link for guest and resolve it
        let share_token = collab
            .create_link("mdpl_party", &owner, Some(&guest.id))
            .await
            .expect("create share link");
        assert_eq!(share_token.token.len(), 64);

        let resolved_playlist_id = collab
            .resolve_link(&guest, &share_token.token)
            .await
            .expect("resolve share link");
        assert_eq!(resolved_playlist_id, "mdpl_party");

        // 3. Start party session as host and submit idempotent track request as guest
        let device_id = "11111111-2222-3333-4444-555555555555";
        let (party_id, _) = collab
            .start_party("mdpl_party", &owner, &host_session_id, device_id)
            .await
            .expect("start party");
        assert!(party_id.starts_with("party_"));

        let mut ws_rx = collab.hub().subscribe("mdpl_party");

        let (req_id, _, req_state) = collab
            .request_track(
                "mdpl_party",
                &guest,
                &md_track,
                "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            )
            .await
            .expect("guest requests track");
        assert_eq!(req_state, "PENDING");

        // Verify real-time WebSocket broadcast frame was published
        let ws_frame = ws_rx.try_recv().expect("received WS broadcast frame");
        assert!(matches!(ws_frame, PartyWsServerFrame::QueueAdded { .. }));

        // 4. Host marks request as QUEUED
        collab
            .host_action(
                "mdpl_party",
                &owner,
                &host_session_id,
                device_id,
                PartyHostAction::Queued,
                Some(&req_id),
            )
            .await
            .expect("host queues request");

        let state_after = collab
            .party_state("mdpl_party", &owner, &host_session_id, device_id)
            .await
            .expect("party state after queue");
        assert!(state_after.requests.is_empty());

        pool.close().await;
    }
}
