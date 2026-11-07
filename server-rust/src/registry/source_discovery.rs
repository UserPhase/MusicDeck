//! # Source Candidate Discovery, Scoring & Pipeline Orchestration (`registry::source_discovery`)
//!
//! Ports `server/src/domain/source-discovery.ts`:
//! - [`SourceCandidate`] and multi-stage traits ([`SourceDiscoveryProvider`],
//!   [`SourceDetailProvider`], [`SourceContainerProvider`], [`CandidateResolver`])
//! - SSRF-hardened [`validated_playable_url`] rejecting non-HTTPS and private/loopback hosts
//! - [`is_album_container`], [`score_candidate`], and conservative [`matches_candidate`]
//! - [`SourcePipelineRegistry`] and [`SourcePipelineProvider`] facade

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use url::Url;

use crate::catalog::{CanonicalIdentity, normalize_music_text, version_signature};
use crate::db::DbPool;
use crate::providers::UpstreamStreamResponse;
use crate::registry::playable_sources::{
    PlayableSource, PlayableSourceAvailability, PlayableSourceQuality, PlayableSourceType,
    SourceProvider, SourceProviderCapabilities, SourceResolutionOptions, compare_source_quality,
};
use crate::search::{SearchResultType, UnifiedSearchResult};

/// Classification of a discovered source candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceCandidateKind {
    Track,
    AlbumContainer,
    ReleaseContainer,
    Item,
    File,
    DetailLink,
}

/// Optional acquisition hints carried on a [`SourceCandidate`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionInputs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spotify_track_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spotify_track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_mode: Option<String>,
}

/// Parent container metadata attached to a [`SourceCandidate`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCandidateContainer {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
}

/// Discovered, not-yet-playable source candidate returned by a [`SourceDiscoveryProvider`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCandidate {
    pub id: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<SourceCandidateKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<SourceCandidateContainer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<PlayableSourceQuality>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<CanonicalIdentity>,
}

/// Options passed to [`SourceDiscoveryProvider::search`].
#[derive(Debug, Clone, Default)]
pub struct SourceDiscoveryOptions {
    pub limit: Option<usize>,
    pub spotify_track_url: Option<String>,
    pub spotify_track_id: Option<String>,
}

/// Options passed to detail, container, and resolver stages.
#[derive(Debug, Clone, Default)]
pub struct CandidateResolveOptions {
    pub limit: Option<usize>,
    pub target: Option<UnifiedSearchResult>,
}

/// Stage 1: Discovers raw [`SourceCandidate`] records for a [`UnifiedSearchResult`].
#[async_trait]
pub trait SourceDiscoveryProvider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    async fn search(
        &self,
        result: &UnifiedSearchResult,
        options: &SourceDiscoveryOptions,
    ) -> Result<Vec<SourceCandidate>, String>;
}

/// Stage 2a: Expands a `detail-link` candidate into concrete track/container candidates.
#[async_trait]
pub trait SourceDetailProvider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    async fn can_resolve(&self, _candidate: &SourceCandidate) -> bool {
        true
    }
    async fn resolve_details(
        &self,
        candidate: &SourceCandidate,
        options: &CandidateResolveOptions,
    ) -> Result<Vec<SourceCandidate>, String>;
}

/// Stage 2b: Enumerates files inside an album/release/item container candidate.
#[async_trait]
pub trait SourceContainerProvider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    async fn can_enumerate(&self, _candidate: &SourceCandidate) -> bool {
        true
    }
    async fn enumerate(
        &self,
        candidate: &SourceCandidate,
        options: &CandidateResolveOptions,
    ) -> Result<Vec<SourceCandidate>, String>;
}

