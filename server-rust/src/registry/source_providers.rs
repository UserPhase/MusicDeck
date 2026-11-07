//! # Source Provider Registry & Short-Lived Opaque Token Cache (`registry::source_providers`)
//!
//! Ports `server/src/domain/source-provider-registry.ts`:
//! - [`LibrarySourceProvider`] resolving connected library backends
//! - [`DeezerPreviewSourceProvider`] resolving 30s MP3 previews from `*.dzcdn.net`
//! - [`ItunesPreviewSourceProvider`] resolving AAC previews from `*.itunes.apple.com`
//! - [`SourceProviderRegistry`] minting 5-minute opaque `playable_<nanoid>` tokens,
//!   selecting the preferred source (`library`, `external`, `best`, `lossless`,
//!   `highest-bitrate`, `preferred`, `manual`), and gating external stream access

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use nanoid::nanoid;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use url::Url;

use crate::catalog::{LibraryService, SourceResolver, normalize_music_text};
use crate::db::DbPool;
use crate::providers::{BackendRegistry, UpstreamStreamResponse};
use crate::registry::playable_sources::{
    PlayableSource, PlayableSourceAvailability, PlayableSourceQuality, PlayableSourceType,
    SourcePreference, SourceProvider, SourceProviderCapabilities, SourceProviderTestResult,
    SourceResolution, SourceResolutionOptions, compare_source_quality,
};
use crate::registry::source_discovery::{SourcePipelineProvider, SourcePipelineRegistry};
use crate::search::{SearchResultType, UnifiedSearchResult};

/// TTL for minted `playable_<nanoid>` tokens (`5 minutes = 300,000 ms`).
pub const PLAYABLE_SOURCE_TOKEN_TTL_MS: u64 = 5 * 60 * 1_000;
/// Per-provider timeout during [`SourceProviderRegistry::resolve`] (`10,000 ms`).
pub const SOURCE_PROVIDER_RESOLVE_TIMEOUT_MS: u64 = 10_000;

/// Built-in [`SourceProvider`] backed by [`LibraryService`] and [`BackendRegistry`].
pub struct LibrarySourceProvider {
    db: Option<DbPool>,
    backends: BackendRegistry,
}

impl LibrarySourceProvider {
    /// Creates a new [`LibrarySourceProvider`].
    #[must_use]
    pub const fn new(db: Option<DbPool>, backends: BackendRegistry) -> Self {
        Self { db, backends }
    }
}

#[async_trait]
impl SourceProvider for LibrarySourceProvider {
    fn id(&self) -> &str {
        "library"
    }

    fn name(&self) -> &str {
        "Library"
    }

    fn capabilities(&self) -> SourceProviderCapabilities {
        SourceProviderCapabilities {
            tracks: true,
            albums: false,
            quality: false,
            multiple_sources: true,
            caching: true,
        }
    }

    async fn get_sources(
        &self,
        result: &UnifiedSearchResult,
        _options: &SourceResolutionOptions,
    ) -> Result<Vec<PlayableSource>, String> {
        if result.item_type != SearchResultType::Track {
            return Ok(Vec::new());
        }
        let Some(pool) = &self.db else {
            return Ok(Vec::new());
        };

        let lib = LibraryService::new(pool.clone(), None);
        if !lib.exists(&result.id).await.unwrap_or(false) {
            return Ok(Vec::new());
        }

        let refs = lib.get_sources(&result.id).await.unwrap_or_default();
        let mut sources = Vec::new();
        for source_ref in refs {
            let Some(backend) = self.backends.get_by_connection_id(&source_ref.connection_id) else {
                continue;
            };
            if !backend.enabled {
                continue;
            }
            sources.push(PlayableSource {
                // Replaced with an opaque `playable_<nanoid>` token by `SourceProviderRegistry`.
                id: source_ref.connection_id,
                provider: String::from("library"),
                source_type: PlayableSourceType::Library,
                media_type: String::from("audio"),
                label: backend.name,
                availability: PlayableSourceAvailability::Available,
                expires_at: None,
                quality: None,
            });
        }

        Ok(sources)
    }
}

