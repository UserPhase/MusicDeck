//! # Central Plugin Registry & First-Party Plugins (`plugins::registry`)
//!
//! Ports `server/src/plugins/plugin-registry.ts` and `server/src/plugins/first-party.ts`:
//! - [`MusicDeckPlugin`] trait (`manifest`, `validate_config`, `register`, `test`)
//! - [`PluginRegistry`]:
//!   - Manages first-party and third-party custom plugins (`plugin_configs`, `custom_plugins`)
//!   - Enforces explicit permission approval (`approved_permissions`)
//!   - Redacts secret configuration fields (`redact_config_presence`)
//!   - Tracks and toggles registered source/pipeline providers when plugins are enabled/disabled
//! - Built-in first-party plugins:
//!   - [`ListenBrainzPlugin`] (`id = "listenbrainz"`)
//!   - [`LastFmPlugin`] (`id = "lastfm"`)
//!   - [`MusicBrainzPlugin`] (`id = "musicbrainz"`)
//!   - [`ExternalArtworkPlugin`] (`id = "external-artwork"`)
//!   - [`SpotDLDownloaderPlugin`] (`id = "spotdl-downloader"`)

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use tokio::sync::Mutex;

use crate::acquisition::SpotDLOutputFormat;
use crate::db::{DbPool, begin_sqlite_write};
use crate::plugins::manifest::{
    PluginConfigField, PluginConfigOption, PluginConfigSpec, PluginErrorClassification,
    PluginErrorStatus, PluginManifest, classify_plugin_error, validate_manifest,
};
use crate::scrobbling::{LastFmCredentials, LastFmScrobbler, ListenBrainzScrobbler};

/// Origin of a registered plugin (`"first-party" | "third-party"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginOrigin {
    FirstParty,
    ThirdParty,
}

/// Log entry recorded per plugin (`PluginLog`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLog {
    pub level: String,
    pub message: String,
    pub created_at: String,
}

/// Trait implemented by first-party and custom plugins (`MusicDeckPlugin`).
#[async_trait]
pub trait MusicDeckPlugin: Send + Sync {
    /// Returns the plugin's [`PluginManifest`].
    fn manifest(&self) -> &PluginManifest;

    /// Validates a configuration object before persistence.
    fn validate_config(&self, _config: &Value) -> Result<(), PluginErrorClassification> {
        Ok(())
    }

    /// Invoked when the plugin is enabled.
    async fn on_enable(
        &self,
        _config: &Value,
        _approved_permissions: &HashSet<String>,
    ) -> Result<(), PluginErrorClassification> {
        Ok(())
    }

    /// Connectivity and credential test probe.
    async fn test(
        &self,
        _config: &Value,
        approved_permissions: &HashSet<String>,
    ) -> Result<(bool, String), PluginErrorClassification> {
        for req_perm in self.manifest().permissions.as_deref().unwrap_or(&[]) {
            if !approved_permissions.contains(req_perm) {
                return Err(PluginErrorClassification {
                    status: PluginErrorStatus::PermissionDenied,
                    message: String::from("Plugin is missing an approved permission"),
                });
            }
        }
        Ok((true, format!("{} is configured", self.manifest().name)))
    }
}

struct CustomManifestPlugin {
    manifest: PluginManifest,
}

#[async_trait]
impl MusicDeckPlugin for CustomManifestPlugin {
    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }
}

#[derive(Clone)]
struct PluginSettings {
    enabled: bool,
    config: Value,
    permissions: Vec<String>,
}

impl Default for PluginSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            config: json!({}),
            permissions: Vec::new(),
        }
    }
}

#[derive(Clone)]
struct PluginRuntimeState {
    plugin: Arc<dyn MusicDeckPlugin>,
    origin: PluginOrigin,
    settings: Option<PluginSettings>,
}

impl PluginRuntimeState {
    fn new(plugin: Arc<dyn MusicDeckPlugin>, origin: PluginOrigin) -> Self {
        Self {
            plugin,
            origin,
            settings: Some(PluginSettings::default()),
        }
    }
}

/// A plugin registry operation that could not be completed.
#[derive(Debug, thiserror::Error)]
pub enum PluginRegistryError {
    #[error("Unknown plugin")]
    Unknown,
    #[error("Plugin is already registered")]
    AlreadyRegistered,
    #[error("Only custom plugins can be uninstalled")]
    NotUninstallable,
    #[error(transparent)]
    InvalidManifest(#[from] super::manifest::ManifestValidationError),
    #[error("Plugin configuration must be a JSON object")]
    InvalidConfiguration,
    #[error("Stored plugin configuration is invalid")]
    InvalidStoredConfiguration,
    #[error("Plugin operation failed")]
    Rejected(PluginErrorClassification),
    #[error("Plugin database operation failed: {0}")]
    Database(#[from] sqlx::Error),
}

impl From<PluginErrorClassification> for PluginRegistryError {
    fn from(error: PluginErrorClassification) -> Self {
        Self::Rejected(error)
    }
}

fn missing_required_fields<'a>(
    manifest: &'a PluginManifest,
    config: &Value,
) -> Vec<&'a PluginConfigField> {
    let Some(ref spec) = manifest.config else {
        return Vec::new();
    };
    let obj = config.as_object();
    spec.fields
        .iter()
        .filter(|f| f.required)
        .filter(|f| {
            let val = obj.and_then(|m| m.get(&f.key));
            match val {
                None | Some(Value::Null) => true,
                Some(Value::String(s)) => s.is_empty(),
                _ => false,
            }
        })
        .collect()
}

