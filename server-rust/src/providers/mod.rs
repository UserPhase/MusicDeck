//! # Pluggable Music Backend Provider Subsystem (`providers` / `backends`)
//!
//! Complete Rust port of `server/src/backends/*`:
//! - `traits`: Polymorphic [`MusicBackend`] trait and [`ProviderError`] taxonomy.
//! - `models`: [`Track`], [`Album`], [`Artist`], [`Playlist`], [`SearchResult`], and [`StreamResult`].
//! - `navidrome`: [`NavidromeClient`] implementing Subsonic REST API + MD5/salt auth + `UserDataSync`.
//! - `jellyfin`: [`JellyfinClient`] implementing Jellyfin REST API (`X-Emby-Token`) + tick conversion.
//! - `local_sync`: [`LocalUserDataSyncAdapter`] and [`with_local_user_data_sync`].
//! - `registry`: Thread-safe [`BackendRegistry`] (`ProviderRegistry`) and [`create_provider_registry`].

pub mod jellyfin;
pub mod local_sync;
pub mod models;
pub mod navidrome;
pub mod registry;
pub mod traits;

pub use jellyfin::{
    HEADER_X_EMBY_TOKEN, JELLYFIN_REQUEST_TIMEOUT_MS, JellyfinBackend, JellyfinClient,
    map_jellyfin_album, map_jellyfin_artist, map_jellyfin_track,
};
pub use local_sync::{LocalUserDataSyncAdapter, has_user_data_sync, with_local_user_data_sync};
pub use models::{
    Album, Artist, ArtistCredit, AudioMetadata, AudioMetadataSummary, AudioStreamInfo,
    IdentityHints, LibraryScanResult, Loudness, LoudnessMetadata, Playlist, PlaylistUpdateInput,
    ReplayGainMetadata, SearchPagination, SearchResult, StreamResult, Track, TrackArtistCredit,
    UpstreamStreamResponse, format_artwork_url, format_stream_url,
};
pub use navidrome::{
    NAVIDROME_REQUEST_TIMEOUT_MS, NavidromeBackend, NavidromeClient, SUBSONIC_API_VERSION,
    SUBSONIC_CLIENT_NAME, map_subsonic_album, map_subsonic_artist, map_subsonic_playlist,
    map_subsonic_track,
};
pub use registry::{
    BackendRegistry, ProviderRegistry, RegisteredProvider, StoredProviderConfig, create_provider,
    create_provider_registry,
};
pub use traits::{MusicBackend, ProviderError};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AppConfig, MusicBackendKind};
    use crate::db::{DbPool, run_migrations, seed_initial_data};
    use serde_json::json;

    #[test]
    fn navidrome_and_jellyfin_mappers_preserve_domain_invariants() {
        let raw_subsonic_song = json!({
            "id": "tr-101",
            "title": "Midnight City",
            "artistId": "ar-1",
            "artist": "M83",
            "albumId": "al-1",
            "album": "Hurry Up, We're Dreaming",
            "duration": 243,
            "track": 1,
            "year": 2011,
            "coverArt": "cov-101",
            "suffix": "flac",
            "contentType": "audio/flac",
            "bitRate": 950,
            "samplingRate": 44100,
            "bitDepth": 16,
            "channelCount": 2,
            "replayGain": {
                "trackGain": -7.2,
                "trackPeak": 0.98
            }
        });

        let nav_track = map_subsonic_track(&raw_subsonic_song);
        assert_eq!(nav_track.id, "tr-101");
        assert_eq!(nav_track.title, "Midnight City");
        assert_eq!(nav_track.stream_url, "/api/tracks/tr-101/stream");
        assert_eq!(
            nav_track.artwork_url.as_deref(),
            Some("/api/artwork/cov-101")
        );
        assert_eq!(
            nav_track.audio_metadata.as_ref().and_then(|m| m.codec.as_deref()),
            Some("flac")
        );
        assert_eq!(
            nav_track.replay_gain.and_then(|r| r.track_gain_db),
            Some(-7.2)
        );

        let raw_jf_song = json!({
            "Id": "jf-900",
            "Name": "Starlight",
            "AlbumId": "jf-alb-1",
            "Album": "Black Holes and Revelations",
            "Artists": ["Muse"],
            "ArtistItems": [{"Id": "jf-art-1", "Name": "Muse"}],
            "RunTimeTicks": 2_400_000_000i64,
            "ProductionYear": 2006,
            "IndexNumber": 2,
            "Container": "mp3",
            "ImageTags": { "Primary": "tag123" },
            "MediaStreams": [{
                "Type": "Audio",
                "Codec": "mp3",
                "BitRate": 320_000,
                "SampleRate": 48000,
                "Channels": 2
            }]
        });

        let jf_track = map_jellyfin_track(&raw_jf_song);
        assert_eq!(jf_track.id, "jf-900");
        assert_eq!(jf_track.duration_seconds, Some(240));
        assert_eq!(jf_track.artist_id.as_deref(), Some("jf-art-1"));
        assert_eq!(
            jf_track.artwork_url.as_deref(),
            Some("/api/artwork/jf-900")
        );
        assert_eq!(
            jf_track
                .audio_metadata
                .as_ref()
                .and_then(|m| m.bitrate_kbps),
            Some(320)
        );
    }

    #[tokio::test]
    async fn registry_loads_primary_backend_and_wraps_jellyfin_with_local_user_data_sync() {
        let pool = DbPool::connect_memory().await.expect("open memory pool");
        run_migrations(&pool, None).await.expect("run migrations");

        let mut cfg = AppConfig::default();
        cfg.database.database_path = String::from(":memory:");
        cfg.backend = MusicBackendKind::Jellyfin;
        cfg.jellyfin.url = String::from("http://jellyfin:8096");
        cfg.jellyfin.api_key = String::from("secret-jf-token");
        seed_initial_data(&pool, &cfg).await.expect("seed jellyfin");

        let registry = create_provider_registry(&pool, &cfg)
            .await
            .expect("create provider registry");
        let primary = registry.get_primary().expect("primary exists");
        assert_eq!(primary.provider_type, "jellyfin");
        assert!(!primary.provider.supports_user_data_sync());

        let adapted = with_local_user_data_sync(primary.provider);
        assert!(adapted.supports_user_data_sync());
        assert!(
            adapted
                .list_favorite_tracks()
                .await
                .expect("local favorite list")
                .is_empty()
        );
        assert!(
            !adapted
                .add_track_to_playlist("pl-1", "tr-1")
                .await
                .expect("local no-op playlist add")
        );

        pool.close().await;
    }
}
