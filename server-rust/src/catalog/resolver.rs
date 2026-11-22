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
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use http::header::{CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, LAST_MODIFIED};
use http::{HeaderMap, HeaderValue, StatusCode};

use crate::streaming::http::{parse_byte_range, parse_content_range};
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
    pub(crate) database_unavailable: bool,
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
            database_unavailable: false,
        }
    }

    pub(crate) fn database_unavailable() -> Self {
        Self {
            database_unavailable: true,
            ..Self::new("Playback database temporarily unavailable")
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

pub(crate) use crate::providers::MEDIA_HEADER_BUDGET as STREAM_HEADER_BUDGET;
const PLAYBACK_PIN_IDLE_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const MAX_PLAYBACK_PINS: usize = 16_384;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct PlaybackStreamKey<'a> {
    pub scope: &'a str,
    pub session: Option<&'a str>,
    pub track: &'a str,
    pub preferred_source: Option<&'a str>,
    pub max_bit_rate: Option<u32>,
}

type OwnedPlaybackKey = (String, Option<String>, String, Option<String>, Option<u32>);

impl PlaybackStreamKey<'_> {
    fn owned(&self) -> OwnedPlaybackKey {
        (
            self.scope.to_owned(),
            self.session.map(str::to_owned),
            self.track.to_owned(),
            self.preferred_source.map(str::to_owned),
            self.max_bit_rate,
        )
    }
}

#[derive(Debug, Default)]
pub(crate) struct PlaybackPins(Mutex<HashMap<OwnedPlaybackKey, (Instant, Arc<PlaybackPin>)>>);

#[derive(Debug, Default)]
struct PlaybackPin {
    init: tokio::sync::Mutex<()>,
    representation: OnceLock<StreamRepresentation>,
}

#[derive(Debug)]
struct StreamRepresentation {
    source: SourceRef,
    provider: RegisteredProvider,
    layout: Mutex<StreamLayout>,
}

#[derive(Debug)]
struct StreamLayout {
    direct: bool,
    bitrate: Option<u32>,
    content_type: Option<String>,
    codecs: Option<String>,
    content_encoding: Option<HeaderValue>,
    etag: Option<HeaderValue>,
    last_modified: Option<HeaderValue>,
    total_length: Option<u64>,
}

impl StreamLayout {
    fn new(response: &StreamResult, info: &AudioStreamInfo) -> Self {
        let headers = &response.headers;
        Self {
            direct: info.direct,
            bitrate: info.requested_bitrate_kbps,
            content_type: media_type(headers).map(str::to_ascii_lowercase),
            codecs: media_codecs(headers),
            content_encoding: headers
                .get(CONTENT_ENCODING)
                .filter(|encoding| !encoding.as_bytes().eq_ignore_ascii_case(b"identity"))
                .cloned(),
            etag: headers
                .get(ETAG)
                .filter(|tag| tag.as_bytes().starts_with(b"\""))
                .cloned(),
            last_modified: headers.get(LAST_MODIFIED).cloned(),
            total_length: if response.status == StatusCode::PARTIAL_CONTENT {
                headers
                    .get(CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_content_range)
                    .map(|range| range.total_size)
            } else {
                content_length(headers)
            },
        }
    }

    fn accept(&mut self, response: Self, conditional_full: bool) -> bool {
        if self.direct != response.direct
            || self.bitrate != response.bitrate
            || self.content_encoding != response.content_encoding
            || !compatible(&self.content_type, &response.content_type)
            || !compatible(&self.codecs, &response.codecs)
        {
            return false;
        }
        let validators_match = match (&self.etag, &response.etag) {
            (Some(old), Some(new)) => old == new,
            _ => compatible(&self.last_modified, &response.last_modified),
        };
        if !validators_match || !compatible(&self.total_length, &response.total_length) {
            // If-Range can return a complete replacement. Keep the original
            // layout pinned so a later byte-range retry cannot join the two.
            return conditional_full;
        }
        self.content_type = self.content_type.take().or(response.content_type);
        self.codecs = self.codecs.take().or(response.codecs);
        self.etag = self.etag.take().or(response.etag);
        self.last_modified = self.last_modified.take().or(response.last_modified);
        self.total_length = self.total_length.or(response.total_length);
        true
    }
}