fn redact_plugin_config(manifest: &PluginManifest, config: &Value) -> Value {
    let Some(obj) = config.as_object() else {
        return json!({});
    };
    let secret_keys: HashSet<&str> = manifest
        .config
        .as_ref()
        .map(|c| {
            c.fields
                .iter()
                .filter(|f| f.secret)
                .map(|f| f.key.as_str())
                .collect()
        })
        .unwrap_or_default();

    let mut out = serde_json::Map::new();
    for (k, v) in obj {
        let lower = k.to_ascii_lowercase();
        let is_secret = secret_keys.contains(k.as_str())
            || lower.contains("secret")
            || lower.contains("token")
            || lower.contains("password")
            || lower.contains("apikey")
            || lower.contains("api_key")
            || lower.contains("cookies");
        if is_secret {
            let has_val = match v {
                Value::String(s) => !s.trim().is_empty(),
                Value::Null => false,
                _ => true,
            };
            out.insert(k.clone(), Value::Bool(has_val));
        } else {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

/// Central registry managing built-in and custom plugins (`PluginRegistry`).
#[derive(Clone)]
pub struct PluginRegistry {
    db: Option<DbPool>,
    plugins: Arc<Mutex<Vec<PluginRuntimeState>>>,
}

impl std::fmt::Debug for PluginRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginRegistry").finish()
    }
}

impl PluginRegistry {
    /// Creates a registry pre-populated with first-party plugins.
    #[must_use]
    pub fn new(db: Option<DbPool>) -> Self {
        let builtins: Vec<Arc<dyn MusicDeckPlugin>> = vec![
            Arc::new(ListenBrainzPlugin::new()),
            Arc::new(LastFmPlugin::new()),
            Arc::new(MusicBrainzPlugin::new()),
            Arc::new(ExternalArtworkPlugin::new()),
            Arc::new(SpotDLDownloaderPlugin::new()),
        ];
        let states = builtins
            .into_iter()
            .map(|plugin| {
                validate_manifest(plugin.manifest()).expect("valid built-in plugin manifest");
                PluginRuntimeState::new(plugin, PluginOrigin::FirstParty)
            })
            .collect();
        Self {
            db,
            plugins: Arc::new(Mutex::new(states)),
        }
    }

    /// Rehydrates registered manifests and settings from a consistent SQLite snapshot.
    pub async fn reload_installed(&self) -> Result<(), PluginRegistryError> {
        let mut states = self.plugins.lock().await;
        self.refresh_locked(&mut states).await
    }

    async fn refresh_locked(
        &self,
        states: &mut Vec<PluginRuntimeState>,
    ) -> Result<(), PluginRegistryError> {
        let Some(pool) = &self.db else {
            return Ok(());
        };
        let mut tx = pool.inner().begin().await?;
        let snapshot = Self::read_snapshot(&mut tx, states).await?;
        tx.commit().await?;
        *states = snapshot;
        Ok(())
    }

    async fn read_snapshot(
        conn: &mut SqliteConnection,
        previous: &[PluginRuntimeState],
    ) -> Result<Vec<PluginRuntimeState>, sqlx::Error> {
        let mut states: Vec<_> = previous
            .iter()
            .filter(|state| state.origin == PluginOrigin::FirstParty)
            .cloned()
            .collect();
        let manifests: Vec<(String, String)> = sqlx::query_as(
            "SELECT plugin_id, manifest_json FROM custom_plugins ORDER BY installed_at, plugin_id",
        )
        .fetch_all(&mut *conn)
        .await?;
        for (id, raw) in manifests {
            let manifest = serde_json::from_str::<PluginManifest>(&raw)
                .ok()
                .filter(|manifest| {
                    manifest.id == id
                        && validate_manifest(manifest).is_ok()
                        && !states.iter().any(|state| state.plugin.manifest().id == id)
                });
            if let Some(manifest) = manifest {
                states.push(PluginRuntimeState::new(
                    Arc::new(CustomManifestPlugin { manifest }),
                    PluginOrigin::ThirdParty,
                ));
            } else {
                tracing::warn!(plugin_id = %id, "Skipping invalid persisted custom plugin manifest");
            }
        }

        let settings = sqlx::query(
            "SELECT plugin_id, enabled, config_json, permissions_json FROM plugin_configs",
        )
        .fetch_all(&mut *conn)
        .await?;
        let mut settings_by_id = HashMap::with_capacity(settings.len());
        for row in settings {
            let id: String = row.try_get("plugin_id")?;
            let enabled = row.try_get::<i64, _>("enabled")? != 0;
            let config: String = row.try_get("config_json")?;
            let permissions: String = row.try_get("permissions_json")?;
            let decoded = serde_json::from_str::<Value>(&config)
                .ok()
                .filter(Value::is_object)
                .zip(serde_json::from_str::<Vec<String>>(&permissions).ok())
                .map(|(config, permissions)| PluginSettings {
                    enabled,
                    config,
                    permissions,
                });
            settings_by_id.insert(id, decoded);
        }
        for state in &mut states {
            state.settings = settings_by_id
                .remove(&state.plugin.manifest().id)
                .unwrap_or_else(|| Some(PluginSettings::default()));
            if let Some(settings) = &mut state.settings {
                let declared = state
                    .plugin
                    .manifest()
                    .permissions
                    .as_deref()
                    .unwrap_or(&[]);
                settings
                    .permissions
                    .retain(|permission| declared.contains(permission));
            }
        }
        Ok(states)
    }

    async fn begin_update(
        &self,
        states: &[PluginRuntimeState],
    ) -> Result<
        (
            Vec<PluginRuntimeState>,
            Option<Transaction<'static, Sqlite>>,
        ),
        PluginRegistryError,
    > {
        let Some(pool) = &self.db else {
            return Ok((states.to_vec(), None));
        };
        // Reserve the SQLite writer before reading settings used by a partial patch.
        let mut tx = begin_sqlite_write(
            pool.inner(),
            "UPDATE plugin_configs SET enabled = enabled WHERE 0",
        )
        .await?;
        let snapshot = Self::read_snapshot(&mut tx, states).await?;
        Ok((snapshot, Some(tx)))
    }

    /// Installs a custom plugin disabled and without permission grants.
    pub async fn install_custom_plugin(
        &self,
        manifest: PluginManifest,
    ) -> Result<Value, PluginRegistryError> {
        validate_manifest(&manifest)?;
        let mut states = self.plugins.lock().await;
        let (mut snapshot, tx) = self.begin_update(&states).await?;
        let id = &manifest.id;
        if snapshot
            .iter()
            .any(|state| state.plugin.manifest().id == *id)
        {
            return Err(PluginRegistryError::AlreadyRegistered);
        }
        let mut installed = PluginRuntimeState::new(
            Arc::new(CustomManifestPlugin {
                manifest: manifest.clone(),
            }),
            PluginOrigin::ThirdParty,
        );
        if let Some(mut tx) = tx {
            let now = Utc::now().to_rfc3339();
            let inserted = sqlx::query(
                "INSERT INTO custom_plugins (plugin_id, manifest_json, installed_at) VALUES (?, ?, ?)
                 ON CONFLICT(plugin_id) DO NOTHING",
            ).bind(id).bind(json!(manifest).to_string()).bind(&now).execute(&mut *tx).await?;
            if inserted.rows_affected() != 1 {
                return Err(PluginRegistryError::AlreadyRegistered);
            }
            let config: Option<String> =
                sqlx::query_scalar("SELECT config_json FROM plugin_configs WHERE plugin_id = ?")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?;
            let config = config
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({}));
            let settings = PluginSettings {
                config,
                ..PluginSettings::default()
            };
            Self::store_settings(&mut tx, id, &settings).await?;
            tx.commit().await?;
            installed.settings = Some(settings);
        }
        let description = describe_plugin(&installed, true);
        snapshot.push(installed);
        *states = snapshot;
        Ok(description)
    }

    /// Removes a custom plugin and its configuration together.
    pub async fn uninstall_plugin(&self, plugin_id: &str) -> Result<(), PluginRegistryError> {
        let mut states = self.plugins.lock().await;
        let (mut snapshot, tx) = self.begin_update(&states).await?;
        let index = snapshot
            .iter()
            .position(|state| state.plugin.manifest().id == plugin_id)
            .ok_or(PluginRegistryError::Unknown)?;
        if snapshot[index].origin != PluginOrigin::ThirdParty {
            return Err(PluginRegistryError::NotUninstallable);
        }
        if let Some(mut tx) = tx {
            sqlx::query("DELETE FROM plugin_configs WHERE plugin_id = ?")
                .bind(plugin_id)
                .execute(&mut *tx)
                .await?;
            let removed = sqlx::query("DELETE FROM custom_plugins WHERE plugin_id = ?")
                .bind(plugin_id)
                .execute(&mut *tx)
                .await?;
            if removed.rows_affected() != 1 {
                return Err(sqlx::Error::RowNotFound.into());
            }
            tx.commit().await?;
        }
        snapshot.remove(index);
        *states = snapshot;
        Ok(())
    }

    /// Merges an admin patch and commits configuration, approvals and enabled state together.
    pub async fn configure(
        &self,
        plugin_id: &str,
        enabled: Option<bool>,
        config: Option<Value>,
        permissions: Option<Vec<String>>,
    ) -> Result<Value, PluginRegistryError> {
        let mut states = self.plugins.lock().await;
        let (mut snapshot, tx) = self.begin_update(&states).await?;
        let state = snapshot
            .iter_mut()
            .find(|state| state.plugin.manifest().id == plugin_id)
            .ok_or(PluginRegistryError::Unknown)?;
        let manifest = state.plugin.manifest();
        let mut settings = state
            .settings
            .take()
            .ok_or(PluginRegistryError::InvalidStoredConfiguration)?;
        if let Some(config) = config {
            let Value::Object(patch) = config else {
                return Err(PluginRegistryError::InvalidConfiguration);
            };
            settings
                .config
                .as_object_mut()
                .expect("stored configuration is an object")
                .extend(patch);
            state.plugin.validate_config(&settings.config)?;
        }
        if let Some(permissions) = permissions {
            let declared = manifest.permissions.as_deref().unwrap_or(&[]);
            if permissions
                .iter()
                .any(|permission| !declared.contains(permission))
            {
                return Err(PluginErrorClassification {
                    status: PluginErrorStatus::PermissionDenied,
                    message: String::from("Plugin is missing an approved permission"),
                }
                .into());
            }
            settings.permissions = permissions;
        }
        if let Some(enabled) = enabled {
            settings.enabled = enabled;
        }
        if settings.enabled {
            if !missing_required_fields(manifest, &settings.config).is_empty() {
                return Err(PluginErrorClassification {
                    status: PluginErrorStatus::NotConfigured,
                    message: String::from("Plugin is misconfigured"),
                }
                .into());
            }
            state.plugin.validate_config(&settings.config)?;
            if enabled == Some(true) {
                let approved = settings.permissions.iter().cloned().collect();
                state.plugin.on_enable(&settings.config, &approved).await?;
            }
        }
        if let Some(mut tx) = tx {
            Self::store_settings(&mut tx, plugin_id, &settings).await?;
            tx.commit().await?;
        }
        state.settings = Some(settings);
        let description = describe_plugin(state, true);
        *states = snapshot;
        Ok(description)
    }

    async fn store_settings(
        conn: &mut SqliteConnection,
        plugin_id: &str,
        settings: &PluginSettings,
    ) -> Result<(), sqlx::Error> {
        let changed = sqlx::query(
            "INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(plugin_id) DO UPDATE SET enabled = excluded.enabled, config_json = excluded.config_json,
               permissions_json = excluded.permissions_json, updated_at = excluded.updated_at",
        ).bind(plugin_id).bind(settings.enabled).bind(settings.config.to_string())
            .bind(json!(settings.permissions).to_string()).bind(Utc::now().to_rfc3339())
            .execute(conn).await?;
        if changed.rows_affected() != 1 {
            return Err(sqlx::Error::RowNotFound);
        }
        Ok(())
    }

    /// Enables a plugin after checking its configuration.
    pub async fn enable(&self, plugin_id: &str) -> Result<(), PluginRegistryError> {
        self.configure(plugin_id, Some(true), None, None)
            .await
            .map(|_| ())
    }

    /// Disables a plugin and preserves its saved configuration.
    pub async fn disable(&self, plugin_id: &str) -> Result<(), PluginRegistryError> {
        self.configure(plugin_id, Some(false), None, None)
            .await
            .map(|_| ())
    }

    /// Lists registered plugins from committed state.
    pub async fn list(&self, admin: bool) -> Result<Vec<Value>, PluginRegistryError> {
        let mut states = self.plugins.lock().await;
        // Refresh from SQLite even after an abandoned request or runtime restore.
        self.refresh_locked(&mut states).await?;
        Ok(states
            .iter()
            .map(|state| describe_plugin(state, admin))
            .collect())
    }

    /// Retrieves the committed descriptor for one plugin.
    pub async fn get(
        &self,
        plugin_id: &str,
        admin: bool,
    ) -> Result<Option<Value>, PluginRegistryError> {
        let mut states = self.plugins.lock().await;
        self.refresh_locked(&mut states).await?;
        Ok(states
            .iter()
            .find(|state| state.plugin.manifest().id == plugin_id)
            .map(|state| describe_plugin(state, admin)))
    }

    /// Runs the connectivity/configuration test for `plugin_id`.
    pub async fn test(&self, plugin_id: &str) -> Result<Value, PluginRegistryError> {
        let state = {
            let mut states = self.plugins.lock().await;
            self.refresh_locked(&mut states).await?;
            states
                .iter()
                .find(|state| state.plugin.manifest().id == plugin_id)
                .cloned()
                .ok_or(PluginRegistryError::Unknown)?
        };
        let settings = state
            .settings
            .ok_or(PluginRegistryError::InvalidStoredConfiguration)?;
        if !missing_required_fields(state.plugin.manifest(), &settings.config).is_empty() {
            return Ok(json!({
                "id": plugin_id, "ok": false, "status": "not_configured",
                "message": "Plugin is not fully configured",
            }));
        }
        let approved = settings.permissions.into_iter().collect();
        match state.plugin.test(&settings.config, &approved).await {
            Ok((ok, message)) => Ok(json!({
                "id": plugin_id, "ok": ok, "status": if ok { "success" } else { "provider_unavailable" }, "message": message,
            })),
            Err(error) => Ok(json!({
                "id": plugin_id, "ok": false, "status": error.status.as_str(), "message": error.message,
            })),
        }
    }
}

