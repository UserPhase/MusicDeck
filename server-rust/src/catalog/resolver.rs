//! # Multi-Source Stream & Artwork Fallback Resolver (`catalog::resolver`)
//!
//! Complete Rust port of `server/src/domain/source-resolver.ts`.
//!
//! ## Resolution Algorithm
//! 1. Maps a stable MusicDeck `library_item_id` (`md_...` or `mdart_...`) to its candidate
//!    [`SourceRef`] entries in `library_item_sources`.
//! 2. Filters out disabled/unregistered connections and sorts candidates deterministically
//!    by their order in [`BackendRegistry`].
//! 3. If `preferred_connection_id` is supplied, promotes that source to the front of the
//!    candidate list while keeping all remaining sources as automatic fallbacks.
//! 4. Attempts each candidate in order until one returns `HTTP 200 OK` or `206 Partial Content`.
//!    Failed sources never surface as an `HTTP 500` while another mapped source can satisfy
//!    the request; if all sources fail, returns [`SourceUnavailableError`].

use std::collections::HashMap;

use http::StatusCode;
use thiserror::Error;

use crate::catalog::library::{LibraryService, SourceRef};
use crate::providers::{
    AudioMetadataSummary, AudioStreamInfo, BackendRegistry, RegisteredProvider, StreamResult,
};

/// Error returned when no mapped, enabled backend source can satisfy a media stream
/// or artwork request (`SourceUnavailableError` in `source-resolver.ts`).
#[derive(Debug, Clone, Error)]
#[error("{message}")]
pub struct SourceUnavailableError {
    /// Safe client-facing message without provider internals.
    pub message: String,
    /// True when every attempted artwork source explicitly returned `404 Not Found`.
    pub all_not_found: bool,
}

impl Default for SourceUnavailableError {
    fn default() -> Self {
        Self::new("No playable source is available for this item")
    }
}

impl SourceUnavailableError {
    /// Creates a [`SourceUnavailableError`] with a custom message.
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            all_not_found: false,
        }
    }
}

/// Candidate source paired with its live [`RegisteredProvider`].
#[derive(Debug, Clone)]
pub struct CandidateSource {
    /// Mapped `(connection_id, provider_item_id)`.
    pub source: SourceRef,
    /// Live registered provider connection.
    pub provider: RegisteredProvider,
}

/// Resolves stable MusicDeck library IDs into playable streams, artwork, and scrobble targets
/// with ordered multi-provider fallback.
#[derive(Debug, Clone)]
pub struct SourceResolver {
    registry: BackendRegistry,
    library: LibraryService,
}

impl SourceResolver {
    /// Constructs a new [`SourceResolver`].
    #[must_use]
    pub const fn new(registry: BackendRegistry, library: LibraryService) -> Self {
        Self { registry, library }
    }

    /// Returns a reference to the underlying [`LibraryService`].
    #[must_use]
    pub const fn library(&self) -> &LibraryService {
        &self.library
    }

    /// Resolves candidate sources for `library_item_id` ordered by [`BackendRegistry`] priority,
    /// optionally promoting `preferred_connection_id` to the first slot.
    pub async fn candidate_sources(
        &self,
        library_item_id: &str,
        preferred_connection_id: Option<&str>,
    ) -> Vec<CandidateSource> {
        let Ok(sources) = self.library.get_sources(library_item_id).await else {
            return Vec::new();
        };
        if sources.is_empty() {
            return Vec::new();
        }

        let registered = self.registry.list();
        let order_map: HashMap<String, usize> = registered
            .iter()
            .enumerate()
            .map(|(idx, entry)| (entry.connection_id.clone(), idx))
            .collect();

        let mut candidates: Vec<CandidateSource> = sources
            .into_iter()
            .filter_map(|source| self.candidate_for_source(source))
            .collect();

        candidates.sort_by_key(|c| {
            let preferred_rank = match preferred_connection_id {
                Some(pref) if c.source.connection_id == pref => 0usize,
                _ => 1usize,
            };
            let registry_rank = order_map
                .get(&c.source.connection_id)
                .copied()
                .unwrap_or(usize::MAX);
            (preferred_rank, registry_rank)
        });

        candidates
    }

    /// Resolves a provider-native source without requiring a library mapping.
    pub(crate) fn candidate_for_source(&self, source: SourceRef) -> Option<CandidateSource> {
        let provider = self.registry.get_by_connection_id(&source.connection_id)?;
        provider
            .enabled
            .then_some(CandidateSource { source, provider })
    }