/// Stage 3: Resolves a matched [`SourceCandidate`] into playable audio URLs.
#[async_trait]
pub trait CandidateResolver: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    async fn can_resolve(&self, _candidate: &SourceCandidate) -> bool {
        true
    }
    async fn resolve(
        &self,
        candidate: &SourceCandidate,
        options: &CandidateResolveOptions,
    ) -> Result<Vec<PlayableSource>, String>;
    async fn test(&self) -> Result<(bool, Option<String>), String> {
        Ok((true, Some(format!("{} is reachable", self.name()))))
    }
}

fn is_private_hostname(hostname: &str) -> bool {
    let host = hostname.trim().to_ascii_lowercase();
    host == "localhost"
        || host == "::1"
        || host == "[::1]"
        || host.ends_with(".local")
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || host.starts_with("169.254.")
}

/// Validates that a resolver-produced URL is `https://` and does not target a
/// loopback or RFC 1918 private network address.
#[must_use]
pub fn validated_playable_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = Url::parse(trimmed).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?;
    if is_private_hostname(host) {
        return None;
    }
    Some(parsed.to_string())
}

/// Returns `true` when `candidate` represents an album/release container whose
/// normalized `artist` and `album` match `result` while its title is the album name.
#[must_use]
pub fn is_album_container(result: &UnifiedSearchResult, candidate: &SourceCandidate) -> bool {
    let metadata_kind = candidate
        .metadata
        .as_ref()
        .and_then(|m| m.get("kind"))
        .and_then(Value::as_str);
    let after_colon = candidate
        .id
        .find(':')
        .map_or("", |idx| &candidate.id[idx + 1..]);

    let is_container_candidate = matches!(
        candidate.kind,
        Some(
            SourceCandidateKind::AlbumContainer
                | SourceCandidateKind::ReleaseContainer
                | SourceCandidateKind::Item
                | SourceCandidateKind::DetailLink
        )
    ) || metadata_kind == Some("album-container")
        || (candidate.id.starts_with("archiveorg:")
            && !candidate.id["archiveorg:".len()..].contains(':'))
        || after_colon.starts_with("magnet:")
        || candidate.id.starts_with("archive-org:");

    if !is_container_candidate {
        return false;
    }

    let artist = normalize_music_text(result.artist.as_deref());
    let album = normalize_music_text(result.album.as_deref());
    if artist.is_empty() || album.is_empty() {
        return false;
    }

    let candidate_title = normalize_music_text(candidate.title.as_deref());
    let candidate_album = normalize_music_text(candidate.album.as_deref());
    let title = normalize_music_text(Some(&result.title));
    let matches_artist = normalize_music_text(candidate.artist.as_deref()) == artist;
    let matches_album = candidate_title == album || candidate_album == album;

    matches_artist && matches_album && candidate_title != title
}