fn describe_plugin(st: &PluginRuntimeState, admin: bool) -> Value {
    let m = st.plugin.manifest();
    let defaults = PluginSettings::default();
    let settings = st.settings.as_ref().unwrap_or(&defaults);
    let cfg = &settings.config;
    let missing = missing_required_fields(m, cfg);
    let (status, health) = if st.settings.is_none() {
        ("error", "error")
    } else if settings.enabled {
        ("enabled", "healthy")
    } else if !missing.is_empty() {
        ("disabled", "unconfigured")
    } else {
        ("disabled", "disabled")
    };
    let config_fields: Vec<Value> = m
        .config
        .as_ref()
        .map(|c| {
            c.fields
                .iter()
                .map(|f| {
                    let val_opt = cfg.as_object().and_then(|o| o.get(&f.key));
                    let configured = match val_opt {
                        None | Some(Value::Null) => false,
                        Some(Value::String(s)) => !s.is_empty(),
                        _ => true,
                    };
                    let mut obj = json!({
                        "key": f.key,
                        "label": f.label.as_deref().unwrap_or(&f.key),
                        "type": f.field_type,
                        "options": f.options,
                        "description": f.description,
                        "secret": f.secret,
                        "required": f.required,
                        "configured": configured,
                    });
                    if !f.secret {
                        if let Some(ref def) = f.default {
                            obj["default"] = def.clone();
                        }
                    }
                    obj
                })
                .collect()
        })
        .unwrap_or_default();

    let mut item = json!({
        "id": m.id,
        "name": m.name,
        "version": m.version,
        "description": m.description,
        "author": m.author,
        "origin": st.origin,
        "capabilities": m.capabilities,
        "permissions": m.permissions.clone().unwrap_or_default(),
        "approvedPermissions": settings.permissions,
        "enabled": settings.enabled,
        "status": status,
        "health": health,
        "config": if admin { redact_plugin_config(m, cfg) } else { json!({}) },
        "configFields": config_fields,
        "configRequired": missing.iter().map(|f| &f.key).collect::<Vec<_>>(),
        "uiExtensions": [],
    });

    if admin {
        item["logs"] = json!([]);
        item["error"] = json!(st.settings.is_none().then_some("invalid_configuration"));
    }
    item
}

