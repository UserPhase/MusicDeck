//! # Search Provider Registry & Concurrent Broadcast Querying (`registry::search_providers`)
//!
//! Ports `server/src/domain/search-provider-registry.ts`:
//! - Built-in [`LibrarySearchProvider`], [`PlaylistSearchProvider`], [`DeezerSearchProvider`],
//!   and [`SpotifySearchProvider`]
//! - [`SearchProviderRegistry`] persisting provider configuration in `search_provider_configs`,
//!   redacting secrets from admin listings while exposing `raw_config` for server-side wiring,
//!   and executing concurrent multi-provider search fan-out

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;

use crate::catalog::CatalogService;
use crate::db::DbPool;
use crate::external::{DeezerAdapter, ExternalArtworkTokenStore, ExternalProvider, ItunesAdapter};
use crate::providers::BackendRegistry;
use crate::search::{
    SearchMode, SearchOptions, SearchProvider, SearchProviderKind, SearchProviderResult,
    SearchProviderTestResult, SearchResultType, SpotifySearchProvider, UnifiedSearchGroups,
    UnifiedSearchResult, dedupe_keyless_search_results, group_search_results,
    to_album_search_result, to_artist_search_result, to_playlist_search_result,
    to_track_search_result,
};

/// Operational status of a search provider (`enabled | disabled | error`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchProviderStatus {
    Enabled,
    Disabled,
    Error,
}

/// Admin representation of a registered search provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminSearchProvider {
    pub id: String,
    pub name: String,
    pub kind: SearchProviderKind,
    pub enabled: bool,
    pub status: SearchProviderStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
    pub config: Value,
}

/// Aggregated search outcome returned by [`SearchProviderRegistry::search`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FederatedSearchOutcome {
    pub groups: UnifiedSearchGroups,
    pub degraded: bool,
}

/// Built-in library catalog search provider (`id = "library"`).
pub struct LibrarySearchProvider {
    db: Option<DbPool>,
    backends: BackendRegistry,
}

impl LibrarySearchProvider {
    /// Creates a new [`LibrarySearchProvider`].
    #[must_use]
    pub const fn new(db: Option<DbPool>, backends: BackendRegistry) -> Self {
        Self { db, backends }
    }
}

#[async_trait]
impl SearchProvider for LibrarySearchProvider {
    fn id(&self) -> &str {
        "library"
    }

    fn name(&self) -> &str {
        "Your Library"
    }

    async fn search(
        &self,
        query: &str,
        options: &SearchOptions,
    ) -> Result<Vec<UnifiedSearchResult>, String> {
        let Some(pool) = &self.db else {
            return Ok(Vec::new());
        };
        let catalog = CatalogService::from_pool(pool.clone(), self.backends.clone());
        let res = catalog
            .search(query, &["artist", "album", "track"], None)
            .await
            .map_err(|e| e.to_string())?;

        let mut items = Vec::new();
        if options.includes(SearchResultType::Track) {
            for t in &res.tracks {
                items.push(to_track_search_result(
                    &t.item,
                    Some(t.availability.clone()),
                    t.sources.clone(),
                ));
            }
        }
        if options.includes(SearchResultType::Album) {
            for a in &res.albums {
                items.push(to_album_search_result(
                    &a.item,
                    a.availability.clone(),
                    a.sources.clone(),
                ));
            }
        }
        if options.includes(SearchResultType::Artist) {
            for ar in &res.artists {
                items.push(to_artist_search_result(
                    &ar.item,
                    ar.availability.clone(),
                    ar.sources.clone(),
                ));
            }
        }

        Ok(items)
    }
}

/// Built-in MusicDeck playlist search provider (`id = "musicdeck-playlists"`).
pub struct PlaylistSearchProvider {
    db: Option<DbPool>,
    backends: BackendRegistry,
}

impl PlaylistSearchProvider {
    /// Creates a new [`PlaylistSearchProvider`].
    #[must_use]
    pub const fn new(db: Option<DbPool>, backends: BackendRegistry) -> Self {
        Self { db, backends }
    }
}

#[async_trait]
impl SearchProvider for PlaylistSearchProvider {
    fn id(&self) -> &str {
        "musicdeck-playlists"
    }

    fn name(&self) -> &str {
        "Your Playlists"
    }