/// Deterministic multi-factor candidate scoring (`server/src/domain/source-discovery.ts`):
/// - Canonical identity match: `+100`
/// - Exact track title: `+40` (`+25` for album container, `+20` for substring containment)
/// - Exact artist: `+30` (`+15` for substring containment, `-15` if missing)
/// - Exact album: `+25` (`-5` if missing on non-container)
/// - Duration proximity: `<= 3s` -> `+20`, `<= 8s` -> `+10`, `> 20s` -> `-30`
/// - Lossless audio flag: `+10`
/// - Bitrate or sampleRate present: `+5`
/// - Version signature mismatch (`live`, `remix`, `acoustic`, etc.): `-50`
#[must_use]
pub fn score_candidate(result: &UnifiedSearchResult, candidate: &SourceCandidate) -> i32 {
    let mut score = 0_i32;

    if let (Some(r_id), Some(c_id)) = (&result.identity, &candidate.identity) {
        if r_id.id == c_id.id {
            score += 100;
        }
    }

    let result_title = normalize_music_text(Some(&result.title));
    let result_artist = normalize_music_text(result.artist.as_deref());
    let result_album = normalize_music_text(result.album.as_deref());

    let candidate_title = normalize_music_text(candidate.title.as_deref());
    let candidate_artist = normalize_music_text(candidate.artist.as_deref());
    let candidate_album = normalize_music_text(candidate.album.as_deref());

    let container = is_album_container(result, candidate);
    if !result_title.is_empty() && candidate_title == result_title {
        score += 40;
    } else if container {
        score += 25;
    } else if !result_title.is_empty()
        && !candidate_title.is_empty()
        && (candidate_title.contains(&result_title) || result_title.contains(&candidate_title))
    {
        score += 20;
    }

    if !result_artist.is_empty() && candidate_artist == result_artist {
        score += 30;
    } else if !result_artist.is_empty()
        && !candidate_artist.is_empty()
        && (candidate_artist.contains(&result_artist) || result_artist.contains(&candidate_artist))
    {
        score += 15;
    } else if candidate_artist.is_empty() {
        score -= 15;
    }

    if !result_album.is_empty() && candidate_album == result_album {
        score += 25;
    } else if candidate_album.is_empty() && !container {
        score -= 5;
    }

    let requested_duration = result.metadata.duration_seconds.unwrap_or(0);
    if requested_duration > 0 {
        if let Some(cand_dur) = candidate.duration_seconds.filter(|&d| d > 0) {
            let diff = cand_dur.abs_diff(requested_duration);
            if diff <= 3 {
                score += 20;
            } else if diff <= 8 {
                score += 10;
            } else if diff > 20 {
                score -= 30;
            }
        }
    }

    if candidate
        .quality
        .as_ref()
        .and_then(|q| q.lossless)
        .unwrap_or(false)
    {
        score += 10;
    }

    if candidate
        .quality
        .as_ref()
        .is_some_and(|q| q.bitrate.is_some() || q.sample_rate.is_some())
    {
        score += 5;
    }

    if !container {
        let requested_version = version_signature(Some(&result.title));
        let candidate_version = version_signature(candidate.title.as_deref());
        if requested_version != candidate_version {
            score -= 50;
        }
    }

    score
}

/// Conservative candidate eligibility filter.
///
/// Accepts a candidate only when:
/// 1. Strong canonical identity matches, OR
/// 2. It is a verified album container (`artist` + `album` match), OR
/// 3. Version signatures match, normalized title matches (or equals `"<artist> <title>"`),
///    non-empty artist/album fields do not conflict, metadata context is present, and
///    duration difference is within `<= 8` seconds.
#[must_use]
pub fn matches_candidate(result: &UnifiedSearchResult, candidate: &SourceCandidate) -> bool {
    if let (Some(r_id), Some(c_id)) = (&result.identity, &candidate.identity) {
        if r_id.id == c_id.id {
            return true;
        }
    }

    if is_album_container(result, candidate) {
        return true;
    }

    let requested_version = version_signature(Some(&result.title));
    let candidate_version = version_signature(candidate.title.as_deref());
    if requested_version != candidate_version {
        return false;
    }

    let title = normalize_music_text(Some(&result.title));
    let candidate_title = normalize_music_text(candidate.title.as_deref());
    let combined = [
        candidate.artist.as_deref(),
        candidate.album.as_deref(),
        candidate.title.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    let candidate_text = normalize_music_text(Some(&combined));
    let artist = normalize_music_text(result.artist.as_deref());

    let title_matches = !title.is_empty()
        && (candidate_title == title
            || (!artist.is_empty()
                && candidate.title.is_some()
                && candidate_title == format!("{artist} {title}")));
    if !title_matches {
        return false;
    }

    let candidate_artist = normalize_music_text(candidate.artist.as_deref());
    if !artist.is_empty() && !candidate_artist.is_empty() && artist != candidate_artist {
        return false;
    }

    let album = normalize_music_text(result.album.as_deref());
    let candidate_album = normalize_music_text(candidate.album.as_deref());
    if !album.is_empty() && !candidate_album.is_empty() && album != candidate_album {
        return false;
    }

    let has_metadata_context = candidate.artist.is_some()
        || candidate.album.is_some()
        || candidate.duration_seconds.is_some()
        || candidate.identity.is_some()
        || (!artist.is_empty() && candidate_text.contains(&artist))
        || candidate
            .container
            .as_ref()
            .is_some_and(|c| c.artist.is_some() || c.album.is_some());

    if !has_metadata_context {
        return false;
    }

    let requested_duration = result.metadata.duration_seconds.unwrap_or(0);
    if requested_duration > 0 {
        if let Some(cand_dur) = candidate.duration_seconds.filter(|&d| d > 0) {
            if cand_dur.abs_diff(requested_duration) > 8 {
                return false;
            }
        }
    }

    true
}

/// Summary descriptor for a registered pipeline provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineProviderSummary {
    pub id: String,
    pub name: String,
    /// `"discovery" | "resolver"`.
    pub role: String,
    pub enabled: bool,
}