// ============================================================================
// Built-In First-Party Plugins (`server/src/plugins/first-party.ts`)
// ============================================================================

/// Built-in ListenBrainz scrobbler plugin (`id = "listenbrainz"`).
pub struct ListenBrainzPlugin {
    manifest: PluginManifest,
}

impl Default for ListenBrainzPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl ListenBrainzPlugin {
    /// Creates a new [`ListenBrainzPlugin`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            manifest: PluginManifest {
                id: String::from("listenbrainz"),
                name: String::from("ListenBrainz"),
                version: String::from("2.0.0"),
                description: Some(String::from(
                    "Allow users to connect ListenBrainz in Settings. Qualified listens use a durable per-user queue.",
                )),
                author: None,
                capabilities: vec![String::from("scrobble")],
                permissions: Some(vec![
                    String::from("history.read"),
                    String::from("network.request"),
                ]),
                config: Some(PluginConfigSpec {
                    fields: vec![PluginConfigField {
                        key: String::from("token"),
                        label: Some(String::from("Optional administrator test token")),
                        field_type: None,
                        options: None,
                        description: None,
                        secret: true,
                        required: false,
                        default: None,
                    }],
                }),
            },
        }
    }
}

#[async_trait]
impl MusicDeckPlugin for ListenBrainzPlugin {
    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    async fn test(
        &self,
        config: &Value,
        approved_permissions: &HashSet<String>,
    ) -> Result<(bool, String), PluginErrorClassification> {
        if !approved_permissions.contains("network.request") {
            return Err(PluginErrorClassification {
                status: PluginErrorStatus::PermissionDenied,
                message: String::from("Plugin is missing an approved permission"),
            });
        }
        let token = config
            .get("token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let Some(token) = token else {
            return Ok((
                true,
                String::from(
                    "Enabled for per-user connections in Settings. No shared account receives listens.",
                ),
            ));
        };
        let client = ListenBrainzScrobbler::new(token)
            .map_err(|e| classify_plugin_error(&e.message))?;
        let username = client
            .validate_token()
            .await
            .map_err(|e| classify_plugin_error(&e.message))?;
        Ok((
            true,
            format!(
                "Validated ListenBrainz account {username}. Users connect their own accounts in Settings."
            ),
        ))
    }
}

