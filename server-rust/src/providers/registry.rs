//! # Thread-Safe Dynamic Backend Registry & Factory (`providers::registry`)
//!
//! Complete Rust port of `server/src/backends/registry.ts` and `server/src/backends/factory.ts`.
//!
//! ## Concurrency & Routing Architecture
//! - [`BackendRegistry`] (also exported as [`ProviderRegistry`]) wraps the ordered list
//!   of [`RegisteredProvider`] instances inside an `Arc<RwLock<Vec<RegisteredProvider>>>`
//!   so read lookups (`get_primary`, `get_by_connection_id`, `list`) are lock-free across
//!   concurrent readers while supporting live hot-swapping (`replace_all`, `reload_from_db`)
//!   when setup/recovery updates backend configurations.
//! - Preserves exact primary selection semantics: enabled `backend_connections` rows are
//!   loaded in `ORDER BY created_at ASC` order so `get_primary()` always selects the oldest
//!   enabled connection, falling back to a synthetic `env-<backend>` entry if the table has
//!   no enabled rows.

use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::config::{AppConfig, JellyfinConfig, MusicBackendKind, NavidromeConfig};
use crate::db::DbPool;
use crate::providers::jellyfin::JellyfinClient;
use crate::providers::navidrome::NavidromeClient;
use crate::providers::traits::{MusicBackend, ProviderError};

/// Optional stored JSON overrides inside `backend_connections.config_json`.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProviderConfig {
    /// Stored server base URL.
    pub url: Option<String>,
    /// Legacy fallback username (superseded by environment credentials).
    pub username: Option<String>,
    /// Legacy fallback password (superseded by environment credentials).
    pub password: Option<String>,
    /// Legacy fallback API key (superseded by environment credentials).
    pub api_key: Option<String>,
}

impl StoredProviderConfig {
    /// Parses `config_json` leniently, returning default empty fields on malformed JSON
    /// (matching `parseStoredConfig` in `server/src/backends/factory.ts`).
    #[must_use]
    pub fn parse_lenient(config_json: &str) -> Self {
        serde_json::from_str::<Self>(config_json).unwrap_or_default()
    }
}

/// A live provider connection entry registered in [`BackendRegistry`].
#[derive(Debug, Clone)]
pub struct RegisteredProvider {
    /// Stable `backend_connections.id` (or `"env-navidrome"` / `"env-jellyfin"` fallback).
    pub connection_id: String,
    /// Provider type discriminant (`"navidrome"` or `"jellyfin"`).
    pub provider_type: String,
    /// Human-readable connection display name.
    pub name: String,
    /// Whether this connection is enabled.
    pub enabled: bool,
    /// Polymorphic handle to the live [`MusicBackend`] implementation.
    pub provider: Arc<dyn MusicBackend>,
}

/// Thread-safe registry of active [`RegisteredProvider`] connections.
#[derive(Debug, Clone, Default)]
pub struct BackendRegistry {
    providers: Arc<RwLock<Vec<RegisteredProvider>>>,
}

/// Alias matching the legacy TypeScript class name `ProviderRegistry`.
pub type ProviderRegistry = BackendRegistry;

impl BackendRegistry {
    /// Creates a new [`BackendRegistry`] initialized with `providers`.
    #[must_use]
    pub fn new(providers: Vec<RegisteredProvider>) -> Self {
        Self {
            providers: Arc::new(RwLock::new(providers)),
        }
    }

    /// Returns a cloned snapshot of all registered providers.
    #[must_use]
    pub fn list(&self) -> Vec<RegisteredProvider> {
        self.providers
            .read()
            .map_or_else(|e| e.into_inner().clone(), |guard| guard.clone())
    }

    /// Looks up a registered provider by its `connection_id`.
    #[must_use]
    pub fn get_by_connection_id(&self, connection_id: &str) -> Option<RegisteredProvider> {
        let guard = self
            .providers
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard
            .iter()
            .find(|entry| entry.connection_id == connection_id)
            .cloned()
    }

