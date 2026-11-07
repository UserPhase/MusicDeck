//! # Unified `MusicBackend` Trait & Provider Error Taxonomy (`providers::traits`)
//!
//! Defines the polymorphic asynchronous [`MusicBackend`] trait combining
//! `CatalogProvider`, `StreamProvider`, `PlaybackScrobbler`, and optional
//! `UserDataSync` capabilities from `server/src/backends/*`.

use async_trait::async_trait;
use thiserror::Error;

use crate::providers::models::{
    Album, Artist, LibraryScanResult, Playlist, PlaylistUpdateInput, SearchPagination,
    SearchResult, StreamResult, Track, format_artwork_url, format_stream_url,
};

/// Unified error taxonomy for upstream media backend providers (`Navidrome` and `Jellyfin`).
#[derive(Debug, Error)]
pub enum ProviderError {
    /// Upstream request timed out (`15,000` ms control timeout).
    #[error("{provider} request timed out")]
    Timeout {
        /// Provider name (`"Navidrome"` or `"Jellyfin"`).
        provider: &'static str,
    },

    /// Upstream authentication failed (`401`/`403` or Subsonic error code 40/50).
    #[error("{provider} authentication failed: {message}")]
    Authentication {
        /// Provider name.
        provider: &'static str,
        /// Redacted error detail.
        message: String,
    },

    /// Requested media item was not found (`404` or Subsonic error 70).
    #[error("{provider} item not found")]
    NotFound {
        /// Provider name.
        provider: &'static str,
    },

    /// Upstream pagination stalled without advancing item cursors.
    #[error("{provider} did not advance its {entity} listing")]
    PaginationStalled {
        /// Provider name.
        provider: &'static str,
        /// Entity kind (`"album"` or `"track"`).
        entity: &'static str,
    },

    /// Upstream server returned an HTTP error or invalid JSON payload.
    #[error("{provider} upstream error: {message}")]
    Upstream {
        /// Provider name.
        provider: &'static str,
        /// Error detail.
        message: String,
    },

    /// Unknown or unsupported provider type or configuration in `BackendRegistry`.
    #[error("{0}")]
    Configuration(String),

    /// Outbound request blocked by [`crate::services::privacy::PrivacyManager`].
    #[error("Privacy policy blocked provider request: {0}")]
    PrivacyBlocked(String),
}

/// Polymorphic asynchronous interface implemented by all MusicDeck media backends
/// (`NavidromeClient`, `JellyfinClient`, and [`crate::providers::LocalUserDataSyncAdapter`]).
#[async_trait]
pub trait MusicBackend: Send + Sync + std::fmt::Debug {
    /// Returns the provider kind identifier (`"navidrome"` or `"jellyfin"`).
    fn provider_kind(&self) -> &'static str;

    // ------------------------------------------------------------------------
    // Catalog Capabilities (`CatalogProvider`)
    // ------------------------------------------------------------------------

    /// Lists albums up to `limit` (defaults to `500`), sorted alphabetically by name.
    async fn list_albums(&self, limit: Option<u32>) -> Result<Vec<Album>, ProviderError>;

    /// Enumerates all albums in the library using 500-item pages with stall detection.
    async fn list_all_albums(&self) -> Result<Vec<Album>, ProviderError>;

    /// Fetches a single album's metadata by its provider-native ID.
    async fn get_album(&self, album_id: &str) -> Result<Option<Album>, ProviderError>;

    /// Fetches all tracks belonging to `album_id` in disc/track order.
    async fn get_album_tracks(&self, album_id: &str) -> Result<Vec<Track>, ProviderError>;

    /// Lists all artists in the library (`listArtists` / `get_artists`).
    async fn get_artists(&self) -> Result<Vec<Artist>, ProviderError>;

    /// Alias for [`MusicBackend::get_artists`] matching `CatalogProvider.listArtists()`.
    async fn list_artists(&self) -> Result<Vec<Artist>, ProviderError> {
        self.get_artists().await
    }

    /// Fetches a single artist by ID, optionally querying extended artist portrait info.
    async fn get_artist(
        &self,
        artist_id: &str,
        include_artist_info: bool,
    ) -> Result<Option<Artist>, ProviderError>;

    /// Lists all albums credited to `artist_id`.
    async fn get_artist_albums(&self, artist_id: &str) -> Result<Vec<Album>, ProviderError>;

    /// Lists all tracks credited to `artist_id`.
    async fn get_artist_tracks(&self, artist_id: &str) -> Result<Vec<Track>, ProviderError>;

    /// Returns up to `limit` (`1..=10`) top tracks for `artist_id`.
    async fn get_artist_top_tracks(
        &self,
        artist_id: &str,
        limit: usize,
    ) -> Result<Vec<Track>, ProviderError>;

    /// Enumerates all tracks in the library across paginated batches.
    async fn list_tracks(&self) -> Result<Vec<Track>, ProviderError>;

    /// Fetches a single track by its provider-native ID.
    async fn get_track(&self, track_id: &str) -> Result<Option<Track>, ProviderError>;

    /// Resolves the server-side filesystem path of `track_id` (used only by admin media deletion
    /// and loudness/silence analysis; never exposed in public track JSON).
    async fn get_track_file_path(&self, track_id: &str) -> Result<Option<String>, ProviderError>;