/// Built-in Last.fm scrobbler plugin (`id = "lastfm"`).
pub struct LastFmPlugin {
    manifest: PluginManifest,
}

impl Default for LastFmPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl LastFmPlugin {
    /// Creates a new [`LastFmPlugin`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            manifest: PluginManifest {
                id: String::from("lastfm"),
                name: String::from("Last.fm"),
                version: String::from("2.0.0"),
                description: Some(String::from(
                    "Configure application credentials, then let each user authorize Last.fm in Settings.",
                )),
                author: None,
                capabilities: vec![String::from("scrobble")],
                permissions: Some(vec![
                    String::from("history.read"),
                    String::from("network.request"),
                ]),
                config: Some(PluginConfigSpec {
                    fields: vec![
                        PluginConfigField {
                            key: String::from("apiKey"),
                            label: Some(String::from("Application API key")),
                            field_type: None,
                            options: None,
                            description: None,
                            secret: true,
                            required: true,
                            default: None,
                        },
                        PluginConfigField {
                            key: String::from("apiSecret"),
                            label: Some(String::from("Application shared secret")),
                            field_type: None,
                            options: None,
                            description: None,
                            secret: true,
                            required: true,
                            default: None,
                        },
                        PluginConfigField {
                            key: String::from("sessionKey"),
                            label: Some(String::from("Optional administrator test session")),
                            field_type: None,
                            options: None,
                            description: None,
                            secret: true,
                            required: false,
                            default: None,
                        },
                    ],
                }),
            },
        }
    }
}