    async fn search(
        &self,
        query: &str,
        options: &SearchOptions,
    ) -> Result<Vec<UnifiedSearchResult>, String> {
        let _ = &self.backends;
        if !options.includes(SearchResultType::Playlist) {
            return Ok(Vec::new());
        }
        let Some(pool) = &self.db else {
            return Ok(Vec::new());
        };
        let limit = options.limit.unwrap_or(20) as i64;
        let pattern = format!("%{}%", query.trim());
        let user_id = options.user.as_ref().map(|u| u.user.id.as_str()).unwrap_or("");

        let rows = sqlx::query(
            r"
            SELECT p.id, p.name, p.description, COUNT(i.id) AS song_count
            FROM playlists p
            LEFT JOIN playlist_items i ON i.playlist_id = p.id
            WHERE p.deleted_at IS NULL
              AND (p.owner_user_id = ? OR p.owner_user_id IS NULL OR p.sharing_mode = 'PUBLIC_SERVER')
              AND (p.name LIKE ? COLLATE NOCASE OR COALESCE(p.description, '') LIKE ? COLLATE NOCASE)
            GROUP BY p.id
            ORDER BY p.name COLLATE NOCASE, p.id
            LIMIT ?
            ",
        )
        .bind(user_id)
        .bind(&pattern)
        .bind(&pattern)
        .bind(limit)
        .fetch_all(pool.inner())
        .await
        .map_err(|e| e.to_string())?;

        let playlists: Vec<crate::providers::Playlist> = rows
            .into_iter()
            .filter_map(|r| {
                let id: String = r.try_get("id").ok()?;
                Some(crate::providers::Playlist {
                    provider_id: id.clone(),
                    id,
                    name: r.try_get("name").ok()?,
                    description: r.try_get("description").ok(),
                    artwork_id: None,
                    artwork_url: None,
                    song_count: r.try_get::<i64, _>("song_count").unwrap_or(0).max(0) as u32,
                    tracks: None,
                })
            })
            .collect();

        Ok(playlists.iter().map(to_playlist_search_result).collect())
    }
}

/// Built-in keyless external catalog search provider backed by Deezer primary + iTunes supplementary.
pub struct DeezerSearchProvider {
    artwork_tokens: ExternalArtworkTokenStore,
}

impl DeezerSearchProvider {
    /// Creates a new [`DeezerSearchProvider`].
    #[must_use]
    pub const fn new(artwork_tokens: ExternalArtworkTokenStore) -> Self {
        Self { artwork_tokens }
    }
}

#[async_trait]
impl SearchProvider for DeezerSearchProvider {
    fn id(&self) -> &str {
        "deezer"
    }

    fn name(&self) -> &str {
        "Deezer"
    }

    async fn search(
        &self,
        query: &str,
        options: &SearchOptions,
    ) -> Result<Vec<UnifiedSearchResult>, String> {
        let limit = options.limit.unwrap_or(10).clamp(1, 25);
        let want_tracks = options.includes(SearchResultType::Track);
        let want_albums = options.includes(SearchResultType::Album);
        let want_artists = options.includes(SearchResultType::Artist);

        if !want_tracks && !want_albums && !want_artists {
            return Ok(Vec::new());
        }

        let deezer = DeezerAdapter::new(self.artwork_tokens.clone(), limit);
        let itunes = ItunesAdapter::new(self.artwork_tokens.clone(), 15);

        let (dz_tracks, dz_albums, dz_artists, it_tracks) = tokio::join!(
            async {
                if want_tracks {
                    Some(deezer.search_tracks(query).await)
                } else {
                    None
                }
            },
            async {
                if want_albums {
                    Some(deezer.search_albums(query).await)
                } else {
                    None
                }
            },
            async {
                if want_artists {
                    Some(deezer.search_artists(query).await)
                } else {
                    None
                }
            },
            async {
                if want_tracks {
                    Some(itunes.search_tracks(query).await)
                } else {
                    None
                }
            }
        );

        let mut deezer_ok = false;
        let mut combined = Vec::new();

        for items in [dz_tracks, dz_albums, dz_artists].into_iter().flatten().flatten() {
            deezer_ok = true;
            combined.extend(items.into_iter().map(UnifiedSearchResult::from_external_item));
        }

        let mut itunes_ok = !want_tracks;
        if let Some(Ok(items)) = it_tracks {
            itunes_ok = true;
            combined.extend(items.into_iter().map(UnifiedSearchResult::from_external_item));
        }

        if !deezer_ok && !itunes_ok {
            return Err(String::from("Keyless catalog search failed"));
        }

        Ok(dedupe_keyless_search_results(combined))
    }

    async fn test(&self) -> Result<SearchProviderTestResult, String> {
        let deezer = DeezerAdapter::new(self.artwork_tokens.clone(), 1);
        match deezer.search_tracks("test").await {
            Ok(_) => Ok(SearchProviderTestResult {
                ok: true,
                status: Some(String::from("success")),
                message: Some(String::from("Deezer is reachable")),
            }),
            Err(err) => Ok(SearchProviderTestResult {
                ok: false,
                status: Some(String::from("provider_unavailable")),
                message: Some(format!("Deezer is unavailable: {err}")),
            }),
        }
    }
}

