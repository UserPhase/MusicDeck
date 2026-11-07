//! # Artist Follows & Release Radar (`social`)
//!
//! Exports [`ArtistFollowService`], [`FollowedArtist`], [`NewRelease`],
//! [`followed_artist_key`], and [`canonical_release_key`].

pub mod artist_follows;

pub use artist_follows::{
    ArtistFollowService, DAY_MS, DEFAULT_RELEASE_REQUEST_INTERVAL_MS, FollowArtistInput,
    FollowProvider, FollowedArtist, HOUR_MS, MAX_FOLLOWED_ARTISTS_PER_USER,
    MAX_RELEASE_METADATA_BYTES, NewRelease, ReleaseAlbumType, ReleaseFeedPage, ReleaseLookupError,
    canonical_release_key, followed_artist_key,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{DbPool, run_migrations};
    use crate::external::ExternalArtworkTokenStore;

    #[tokio::test]
    async fn follows_lists_and_unfollows_artists_with_normalized_external_ids() {
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

        let service = ArtistFollowService::new(Some(pool.clone()), ExternalArtworkTokenStore::new());
        let followed = service
            .follow(
                "u1",
                FollowArtistInput {
                    artist_id: String::from("27"),
                    artist_name: String::from("Daft Punk"),
                    provider: FollowProvider::Deezer,
                },
            )
            .await
            .expect("follow artist");

        assert_eq!(followed.artist_id, "external_deezer_artist_27");
        assert!(service.has_followers().await);

        let listed = service.list("u1").await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].key, followed.key);

        service.unfollow("u1", &followed.key).await;
        assert!(service.list("u1").await.is_empty());

        pool.close().await;
    }
}