#[derive(Default)]
struct PipelineState {
    discovery: Vec<Arc<dyn SourceDiscoveryProvider>>,
    detail: Vec<Arc<dyn SourceDetailProvider>>,
    container: Vec<Arc<dyn SourceContainerProvider>>,
    resolvers: Vec<Arc<dyn CandidateResolver>>,
}

/// Discovery -> detail/container expansion -> candidate matching -> resolver orchestration.
#[derive(Clone, Default)]
pub struct SourcePipelineRegistry {
    state: Arc<RwLock<PipelineState>>,
    db: Option<DbPool>,
}

impl std::fmt::Debug for SourcePipelineRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourcePipelineRegistry").finish()
    }
}

impl SourcePipelineRegistry {
    /// Creates a new [`SourcePipelineRegistry`].
    #[must_use]
    pub fn new(db: Option<DbPool>) -> Self {
        Self {
            state: Arc::new(RwLock::new(PipelineState::default())),
            db,
        }
    }

    async fn enabled_ids(&self) -> HashMap<String, bool> {
        let Some(pool) = &self.db else {
            return HashMap::new();
        };
        let rows = sqlx::query("SELECT provider_id, enabled FROM source_provider_configs")
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default();

        rows.into_iter()
            .filter_map(|row| {
                let id: String = row.try_get("provider_id").ok()?;
                let enabled: i64 = row.try_get("enabled").unwrap_or(0);
                Some((id, enabled != 0))
            })
            .collect()
    }

    /// Registers or replaces a [`SourceDiscoveryProvider`].
    pub fn register_discovery(
        &self,
        provider: Arc<dyn SourceDiscoveryProvider>,
    ) -> Result<(), String> {
        let mut guard = self
            .state
            .write()
            .map_err(|_| String::from("Lock poisoned"))?;
        if guard.resolvers.iter().any(|r| r.id() == provider.id()) {
            return Err(String::from(
                "Source pipeline provider is already registered",
            ));
        }
        if let Some(pos) = guard.discovery.iter().position(|d| d.id() == provider.id()) {
            guard.discovery[pos] = provider;
        } else {
            guard.discovery.push(provider);
        }
        Ok(())
    }

    /// Registers or replaces a [`SourceDetailProvider`].
    pub fn register_detail(&self, provider: Arc<dyn SourceDetailProvider>) {
        if let Ok(mut guard) = self.state.write() {
            if let Some(pos) = guard.detail.iter().position(|d| d.id() == provider.id()) {
                guard.detail[pos] = provider;
            } else {
                guard.detail.push(provider);
            }
        }
    }

    /// Registers or replaces a [`SourceContainerProvider`].
    pub fn register_container(&self, provider: Arc<dyn SourceContainerProvider>) {
        if let Ok(mut guard) = self.state.write() {
            if let Some(pos) = guard.container.iter().position(|c| c.id() == provider.id()) {
                guard.container[pos] = provider;
            } else {
                guard.container.push(provider);
            }
        }
    }