#[async_trait]
impl MusicDeckPlugin for LastFmPlugin {
    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    async fn test(
        &self,
        config: &Value,
        approved_permissions: &HashSet<String>,
    ) -> Result<(bool, String), PluginErrorClassification> {
        if !approved_permissions.contains("network.request") {
            return Err(PluginErrorClassification {
                status: PluginErrorStatus::PermissionDenied,
                message: String::from("Plugin is missing an approved permission"),
            });
        }
        let api_key = config
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let api_secret = config
            .get("apiSecret")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let session_key = config
            .get("sessionKey")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned);

        let scrobbler = LastFmScrobbler::new(LastFmCredentials {
            api_key,
            api_secret,
            session_key: session_key.clone(),
        })
        .map_err(|e| classify_plugin_error(&e.message))?;

        if session_key.is_some() {
            scrobbler
                .validate_session()
                .await
                .map_err(|e| classify_plugin_error(&e.message))?;
        } else {
            scrobbler
                .validate_application()
                .await
                .map_err(|e| classify_plugin_error(&e.message))?;
        }

        Ok((
            true,
            String::from(
                "Last.fm credentials validated. Users authorize their own accounts in Settings.",
            ),
        ))
    }
}

/// Built-in MusicBrainz metadata plugin (`id = "musicbrainz"`).
pub struct MusicBrainzPlugin {
    manifest: PluginManifest,
}

impl Default for MusicBrainzPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl MusicBrainzPlugin {
    /// Creates a new [`MusicBrainzPlugin`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            manifest: PluginManifest {
                id: String::from("musicbrainz"),
                name: String::from("MusicBrainz Metadata"),
                version: String::from("1.0.0"),
                description: Some(String::from(
                    "Provides canonical metadata lookups without modifying library files.",
                )),
                author: None,
                capabilities: vec![String::from("metadata")],
                permissions: Some(vec![String::from("network.request")]),
                config: Some(PluginConfigSpec {
                    fields: vec![PluginConfigField {
                        key: String::from("contact"),
                        label: Some(String::from("Contact URL or email")),
                        field_type: None,
                        options: None,
                        description: None,
                        secret: false,
                        required: false,
                        default: None,
                    }],
                }),
            },
        }
    }
}

#[async_trait]
impl MusicDeckPlugin for MusicBrainzPlugin {
    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    async fn test(
        &self,
        _config: &Value,
        approved_permissions: &HashSet<String>,
    ) -> Result<(bool, String), PluginErrorClassification> {
        if !approved_permissions.contains("network.request") {
            return Err(PluginErrorClassification {
                status: PluginErrorStatus::PermissionDenied,
                message: String::from("Plugin is missing an approved permission"),
            });
        }
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("MusicDeck/1.0 (metadata-plugin)")
            .build()
            .unwrap_or_default();
        let resp = http
            .get("https://musicbrainz.org/ws/2/artist/?query=artist:test&fmt=json&limit=1")
            .send()
            .await
            .map_err(|e| classify_plugin_error(&e.to_string()))?;
        let ok = resp.status().is_success();
        Ok((
            ok,
            if ok {
                String::from("MusicBrainz is reachable")
            } else {
                String::from("MusicBrainz is unavailable")
            },
        ))
    }
}

/// Built-in External Artwork plugin (`id = "external-artwork"`).
pub struct ExternalArtworkPlugin {
    manifest: PluginManifest,
}

impl Default for ExternalArtworkPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl ExternalArtworkPlugin {
    /// Creates a new [`ExternalArtworkPlugin`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            manifest: PluginManifest {
                id: String::from("external-artwork"),
                name: String::from("External Artwork"),
                version: String::from("1.0.0"),
                description: Some(String::from(
                    "Resolves safe external artwork through MusicDeck's artwork proxy model.",
                )),
                author: None,
                capabilities: vec![String::from("artwork")],
                permissions: Some(vec![String::from("network.request")]),
                config: Some(PluginConfigSpec {
                    fields: vec![PluginConfigField {
                        key: String::from("preferredProvider"),
                        label: Some(String::from("Preferred provider")),
                        field_type: None,
                        options: None,
                        description: None,
                        secret: false,
                        required: false,
                        default: Some(json!("itunes")),
                    }],
                }),
            },
        }
    }
}

#[async_trait]
impl MusicDeckPlugin for ExternalArtworkPlugin {
    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    async fn test(
        &self,
        _config: &Value,
        approved_permissions: &HashSet<String>,
    ) -> Result<(bool, String), PluginErrorClassification> {
        if !approved_permissions.contains("network.request") {
            return Err(PluginErrorClassification {
                status: PluginErrorStatus::PermissionDenied,
                message: String::from("Plugin is missing an approved permission"),
            });
        }
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        let resp = http
            .get("https://itunes.apple.com/search?term=test&media=music&entity=album&limit=1")
            .send()
            .await
            .map_err(|e| classify_plugin_error(&e.to_string()))?;
        let ok = resp.status().is_success();
        Ok((
            ok,
            if ok {
                String::from("Artwork provider is reachable")
            } else {
                String::from("Artwork provider is unavailable")
            },
        ))
    }
}

/// Built-in SpotDL Downloader plugin (`id = "spotdl-downloader"`).
pub struct SpotDLDownloaderPlugin {
    manifest: PluginManifest,
}