    /// Returns the primary enabled provider (the oldest enabled connection in `created_at ASC`
    /// order), or `Err(ProviderError::Configuration)` if no connections are registered.
    pub fn get_primary(&self) -> Result<RegisteredProvider, ProviderError> {
        let guard = self
            .providers
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.first().cloned().ok_or_else(|| {
            ProviderError::Configuration(String::from(
                "No enabled backend connections are configured",
            ))
        })
    }

    /// Atomically hot-swaps the active provider list without dropping the registry handle.
    pub fn replace_all(&self, next_providers: Vec<RegisteredProvider>) {
        if let Ok(mut guard) = self.providers.write() {
            *guard = next_providers;
        }
    }
}

/// Instantiates a single [`MusicBackend`] from `provider_type` (`"navidrome"` or `"jellyfin"`),
/// merging environment-owned credentials in `config` with `stored_config`.
///
/// Unknown provider types return `Err(ProviderError::Configuration)` immediately rather than
/// silently degrading the catalog.
pub fn create_provider(
    provider_type: &str,
    stored_config: &StoredProviderConfig,
    config: &AppConfig,
) -> Result<Arc<dyn MusicBackend>, ProviderError> {
    match provider_type.trim() {
        "navidrome" => {
            let url = non_empty_or(&config.navidrome.url, stored_config.url.as_deref());
            let username =
                non_empty_or(&config.navidrome.username, stored_config.username.as_deref());
            let password =
                non_empty_or(&config.navidrome.password, stored_config.password.as_deref());

            let client = NavidromeClient::new(NavidromeConfig {
                url,
                username,
                password,
            })?;
            Ok(Arc::new(client))
        }
        "jellyfin" => {
            let url = non_empty_or(&config.jellyfin.url, stored_config.url.as_deref());
            let api_key =
                non_empty_or(&config.jellyfin.api_key, stored_config.api_key.as_deref());

            let client = JellyfinClient::new(JellyfinConfig { url, api_key })?;
            Ok(Arc::new(client))
        }
        other => Err(ProviderError::Configuration(format!(
            "Unknown backend provider type: {other}"
        ))),
    }
}

/// Loads all enabled `backend_connections` rows from SQLite (`ORDER BY created_at ASC`)
/// and constructs a [`BackendRegistry`], falling back to a synthetic `env-<backend>` entry
/// when the table has no enabled rows (matching `createProviderRegistry` in `factory.ts`).
pub async fn create_provider_registry(
    db: &DbPool,
    config: &AppConfig,
) -> Result<BackendRegistry, ProviderError> {
    let rows = sqlx::query(
        r"
        SELECT id, type, name, config_json, enabled
        FROM backend_connections
        WHERE enabled = 1
        ORDER BY created_at ASC;
        ",
    )
    .fetch_all(db.inner())
    .await
    .map_err(|err| ProviderError::Configuration(format!("Failed to load backend_connections: {err}")))?;

    let mut providers = Vec::with_capacity(rows.len().max(1));
    for row in rows {
        let connection_id: String = row.try_get("id").unwrap_or_default();
        let provider_type: String = row.try_get("type").unwrap_or_default();
        let name: String = row.try_get("name").unwrap_or_default();
        let config_json: String = row.try_get("config_json").unwrap_or_default();

        let stored = StoredProviderConfig::parse_lenient(&config_json);
        let provider = create_provider(&provider_type, &stored, config)?;

        providers.push(RegisteredProvider {
            connection_id,
            provider_type,
            name,
            enabled: true,
            provider,
        });
    }

    if providers.is_empty() {
        let (backend_type, default_name) = match config.backend {
            MusicBackendKind::Jellyfin => ("jellyfin", "Jellyfin"),
            MusicBackendKind::Navidrome => ("navidrome", "Navidrome"),
        };
        let provider = create_provider(backend_type, &StoredProviderConfig::default(), config)?;
        providers.push(RegisteredProvider {
            connection_id: format!("env-{backend_type}"),
            provider_type: backend_type.to_owned(),
            name: default_name.to_owned(),
            enabled: true,
            provider,
        });
    }

    Ok(BackendRegistry::new(providers))
}

fn non_empty_or(primary: &str, fallback: Option<&str>) -> String {
    if !primary.trim().is_empty() {
        return primary.to_owned();
    }
    fallback
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_default()
        .to_owned()
}
