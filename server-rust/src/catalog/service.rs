//! # Multi-Provider Catalog Fan-Out & ID Stamping Service (`catalog::service`)
//!
//! Complete Rust port of `server/src/domain/catalog.ts`.
//!
//! ## Responsibilities
//! - Fans catalog reads (`list_albums`, `list_artists`, `list_tracks`, `search`) out
//!   across every enabled [`RegisteredProvider`] in deterministic registry order.
//! - Isolates per-provider failures: if one provider fails while another succeeds,
//!   returns the successful items with `degraded = true` and logs the failure into
//!   [`LogBuffer`]; only if **all** providers fail does it return an error.
//! - Stamps every returned [`Track`], [`Album`], and [`Artist`] with a stable MusicDeck
//!   `md_...` / `mdart_...` ID via [`LibraryService`] and attaches an [`Availability`]
//!   descriptor (`available`, `degraded`, `unavailable`) and optional multi-source
//!   [`SourceOption`] list.

use serde::{Deserialize, Serialize};

use crate::catalog::library::{LibraryItemType, LibraryService, SourceRef};
use crate::logger::{LogBuffer, LogInput, LogLevel, server_logs};
use crate::providers::{
    Album, Artist, BackendRegistry, ProviderError, SearchPagination, Track, format_artwork_url,
    format_stream_url,
};

/// Availability state attached to every catalog item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AvailabilityState {
    /// All mapped sources are reachable.
    Available,
    /// At least one mapped source is reachable, but another is offline.
    Degraded,
    /// No mapped sources are currently reachable.
    Unavailable,
}

/// MusicDeck availability descriptor attached to catalog read-model items.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    /// Reachability state (`available`, `degraded`, `unavailable`).
    pub state: AvailabilityState,
    /// Primary connection ID that supplied this item.
    pub connection_id: String,
    /// Total mapped sources for this item.
    pub source_count: usize,
    /// Currently enabled/available sources for this item.
    pub available_source_count: usize,
    /// `true` when `available_source_count > 0`.
    pub library_available: bool,
}

impl Availability {
    /// Computes an [`Availability`] summary from source counts.
    #[must_use]
    pub fn from_counts(
        connection_id: impl Into<String>,
        total_sources: usize,
        available_sources: usize,
    ) -> Self {
        let state = if available_sources == 0 {
            AvailabilityState::Unavailable
        } else if available_sources < total_sources {
            AvailabilityState::Degraded
        } else {
            AvailabilityState::Available
        };

        Self {
            state,
            connection_id: connection_id.into(),
            source_count: total_sources,
            available_source_count: available_sources,
            library_available: available_sources > 0,
        }
    }
}

/// Friendly playable-source selector option (`{ id, name }`) exposed when an item
/// is available on more than one enabled connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceOption {
    /// Connection ID (`backend_connections.id`).
    pub id: String,
    /// Human-readable server display name.
    pub name: String,
}

/// Wrapper pairing a catalog item `T` (`Track`, `Album`, `Artist`) with its [`Availability`]
/// and optional multi-source [`SourceOption`] list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Available<T> {
    /// Inner catalog entity (`Track`, `Album`, or `Artist`).
    #[serde(flatten)]
    pub item: T,
    /// Availability summary.
    pub availability: Availability,
    /// Optional source selector list when more than one enabled source exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<SourceOption>>,
}

/// Result of a multi-provider fan-out list read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CatalogListResult<T> {
    /// Stamped items with availability metadata.
    pub items: Vec<Available<T>>,
    /// `true` when at least one provider failed while at least one succeeded.
    pub degraded: bool,
}

/// Result of a multi-provider fan-out catalog search.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CatalogSearchResult {
    /// Stamped matching artists.
    pub artists: Vec<Available<Artist>>,
    /// Stamped matching albums.
    pub albums: Vec<Available<Album>>,
    /// Stamped matching tracks.
    pub tracks: Vec<Available<Track>>,
    /// `true` when at least one provider failed during fan-out.
    pub degraded: bool,
}

/// MusicDeck catalog service coordinating multi-provider fan-out and stable `md_` ID stamping.
#[derive(Debug, Clone)]
pub struct CatalogService {
    registry: BackendRegistry,
    library: LibraryService,
    logs: LogBuffer,
}

/// Resolved physical file reference for a catalog track.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTrackFile {
    pub connection_id: String,
    pub file_path: Option<String>,
}

