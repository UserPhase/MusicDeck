//! # Playable Sources Contract & Quality Comparator (`registry::playable_sources`)
//!
//! Ports `server/src/domain/playable-sources.ts` and `compareSourceQuality` from
//! `server/src/domain/source-discovery.ts`:
//! - [`PlayableSource`] with opaque short-lived MusicDeck token (`playable_<nanoid>`)
//! - [`SourcePreference`] (`library | external | manual | best | lossless | highest-bitrate | preferred`)
//! - [`SourceProvider`] trait for library, preview, and external stream providers
//! - [`compare_source_quality`] deterministic ordering (`non-preview > preview`,
//!   `lossless`, `bitrate`, `bit_depth`, `sample_rate`, `file_size`, `label`)

use std::cmp::Ordering;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::providers::UpstreamStreamResponse;
use crate::search::UnifiedSearchResult;

/// Playable audio source tier (`library | external | preview`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayableSourceType {
    Library,
    External,
    Preview,
}

/// Runtime availability of a [`PlayableSource`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayableSourceAvailability {
    Unknown,
    Resolving,
    Available,
    Unavailable,
    Failed,
    Expired,
}

/// Capabilities declared by a [`SourceProvider`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProviderCapabilities {
    pub tracks: bool,
    pub albums: bool,
    pub quality: bool,
    pub multiple_sources: bool,
    pub caching: bool,
}

impl Default for SourceProviderCapabilities {
    fn default() -> Self {
        Self {
            tracks: true,
            albums: false,
            quality: false,
            multiple_sources: false,
            caching: true,
        }
    }
}

/// Technical quality metrics attached to a [`PlayableSource`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayableSourceQuality {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bit_depth: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lossless: Option<bool>,
}

/// Provider-neutral playable audio source returned to the client.
///
/// Raw upstream URLs and provider connection IDs are never exposed to the client;
/// `id` is replaced with an opaque 5-minute `playable_<nanoid>` token by [`crate::registry::SourceProviderRegistry`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayableSource {
    /// Opaque, short-lived MusicDeck source token (`playable_<nanoid>`).
    pub id: String,
    /// `"library" | "external" | "plugin"`.
    pub provider: String,
    #[serde(rename = "type")]
    pub source_type: PlayableSourceType,
    pub media_type: String,
    pub label: String,
    pub availability: PlayableSourceAvailability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<PlayableSourceQuality>,
}

/// Automatic source selection preference configured per user or per request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SourcePreference {
    Library,
    External,
    #[default]
    Manual,
    Best,
    Lossless,
    HighestBitrate,
    Preferred,
}

impl SourcePreference {
    /// Parses a stored user setting or query string into a [`SourcePreference`].
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "library-first" | "library" => Self::Library,
            "external-first" | "external" => Self::External,
            "best" => Self::Best,
            "lossless" => Self::Lossless,
            "highest-bitrate" => Self::HighestBitrate,
            "preferred" => Self::Preferred,
            _ => Self::Manual,
        }
    }
}

/// Options governing [`crate::registry::SourceProviderRegistry::resolve`].
#[derive(Debug, Clone, Default)]
pub struct SourceResolutionOptions {
    pub limit: Option<usize>,
    pub allow_external: bool,
    pub preference: Option<SourcePreference>,
    /// Friendly source label or provider ID to prefer when `preference == Some(SourcePreference::Preferred)`.
    pub preferred_provider: Option<String>,
}

/// Outcome returned by [`crate::registry::SourceProviderRegistry::resolve`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceResolution {
    pub sources: Vec<PlayableSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_source: Option<PlayableSource>,
    pub degraded: bool,
}

/// Diagnostic probe result returned by [`SourceProvider::test`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProviderTestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Trait implemented by library, preview, and external playable source providers.
#[async_trait]
pub trait SourceProvider: Send + Sync {
    /// Unique provider ID (`"library"`, `"deezer-preview"`, `"itunes-preview"`, `"source-pipeline"`).
    fn id(&self) -> &str;

    /// Display name shown in admin settings.
    fn name(&self) -> &str;

    /// Provider capability flags.
    fn capabilities(&self) -> SourceProviderCapabilities {
        SourceProviderCapabilities::default()
    }

    /// Fast preflight check indicating whether this provider can resolve `result`.
    async fn can_resolve(&self, result: &UnifiedSearchResult) -> bool {
        result.item_type == crate::search::SearchResultType::Track
    }

    /// Resolves playable sources for `result`.
    async fn get_sources(
        &self,
        result: &UnifiedSearchResult,
        options: &SourceResolutionOptions,
    ) -> Result<Vec<PlayableSource>, String>;

    /// Optional connectivity diagnostic probe.
    async fn test(&self) -> Result<SourceProviderTestResult, String> {
        Ok(SourceProviderTestResult {
            ok: true,
            message: Some(String::from("Provider is configured")),
        })
    }

    /// Fetches the audio byte stream for `source` (with `source.id` restored to the provider-internal ID/URL).
    async fn fetch_stream(
        &self,
        _source: &PlayableSource,
        _range: Option<&str>,
    ) -> Result<UpstreamStreamResponse, String> {
        Err(String::from("Playable source is unavailable"))
    }
}

/// Deterministic quality comparator for sorting [`PlayableSource`] items from highest to lowest quality:
/// 1. Full recordings (`Library`, `External`) strictly precede 30-second `Preview` sources.
/// 2. `lossless == true` precedes lossy or unknown codecs.
/// 3. Higher `bitrate` -> `bit_depth` -> `sample_rate` -> `file_size`.
/// 4. Lexicographical `label` tie-breaker for stability.
#[must_use]
pub fn compare_source_quality(left: &PlayableSource, right: &PlayableSource) -> Ordering {
    if left.source_type != right.source_type {
        if left.source_type == PlayableSourceType::Preview
            && right.source_type != PlayableSourceType::Preview
        {
            return Ordering::Greater;
        }
        if right.source_type == PlayableSourceType::Preview
            && left.source_type != PlayableSourceType::Preview
        {
            return Ordering::Less;
        }
    }

    let l_qual = left.quality.as_ref();
    let r_qual = right.quality.as_ref();

    let l_lossless = u8::from(l_qual.and_then(|q| q.lossless).unwrap_or(false));
    let r_lossless = u8::from(r_qual.and_then(|q| q.lossless).unwrap_or(false));
    if l_lossless != r_lossless {
        return r_lossless.cmp(&l_lossless);
    }

    let l_bitrate = l_qual.and_then(|q| q.bitrate).unwrap_or(0);
    let r_bitrate = r_qual.and_then(|q| q.bitrate).unwrap_or(0);
    if l_bitrate != r_bitrate {
        return r_bitrate.cmp(&l_bitrate);
    }

    let l_depth = l_qual.and_then(|q| q.bit_depth).unwrap_or(0);
    let r_depth = r_qual.and_then(|q| q.bit_depth).unwrap_or(0);
    if l_depth != r_depth {
        return r_depth.cmp(&l_depth);
    }

    let l_rate = l_qual.and_then(|q| q.sample_rate).unwrap_or(0);
    let r_rate = r_qual.and_then(|q| q.sample_rate).unwrap_or(0);
    if l_rate != r_rate {
        return r_rate.cmp(&l_rate);
    }

    let l_size = l_qual.and_then(|q| q.file_size).unwrap_or(0);
    let r_size = r_qual.and_then(|q| q.file_size).unwrap_or(0);
    if l_size != r_size {
        return r_size.cmp(&l_size);
    }

    left.label.cmp(&right.label)
}