    /// Returns `true` if at least one enabled provider source is mapped for `library_item_id`.
    pub async fn has_source(&self, library_item_id: &str) -> bool {
        !self.candidate_sources(library_item_id, None).await.is_empty()
    }

    /// Opens an audio stream for `library_item_id`, trying candidate sources in order
    /// until one returns `200 OK` or `206 Partial Content`.
    pub async fn fetch_stream(
        &self,
        library_item_id: &str,
        range: Option<&str>,
        preferred_connection_id: Option<&str>,
        max_bit_rate: Option<u32>,
    ) -> Result<StreamResult, SourceUnavailableError> {
        let candidates = self
            .candidate_sources(library_item_id, preferred_connection_id)
            .await;
        if candidates.is_empty() {
            return Err(SourceUnavailableError::default());
        }

        for CandidateSource { source, provider } in candidates {
            if let Ok(mut result) = provider
                .provider
                .fetch_stream(&source.provider_item_id, range, max_bit_rate)
                .await
                && matches!(result.status, StatusCode::OK | StatusCode::PARTIAL_CONTENT)
            {
                let mut stream_info = result.audio_stream.unwrap_or(AudioStreamInfo {
                    direct: max_bit_rate.is_none(),
                    requested_bitrate_kbps: max_bit_rate,
                    source_connection_id: None,
                });
                stream_info.source_connection_id = Some(source.connection_id);
                result.audio_stream = Some(stream_info);
                return Ok(result);
            }
        }

        Err(SourceUnavailableError::default())
    }

    /// Fetches cover artwork for `library_item_id` with source fallback.
    ///
    /// If every attempted source returns `404 Not Found`, sets `all_not_found = true` on
    /// [`SourceUnavailableError`] so the artwork route can return `404 Not Found` instead
    /// of `502`/`503`.
    pub async fn fetch_artwork(
        &self,
        library_item_id: &str,
        size: Option<u32>,
    ) -> Result<StreamResult, SourceUnavailableError> {
        let candidates = self.candidate_sources(library_item_id, None).await;
        if candidates.is_empty() {
            return Err(SourceUnavailableError::default());
        }

        let mut attempts = 0usize;
        let mut missing = 0usize;

        for CandidateSource { source, provider } in candidates {
            attempts += 1;
            if let Ok(result) = provider
                .provider
                .fetch_artwork(&source.provider_item_id, size)
                .await
            {
                if result.status == StatusCode::NOT_FOUND {
                    missing += 1;
                    continue;
                }
                if matches!(result.status, StatusCode::OK | StatusCode::PARTIAL_CONTENT) {
                    return Ok(result);
                }
            }
        }

        Err(SourceUnavailableError {
            message: String::from("No playable source is available for this item"),
            all_not_found: attempts > 0 && attempts == missing,
        })
    }

    /// Queries the upstream [`AudioMetadataSummary`] for `library_item_id` (optionally scoped
    /// to `connection_id`) for stream inspection comparisons.
    pub async fn audio_metadata(
        &self,
        library_item_id: &str,
        connection_id: Option<&str>,
    ) -> Result<Option<AudioMetadataSummary>, SourceUnavailableError> {
        let candidates = self.candidate_sources(library_item_id, None).await;
        let selected = if let Some(cid) = connection_id {
            candidates
                .into_iter()
                .find(|c| c.source.connection_id == cid)
        } else {
            candidates.into_iter().next()
        };

        let Some(selected) = selected else {
            return Err(SourceUnavailableError::default());
        };

        let track = selected
            .provider
            .provider
            .get_track(&selected.source.provider_item_id)
            .await
            .map_err(|_| SourceUnavailableError::default())?;

        Ok(track.and_then(|t| t.audio_metadata))
    }

    /// Submits a playback scrobble to the first mapped scrobble-capable provider (Navidrome),
    /// translating the MusicDeck `library_item_id` into its native `provider_item_id`.
    pub async fn scrobble_track(
        &self,
        library_item_id: &str,
        played_at_ms: Option<i64>,
    ) -> Result<bool, SourceUnavailableError> {
        let candidates = self.candidate_sources(library_item_id, None).await;
        let Some(candidate) = candidates
            .into_iter()
            .find(|c| c.provider.provider_type == "navidrome" && c.provider.provider.supports_scrobble())
        else {
            return Ok(false);
        };

        candidate
            .provider
            .provider
            .scrobble(&candidate.source.provider_item_id, played_at_ms)
            .await
            .map_err(|_| SourceUnavailableError::default())?;

        Ok(true)
    }
}