/// Built-in 30-second preview [`SourceProvider`] backed by Deezer's public API (`*.dzcdn.net`).
pub struct DeezerPreviewSourceProvider {
    http: Client,
}

impl Default for DeezerPreviewSourceProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl DeezerPreviewSourceProvider {
    /// Fixed duration of a Deezer preview excerpt (`30 seconds`).
    pub const PREVIEW_SECONDS: u32 = 30;

    /// Creates a new [`DeezerPreviewSourceProvider`].
    #[must_use]
    pub fn new() -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self { http }
    }

    async fn lookup_preview(&self, track_id: &str) -> Result<Option<String>, String> {
        if track_id.is_empty() || !track_id.chars().all(|c| c.is_ascii_digit()) {
            return Ok(None);
        }
        let resp = self
            .http
            .get(format!("https://api.deezer.com/track/{track_id}"))
            .send()
            .await
            .map_err(|_| String::from("External preview is unavailable"))?;
        if !resp.status().is_success() {
            return Err(String::from("External preview is unavailable"));
        }
        let payload: Value = resp
            .json()
            .await
            .map_err(|_| String::from("External preview is unavailable"))?;
        Ok(payload
            .get("preview")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned))
    }

    async fn search_preview(&self, result: &UnifiedSearchResult) -> Result<Option<String>, String> {
        let q = format!("{} {}", result.artist.as_deref().unwrap_or(""), result.title)
            .trim()
            .to_owned();
        let resp = self
            .http
            .get("https://api.deezer.com/search")
            .query(&[("q", q.as_str()), ("limit", "5")])
            .send()
            .await
            .map_err(|_| String::from("External preview is unavailable"))?;
        if !resp.status().is_success() {
            return Err(String::from("External preview is unavailable"));
        }
        let payload: Value = resp
            .json()
            .await
            .map_err(|_| String::from("External preview is unavailable"))?;

        let target_title = normalize_music_text(Some(&result.title));
        let target_artist = normalize_music_text(result.artist.as_deref());
        let target_album = normalize_music_text(result.album.as_deref());

        let Some(items) = payload.get("data").and_then(Value::as_array) else {
            return Ok(None);
        };

        for item in items {
            let item_title = normalize_music_text(item.get("title").and_then(Value::as_str));
            let item_artist = normalize_music_text(
                item.get("artist")
                    .and_then(|a| a.get("name"))
                    .and_then(Value::as_str),
            );
            let item_album = normalize_music_text(
                item.get("album")
                    .and_then(|a| a.get("title"))
                    .and_then(Value::as_str),
            );

            if item_title == target_title
                && (target_artist.is_empty() || item_artist == target_artist)
                && (target_album.is_empty() || item_album == target_album)
            {
                if let Some(prev) = item
                    .get("preview")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    return Ok(Some(prev.to_owned()));
                }
            }
        }

        Ok(None)
    }
}

#[async_trait]
impl SourceProvider for DeezerPreviewSourceProvider {
    fn id(&self) -> &str {
        "deezer-preview"
    }

    fn name(&self) -> &str {
        "External preview"
    }

    fn capabilities(&self) -> SourceProviderCapabilities {
        SourceProviderCapabilities {
            tracks: true,
            albums: false,
            quality: true,
            multiple_sources: false,
            caching: true,
        }
    }