fn redact_config_omit(config: &Value) -> Value {
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
        if !is_secret {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

#[derive(Clone)]
struct SearchProviderDefinition {
    id: &'static str,
    name: &'static str,
    kind: SearchProviderKind,
    default_enabled: bool,
}

/// Dynamic registry for built-in and plugin search providers (`search_provider_configs`).
#[derive(Clone)]
pub struct SearchProviderRegistry {
    definitions: Vec<SearchProviderDefinition>,
    last_errors: Arc<RwLock<HashMap<String, String>>>,
    db: Option<DbPool>,
    backends: BackendRegistry,
    artwork_tokens: ExternalArtworkTokenStore,
}

impl std::fmt::Debug for SearchProviderRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SearchProviderRegistry").finish()
    }
}

impl SearchProviderRegistry {
    /// Creates a new [`SearchProviderRegistry`] with the 4 built-in providers
    /// (`library`, `musicdeck-playlists`, `deezer`, `spotify`).
    #[must_use]
    pub fn new(
        db: Option<DbPool>,
        backends: BackendRegistry,
        artwork_tokens: ExternalArtworkTokenStore,
    ) -> Self {
        let definitions = vec![
            SearchProviderDefinition {
                id: "library",
                name: "Your Library",
                kind: SearchProviderKind::Library,
                default_enabled: true,
            },
            SearchProviderDefinition {
                id: "musicdeck-playlists",
                name: "Your Playlists",
                kind: SearchProviderKind::Musicdeck,
                default_enabled: true,
            },
            SearchProviderDefinition {
                id: "deezer",
                name: "Deezer",
                kind: SearchProviderKind::External,
                default_enabled: true,
            },
            SearchProviderDefinition {
                id: "spotify",
                name: "Spotify",
                kind: SearchProviderKind::External,
                default_enabled: false,
            },
        ];

        Self {
            definitions,
            last_errors: Arc::new(RwLock::new(HashMap::new())),
            db,
            backends,
            artwork_tokens,
        }
    }

    fn instantiate(&self, id: &str, config: Value) -> Option<Box<dyn SearchProvider>> {
        match id {
            "library" => Some(Box::new(LibrarySearchProvider::new(
                self.db.clone(),
                self.backends.clone(),
            ))),
            "musicdeck-playlists" => Some(Box::new(PlaylistSearchProvider::new(
                self.db.clone(),
                self.backends.clone(),
            ))),
            "deezer" => Some(Box::new(DeezerSearchProvider::new(
                self.artwork_tokens.clone(),
            ))),
            "spotify" => Some(Box::new(SpotifySearchProvider::new(
                config,
                self.db.clone(),
            ))),
            _ => None,
        }
    }