impl Default for SpotDLDownloaderPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl SpotDLDownloaderPlugin {
    /// Creates a new [`SpotDLDownloaderPlugin`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            manifest: PluginManifest {
                id: String::from("spotdl-downloader"),
                name: String::from("SpotDL Downloader"),
                version: String::from("1.0.0"),
                description: Some(String::from(
                    "Configures the shared download format, Spotify credentials, optional YouTube cookies, and downloader paths.",
                )),
                author: None,
                capabilities: vec![String::from("acquisition")],
                permissions: Some(vec![
                    String::from("library.acquire"),
                    String::from("network.request"),
                ]),
                config: Some(PluginConfigSpec {
                    fields: vec![
                        PluginConfigField {
                            key: String::from("outputFormat"),
                            label: Some(String::from("Audio format")),
                            field_type: Some(String::from("select")),
                            options: Some(vec![
                                PluginConfigOption {
                                    value: json!("best"),
                                    label: String::from("Default (M4A) - recommended"),
                                },
                                PluginConfigOption {
                                    value: json!("m4a"),
                                    label: String::from("M4A (AAC)"),
                                },
                                PluginConfigOption {
                                    value: json!("opus"),
                                    label: String::from("Opus"),
                                },
                                PluginConfigOption {
                                    value: json!("mp3"),
                                    label: String::from("MP3 — 320 kbps, broad compatibility"),
                                },
                                PluginConfigOption {
                                    value: json!("flac"),
                                    label: String::from("FLAC — larger files"),
                                },
                                PluginConfigOption {
                                    value: json!("ogg"),
                                    label: String::from("OGG Vorbis"),
                                },
                                PluginConfigOption {
                                    value: json!("wav"),
                                    label: String::from("WAV — uncompressed, very large files"),
                                },
                            ]),
                            description: Some(String::from(
                                "Applies to spotDL and Deezer/YouTube Music downloads.",
                            )),
                            secret: false,
                            required: false,
                            default: Some(json!("best")),
                        },
                        PluginConfigField {
                            key: String::from("spotdlPath"),
                            label: Some(String::from(
                                "spotDL executable (leave blank for auto-detect)",
                            )),
                            field_type: None,
                            options: None,
                            description: None,
                            secret: false,
                            required: false,
                            default: None,
                        },
                        PluginConfigField {
                            key: String::from("ffmpegPath"),
                            label: Some(String::from(
                                "FFmpeg executable (leave blank for auto-detect)",
                            )),
                            field_type: None,
                            options: None,
                            description: None,
                            secret: false,
                            required: false,
                            default: None,
                        },
                        PluginConfigField {
                            key: String::from("clientId"),
                            label: Some(String::from("Spotify Client ID")),
                            field_type: None,
                            options: None,
                            description: None,
                            secret: false,
                            required: false,
                            default: None,
                        },
                        PluginConfigField {
                            key: String::from("clientSecret"),
                            label: Some(String::from("Spotify Client Secret")),
                            field_type: None,
                            options: None,
                            description: None,
                            secret: true,
                            required: false,
                            default: None,
                        },
                        PluginConfigField {
                            key: String::from("youtubeCookies"),
                            label: Some(String::from(
                                "YouTube cookies (Netscape format) — optional",
                            )),
                            field_type: Some(String::from("textarea")),
                            options: None,
                            description: None,
                            secret: true,
                            required: false,
                            default: None,
                        },
                    ],
                }),
            },
        }
    }
}