fn compatible<T: PartialEq>(first: &Option<T>, second: &Option<T>) -> bool {
    first
        .as_ref()
        .zip(second.as_ref())
        .is_none_or(|(old, new)| old == new)
}

impl PlaybackPins {
    fn get(&self, key: &PlaybackStreamKey<'_>) -> Option<Arc<PlaybackPin>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&key.owned())
            .map(|(_, pin)| Arc::clone(pin))
    }

    fn entry(
        &self,
        key: &PlaybackStreamKey<'_>,
    ) -> Result<Arc<PlaybackPin>, SourceUnavailableError> {
        let key = key.owned();
        let now = Instant::now();
        let mut entries = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((touched, entry)) = entries.get_mut(&key) {
            *touched = now;
            return Ok(Arc::clone(entry));
        }
        if entries.len() >= MAX_PLAYBACK_PINS {
            entries.retain(|_, (touched, entry)| {
                now.duration_since(*touched) < PLAYBACK_PIN_IDLE_TTL || Arc::strong_count(entry) > 1
            });
        }
        if entries.len() >= MAX_PLAYBACK_PINS {
            return Err(SourceUnavailableError::new(
                "Too many active playback streams",
            ));
        }
        let entry = Arc::new(PlaybackPin::default());
        entries.insert(key, (now, Arc::clone(&entry)));
        Ok(entry)
    }
}

fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers.get(CONTENT_LENGTH)?.to_str().ok()?.parse().ok()
}

fn media_type(headers: &HeaderMap) -> Option<&str> {
    Some(
        headers
            .get(CONTENT_TYPE)?
            .to_str()
            .ok()?
            .split(';')
            .next()?
            .trim(),
    )
}

fn media_codecs(headers: &HeaderMap) -> Option<String> {
    let media_type = headers.get(CONTENT_TYPE)?.to_str().ok()?;
    media_type.split(';').skip(1).find_map(|param| {
        let (name, value) = param.split_once('=')?;
        name.trim().eq_ignore_ascii_case("codecs").then(|| {
            value
                .trim()
                .trim_matches('"')
                .split(',')
                .map(str::trim)
                .collect::<Vec<_>>()
                .join(",")
        })
    })
}

fn partial_validator_matches(headers: &HeaderMap, if_range: Option<&str>) -> bool {
    let Some(validator) = if_range else {
        return true;
    };
    let field = if validator.starts_with('"') || validator.starts_with("W/\"") {
        ETAG
    } else {
        LAST_MODIFIED
    };
    headers
        .get(field)
        .is_none_or(|actual| actual.as_bytes() == validator.as_bytes())
}