    async fn can_resolve(&self, result: &UnifiedSearchResult) -> bool {
        if result.item_type != SearchResultType::Track {
            return false;
        }
        let is_deezer_id = result
            .id
            .strip_prefix("external_deezer_")
            .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()));
        is_deezer_id
            || result.source.kind == "external"
            || result.source.external_available == Some(true)
    }

    async fn get_sources(
        &self,
        result: &UnifiedSearchResult,
        _options: &SourceResolutionOptions,
    ) -> Result<Vec<PlayableSource>, String> {
        if !self.can_resolve(result).await {
            return Ok(Vec::new());
        }

        let preview_url = if let Some(track_id) = result.id.strip_prefix("external_deezer_") {
            self.lookup_preview(track_id).await?
        } else {
            self.search_preview(result).await?
        };

        let Some(preview_url) = preview_url else {
            return Ok(Vec::new());
        };

        let parsed = Url::parse(&preview_url)
            .map_err(|_| String::from("External preview is unavailable"))?;
        let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
        if parsed.scheme() != "https" || !(host == "dzcdn.net" || host.ends_with(".dzcdn.net")) {
            return Err(String::from("External preview is unavailable"));
        }

        Ok(vec![PlayableSource {
            id: parsed.to_string(),
            provider: String::from("external"),
            source_type: PlayableSourceType::Preview,
            media_type: String::from("audio"),
            label: String::from("External preview"),
            availability: PlayableSourceAvailability::Available,
            expires_at: None,
            quality: Some(PlayableSourceQuality {
                codec: Some(String::from("MP3")),
                lossless: Some(false),
                duration_seconds: Some(Self::PREVIEW_SECONDS),
                ..PlayableSourceQuality::default()
            }),
        }])
    }

    async fn test(&self) -> Result<SourceProviderTestResult, String> {
        let resp = self
            .http
            .get("https://api.deezer.com/search?q=test&limit=1")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let ok = resp.status().is_success();
        Ok(SourceProviderTestResult {
            ok,
            message: Some(if ok {
                String::from("External preview is reachable")
            } else {
                format!(
                    "External preview is unavailable (preview catalog responded with {})",
                    resp.status().as_u16()
                )
            }),
        })
    }

    async fn fetch_stream(
        &self,
        source: &PlayableSource,
        range: Option<&str>,
    ) -> Result<UpstreamStreamResponse, String> {
        let mut req = self.http.get(&source.id);
        if let Some(r) = range {
            req = req.header("Range", r);
        }
        let resp = req
            .send()
            .await
            .map_err(|_| String::from("External preview is unavailable"))?;
        let status = resp.status().as_u16();
        let headers = resp
            .headers()
            .iter()
            .filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned())))
            .collect();
        let bytes = resp
            .bytes()
            .await
            .map_err(|_| String::from("External preview is unavailable"))?;
        Ok(UpstreamStreamResponse {
            status,
            headers,
            bytes,
        })
    }
}

/// Built-in AAC preview [`SourceProvider`] backed by Apple's iTunes Search API (`*.itunes.apple.com`).
pub struct ItunesPreviewSourceProvider {
    http: Client,
}

impl Default for ItunesPreviewSourceProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl ItunesPreviewSourceProvider {
    /// Creates a new [`ItunesPreviewSourceProvider`].
    #[must_use]
    pub fn new() -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self { http }
    }
}

#[async_trait]
impl SourceProvider for ItunesPreviewSourceProvider {
    fn id(&self) -> &str {
        "itunes-preview"
    }

    fn name(&self) -> &str {
        "External preview"
    }

    fn capabilities(&self) -> SourceProviderCapabilities {
        SourceProviderCapabilities {
            tracks: true,
            albums: false,
            quality: true,
            multiple_sources: false,
            caching: true,
        }
    }