#[async_trait]
impl MusicDeckPlugin for SpotDLDownloaderPlugin {
    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    fn validate_config(&self, config: &Value) -> Result<(), PluginErrorClassification> {
        SpotDLOutputFormat::from_plugin_config(config).map_err(|msg| PluginErrorClassification {
            status: PluginErrorStatus::NotConfigured,
            message: msg,
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use crate::db::run_migrations;
    use crate::plugins::parse_custom_manifest;
    use crate::{AppConfig, AppState};

    fn manifest(id: &str) -> PluginManifest {
        parse_custom_manifest(&json!({
            "manifestVersion": 1, "id": id, "name": "Fixture plugin", "version": "1.0.0",
            "capabilities": ["lyrics"], "permissions": ["network.request"],
            "configuration": {"token": {"type": "secret", "required": true}},
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn startup_rehydrates_valid_custom_plugins_with_committed_settings() {
        let db = DbPool::connect_memory().await.unwrap();
        run_migrations(&db, None).await.unwrap();
        let plugins = PluginRegistry::new(Some(db.clone()));
        plugins
            .install_custom_plugin(manifest("fixture.lyrics"))
            .await
            .unwrap();
        plugins
            .configure(
                "fixture.lyrics",
                Some(true),
                Some(json!({"token": "secret", "region": "nl"})),
                Some(vec!["network.request".into()]),
            )
            .await
            .unwrap();
        for (id, value) in [
            ("wrong-row-id", json!(manifest("embedded-id")).to_string()),
            ("invalid", "{}".into()),
            ("lastfm", json!(manifest("lastfm")).to_string()),
        ] {
            sqlx::query("INSERT INTO custom_plugins (plugin_id, manifest_json, installed_at) VALUES (?, ?, '2026')")
                .bind(id).bind(value).execute(db.inner()).await.unwrap();
        }

        let state = AppState::with_database(AppConfig::default(), db.clone())
            .await
            .unwrap();
        {
            let loaded = state.plugins().plugins.lock().await;
            assert!(loaded.iter().any(|state| {
                state.origin == PluginOrigin::ThirdParty
                    && state.plugin.manifest().id == "fixture.lyrics"
                    && state
                        .settings
                        .as_ref()
                        .is_some_and(|settings| settings.enabled)
            }));
            assert_eq!(
                loaded
                    .iter()
                    .filter(|state| state.origin == PluginOrigin::ThirdParty)
                    .count(),
                1
            );
        }
        let installed = state
            .plugins()
            .get("fixture.lyrics", true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(installed["enabled"], true);
        assert_eq!(installed["config"], json!({"token": true, "region": "nl"}));
        assert_eq!(installed["approvedPermissions"], json!(["network.request"]));
        assert_eq!(
            state.plugins().get("lastfm", true).await.unwrap().unwrap()["origin"],
            "first-party"
        );

        sqlx::query("DROP TABLE custom_plugins")
            .execute(db.inner())
            .await
            .unwrap();
        let error = AppState::with_database(AppConfig::default(), db)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            crate::state::AppStateInitError::Plugins(PluginRegistryError::Database(_))
        ));
    }

    #[tokio::test]
    async fn failed_plugin_writes_leave_the_prior_manifest_and_configuration_intact() {
        let db = DbPool::connect_memory().await.unwrap();
        run_migrations(&db, None).await.unwrap();
        let registry = PluginRegistry::new(Some(db.clone()));
        sqlx::query("CREATE TRIGGER fail_install BEFORE INSERT ON plugin_configs BEGIN SELECT RAISE(ABORT, 'fixture'); END")
            .execute(db.inner()).await.unwrap();
        assert!(matches!(
            registry
                .install_custom_plugin(manifest("fixture.lyrics"))
                .await,
            Err(PluginRegistryError::Database(_))
        ));
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM custom_plugins")
            .fetch_one(db.inner())
            .await
            .unwrap();
        assert_eq!(count, 0);
        assert!(
            registry
                .get("fixture.lyrics", true)
                .await
                .unwrap()
                .is_none()
        );

        sqlx::query("DROP TRIGGER fail_install")
            .execute(db.inner())
            .await
            .unwrap();
        registry
            .install_custom_plugin(manifest("fixture.lyrics"))
            .await
            .unwrap();
        registry
            .configure(
                "fixture.lyrics",
                Some(true),
                Some(json!({"token": "secret"})),
                None,
            )
            .await
            .unwrap();
        let before = registry.get("fixture.lyrics", true).await.unwrap().unwrap();
        sqlx::raw_sql(
            "CREATE TRIGGER fail_config BEFORE UPDATE ON plugin_configs BEGIN SELECT RAISE(ABORT, 'fixture'); END;
             CREATE TRIGGER fail_removal BEFORE DELETE ON custom_plugins BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
        ).execute(db.inner()).await.unwrap();

        assert!(
            registry
                .configure("fixture.lyrics", None, Some(json!({"region": "nl"})), None)
                .await
                .is_err()
        );
        assert!(registry.disable("fixture.lyrics").await.is_err());
        assert!(registry.uninstall_plugin("fixture.lyrics").await.is_err());
        assert_eq!(
            registry.get("fixture.lyrics", true).await.unwrap().unwrap(),
            before
        );

        sqlx::raw_sql("DROP TRIGGER fail_config; DROP TRIGGER fail_removal;")
            .execute(db.inner())
            .await
            .unwrap();
        registry.disable("fixture.lyrics").await.unwrap();
        registry.enable("fixture.lyrics").await.unwrap();
        registry.uninstall_plugin("fixture.lyrics").await.unwrap();
        assert!(
            registry
                .get("fixture.lyrics", true)
                .await
                .unwrap()
                .is_none()
        );
        let configs: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM plugin_configs WHERE plugin_id = 'fixture.lyrics'",
        )
        .fetch_one(db.inner())
        .await
        .unwrap();
        assert_eq!(configs, 0);
    }

    #[tokio::test]
    async fn concurrent_wal_patches_merge_under_the_database_writer_lock() {
        let temp = tempfile::tempdir().unwrap();
        let db = DbPool::connect(&temp.path().join("plugins.sqlite"))
            .await
            .unwrap();
        run_migrations(&db, None).await.unwrap();
        let first = PluginRegistry::new(Some(db.clone()));
        let second = PluginRegistry::new(Some(db.clone()));
        first
            .install_custom_plugin(manifest("fixture.lyrics"))
            .await
            .unwrap();
        first
            .configure(
                "fixture.lyrics",
                Some(true),
                Some(json!({"token": "retained"})),
                None,
            )
            .await
            .unwrap();
        let (first_result, second_result) = tokio::join!(
            first.configure("fixture.lyrics", None, Some(json!({"region": "nl"})), None),
            second.configure(
                "fixture.lyrics",
                None,
                Some(json!({"limit": 12})),
                Some(vec!["network.request".into()])
            ),
        );
        first_result.unwrap();
        second_result.unwrap();
        let committed = first.get("fixture.lyrics", true).await.unwrap().unwrap();
        assert_eq!(
            committed["config"],
            json!({"token": true, "region": "nl", "limit": 12})
        );
        assert_eq!(committed["enabled"], true);
        assert_eq!(committed["approvedPermissions"], json!(["network.request"]));
        db.close().await;
    }
}