    /// Registers or replaces a [`CandidateResolver`].
    pub fn register_resolver(&self, provider: Arc<dyn CandidateResolver>) -> Result<(), String> {
        let mut guard = self
            .state
            .write()
            .map_err(|_| String::from("Lock poisoned"))?;
        if guard.discovery.iter().any(|d| d.id() == provider.id()) {
            return Err(String::from(
                "Source pipeline provider is already registered",
            ));
        }
        if let Some(pos) = guard.resolvers.iter().position(|r| r.id() == provider.id()) {
            guard.resolvers[pos] = provider;
        } else {
            guard.resolvers.push(provider);
        }
        Ok(())
    }

    /// Lists all registered discovery and resolver pipeline providers.
    pub async fn list(&self) -> Vec<PipelineProviderSummary> {
        let enabled = self.enabled_ids().await;
        let Ok(guard) = self.state.read() else {
            return Vec::new();
        };

        let mut list = Vec::new();
        for d in &guard.discovery {
            list.push(PipelineProviderSummary {
                id: d.id().to_owned(),
                name: d.name().to_owned(),
                role: String::from("discovery"),
                enabled: enabled.get(d.id()).copied().unwrap_or(false),
            });
        }
        for r in &guard.resolvers {
            list.push(PipelineProviderSummary {
                id: r.id().to_owned(),
                name: r.name().to_owned(),
                role: String::from("resolver"),
                enabled: enabled.get(r.id()).copied().unwrap_or(false),
            });
        }
        list
    }

    /// Persists the enablement state of a pipeline provider in `source_provider_configs`.
    pub async fn configure(&self, provider_id: &str, enabled: bool) -> Result<(), String> {
        let exists = {
            let guard = self
                .state
                .read()
                .map_err(|_| String::from("Lock poisoned"))?;
            guard.discovery.iter().any(|p| p.id() == provider_id)
                || guard.resolvers.iter().any(|p| p.id() == provider_id)
                || guard.detail.iter().any(|p| p.id() == provider_id)
                || guard.container.iter().any(|p| p.id() == provider_id)
        };
        if !exists {
            return Err(String::from("Unknown source pipeline provider"));
        }

        let Some(pool) = &self.db else {
            return Ok(());
        };

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r"
            INSERT INTO source_provider_configs (provider_id, enabled, config_json, updated_at)
            VALUES (?, ?, '{}', ?)
            ON CONFLICT(provider_id) DO UPDATE SET
                enabled = excluded.enabled,
                updated_at = excluded.updated_at
            ",
        )
        .bind(provider_id)
        .bind(i64::from(enabled))
        .bind(&now)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;