    async fn configs(&self) -> HashMap<String, (bool, Value)> {
        let Some(pool) = &self.db else {
            return HashMap::new();
        };
        let rows = sqlx::query(
            "SELECT provider_id, enabled, config_json FROM search_provider_configs",
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

    /// Lists all search providers with secret keys omitted for admin API responses.
    pub async fn list(&self) -> Vec<AdminSearchProvider> {
        let configs = self.configs().await;
        let errors = self
            .last_errors
            .read()
            .map(|g| g.clone())
            .unwrap_or_default();

        self.definitions
            .iter()
            .map(|def| {
                let (enabled, cfg) = configs
                    .get(def.id)
                    .cloned()
                    .unwrap_or((def.default_enabled, json!({})));
                let err_msg = errors.get(def.id).cloned();
                let status = if err_msg.is_some() {
                    SearchProviderStatus::Error
                } else if enabled {
                    SearchProviderStatus::Enabled
                } else {
                    SearchProviderStatus::Disabled
                };

                AdminSearchProvider {
                    id: def.id.to_owned(),
                    name: def.name.to_owned(),
                    kind: def.kind,
                    enabled,
                    status,
                    status_message: err_msg,
                    config: redact_config_omit(&cfg),
                }
            })
            .collect()
    }

    /// Returns the raw (non-redacted) configuration and enablement state for `provider_id`.
    pub async fn raw_config(&self, provider_id: &str) -> Option<(bool, Value)> {
        let def = self.definitions.iter().find(|d| d.id == provider_id)?;
        let configs = self.configs().await;
        let (enabled, cfg) = configs
            .get(provider_id)
            .cloned()
            .unwrap_or((def.default_enabled, json!({})));
        Some((enabled, cfg))
    }

    /// Updates enablement and/or configuration for `provider_id` in `search_provider_configs`.
    pub async fn configure(
        &self,
        provider_id: &str,
        enabled: Option<bool>,
        config: Option<Value>,
    ) -> Result<(), String> {
        let Some(def) = self.definitions.iter().find(|d| d.id == provider_id) else {
            return Err(String::from("Unknown search provider"));
        };

        let existing = self.configs().await;
        let (prev_enabled, prev_cfg) = existing
            .get(provider_id)
            .cloned()
            .unwrap_or((def.default_enabled, json!({})));

        let next_enabled = enabled.unwrap_or(prev_enabled);
        let next_cfg = config.unwrap_or(prev_cfg);

        if let Some(pool) = &self.db {
            let now = Utc::now().to_rfc3339();
            sqlx::query(
                r"
                INSERT INTO search_provider_configs (provider_id, enabled, config_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(provider_id) DO UPDATE SET
                    enabled = excluded.enabled,
                    config_json = excluded.config_json,
                    updated_at = excluded.updated_at
                ",
            )
            .bind(provider_id)
            .bind(i64::from(next_enabled))
            .bind(serde_json::to_string(&next_cfg).unwrap_or_else(|_| String::from("{}")))
            .bind(now)
            .execute(pool.inner())
            .await
            .map_err(|e| e.to_string())?;
        }

        if let Ok(mut guard) = self.last_errors.write() {
            guard.remove(provider_id);
        }

        Ok(())
    }

    /// Executes a federated search across all enabled providers matching `options.mode`.
    pub async fn search(
        &self,
        query: &str,
        options: &SearchOptions,
    ) -> Result<FederatedSearchOutcome, String> {
        let configs = self.configs().await;
        let enabled_defs: Vec<(SearchProviderDefinition, Value)> = self
            .definitions
            .iter()
            .filter_map(|def| {
                let (is_enabled, cfg) = configs
                    .get(def.id)
                    .cloned()
                    .unwrap_or((def.default_enabled, json!({})));
                let is_external = matches!(
                    def.kind,
                    SearchProviderKind::External | SearchProviderKind::Plugin
                );
                let included = match options.mode {
                    SearchMode::Hybrid => true,
                    SearchMode::External => is_external,
                    SearchMode::Library => !is_external,
                };
                (is_enabled && included).then(|| (def.clone(), cfg))
            })
            .collect();

        let total_enabled = enabled_defs.len();
        let mut successful: Vec<SearchProviderResult> = Vec::new();

        for (def, cfg) in enabled_defs {
            let Some(provider) = self.instantiate(def.id, cfg) else {
                continue;
            };
            match provider.search(query, options).await {
                Ok(items) => {
                    if let Ok(mut guard) = self.last_errors.write() {
                        guard.remove(def.id);
                    }
                    successful.push(SearchProviderResult {
                        provider_id: def.id.to_owned(),
                        items,
                    });
                }
                Err(err) => {
                    if let Ok(mut guard) = self.last_errors.write() {
                        guard.insert(
                            def.id.to_owned(),
                            format!("{} is unavailable: {err}", def.name),
                        );
                    }
                }
            }
        }

        if total_enabled > 0 && successful.is_empty() {
            return Err(String::from("All search providers are unavailable"));
        }

        let degraded = successful.len() < total_enabled;
        let flat_items: Vec<UnifiedSearchResult> =
            successful.into_iter().flat_map(|r| r.items).collect();

        Ok(FederatedSearchOutcome {
            groups: group_search_results(flat_items),
            degraded,
        })
    }

    /// Runs a connectivity/configuration test for `provider_id`.
    pub async fn test(&self, provider_id: &str) -> Result<Value, String> {
        let Some(def) = self.definitions.iter().find(|d| d.id == provider_id) else {
            return Err(String::from("Unknown search provider"));
        };
        let configs = self.configs().await;
        let (_, cfg) = configs
            .get(provider_id)
            .cloned()
            .unwrap_or((def.default_enabled, json!({})));

        let Some(provider) = self.instantiate(provider_id, cfg) else {
            return Err(String::from("Unknown search provider"));
        };

        match provider.test().await {
            Ok(res) => Ok(json!({
                "id": provider_id,
                "ok": res.ok,
                "status": if res.ok {
                    String::from("success")
                } else {
                    res.status.unwrap_or_else(|| String::from("provider_unavailable"))
                },
                "message": res.message.unwrap_or_else(|| {
                    if res.ok {
                        format!("{} is reachable", def.name)
                    } else {
                        format!("{} is unavailable", def.name)
                    }
                }),
            })),
            Err(err) => Ok(json!({
                "id": provider_id,
                "ok": false,
                "status": "provider_unavailable",
                "message": format!("{}: {err}", def.name),
            })),
        }
    }
}