impl CatalogService {
    /// Constructs a new [`CatalogService`].
    #[must_use]
    pub fn new(registry: BackendRegistry, library: LibraryService) -> Self {
        Self {
            registry,
            library,
            logs: server_logs(),
        }
    }

    /// Convenience constructor from a [`crate::db::DbPool`] and [`BackendRegistry`].
    #[must_use]
    pub fn from_pool(pool: crate::db::DbPool, registry: BackendRegistry) -> Self {
        Self::new(registry, LibraryService::new(pool, None))
    }

    /// Stamps a provider-native [`Track`] with stable MusicDeck `md_` / `mdart_` IDs.
    pub async fn stamp_track(
        &self,
        track: Track,
        connection_id: &str,
    ) -> Result<Available<Track>, ProviderError> {
        self.resolve_track_ids(track, connection_id, true, None)
            .await?
            .ok_or_else(|| ProviderError::Configuration("Track identity is missing".into()))
    }

    /// Stamps metadata for a track with a stable ID and sources already read in bulk.
    pub(crate) async fn stamp_mapped_track(
        &self,
        track: Track,
        connection_id: &str,
        library_id: &str,
        sources: &[SourceRef],
    ) -> Result<Available<Track>, ProviderError> {
        self.resolve_track_ids(track, connection_id, true, Some((library_id, sources)))
            .await?
            .ok_or_else(|| ProviderError::Configuration("Track identity is missing".into()))
    }

    async fn resolve_track_ids(
        &self,
        mut track: Track,
        connection_id: &str,
        register_missing: bool,
        mapped: Option<(&str, &[SourceRef])>,
    ) -> Result<Option<Available<Track>>, ProviderError> {
        let resolve_id = async |item_type, provider_item_id: &str| {
            let source = SourceRef {
                connection_id: connection_id.to_owned(),
                provider_item_id: provider_item_id.to_owned(),
            };
            let result = if register_missing {
                self.library
                    .ensure_id(item_type, &source, None)
                    .await
                    .map(Some)
            } else {
                self.library.find_id(item_type, &source).await
            };
            result.map_err(|err| ProviderError::Configuration(err.to_string()))
        };
        let md_id = if let Some((id, _)) = mapped {
            id.to_owned()
        } else {
            let Some(id) = resolve_id(LibraryItemType::Track, &track.provider_id).await? else {
                return Ok(None);
            };
            id
        };

        if let Some(ref artist_id) = track.artist_id {
            track.artist_id = resolve_id(LibraryItemType::Artist, artist_id).await?;
        }

        if let Some(ref mut credits) = track.artist_credits {
            for credit in credits.iter_mut() {
                if let Some(ref raw_artist_id) = credit.id {
                    if !raw_artist_id.trim().is_empty() && !raw_artist_id.starts_with("md_") {
                        if let Ok(id) = resolve_id(LibraryItemType::Artist, raw_artist_id).await {
                            credit.id = id;
                        }
                    }
                }
            }
        }

        if let Some(ref album_id) = track.album_id {
            track.album_id = resolve_id(LibraryItemType::Album, album_id).await?;
        }

        if let Some(ref art_id) = track.artwork_id {
            let md_art = resolve_id(LibraryItemType::Artwork, art_id).await?;
            track.artwork_url = format_artwork_url(md_art.as_deref());
            track.artwork_id = md_art;
        }

        track.stream_url = format_stream_url(&md_id);
        track.id = md_id.clone();

        let (availability, sources) = if let Some((_, sources)) = mapped {
            self.availability_for_sources(sources, connection_id)
        } else {
            self.availability_for_item(&md_id, connection_id).await
        };
        Ok(Some(Available {
            item: track,
            availability,
            sources,
        }))
    }

