//! # Local User-Data Synchronization Adapter (`providers::local_sync`)
//!
//! Complete Rust port of `server/src/backends/local-user-data-sync.ts`.
//!
//! ## Purpose
//! Providers that implement `CatalogProvider` and `StreamProvider` but do not
//! store user favorites or playlists remotely (such as [`crate::providers::JellyfinClient`])
//! are wrapped via [`with_local_user_data_sync`]. The decorator delegates all catalog,
//! streaming, artwork, and scrobble calls directly to the inner [`MusicBackend`], while
//! turning remote user-data sync calls into local-only no-ops (`list_favorite_tracks -> []`,
//! `add_track_to_playlist -> false`, etc.) so MusicDeck's SQLite database remains the
//! authoritative store without blocking startup.

use std::sync::Arc;

use async_trait::async_trait;

use crate::providers::models::{
    Album, Artist, LibraryScanResult, Playlist, PlaylistUpdateInput, SearchPagination,
    SearchResult, StreamResult, Track,
};
use crate::providers::traits::{MusicBackend, ProviderError};

/// Returns `true` if `provider` natively supports remote user-data synchronization,
/// matching `hasUserDataSync(provider)` in `server/src/backends/user-data-sync.ts`.
#[must_use]
pub fn has_user_data_sync(provider: &dyn MusicBackend) -> bool {
    provider.supports_user_data_sync()
}

/// Wraps `provider` in a [`LocalUserDataSyncAdapter`] if it does not natively implement
/// remote user-data synchronization (`supports_user_data_sync() == false`).
#[must_use]
pub fn with_local_user_data_sync(provider: Arc<dyn MusicBackend>) -> Arc<dyn MusicBackend> {
    if provider.supports_user_data_sync() {
        return provider;
    }
    Arc::new(LocalUserDataSyncAdapter::new(provider))
}

/// Decorator around an `Arc<dyn MusicBackend>` that supplies local-only no-op
/// implementations for remote favorite/playlist sync methods.
#[derive(Debug, Clone)]
pub struct LocalUserDataSyncAdapter {
    inner: Arc<dyn MusicBackend>,
}

impl LocalUserDataSyncAdapter {
    /// Wraps `inner` with local user-data sync fallback behavior.
    #[must_use]
    pub fn new(inner: Arc<dyn MusicBackend>) -> Self {
        Self { inner }
    }

    /// Returns a reference to the wrapped [`MusicBackend`].
    #[must_use]
    pub fn inner(&self) -> &dyn MusicBackend {
        self.inner.as_ref()
    }
}