        if enabled {
            sqlx::query(
                r"
                INSERT INTO source_provider_configs (provider_id, enabled, config_json, updated_at)
                VALUES ('source-pipeline', 1, '{}', ?)
                ON CONFLICT(provider_id) DO UPDATE SET
                    enabled = 1,
                    updated_at = excluded.updated_at
                ",
            )
            .bind(&now)
            .execute(pool.inner())
            .await
            .map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    /// Discovers and ranks matching [`SourceCandidate`] items across enabled discovery providers.
    pub async fn discover(
        &self,
        result: &UnifiedSearchResult,
        options: &SourceDiscoveryOptions,
    ) -> Vec<SourceCandidate> {
        let enabled = self.enabled_ids().await;
        let discovery_providers: Vec<Arc<dyn SourceDiscoveryProvider>> = {
            let Ok(guard) = self.state.read() else {
                return Vec::new();
            };
            let mut seen = HashSet::new();
            guard
                .discovery
                .iter()
                .filter(|p| enabled.get(p.id()).copied().unwrap_or(false) && seen.insert(p.id()))
                .cloned()
                .collect()
        };

        let mut candidates = Vec::new();
        for provider in discovery_providers {
            if let Ok(Ok(list)) = tokio::time::timeout(
                Duration::from_millis(5_000),
                provider.search(result, options),
            )
            .await
            {
                candidates.extend(list.into_iter().filter(|c| matches_candidate(result, c)));
            }
        }

        candidates.sort_by_key(|c| std::cmp::Reverse(score_candidate(result, c)));
        candidates
    }

    /// Full 3-stage pipeline: discovery -> detail/container expansion -> candidate scoring -> resolver execution.
    pub async fn resolve(
        &self,
        result: &UnifiedSearchResult,
        options: &SourceResolutionOptions,
    ) -> Vec<PlayableSource> {
        if result.item_type != SearchResultType::Track {
            return Vec::new();
        }

        let enabled = self.enabled_ids().await;
        let (discovery, detail, container, resolvers) = {
            let Ok(guard) = self.state.read() else {
                return Vec::new();
            };
            let mut seen_d = HashSet::new();
            let d: Vec<_> = guard
                .discovery
                .iter()
                .filter(|p| enabled.get(p.id()).copied().unwrap_or(false) && seen_d.insert(p.id()))
                .cloned()
                .collect();
            let mut seen_r = HashSet::new();
            let r: Vec<_> = guard
                .resolvers
                .iter()
                .filter(|p| enabled.get(p.id()).copied().unwrap_or(false) && seen_r.insert(p.id()))
                .cloned()
                .collect();
            (d, guard.detail.clone(), guard.container.clone(), r)
        };

        if discovery.is_empty() || resolvers.is_empty() {
            return Vec::new();
        }

        let disc_opts = SourceDiscoveryOptions {
            limit: options.limit,
            spotify_track_url: result.metadata.spotify_track_url.clone(),
            spotify_track_id: result.metadata.spotify_track_id.clone(),
        };

        let mut all_candidates = Vec::new();
        for provider in discovery {
            if let Ok(Ok(found)) = tokio::time::timeout(
                Duration::from_millis(5_000),
                provider.search(result, &disc_opts),
            )
            .await
            {
                all_candidates.extend(found);
            }
        }

        let resolve_opts = CandidateResolveOptions {
            limit: options.limit,
            target: Some(result.clone()),
        };

        let mut expanded = Vec::new();
        for cand in all_candidates {
            let is_detail = cand.kind == Some(SourceCandidateKind::DetailLink)
                || (cand.detail_url.is_some()
                    && !cand.id.contains("magnet:")
                    && !cand.id.contains(".mp3")
                    && !cand.id.contains(".flac"));

            if is_detail {
                let mut resolved_details = None;
                for dp in &detail {
                    if !dp.can_resolve(&cand).await {
                        continue;
                    }
                    if let Ok(Ok(items)) = tokio::time::timeout(
                        Duration::from_millis(5_000),
                        dp.resolve_details(&cand, &resolve_opts),
                    )
                    .await
                    {
                        if !items.is_empty() {
                            resolved_details = Some(items);
                            break;
                        }
                    }
                }
                if let Some(items) = resolved_details {
                    expanded.extend(items);
                    continue;
                }
            }

            let is_cont = matches!(
                cand.kind,
                Some(
                    SourceCandidateKind::AlbumContainer
                        | SourceCandidateKind::ReleaseContainer
                        | SourceCandidateKind::Item
                )
            ) || is_album_container(result, &cand);

            if is_cont {
                let mut enumerated = None;
                for cp in &container {
                    if !cp.can_enumerate(&cand).await {
                        continue;
                    }
                    if let Ok(Ok(items)) = tokio::time::timeout(
                        Duration::from_millis(6_000),
                        cp.enumerate(&cand, &resolve_opts),
                    )
                    .await
                    {
                        if !items.is_empty() {
                            enumerated = Some(items);
                            break;
                        }
                    }
                }
                if let Some(items) = enumerated {
                    expanded.extend(items);
                    expanded.push(cand);
                    continue;
                }
            }

            expanded.push(cand);
        }

        let mut seen_targets = HashSet::new();
        let mut unique_matching = Vec::new();
        for cand in expanded
            .into_iter()
            .filter(|c| matches_candidate(result, c))
        {
            let target = cand
                .id
                .find(':')
                .map_or_else(|| cand.id.clone(), |idx| cand.id[idx + 1..].to_owned());
            if seen_targets.insert(target) {
                unique_matching.push(cand);
            }
        }

        unique_matching.sort_by_key(|c| std::cmp::Reverse(score_candidate(result, c)));

        let max_sources = options.limit.unwrap_or(10).clamp(1, 25);
        let mut sources = Vec::new();
        let mut seen_urls = HashSet::new();

        'outer: for cand in unique_matching {
            if sources.len() >= max_sources {
                break;
            }
            for resolver in &resolvers {
                if !resolver.can_resolve(&cand).await {
                    continue;
                }
                if let Ok(Ok(resolved)) = tokio::time::timeout(
                    Duration::from_millis(8_000),
                    resolver.resolve(&cand, &resolve_opts),
                )
                .await
                {
                    for mut src in resolved {
                        let Some(safe_url) = validated_playable_url(&src.id) else {
                            continue;
                        };
                        if !seen_urls.insert(safe_url.clone()) {
                            continue;
                        }
                        src.id = safe_url;
                        src.source_type = PlayableSourceType::External;
                        if src.label.trim().is_empty() {
                            src.label = resolver.name().to_owned();
                        }
                        if src.availability == PlayableSourceAvailability::Unknown {
                            src.availability = PlayableSourceAvailability::Available;
                        }
                        sources.push(src);
                        if sources.len() >= max_sources {
                            break 'outer;
                        }
                    }
                }
            }
        }

        sources.sort_by(compare_source_quality);
        sources
    }
}