    /// Fetches synced (LRC) or plain lyrics for `track_id`, if available on the provider.
    async fn get_lyrics(&self, track_id: &str) -> Result<Option<String>, ProviderError>;

    /// Fetches the primary artist biography for `track_id`.
    async fn get_artist_biography_for_track(
        &self,
        track_id: &str,
    ) -> Result<Option<String>, ProviderError>;

    /// Searches artists, albums, and tracks matching `query`.
    async fn search(
        &self,
        query: &str,
        types: &[&str],
        pagination: Option<SearchPagination>,
    ) -> Result<SearchResult, ProviderError>;

    /// Returns `limit` random tracks from the library.
    async fn get_random_tracks(&self, limit: u32) -> Result<Vec<Track>, ProviderError>;

    /// Returns `limit` random albums from the library.
    async fn get_random_albums(&self, limit: u32) -> Result<Vec<Album>, ProviderError>;

    /// Triggers an asynchronous library rescan without waiting for indexing to complete.
    async fn request_library_rescan(&self) -> Result<(), ProviderError>;

    /// Triggers a library scan and (when supported by the provider) polls until completion.
    async fn scan_library(&self) -> Result<LibraryScanResult, ProviderError>;

    // ------------------------------------------------------------------------
    // Stream & Artwork Capabilities (`StreamProvider`)
    // ------------------------------------------------------------------------

    /// Returns the public MusicDeck stream path (`/api/tracks/<id>/stream`) for `track_id`.
    fn stream_url(&self, track_id: &str) -> String {
        format_stream_url(track_id)
    }

    /// Returns the public MusicDeck artwork path (`/api/artwork/<id>`) for `artwork_id`.
    fn artwork_url(&self, artwork_id: &str) -> Option<String> {
        format_artwork_url(Some(artwork_id))
    }

    /// Opens an upstream audio stream for `track_id`, forwarding an optional HTTP `Range`
    /// header and optional `max_bit_rate` (kbps) transcoding hint.
    async fn fetch_stream(
        &self,
        track_id: &str,
        range: Option<&str>,
        max_bit_rate: Option<u32>,
    ) -> Result<StreamResult, ProviderError>;

    /// Fetches cover art for `artwork_id`, passing an optional square thumbnail `size` hint.
    async fn fetch_artwork(
        &self,
        artwork_id: &str,
        size: Option<u32>,
    ) -> Result<StreamResult, ProviderError>;

    // ------------------------------------------------------------------------
    // Scrobbling Capability (`PlaybackScrobbler`)
    // ------------------------------------------------------------------------

    /// Returns `true` if this provider natively accepts playback scrobbles.
    fn supports_scrobble(&self) -> bool {
        false
    }

    /// Submits a qualified track play to the upstream provider.
    async fn scrobble(
        &self,
        _track_id: &str,
        _played_at_ms: Option<i64>,
    ) -> Result<(), ProviderError> {
        Ok(())
    }

    // ------------------------------------------------------------------------
    // Optional User-Data Sync Capabilities (`UserDataSync`)
    // ------------------------------------------------------------------------

    /// Returns `true` if the provider natively stores user favorites and playlists remotely
    /// (`true` for `NavidromeClient`, `false` for `JellyfinClient`).
    fn supports_user_data_sync(&self) -> bool {
        false
    }

    /// Lists tracks starred/favorited on the remote provider.
    async fn list_favorite_tracks(&self) -> Result<Vec<Track>, ProviderError> {
        Ok(Vec::new())
    }

    /// Stars or unstars `track_id` on the remote provider.
    async fn set_track_favorite(&self, _track_id: &str, _liked: bool) -> Result<(), ProviderError> {
        Ok(())
    }

    /// Lists all playlists stored on the remote provider.
    async fn list_playlists(&self) -> Result<Vec<Playlist>, ProviderError> {
        Ok(Vec::new())
    }

    /// Creates a new playlist on the remote provider.
    async fn create_playlist(&self, _name: &str) -> Result<Option<Playlist>, ProviderError> {
        Ok(None)
    }

    /// Fetches a single playlist (with its tracks) from the remote provider.
    async fn get_playlist(&self, _playlist_id: &str) -> Result<Option<Playlist>, ProviderError> {
        Ok(None)
    }

    /// Updates a playlist's name and/or description on the remote provider.
    async fn update_playlist(
        &self,
        _playlist_id: &str,
        _input: PlaylistUpdateInput,
    ) -> Result<Option<Playlist>, ProviderError> {
        Ok(None)
    }

    /// Deletes a playlist on the remote provider.
    async fn delete_playlist(&self, _playlist_id: &str) -> Result<(), ProviderError> {
        Ok(())
    }

    /// Appends `track_id` to `playlist_id` on the remote provider if not already present.
    async fn add_track_to_playlist(
        &self,
        _playlist_id: &str,
        _track_id: &str,
    ) -> Result<bool, ProviderError> {
        Ok(false)
    }

    /// Removes `playlist_item_id` from `playlist_id` on the remote provider.
    async fn remove_playlist_item(
        &self,
        _playlist_id: &str,
        _playlist_item_id: &str,
    ) -> Result<(), ProviderError> {
        Ok(())
    }

    /// Replaces the track order of `playlist_id` on the remote provider.
    async fn reorder_playlist_tracks(
        &self,
        _playlist_id: &str,
        _track_ids: &[String],
    ) -> Result<Option<Playlist>, ProviderError> {
        Ok(None)
    }
}