    async fn can_resolve(&self, result: &UnifiedSearchResult) -> bool {
        if result.item_type != SearchResultType::Track {
            return false;
        }
        let is_itunes_id = result
            .id
            .strip_prefix("external_itunes_")
            .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()));
        is_itunes_id || result.source.external_available == Some(true)
    }

    async fn get_sources(
        &self,
        result: &UnifiedSearchResult,
        _options: &SourceResolutionOptions,
    ) -> Result<Vec<PlayableSource>, String> {
        if !self.can_resolve(result).await {
            return Ok(Vec::new());
        }

        let mut preview_url: Option<String> = None;

        if let Some(track_id) = result.id.strip_prefix("external_itunes_") {
            if track_id.is_empty() || !track_id.chars().all(|c| c.is_ascii_digit()) {
                return Ok(Vec::new());
            }
            let resp = self
                .http
                .get("https://itunes.apple.com/lookup")
                .query(&[("id", track_id)])
                .send()
                .await
                .map_err(|_| String::from("External preview is unavailable"))?;
            if !resp.status().is_success() {
                return Err(String::from("External preview is unavailable"));
            }
            let payload: Value = resp
                .json()
                .await
                .map_err(|_| String::from("External preview is unavailable"))?;
            preview_url = payload
                .get("results")
                .and_then(Value::as_array)
                .and_then(|arr| arr.first())
                .and_then(|item| item.get("previewUrl"))
                .and_then(Value::as_str)
                .map(str::to_owned);
        } else if result.source.external_available == Some(true) {
            let term = format!("{} {}", result.artist.as_deref().unwrap_or(""), result.title)
                .trim()
                .to_owned();
            let resp = self
                .http
                .get("https://itunes.apple.com/search")
                .query(&[
                    ("term", term.as_str()),
                    ("media", "music"),
                    ("entity", "song"),
                    ("limit", "5"),
                ])
                .send()
                .await
                .map_err(|_| String::from("External preview is unavailable"))?;
            if !resp.status().is_success() {
                return Err(String::from("External preview is unavailable"));
            }
            let payload: Value = resp
                .json()
                .await
                .map_err(|_| String::from("External preview is unavailable"))?;

            let target_title = normalize_music_text(Some(&result.title));
            let target_artist = normalize_music_text(result.artist.as_deref());
            let target_album = normalize_music_text(result.album.as_deref());

            if let Some(items) = payload.get("results").and_then(Value::as_array) {
                for item in items {
                    let t_name = normalize_music_text(item.get("trackName").and_then(Value::as_str));
                    let a_name =
                        normalize_music_text(item.get("artistName").and_then(Value::as_str));
                    let c_name =
                        normalize_music_text(item.get("collectionName").and_then(Value::as_str));
                    if t_name == target_title
                        && a_name == target_artist
                        && (target_album.is_empty() || c_name == target_album)
                    {
                        preview_url = item
                            .get("previewUrl")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        if preview_url.is_some() {
                            break;
                        }
                    }
                }
            }
        }

        let Some(preview_url) = preview_url else {
            return Ok(Vec::new());
        };

        let parsed = Url::parse(&preview_url)
            .map_err(|_| String::from("External preview is unavailable"))?;
        let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
        if parsed.scheme() != "https" || !host.ends_with("itunes.apple.com") {
            return Err(String::from("External preview is unavailable"));
        }

        Ok(vec![PlayableSource {
            id: parsed.to_string(),
            provider: String::from("external"),
            source_type: PlayableSourceType::Preview,
            media_type: String::from("audio"),
            label: String::from("External preview"),
            availability: PlayableSourceAvailability::Available,
            expires_at: None,
            quality: Some(PlayableSourceQuality {
                codec: Some(String::from("AAC")),
                lossless: Some(false),
                ..PlayableSourceQuality::default()
            }),
        }])
    }

    async fn test(&self) -> Result<SourceProviderTestResult, String> {
        let resp = self
            .http
            .get("https://itunes.apple.com/search?term=test&media=music&entity=song&limit=1")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let ok = resp.status().is_success();
        Ok(SourceProviderTestResult {
            ok,
            message: Some(if ok {
                String::from("External preview is reachable")
            } else {
                format!(
                    "External preview is unavailable (iTunes responded with {})",
                    resp.status().as_u16()
                )
            }),
        })
    }

    async fn fetch_stream(
        &self,
        source: &PlayableSource,
        range: Option<&str>,
    ) -> Result<UpstreamStreamResponse, String> {
        let mut req = self.http.get(&source.id);
        if let Some(r) = range {
            req = req.header("Range", r);
        }
        let resp = req
            .send()
            .await
            .map_err(|_| String::from("External preview is unavailable"))?;
        let status = resp.status().as_u16();
        let headers = resp
            .headers()
            .iter()
            .filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned())))
            .collect();
        let bytes = resp
            .bytes()
            .await
            .map_err(|_| String::from("External preview is unavailable"))?;
        Ok(UpstreamStreamResponse {
            status,
            headers,
            bytes,
        })
    }
}