    /// Stamps a provider-native [`Album`] with stable MusicDeck `md_` / `mdart_` IDs.
    pub async fn stamp_album(
        &self,
        mut album: Album,
        connection_id: &str,
    ) -> Result<Available<Album>, ProviderError> {
        let md_id = self
            .library
            .ensure_id(
                LibraryItemType::Album,
                &SourceRef {
                    connection_id: connection_id.to_owned(),
                    provider_item_id: album.provider_id.clone(),
                },
                None,
            )
            .await
            .map_err(|err| ProviderError::Configuration(err.to_string()))?;

        if let Some(ref artist_id) = album.artist_id {
            let md_artist = self
                .library
                .ensure_id(
                    LibraryItemType::Artist,
                    &SourceRef {
                        connection_id: connection_id.to_owned(),
                        provider_item_id: artist_id.clone(),
                    },
                    None,
                )
                .await
                .map_err(|err| ProviderError::Configuration(err.to_string()))?;
            album.artist_id = Some(md_artist);
        }

        if let Some(ref art_id) = album.artwork_id {
            let md_art = self
                .library
                .ensure_artwork_id(&SourceRef {
                    connection_id: connection_id.to_owned(),
                    provider_item_id: art_id.clone(),
                })
                .await
                .map_err(|err| ProviderError::Configuration(err.to_string()))?;
            album.artwork_url = format_artwork_url(Some(&md_art));
            album.artwork_id = Some(md_art);
        }

        album.id = md_id.clone();
        let (availability, sources) = self.availability_for_item(&md_id, connection_id).await;
        Ok(Available {
            item: album,
            availability,
            sources,
        })
    }

    /// Stamps a provider-native [`Artist`] with stable MusicDeck `md_` / `mdart_` IDs.
    pub async fn stamp_artist(
        &self,
        mut artist: Artist,
        connection_id: &str,
    ) -> Result<Available<Artist>, ProviderError> {
        let md_id = self
            .library
            .ensure_id(
                LibraryItemType::Artist,
                &SourceRef {
                    connection_id: connection_id.to_owned(),
                    provider_item_id: artist.provider_id.clone(),
                },
                None,
            )
            .await
            .map_err(|err| ProviderError::Configuration(err.to_string()))?;

        if let Some(ref art_id) = artist.artwork_id {
            let md_art = self
                .library
                .ensure_artwork_id(&SourceRef {
                    connection_id: connection_id.to_owned(),
                    provider_item_id: art_id.clone(),
                })
                .await
                .map_err(|err| ProviderError::Configuration(err.to_string()))?;
            artist.artwork_url = format_artwork_url(Some(&md_art));
            artist.artwork_id = Some(md_art);
        }

        artist.id = md_id.clone();
        let (availability, sources) = self.availability_for_item(&md_id, connection_id).await;
        Ok(Available {
            item: artist,
            availability,
            sources,
        })
    }

    /// Lists albums across all enabled providers with partial-failure degradation support.
    pub async fn list_albums(
        &self,
        limit: Option<u32>,
    ) -> Result<CatalogListResult<Album>, ProviderError> {
        let providers = self.registry.list();
        if providers.is_empty() && limit.is_some() {
            return Err(ProviderError::Configuration(String::from(
                "All catalog providers are unavailable",
            )));
        }

        let mut items = Vec::new();
        let mut successes = 0usize;
        let mut failures = 0usize;

        for entry in providers {
            if !entry.enabled {
                continue;
            }
            let result = match limit {
                Some(limit) => entry.provider.list_albums(Some(limit)).await,
                None => entry.provider.list_all_albums().await,
            };
            match result {
                Ok(albums) => {
                    successes += 1;
                    for album in albums {
                        items.push(self.stamp_album(album, &entry.connection_id).await?);
                    }
                }
                Err(err) => {
                    failures += 1;
                    let _ = self.logs.push(LogInput::new(
                        LogLevel::Warn,
                        format!(
                            "Catalog provider '{}' failed during list_albums: {err}",
                            entry.connection_id
                        ),
                    ));
                }
            }
        }

        if limit.is_some() && successes == 0 && failures > 0 {
            return Err(ProviderError::Upstream {
                provider: "CatalogService",
                message: String::from("All catalog providers are unavailable"),
            });
        }

        Ok(CatalogListResult {
            items,
            degraded: failures > 0,
        })
    }

    /// Lists artists across all enabled providers.
    pub async fn list_artists(&self) -> Result<CatalogListResult<Artist>, ProviderError> {
        let providers = self.registry.list();
        let mut items = Vec::new();
        let mut successes = 0usize;
        let mut failures = 0usize;

        for entry in providers {
            if !entry.enabled {
                continue;
            }
            match entry.provider.get_artists().await {
                Ok(artists) => {
                    successes += 1;
                    for artist in artists {
                        items.push(self.stamp_artist(artist, &entry.connection_id).await?);
                    }
                }
                Err(err) => {
                    failures += 1;
                    let _ = self.logs.push(LogInput::new(
                        LogLevel::Warn,
                        format!(
                            "Catalog provider '{}' failed during list_artists: {err}",
                            entry.connection_id
                        ),
                    ));
                }
            }
        }

        if successes == 0 && failures > 0 {
            return Err(ProviderError::Upstream {
                provider: "CatalogService",
                message: String::from("All catalog providers are unavailable"),
            });
        }

        Ok(CatalogListResult {
            items,
            degraded: failures > 0,
        })
    }