#[async_trait]
impl MusicBackend for LocalUserDataSyncAdapter {
    fn provider_kind(&self) -> &'static str {
        self.inner.provider_kind()
    }

    async fn list_albums(&self, limit: Option<u32>) -> Result<Vec<Album>, ProviderError> {
        self.inner.list_albums(limit).await
    }

    async fn list_all_albums(&self) -> Result<Vec<Album>, ProviderError> {
        self.inner.list_all_albums().await
    }

    async fn get_album(&self, album_id: &str) -> Result<Option<Album>, ProviderError> {
        self.inner.get_album(album_id).await
    }

    async fn get_album_tracks(&self, album_id: &str) -> Result<Vec<Track>, ProviderError> {
        self.inner.get_album_tracks(album_id).await
    }

    async fn get_artists(&self) -> Result<Vec<Artist>, ProviderError> {
        self.inner.get_artists().await
    }

    async fn get_artist(
        &self,
        artist_id: &str,
        include_artist_info: bool,
    ) -> Result<Option<Artist>, ProviderError> {
        self.inner.get_artist(artist_id, include_artist_info).await
    }

    async fn get_artist_albums(&self, artist_id: &str) -> Result<Vec<Album>, ProviderError> {
        self.inner.get_artist_albums(artist_id).await
    }

    async fn get_artist_tracks(&self, artist_id: &str) -> Result<Vec<Track>, ProviderError> {
        self.inner.get_artist_tracks(artist_id).await
    }

    async fn get_artist_top_tracks(
        &self,
        artist_id: &str,
        limit: usize,
    ) -> Result<Vec<Track>, ProviderError> {
        self.inner.get_artist_top_tracks(artist_id, limit).await
    }

    async fn list_tracks(&self) -> Result<Vec<Track>, ProviderError> {
        self.inner.list_tracks().await
    }

    async fn get_track(&self, track_id: &str) -> Result<Option<Track>, ProviderError> {
        self.inner.get_track(track_id).await
    }

    async fn get_track_file_path(&self, track_id: &str) -> Result<Option<String>, ProviderError> {
        self.inner.get_track_file_path(track_id).await
    }

    async fn get_lyrics(&self, track_id: &str) -> Result<Option<String>, ProviderError> {
        self.inner.get_lyrics(track_id).await
    }

    async fn get_artist_biography_for_track(
        &self,
        track_id: &str,
    ) -> Result<Option<String>, ProviderError> {
        self.inner.get_artist_biography_for_track(track_id).await
    }

    async fn search(
        &self,
        query: &str,
        types: &[&str],
        pagination: Option<SearchPagination>,
    ) -> Result<SearchResult, ProviderError> {
        self.inner.search(query, types, pagination).await
    }

    async fn get_random_tracks(&self, limit: u32) -> Result<Vec<Track>, ProviderError> {
        self.inner.get_random_tracks(limit).await
    }

    async fn get_random_albums(&self, limit: u32) -> Result<Vec<Album>, ProviderError> {
        self.inner.get_random_albums(limit).await
    }

    async fn request_library_rescan(&self) -> Result<(), ProviderError> {
        self.inner.request_library_rescan().await
    }

    async fn scan_library(&self) -> Result<LibraryScanResult, ProviderError> {
        self.inner.scan_library().await
    }

    async fn fetch_stream(
        &self,
        track_id: &str,
        range: Option<&str>,
        max_bit_rate: Option<u32>,
    ) -> Result<StreamResult, ProviderError> {
        self.inner.fetch_stream(track_id, range, max_bit_rate).await
    }

    async fn fetch_artwork(
        &self,
        artwork_id: &str,
        size: Option<u32>,
    ) -> Result<StreamResult, ProviderError> {
        self.inner.fetch_artwork(artwork_id, size).await
    }

    fn supports_scrobble(&self) -> bool {
        self.inner.supports_scrobble()
    }

    async fn scrobble(
        &self,
        track_id: &str,
        played_at_ms: Option<i64>,
    ) -> Result<(), ProviderError> {
        self.inner.scrobble(track_id, played_at_ms).await
    }

    fn supports_user_data_sync(&self) -> bool {
        true
    }

    async fn list_favorite_tracks(&self) -> Result<Vec<Track>, ProviderError> {
        Ok(Vec::new())
    }

    async fn set_track_favorite(&self, _track_id: &str, _liked: bool) -> Result<(), ProviderError> {
        Ok(())
    }

    async fn list_playlists(&self) -> Result<Vec<Playlist>, ProviderError> {
        Ok(Vec::new())
    }

    async fn create_playlist(&self, _name: &str) -> Result<Option<Playlist>, ProviderError> {
        Ok(None)
    }

    async fn get_playlist(&self, _playlist_id: &str) -> Result<Option<Playlist>, ProviderError> {
        Ok(None)
    }

    async fn update_playlist(
        &self,
        _playlist_id: &str,
        _input: PlaylistUpdateInput,
    ) -> Result<Option<Playlist>, ProviderError> {
        Ok(None)
    }

    async fn delete_playlist(&self, _playlist_id: &str) -> Result<(), ProviderError> {
        Ok(())
    }

    async fn add_track_to_playlist(
        &self,
        _playlist_id: &str,
        _track_id: &str,
    ) -> Result<bool, ProviderError> {
        Ok(false)
    }

    async fn remove_playlist_item(
        &self,
        _playlist_id: &str,
        _playlist_item_id: &str,
    ) -> Result<(), ProviderError> {
        Ok(())
    }

    async fn reorder_playlist_tracks(
        &self,
        _playlist_id: &str,
        _track_ids: &[String],
    ) -> Result<Option<Playlist>, ProviderError> {
        Ok(None)
    }
}