#[derive(Debug, Clone)]
struct StoredSource {
    source: PlayableSource,
    provider_id: String,
    provider_source_id: String,
    result_id: String,
    expires_at: Instant,
}

/// Admin view of a registered [`SourceProvider`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminSourceProvider {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub capabilities: SourceProviderCapabilities,
    pub config: Value,
}

fn redact_config_presence(config: &Value) -> Value {
    let Some(obj) = config.as_object() else {
        return json!({});
    };
    let mut out = serde_json::Map::new();
    for (k, v) in obj {
        let lower = k.to_ascii_lowercase();
        let is_secret = lower.contains("secret")
            || lower.contains("token")
            || lower.contains("password")
            || lower.contains("apikey")
            || lower.contains("api_key");
        if is_secret {
            let has_val = v.as_str().is_some_and(|s| !s.trim().is_empty());
            out.insert(k.clone(), Value::Bool(has_val));
        } else {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

/// Provider-neutral playable source resolution registry.
#[derive(Clone)]
pub struct SourceProviderRegistry {
    providers: Arc<RwLock<Vec<Arc<dyn SourceProvider>>>>,
    source_cache: Arc<RwLock<HashMap<String, StoredSource>>>,
    db: Option<DbPool>,
    backends: BackendRegistry,
    pipeline: Option<SourcePipelineRegistry>,
}

impl std::fmt::Debug for SourceProviderRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourceProviderRegistry").finish()
    }
}

impl SourceProviderRegistry {
    /// Creates a new [`SourceProviderRegistry`] pre-populated with `library`,
    /// `deezer-preview`, `itunes-preview`, and optional `source-pipeline`.
    #[must_use]
    pub fn new(
        db: Option<DbPool>,
        backends: BackendRegistry,
        pipeline: Option<SourcePipelineRegistry>,
    ) -> Self {
        let mut list: Vec<Arc<dyn SourceProvider>> = vec![
            Arc::new(LibrarySourceProvider::new(db.clone(), backends.clone())),
            Arc::new(DeezerPreviewSourceProvider::new()),
            Arc::new(ItunesPreviewSourceProvider::new()),
        ];
        if let Some(pipe) = &pipeline {
            list.push(Arc::new(SourcePipelineProvider::new(pipe.clone())));
        }

        Self {
            providers: Arc::new(RwLock::new(list)),
            source_cache: Arc::new(RwLock::new(HashMap::new())),
            db,
            backends,
            pipeline,
        }
    }

    async fn provider_configs(&self) -> HashMap<String, (bool, Value)> {
        let Some(pool) = &self.db else {
            return HashMap::new();
        };
        let rows = sqlx::query(
            "SELECT provider_id, enabled, config_json FROM source_provider_configs",
        )
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        rows.into_iter()
            .filter_map(|row| {
                let id: String = row.try_get("provider_id").ok()?;
                let enabled: i64 = row.try_get("enabled").unwrap_or(0);
                let json_str: String = row.try_get("config_json").unwrap_or_default();
                let parsed = serde_json::from_str::<Value>(&json_str).unwrap_or_else(|_| json!({}));
                Some((id, (enabled != 0, parsed)))
            })
            .collect()
    }

    /// Registers or replaces a [`SourceProvider`].
    pub fn register(&self, provider: Arc<dyn SourceProvider>) {
        if let Ok(mut guard) = self.providers.write() {
            if let Some(pos) = guard.iter().position(|p| p.id() == provider.id()) {
                guard[pos] = provider;
            } else {
                guard.push(provider);
            }
        }
    }

    /// Lists all registered source providers and non-overlapping pipeline providers.
    pub async fn list(&self) -> Vec<AdminSourceProvider> {
        let configs = self.provider_configs().await;
        let providers: Vec<Arc<dyn SourceProvider>> = self
            .providers
            .read()
            .map(|g| g.clone())
            .unwrap_or_default();

        let mut own: Vec<AdminSourceProvider> = providers
            .iter()
            .map(|p| {
                let (enabled, cfg) = configs
                    .get(p.id())
                    .cloned()
                    .unwrap_or((false, json!({})));
                AdminSourceProvider {
                    id: p.id().to_owned(),
                    name: p.name().to_owned(),
                    enabled,
                    role: None,
                    capabilities: p.capabilities(),
                    config: redact_config_presence(&cfg),
                }
            })
            .collect();

        if let Some(pipeline) = &self.pipeline {
            for item in pipeline.list().await {
                if !providers.iter().any(|p| p.id() == item.id) {
                    own.push(AdminSourceProvider {
                        id: item.id,
                        name: item.name,
                        enabled: item.enabled,
                        role: Some(item.role.clone()),
                        capabilities: SourceProviderCapabilities {
                            tracks: true,
                            albums: false,
                            quality: item.role == "resolver",
                            multiple_sources: true,
                            caching: true,
                        },
                        config: json!({}),
                    });
                }
            }
        }

        own
    }

    /// Persists enablement and configuration for `provider_id`.
    pub async fn configure(
        &self,
        provider_id: &str,
        enabled: bool,
        config: Option<Value>,
    ) -> Result<(), String> {
        let is_direct = self
            .providers
            .read()
            .map(|g| g.iter().any(|p| p.id() == provider_id))
            .unwrap_or(false);

        if !is_direct {
            if let Some(pipeline) = &self.pipeline {
                return pipeline.configure(provider_id, enabled).await;
            }
            return Err(String::from("Unknown source provider"));
        }

        let Some(pool) = &self.db else {
            return Ok(());
        };

        let existing = self.provider_configs().await;
        let next_config = config.unwrap_or_else(|| {
            existing
                .get(provider_id)
                .map(|(_, c)| c.clone())
                .unwrap_or_else(|| json!({}))
        });
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            r"
            INSERT INTO source_provider_configs (provider_id, enabled, config_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(provider_id) DO UPDATE SET
                enabled = excluded.enabled,
                config_json = excluded.config_json,
                updated_at = excluded.updated_at
            ",
        )
        .bind(provider_id)
        .bind(i64::from(enabled))
        .bind(serde_json::to_string(&next_config).unwrap_or_else(|_| String::from("{}")))
        .bind(now)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Tests a source provider's connectivity.
    pub async fn test(&self, provider_id: &str) -> Result<Value, String> {
        let provider = self
            .providers
            .read()
            .ok()
            .and_then(|g| g.iter().find(|p| p.id() == provider_id).cloned());

        if let Some(provider) = provider {
            return match provider.test().await {
                Ok(res) => Ok(json!({
                    "id": provider.id(),
                    "ok": res.ok,
                    "status": if res.ok { "success" } else { "plugin_error" },
                    "message": res.message.unwrap_or_else(|| {
                        if res.ok {
                            format!("{} is reachable", provider.name())
                        } else {
                            format!("{} is unavailable", provider.name())
                        }
                    }),
                })),
                Err(err) => Ok(json!({
                    "id": provider.id(),
                    "ok": false,
                    "status": "plugin_error",
                    "message": format!("{}: {err}", provider.name()),
                })),
            };
        }

        Err(String::from("Unknown source provider"))
    }

    /// Resolves playable sources across all enabled providers concurrently, mints
    /// 5-minute opaque `playable_<nanoid>` tokens, and selects `selected_source`
    /// according to `options.preference`.
    pub async fn resolve(
        &self,
        result: &UnifiedSearchResult,
        options: &SourceResolutionOptions,
    ) -> SourceResolution {
        let configs = self.provider_configs().await;
        let all_providers: Vec<Arc<dyn SourceProvider>> = self
            .providers
            .read()
            .map(|g| g.clone())
            .unwrap_or_default();

        let active: Vec<Arc<dyn SourceProvider>> = all_providers
            .into_iter()
            .filter(|p| {
                let is_lib = p.id() == "library";
                let allowed = is_lib || options.allow_external;
                let enabled =
                    is_lib || configs.get(p.id()).map(|(en, _)| *en).unwrap_or(false);
                allowed && enabled
            })
            .collect();

        let mut degraded = false;
        let mut sources = Vec::new();
        let now_instant = Instant::now();
        let expires_instant = now_instant + Duration::from_millis(PLAYABLE_SOURCE_TOKEN_TTL_MS);
        let expires_iso: DateTime<Utc> =
            Utc::now() + chrono::Duration::milliseconds(PLAYABLE_SOURCE_TOKEN_TTL_MS as i64);
        let expires_str = expires_iso.to_rfc3339();

        for provider in active {
            if !provider.can_resolve(result).await {
                continue;
            }
            match tokio::time::timeout(
                Duration::from_millis(SOURCE_PROVIDER_RESOLVE_TIMEOUT_MS),
                provider.get_sources(result, options),
            )
            .await
            {
                Ok(Ok(provider_sources)) => {
                    for mut src in provider_sources {
                        let token_id = format!("playable_{}", nanoid!(16));
                        let raw_source_id = std::mem::replace(&mut src.id, token_id.clone());
                        src.expires_at = Some(expires_str.clone());

                        if let Ok(mut cache) = self.source_cache.write() {
                            cache.retain(|_, v| v.expires_at > now_instant);
                            cache.insert(
                                token_id,
                                StoredSource {
                                    source: src.clone(),
                                    provider_id: provider.id().to_owned(),
                                    provider_source_id: raw_source_id,
                                    result_id: result.id.clone(),
                                    expires_at: expires_instant,
                                },
                            );
                        }
                        sources.push(src);
                    }
                }
                Ok(Err(_)) => {
                    degraded = true;
                }
                Err(_) => {
                    // Timed out cleanly after 10s
                }
            }
        }

        let available: Vec<PlayableSource> = sources
            .iter()
            .filter(|s| s.availability == PlayableSourceAvailability::Available)
            .cloned()
            .collect();

        let library = available
            .iter()
            .find(|s| s.source_type == PlayableSourceType::Library)
            .cloned();
        let external = available
            .iter()
            .find(|s| s.source_type == PlayableSourceType::External)
            .cloned();
        let preview = available
            .iter()
            .find(|s| s.source_type == PlayableSourceType::Preview)
            .cloned();

        let mut non_preview: Vec<PlayableSource> = available
            .iter()
            .filter(|s| s.source_type != PlayableSourceType::Preview)
            .cloned()
            .collect();
        non_preview.sort_by(compare_source_quality);
        let best_non_preview = non_preview.into_iter().next();

        let mut all_sorted = available.clone();
        all_sorted.sort_by(compare_source_quality);
        let best = best_non_preview.or_else(|| all_sorted.into_iter().next());

        let selected_source = match options.preference {
            Some(SourcePreference::Library) => library.or(external).or(preview),
            Some(SourcePreference::External) => external.or(preview).or(library),
            Some(SourcePreference::Best) => best,
            Some(SourcePreference::Lossless) => available
                .iter()
                .find(|s| s.quality.as_ref().and_then(|q| q.lossless).unwrap_or(false))
                .cloned()
                .or(best),
            Some(SourcePreference::HighestBitrate) => {
                let mut by_bitrate = available.clone();
                by_bitrate.sort_by(|a, b| {
                    let br_a = a.quality.as_ref().and_then(|q| q.bitrate).unwrap_or(0);
                    let br_b = b.quality.as_ref().and_then(|q| q.bitrate).unwrap_or(0);
                    br_b.cmp(&br_a)
                });
                by_bitrate.into_iter().next()
            }
            Some(SourcePreference::Preferred) if options.preferred_provider.is_some() => {
                let pref = options
                    .preferred_provider
                    .as_deref()
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                available
                    .iter()
                    .find(|s| {
                        s.label.eq_ignore_ascii_case(&pref)
                            || s.label.to_ascii_lowercase().contains(&pref)
                            || s.provider.eq_ignore_ascii_case(&pref)
                    })
                    .cloned()
                    .or(best)
            }
            Some(SourcePreference::Manual) => (available.len() == 1).then(|| available[0].clone()),
            _ => best.or_else(|| (available.len() == 1).then(|| available[0].clone())),
        };

        SourceResolution {
            sources,
            selected_source,
            degraded,
        }
    }

    /// Returns `true` if `source_id` refers to a non-library (`external` or `preview`) source for `result_id`.
    #[must_use]
    pub fn is_external_source(&self, result_id: &str, source_id: &str) -> bool {
        let Ok(guard) = self.source_cache.read() else {
            return false;
        };
        guard.get(source_id).is_some_and(|stored| {
            stored.result_id == result_id
                && matches!(
                    stored.source.source_type,
                    PlayableSourceType::External | PlayableSourceType::Preview
                )
        })
    }

    /// Streams audio for a previously minted `source_id` (`playable_<nanoid>`).
    pub async fn fetch_stream(
        &self,
        result_id: &str,
        source_id: &str,
        range: Option<&str>,
    ) -> Result<UpstreamStreamResponse, String> {
        let stored = {
            let mut guard = self
                .source_cache
                .write()
                .map_err(|_| String::from("Playable source is unavailable"))?;
            let Some(entry) = guard.get(source_id).cloned() else {
                return Err(String::from("Playable source is unavailable"));
            };
            if entry.result_id != result_id || entry.expires_at < Instant::now() {
                guard.remove(source_id);
                return Err(String::from("Playable source is unavailable"));
            }
            entry
        };

        if stored.source.source_type == PlayableSourceType::Library {
            let Some(pool) = &self.db else {
                return Err(String::from("Playable source is unavailable"));
            };
            let lib = LibraryService::new(pool.clone(), None);
            let resolver = SourceResolver::new(self.backends.clone(), lib);
            let stream_res = resolver
                .fetch_stream(
                    result_id,
                    range,
                    Some(&stored.provider_source_id),
                    None,
                )
                .await
                .map_err(|e| e.to_string())?;
            let status = stream_res.status.as_u16();
            let headers = stream_res
                .headers
                .iter()
                .filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned())))
                .collect();
            let bytes = stream_res
                .response
                .bytes()
                .await
                .map_err(|e| e.to_string())?;
            return Ok(UpstreamStreamResponse {
                status,
                headers,
                bytes,
            });
        }

        let provider = self
            .providers
            .read()
            .ok()
            .and_then(|g| g.iter().find(|p| p.id() == stored.provider_id).cloned())
            .ok_or_else(|| String::from("Playable source is unavailable"))?;

        let mut internal_source = stored.source;
        internal_source.id = stored.provider_source_id;
        provider.fetch_stream(&internal_source, range).await
    }
}