    /// Searches artists, albums, and tracks across all enabled providers.
    pub async fn search(
        &self,
        query: &str,
        types: &[&str],
        pagination: Option<SearchPagination>,
    ) -> Result<CatalogSearchResult, ProviderError> {
        // Catalog callers also use the singular API result kinds.
        let provider_types: Vec<_> = types
            .iter()
            .copied()
            .map(|kind| match kind {
                "artist" => "artists",
                "album" => "albums",
                "track" | "song" => "tracks",
                other => other,
            })
            .collect();
        let providers = self.registry.list();
        let mut artists = Vec::new();
        let mut albums = Vec::new();
        let mut tracks = Vec::new();
        let mut successes = 0usize;
        let mut failures = 0usize;

        for entry in providers {
            if !entry.enabled {
                continue;
            }
            match entry
                .provider
                .search(query, &provider_types, pagination)
                .await
            {
                Ok(res) => {
                    successes += 1;
                    for artist in res.artists {
                        artists.push(self.stamp_artist(artist, &entry.connection_id).await?);
                    }
                    for album in res.albums {
                        albums.push(self.stamp_album(album, &entry.connection_id).await?);
                    }
                    for track in res.tracks {
                        tracks.push(self.stamp_track(track, &entry.connection_id).await?);
                    }
                }
                Err(err) => {
                    failures += 1;
                    let _ = self.logs.push(LogInput::new(
                        LogLevel::Warn,
                        format!(
                            "Catalog provider '{}' failed during search: {err}",
                            entry.connection_id
                        ),
                    ));
                }
            }
        }

        if successes == 0 && failures > 0 {
            return Err(ProviderError::Upstream {
                provider: "CatalogService",
                message: String::from("All catalog providers are unavailable"),
            });
        }

        Ok(CatalogSearchResult {
            artists,
            albums,
            tracks,
            degraded: failures > 0,
        })
    }

    async fn availability_for_item(
        &self,
        library_item_id: &str,
        connection_id: &str,
    ) -> (Availability, Option<Vec<SourceOption>>) {
        let sources = self
            .library
            .get_sources(library_item_id)
            .await
            .unwrap_or_default();
        self.availability_for_sources(&sources, connection_id)
    }

    fn availability_for_sources(
        &self,
        sources: &[SourceRef],
        connection_id: &str,
    ) -> (Availability, Option<Vec<SourceOption>>) {
        let total = sources.len().max(1);
        let mut options = Vec::new();

        for src in sources {
            if let Some(entry) = self.registry.get_by_connection_id(&src.connection_id)
                && entry.enabled
            {
                options.push(SourceOption {
                    id: entry.connection_id,
                    name: entry.name,
                });
            }
        }

        let available_count = options.len().max(1);
        let availability = Availability::from_counts(connection_id, total, available_count);
        let source_options = (options.len() > 1).then_some(options);
        (availability, source_options)
    }

    /// Lists tracks across all enabled providers (infallible fallback returning empty list if unconfigured).
    pub async fn list_tracks(&self) -> CatalogListResult<Track> {
        self.list_provider_tracks(true).await
    }

    /// Lists playable tracks with existing identities using only SQLite reads.
    pub(crate) async fn list_mapped_tracks(&self) -> CatalogListResult<Track> {
        self.list_provider_tracks(false).await
    }

    async fn list_provider_tracks(&self, register_missing: bool) -> CatalogListResult<Track> {
        let providers = self.registry.list();
        let mut items = Vec::new();
        let mut failures = 0usize;

        for entry in providers {
            if !entry.enabled {
                continue;
            }
            match entry.provider.list_tracks().await {
                Ok(tracks) => {
                    for track in tracks {
                        match self
                            .resolve_track_ids(track, &entry.connection_id, register_missing, None)
                            .await
                        {
                            Ok(Some(stamped)) => items.push(stamped),
                            Ok(None) => {}
                            Err(_) => failures += 1,
                        }
                    }
                }
                Err(_) => {
                    failures += 1;
                }
            }
        }

        CatalogListResult {
            items,
            degraded: failures > 0,
        }
    }