/// [`SourceProvider`] facade wrapping [`SourcePipelineRegistry`].
pub struct SourcePipelineProvider {
    pipeline: SourcePipelineRegistry,
    http: Client,
}

impl SourcePipelineProvider {
    /// Creates a new [`SourcePipelineProvider`].
    #[must_use]
    pub fn new(pipeline: SourcePipelineRegistry) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_default();
        Self { pipeline, http }
    }
}

#[async_trait]
impl SourceProvider for SourcePipelineProvider {
    fn id(&self) -> &str {
        "source-pipeline"
    }

    fn name(&self) -> &str {
        "Source pipeline"
    }

    fn capabilities(&self) -> SourceProviderCapabilities {
        SourceProviderCapabilities {
            tracks: true,
            albums: false,
            quality: true,
            multiple_sources: true,
            caching: true,
        }
    }

    async fn can_resolve(&self, result: &UnifiedSearchResult) -> bool {
        result.item_type == SearchResultType::Track
    }

    async fn get_sources(
        &self,
        result: &UnifiedSearchResult,
        options: &SourceResolutionOptions,
    ) -> Result<Vec<PlayableSource>, String> {
        Ok(self.pipeline.resolve(result, options).await)
    }

    async fn fetch_stream(
        &self,
        source: &PlayableSource,
        range: Option<&str>,
    ) -> Result<UpstreamStreamResponse, String> {
        let url = validated_playable_url(&source.id)
            .ok_or_else(|| String::from("Playable source is unavailable"))?;

        let mut req = self.http.get(&url);
        if let Some(r) = range {
            req = req.header("Range", r);
        }

        let resp = req
            .send()
            .await
            .map_err(|_| String::from("Playable source is unavailable"))?;
        if !resp.status().is_success() && resp.status().as_u16() != 206 {
            return Err(String::from("Playable source is unavailable"));
        }

        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !content_type.starts_with("audio/") && !content_type.starts_with("application/octet-stream") {
            return Err(String::from("Playable source is unavailable"));
        }

        let status = resp.status().as_u16();
        let headers = resp
            .headers()
            .iter()
            .filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned())))
            .collect();
        let bytes = resp
            .bytes()
            .await
            .map_err(|_| String::from("Playable source is unavailable"))?;

        Ok(UpstreamStreamResponse {
            status,
            headers,
            bytes,
        })
    }
}