pub(crate) fn valid_partial_response(headers: &HeaderMap, request: Option<&str>) -> bool {
    let Some(actual) = headers
        .get(CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_content_range)
    else {
        return false;
    };
    headers.get_all(CONTENT_RANGE).iter().count() == 1
        && headers.get_all(CONTENT_LENGTH).iter().count() <= 1
        && request.and_then(|range| parse_byte_range(range, actual.total_size).ok()) == Some(actual)
        && (!headers.contains_key(CONTENT_LENGTH)
            || content_length(headers) == Some(actual.length()))
        && !media_type(headers)
            .is_some_and(|mime| mime.eq_ignore_ascii_case("multipart/byteranges"))
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
        self.try_candidate_sources(library_item_id, preferred_connection_id)
            .await
            .unwrap_or_default()
    }

    pub(crate) async fn try_candidate_sources(
        &self,
        library_item_id: &str,
        preferred_connection_id: Option<&str>,
    ) -> Result<Vec<CandidateSource>, SourceUnavailableError> {
        let sources = match tokio::time::timeout(
            Duration::from_secs(2),
            self.library.get_sources(library_item_id),
        )
        .await
        {
            Ok(Ok(sources)) => sources,
            Ok(Err(error)) => {
                tracing::warn!(%error, "Could not read media source mappings");
                return Err(SourceUnavailableError::database_unavailable());
            }
            Err(_) => {
                tracing::warn!("Media source mapping lookup timed out");
                return Err(SourceUnavailableError::database_unavailable());
            }
        };
        Ok(self.candidates_for_sources(sources, preferred_connection_id))
    }

    pub(crate) fn candidates_for_sources(
        &self,
        sources: impl IntoIterator<Item = SourceRef>,
        preferred_connection_id: Option<&str>,
    ) -> Vec<CandidateSource> {
        let mut candidates: Vec<CandidateSource> = sources
            .into_iter()
            .filter_map(|source| self.candidate_for_source(source))
            .collect();
        if candidates.len() <= 1 {
            return candidates;
        }
        let registered = self.registry.list();
        let order_map: HashMap<String, usize> = registered
            .iter()
            .enumerate()
            .map(|(idx, entry)| (entry.connection_id.clone(), idx))
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
        !self
            .candidate_sources(library_item_id, None)
            .await
            .is_empty()
    }

    /// Opens an audio stream for `library_item_id`, trying candidate sources in order
    /// until one returns `200 OK` or `206 Partial Content`.
    pub async fn fetch_stream(
        &self,
        library_item_id: &str,
        range: Option<&str>,
        if_range: Option<&str>,
        preferred_connection_id: Option<&str>,
        max_bit_rate: Option<u32>,
    ) -> Result<StreamResult, SourceUnavailableError> {
        let key = PlaybackStreamKey {
            scope: "",
            session: None,
            track: library_item_id,
            preferred_source: preferred_connection_id,
            max_bit_rate,
        };
        self.fetch_pinned_stream(&key, range, if_range).await
    }

    pub(crate) async fn fetch_pinned_stream(
        &self,
        key: &PlaybackStreamKey<'_>,
        range: Option<&str>,
        if_range: Option<&str>,
    ) -> Result<StreamResult, SourceUnavailableError> {
        self.fetch_pinned_stream_until(
            key,
            range,
            if_range,
            tokio::time::Instant::now() + STREAM_HEADER_BUDGET,
        )
        .await
    }

    pub(crate) async fn fetch_pinned_stream_until(
        &self,
        key: &PlaybackStreamKey<'_>,
        range: Option<&str>,
        if_range: Option<&str>,
        deadline: tokio::time::Instant,
    ) -> Result<StreamResult, SourceUnavailableError> {
        self.fetch_recoverable_stream(key, range, if_range, deadline, None)
            .await
    }

    pub(crate) async fn fetch_recoverable_stream(
        &self,
        key: &PlaybackStreamKey<'_>,
        range: Option<&str>,
        if_range: Option<&str>,
        deadline: tokio::time::Instant,
        previous_session: Option<&str>,
    ) -> Result<StreamResult, SourceUnavailableError> {
        let pin = self.registry.playback_pins.entry(key)?;
        let result = tokio::time::timeout_at(deadline, async {
            // Serialize initial selection only. Subsequent seeks can open concurrently.
            if pin.representation.get().is_none() {
                let _initializing = pin.init.lock().await;
                if pin.representation.get().is_none() {
                    if previous_session.is_some()
                        && range.is_some_and(|raw| {
                            let explicit = raw
                                .split_once('=')
                                .is_some_and(|(_, spec)| !spec.trim_start().starts_with('-'));
                            !explicit
                                || !parse_byte_range(raw, u64::MAX)
                                    .is_ok_and(|range| range.start == 0)
                        })
                    {
                        return Err(SourceUnavailableError::new(
                            "A replacement stream must load from the beginning before seeking",
                        ));
                    }
                    let previous_pin = previous_session.and_then(|session| {
                        self.registry.playback_pins.get(&PlaybackStreamKey {
                            session: Some(session),
                            ..*key
                        })
                    });
                    let previous_source = previous_pin
                        .as_ref()
                        .and_then(|pin| pin.representation.get())
                        .map(|representation| &representation.source);
                    let (result, representation) = self
                        .open_stream(
                            key,
                            range,
                            if_range.filter(|_| previous_session.is_none()),
                            None,
                            previous_source,
                        )
                        .await?;
                    if let Some(representation) = representation {
                        let _ = pin.representation.set(representation);
                    }
                    return Ok(result);
                }
            }
            self.open_stream(key, range, if_range, pin.representation.get(), None)
                .await
                .map(|(result, _)| result)
        })
        .await;
        result.unwrap_or_else(|_| {
            tracing::warn!(
                track_id = key.track,
                "Media stream header deadline exceeded"
            );
            Err(SourceUnavailableError::default())
        })
    }

    async fn open_stream(
        &self,
        key: &PlaybackStreamKey<'_>,
        range: Option<&str>,
        if_range: Option<&str>,
        pin: Option<&StreamRepresentation>,
        previous_source: Option<&SourceRef>,
    ) -> Result<(StreamResult, Option<StreamRepresentation>), SourceUnavailableError> {
        let mut candidates = self
            .try_candidate_sources(key.track, key.preferred_source)
            .await?;
        if let Some(previous_source) = previous_source {
            candidates.sort_by_key(|candidate| &candidate.source == previous_source);
        }
        let mut unsatisfied_range = None;
        for candidate in candidates {
            let CandidateSource { source, provider } = &candidate;
            if pin.is_some_and(|pin| {
                pin.source != *source || !Arc::ptr_eq(&pin.provider.provider, &provider.provider)
            }) {
                continue;
            }
            let mut result = match provider
                .provider
                .fetch_stream(&source.provider_item_id, range, if_range, key.max_bit_rate)
                .await
            {
                Ok(result) => result,
                Err(error) => {
                    tracing::warn!(connection_id = %source.connection_id, range_requested = range.is_some(), %error, "Could not open library audio stream");
                    continue;
                }
            };
            if matches!(result.status, StatusCode::OK | StatusCode::PARTIAL_CONTENT) {
                let content_type = media_type(&result.headers)
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if content_type.starts_with("text/")
                    || matches!(
                        content_type.as_str(),
                        "application/json" | "application/xml"
                    )
                    || content_type.ends_with("+json")
                    || content_type.ends_with("+xml")
                {
                    tracing::debug!(connection_id = %source.connection_id, %content_type, "Provider returned a document instead of an audio stream");
                    continue;
                }
                if result.status == StatusCode::PARTIAL_CONTENT
                    && (!valid_partial_response(&result.headers, range)
                        || !partial_validator_matches(&result.headers, if_range))
                {
                    tracing::warn!(connection_id = %source.connection_id, "Provider returned an invalid partial audio response");
                    continue;
                }
                if result.status == StatusCode::OK && result.headers.contains_key(CONTENT_RANGE) {
                    continue;
                }
                let mut stream_info = result.audio_stream.take().unwrap_or(AudioStreamInfo {
                    direct: key.max_bit_rate.is_none(),
                    requested_bitrate_kbps: key.max_bit_rate,
                    source_connection_id: None,
                    source_item_id: None,
                });
                let layout = StreamLayout::new(&result, &stream_info);
                let representation = if let Some(pin) = pin {
                    let conditional_full =
                        result.status == StatusCode::OK && range.is_some() && if_range.is_some();
                    if !pin
                        .layout
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .accept(layout, conditional_full)
                    {
                        tracing::warn!(connection_id = %source.connection_id, "Provider changed the pinned audio representation");
                        continue;
                    }
                    None
                } else {
                    Some(StreamRepresentation {
                        source: source.clone(),
                        provider: provider.clone(),
                        layout: Mutex::new(layout),
                    })
                };
                stream_info.source_connection_id = Some(source.connection_id.clone());
                stream_info.source_item_id = Some(source.provider_item_id.clone());
                result.audio_stream = Some(stream_info);
                return Ok((result, representation));
            }
            if range.is_some() && result.status == StatusCode::RANGE_NOT_SATISFIABLE {
                unsatisfied_range.get_or_insert(result);
                continue;
            }
            tracing::warn!(connection_id = %source.connection_id, status = %result.status, "Library audio provider rejected the stream request");
        }

        unsatisfied_range
            .map(|result| (result, None))
            .ok_or_else(SourceUnavailableError::default)
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
            database_unavailable: false,
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

    /// Reads metadata for the exact provider item that served the representation.
    pub(crate) async fn stream_source_metadata(
        registry: &BackendRegistry,
        pipe: &AudioStreamInfo,
    ) -> Result<Option<AudioMetadataSummary>, SourceUnavailableError> {
        let connection = pipe
            .source_connection_id
            .as_deref()
            .ok_or_else(SourceUnavailableError::default)?;
        let item = pipe
            .source_item_id
            .as_deref()
            .ok_or_else(SourceUnavailableError::default)?;
        let provider = registry
            .get_by_connection_id(connection)
            .filter(|provider| provider.enabled)
            .ok_or_else(SourceUnavailableError::default)?;
        provider
            .provider
            .get_track(item)
            .await
            .map(|track| track.and_then(|track| track.audio_metadata))
            .map_err(|_| SourceUnavailableError::default())
    }

    /// Submits a playback scrobble to the first mapped scrobble-capable provider (Navidrome),
    /// translating the MusicDeck `library_item_id` into its native `provider_item_id`.
    pub async fn scrobble_track(
        &self,
        library_item_id: &str,
        played_at_ms: Option<i64>,
    ) -> Result<bool, SourceUnavailableError> {
        let candidates = self.candidate_sources(library_item_id, None).await;
        let Some(candidate) = candidates.into_iter().find(|c| {
            c.provider.provider_type == "navidrome" && c.provider.provider.supports_scrobble()
        }) else {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{DbPool, run_migrations};
    use crate::providers::media_fixture;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn partial_responses_require_matching_bounds_and_length() {
        let mut headers = HeaderMap::new();
        headers.insert(
            CONTENT_RANGE,
            HeaderValue::from_static("bytes 900-999/1000"),
        );
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("100"));
        for matching in [
            "bytes=900-999",
            "bytes=900-",
            "bytes=-100",
            "bytes=900-2000",
        ] {
            assert!(
                valid_partial_response(&headers, Some(matching)),
                "{matching}"
            );
        }
        for mismatched in [
            None,
            Some("bytes=0-99"),
            Some("bytes=900-950"),
            Some("bytes=-50"),
            Some("bytes=900-,1-2"),
        ] {
            assert!(
                !valid_partial_response(&headers, mismatched),
                "{mismatched:?}"
            );
        }
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("101"));
        assert!(!valid_partial_response(&headers, Some("bytes=900-")));
        headers.remove(CONTENT_LENGTH);
        assert!(valid_partial_response(&headers, Some("bytes=900-")));
        headers.append(
            CONTENT_RANGE,
            HeaderValue::from_static("bytes 900-999/1000"),
        );
        assert!(!valid_partial_response(&headers, Some("bytes=900-")));
    }

    #[tokio::test]
    async fn playback_session_pins_fallback_source_for_every_seek() {
        let available_primary = Arc::new(AtomicBool::new(false));
        let available_fallback = Arc::new(AtomicBool::new(true));
        let changed_encoding = Arc::new(AtomicBool::new(false));
        let providers = [
            ("primary", available_primary.clone()),
            ("fallback", available_fallback.clone()),
        ]
        .map(|(connection, available)| {
            let changed_encoding = changed_encoding.clone();
            media_fixture::provider(connection, move |_, range, if_range, bitrate| {
                assert_eq!(bitrate, Some(192));
                let content_type = if changed_encoding.load(Ordering::Relaxed) {
                    "audio/flac"
                } else {
                    "audio/mpeg"
                };
                let response = if !available.load(Ordering::Relaxed) {
                    media_fixture::response(StatusCode::NOT_FOUND, [], "")
                } else if range.is_some() && if_range.is_none() {
                    media_fixture::response(
                        StatusCode::PARTIAL_CONTENT,
                        [
                            (CONTENT_TYPE, content_type),
                            (CONTENT_RANGE, "bytes 2-3/4"),
                            (CONTENT_LENGTH, "2"),
                        ],
                        "cd",
                    )
                } else {
                    media_fixture::response(
                        StatusCode::OK,
                        [(CONTENT_TYPE, content_type), (CONTENT_LENGTH, "4")],
                        "abcd",
                    )
                };
                (Duration::ZERO, response)
            })
        });
        let db = DbPool::connect_memory().await.unwrap();
        run_migrations(&db, None).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO library_items (id,type,created_at,updated_at) VALUES ('md_track','track','2026','2026');
             INSERT INTO library_item_sources (library_item_id,connection_id,provider_item_id,item_type,created_at)
             VALUES ('md_track','primary','a','track','2026'),('md_track','fallback','b','track','2026');"
        ).execute(db.inner()).await.unwrap();
        let resolver = SourceResolver::new(
            BackendRegistry::new(Vec::from(providers)),
            LibraryService::new(db, None),
        );
        let key = PlaybackStreamKey {
            scope: "listener",
            session: Some("one"),
            track: "md_track",
            preferred_source: None,
            max_bit_rate: Some(192),
        };

        let response = resolver
            .fetch_pinned_stream(&key, None, None)
            .await
            .unwrap();
        assert_eq!(
            response
                .audio_stream
                .unwrap()
                .source_connection_id
                .as_deref(),
            Some("fallback")
        );
        available_primary.store(true, Ordering::Relaxed);
        let response = resolver
            .fetch_pinned_stream(&key, Some("bytes=2-"), None)
            .await
            .unwrap();
        assert_eq!(response.status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.audio_stream.unwrap().source_item_id.as_deref(),
            Some("b")
        );
        let full = resolver
            .fetch_pinned_stream(&key, Some("bytes=2-"), Some("\"old\""))
            .await
            .unwrap();
        assert_eq!(full.status, StatusCode::OK);

        changed_encoding.store(true, Ordering::Relaxed);
        assert!(
            resolver
                .fetch_pinned_stream(&key, Some("bytes=2-"), None)
                .await
                .is_err()
        );
        changed_encoding.store(false, Ordering::Relaxed);

        available_fallback.store(false, Ordering::Relaxed);
        assert!(
            resolver
                .fetch_pinned_stream(&key, Some("bytes=2-"), None)
                .await
                .is_err()
        );
        let new_playback = PlaybackStreamKey {
            session: Some("two"),
            ..key
        };
        let response = resolver
            .fetch_pinned_stream(&new_playback, Some("bytes=2-"), None)
            .await
            .unwrap();
        assert_eq!(
            response
                .audio_stream
                .unwrap()
                .source_connection_id
                .as_deref(),
            Some("primary")
        );
    }

    #[tokio::test]
    async fn provider_streaming_shares_one_header_deadline_across_candidates() {
        use std::sync::atomic::AtomicUsize;
        let attempts = Arc::new(AtomicUsize::new(0));
        let first = media_fixture::provider("first", |_, _, _, _| (
            Duration::from_millis(90), media_fixture::response(StatusCode::SERVICE_UNAVAILABLE, [], ""),
        ));
        let observed = attempts.clone();
        let second = media_fixture::provider("second", move |_, _, _, _| {
            observed.fetch_add(1, Ordering::Relaxed);
            (Duration::from_millis(600), media_fixture::response(StatusCode::OK, [(CONTENT_TYPE, "audio/flac")], "raw"))
        });
        let db = DbPool::connect_memory().await.unwrap();
        run_migrations(&db, None).await.unwrap();
        let library = LibraryService::new(db, None);
        let track = library.ensure_id(crate::catalog::LibraryItemType::Track, &SourceRef {
            connection_id: "first".into(), provider_item_id: "one".into(),
        }, None).await.unwrap();
        library.add_source(&track, &SourceRef {
            connection_id: "second".into(), provider_item_id: "two".into(),
        }).await.unwrap();
        let resolver = SourceResolver::new(BackendRegistry::new(vec![first, second]), library);
        let key = PlaybackStreamKey { scope: "test", session: Some("media"), track: &track,
            preferred_source: None, max_bit_rate: None };
        let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
        assert!(resolver.fetch_recoverable_stream(&key, None, None, deadline, None).await.is_err());
        assert_eq!(attempts.load(Ordering::Relaxed), 1);
    }
}