    /// Alias for [`CatalogService::list_tracks`] used by windowed background tasks.
    pub async fn tracks_for_window(&self) -> CatalogListResult<Track> {
        self.list_tracks().await
    }

    /// Fetches a single stamped [`Track`] by its MusicDeck ID (`md_...`).
    pub async fn get_track(&self, track_id: &str) -> Option<Available<Track>> {
        let sources = self.library.get_sources(track_id).await.ok()?;
        for src in sources {
            let Some(entry) = self.registry.get_by_connection_id(&src.connection_id) else {
                continue;
            };
            if !entry.enabled {
                continue;
            }
            if let Ok(Some(track)) = entry.provider.get_track(&src.provider_item_id).await {
                if let Ok(stamped) = self.stamp_track(track, &src.connection_id).await {
                    return Some(stamped);
                }
            }
        }
        None
    }

    /// Fetches a single stamped [`Album`] by its MusicDeck ID (`md_...`).
    pub async fn get_album(&self, album_id: &str) -> Option<Available<Album>> {
        let sources = self.library.get_sources(album_id).await.ok()?;
        for src in sources {
            let Some(entry) = self.registry.get_by_connection_id(&src.connection_id) else {
                continue;
            };
            if !entry.enabled {
                continue;
            }
            if let Ok(Some(album)) = entry.provider.get_album(&src.provider_item_id).await {
                if let Ok(stamped) = self.stamp_album(album, &src.connection_id).await {
                    return Some(stamped);
                }
            }
        }
        None
    }

    /// Fetches the stamped tracks belonging to `album_id`.
    pub async fn get_album_tracks(&self, album_id: &str, _include_external: bool) -> Vec<Available<Track>> {
        let Ok(sources) = self.library.get_sources(album_id).await else {
            return Vec::new();
        };
        for src in sources {
            let Some(entry) = self.registry.get_by_connection_id(&src.connection_id) else {
                continue;
            };
            if !entry.enabled {
                continue;
            }
            if let Ok(tracks) = entry.provider.get_album_tracks(&src.provider_item_id).await {
                let mut out = Vec::with_capacity(tracks.len());
                for t in tracks {
                    if let Ok(stamped) = self.stamp_track(t, &src.connection_id).await {
                        out.push(stamped);
                    }
                }
                return out;
            }
        }
        Vec::new()
    }

    /// Fetches a single stamped [`Artist`] by its MusicDeck ID (`md_...`).
    pub async fn get_artist(&self, artist_id: &str) -> Option<Available<Artist>> {
        let sources = self.library.get_sources(artist_id).await.ok()?;
        for src in sources {
            let entry = self.registry.get_by_connection_id(&src.connection_id)?;
            if !entry.enabled {
                continue;
            }
            if let Ok(Some(artist)) = entry.provider.get_artist(&src.provider_item_id, false).await {
                if let Ok(stamped) = self.stamp_artist(artist, &src.connection_id).await {
                    return Some(stamped);
                }
            }
        }
        None
    }

    /// Returns the primary source `connection_id` for `item_id`.
    pub async fn get_source_connection_id(&self, item_id: &str) -> Option<String> {
        let sources = self.library.get_sources(item_id).await.ok()?;
        sources.into_iter().next().map(|s| s.connection_id)
    }

    /// Resolves the relative or physical file path reported by the upstream provider for `track_id`.
    pub async fn resolve_track_file(
        &self,
        track_id: &str,
        preferred_connection_id: Option<&str>,
    ) -> Option<ResolvedTrackFile> {
        let sources = self.library.get_sources(track_id).await.ok()?;
        for src in sources {
            if let Some(pref) = preferred_connection_id {
                if src.connection_id != pref {
                    continue;
                }
            }
            let Some(entry) = self.registry.get_by_connection_id(&src.connection_id) else {
                continue;
            };
            if !entry.enabled {
                continue;
            }
            if let Ok(file_path) = entry.provider.get_track_file_path(&src.provider_item_id).await {
                return Some(ResolvedTrackFile {
                    connection_id: src.connection_id,
                    file_path,
                });
            }
        }
        None
    }

    /// Requests a library rescan on `connection_id`.
    pub async fn request_library_rescan(&self, connection_id: &str) -> Result<(), ProviderError> {
        let entry = self
            .registry
            .get_by_connection_id(connection_id)
            .ok_or_else(|| ProviderError::Configuration(String::from("Provider not found")))?;
        entry.provider.request_library_rescan().await?;
        Ok(())
    }
}
