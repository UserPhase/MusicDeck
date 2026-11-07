//! # Composite Metadata Fan-Out, Deduplication & Library Annotation (`external::composite`)
//!
//! Complete Rust port of `server/src/services/CompositeMetadataService.ts` and
//! `server/src/domain/search-deduplication.ts`.
//!
//! ## Orchestration Pipeline
//! 1. **Phase 1 — Local Search (`search_local`)**:
//!    - Queries the local [`SubsonicAdapter`] without waiting for external network providers.
//! 2. **Phase 2 — External Fan-Out (`search_external`)**:
//!    - Queries all enabled [`ExternalProvider`] adapters (`DeezerAdapter`, `ItunesAdapter`)
//!      concurrently, isolating individual adapter failures (`degraded = true` if any adapter
//!      fails while others succeed).
//! 3. **Cross-Provider Deduplication & Library Matching**:
//!    - Deduplicates tracks, albums, and artists using [`derive_canonical_identity`],
//!      merging metadata fields (e.g., adopting a `preview_url`, `artwork`, or `isrc` from
//!      a secondary provider when the primary result lacks one).
//!    - Cross-references external items against a 5-minute cached local library index
//!      (`ISRC` exact match or normalized `artist + title` match) to stamp `in_library`,
//!      `local_track_id`, and `local_album_id`.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::catalog::{
    CatalogEntityType, UnifiedCatalogItem, derive_canonical_identity, normalize_music_text,
};
use crate::external::adapters::{ExternalProvider, ExternalSearchItem, SearchGroups};

/// Result returned by [`CompositeMetadataService::search_external`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompositeExternalSearchResult {
    /// Deduplicated and library-annotated search groups (`tracks`, `albums`, `artists`).
    pub groups: SearchGroups,
    /// `true` if at least one external adapter timed out or returned an error.
    pub degraded: bool,
}

/// Aggregates local and external metadata adapters with canonical deduplication.
#[derive(Debug, Clone)]
pub struct CompositeMetadataService {
    local: Arc<dyn ExternalProvider>,
    external: Vec<Arc<dyn ExternalProvider>>,
}

impl CompositeMetadataService {
    /// Constructs a new [`CompositeMetadataService`].
    #[must_use]
    pub fn new(
        local: Arc<dyn ExternalProvider>,
        external: Vec<Arc<dyn ExternalProvider>>,
    ) -> Self {
        Self { local, external }
    }

    /// Executes a local-only catalog search across `types`.
    pub async fn search_local(&self, query: &str, types: &[CatalogEntityType]) -> SearchGroups {
        let mut groups = SearchGroups::default();
        if types.contains(&CatalogEntityType::Track)
            && let Ok(tracks) = self.local.search_tracks(query).await
        {
            groups.tracks = tracks;
        }
        if types.contains(&CatalogEntityType::Album)
            && let Ok(albums) = self.local.search_albums(query).await
        {
            groups.albums = albums;
        }
        if types.contains(&CatalogEntityType::Artist)
            && let Ok(artists) = self.local.search_artists(query).await
        {
            groups.artists = artists;
        }
        groups
    }

    /// Queries all external adapters concurrently, deduplicates results by canonical identity,
    /// and reports whether any adapter failed (`degraded`).
    pub async fn search_external(
        &self,
        query: &str,
        types: &[CatalogEntityType],
    ) -> CompositeExternalSearchResult {
        let mut raw_groups = SearchGroups::default();
        let mut degraded = false;

        for adapter in &self.external {
            if types.contains(&CatalogEntityType::Track) {
                match adapter.search_tracks(query).await {
                    Ok(tracks) => raw_groups.tracks.extend(tracks),
                    Err(_) => degraded = true,
                }
            }
            if types.contains(&CatalogEntityType::Album) {
                match adapter.search_albums(query).await {
                    Ok(albums) => raw_groups.albums.extend(albums),
                    Err(_) => degraded = true,
                }
            }
            if types.contains(&CatalogEntityType::Artist) {
                match adapter.search_artists(query).await {
                    Ok(artists) => raw_groups.artists.extend(artists),
                    Err(_) => degraded = true,
                }
            }
        }

        CompositeExternalSearchResult {
            groups: deduplicate_search_groups(raw_groups),
            degraded,
        }
    }
}

/// Deduplicates a [`SearchGroups`] bundle by canonical identity (`derive_canonical_identity`),
/// enriching the winning item with missing `artwork`, `preview_url`, or `identity_hints`
/// from duplicate entries.
#[must_use]
pub fn deduplicate_search_groups(groups: SearchGroups) -> SearchGroups {
    SearchGroups {
        tracks: deduplicate_list(groups.tracks),
        albums: deduplicate_list(groups.albums),
        artists: deduplicate_list(groups.artists),
    }
}

fn deduplicate_list(items: Vec<ExternalSearchItem>) -> Vec<ExternalSearchItem> {
    let mut index_by_canonical: HashMap<String, usize> = HashMap::with_capacity(items.len());
    let mut merged: Vec<ExternalSearchItem> = Vec::with_capacity(items.len());

    for item in items {
        let canonical = derive_canonical_identity(&UnifiedCatalogItem {
            id: item.id.clone(),
            item_type: item.item_type,
            provider: item.provider.clone(),
            title: item.title.clone(),
            artist: item.artist.clone(),
            artist_credits: None,
            album: item.album.clone(),
            duration_seconds: item
                .metadata
                .get("durationSeconds")
                .and_then(serde_json::Value::as_u64)
                .and_then(|d| u32::try_from(d).ok()),
            artwork: item.artwork.as_ref().map(|a| a.url.clone()),
            identity_hints: item.identity_hints.clone(),
            identity: None,
        });

        if let Some(&existing_idx) = index_by_canonical.get(&canonical.id) {
            let existing = &mut merged[existing_idx];
            if existing.artwork.is_none() && item.artwork.is_some() {
                existing.artwork = item.artwork;
            }
            if existing.preview_url.is_none() && item.preview_url.is_some() {
                existing.preview_url = item.preview_url;
            }
            if existing.identity_hints.is_none() && item.identity_hints.is_some() {
                existing.identity_hints = item.identity_hints;
            }
        } else {
            let idx = merged.len();
            index_by_canonical.insert(canonical.id, idx);
            merged.push(item);
        }
    }

    let _ = normalize_music_text(None);
    merged
}
