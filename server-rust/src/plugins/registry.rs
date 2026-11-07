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
use std::sync::{Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;

use crate::acquisition::SpotDLOutputFormat;
use crate::db::DbPool;
use crate::plugins::manifest::{
    PluginConfigField, PluginConfigOption, PluginConfigSpec, PluginErrorClassification,
    PluginErrorStatus, PluginManifest, UIExtension, classify_plugin_error, validate_manifest,
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
        Ok((
            true,
            format!("{} is configured", self.manifest().name),
        ))
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
struct PluginRuntimeState {
    plugin: Arc<dyn MusicDeckPlugin>,
    origin: PluginOrigin,
    status: String,
    error: Option<String>,
    logs: Vec<PluginLog>,
    ui_extensions: Vec<UIExtension>,
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
    plugins: Arc<RwLock<Vec<PluginRuntimeState>>>,
}

impl std::fmt::Debug for PluginRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginRegistry").finish()
    }
}

impl PluginRegistry {
    /// Creates a new [`PluginRegistry`] pre-populated with the 5 built-in first-party plugins.
    #[must_use]
    pub fn new(db: Option<DbPool>) -> Self {
        let registry = Self {
            db,
            plugins: Arc::new(RwLock::new(Vec::new())),
        };
        let _ = registry.register_sync(Arc::new(ListenBrainzPlugin::new()), PluginOrigin::FirstParty);
        let _ = registry.register_sync(Arc::new(LastFmPlugin::new()), PluginOrigin::FirstParty);
        let _ = registry.register_sync(Arc::new(MusicBrainzPlugin::new()), PluginOrigin::FirstParty);
        let _ = registry.register_sync(Arc::new(ExternalArtworkPlugin::new()), PluginOrigin::FirstParty);
        let _ = registry.register_sync(Arc::new(SpotDLDownloaderPlugin::new()), PluginOrigin::FirstParty);
        registry
    }

    fn register_sync(
        &self,
        plugin: Arc<dyn MusicDeckPlugin>,
        origin: PluginOrigin,
    ) -> Result<(), String> {
        validate_manifest(plugin.manifest()).map_err(|e| e.0)?;
        let mut guard = self
            .plugins
            .write()
            .map_err(|_| String::from("Lock poisoned"))?;
        if guard
            .iter()
            .any(|p| p.plugin.manifest().id == plugin.manifest().id)
        {
            return Err(String::from("Plugin is already registered"));
        }
        guard.push(PluginRuntimeState {
            plugin,
            origin,
            status: String::from("disabled"),
            error: None,
            logs: Vec::new(),
            ui_extensions: Vec::new(),
        });
        Ok(())
    }

    async fn load_db_rows(&self) -> HashMap<String, (bool, Value, Vec<String>)> {
        let Some(pool) = &self.db else {
            return HashMap::new();
        };
        let rows = sqlx::query(
            "SELECT plugin_id, enabled, config_json, permissions_json FROM plugin_configs",
        )
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        rows.into_iter()
            .filter_map(|r| {
                let id: String = r.try_get("plugin_id").ok()?;
                let enabled = r.try_get::<i64, _>("enabled").unwrap_or(0) != 0;
                let cfg_str: String = r.try_get("config_json").unwrap_or_default();
                let perms_str: String = r.try_get("permissions_json").unwrap_or_default();
                let cfg = serde_json::from_str::<Value>(&cfg_str).unwrap_or_else(|_| json!({}));
                let perms =
                    serde_json::from_str::<Vec<String>>(&perms_str).unwrap_or_default();
                Some((id, (enabled, cfg, perms)))
            })
            .collect()
    }

    fn append_log(&self, plugin_id: &str, level: &str, message: &str) {
        if let Ok(mut guard) = self.plugins.write() {
            if let Some(state) = guard
                .iter_mut()
                .find(|s| s.plugin.manifest().id == plugin_id)
            {
                state.logs.push(PluginLog {
                    level: level.to_owned(),
                    message: message.chars().take(300).collect(),
                    created_at: Utc::now().to_rfc3339(),
                });
                if state.logs.len() > 50 {
                    let drop_n = state.logs.len() - 50;
                    state.logs.drain(0..drop_n);
                }
            }
        }
    }

    /// Installs a custom third-party plugin from a validated [`PluginManifest`].
    pub async fn install_custom_plugin(&self, manifest: PluginManifest) -> Result<Value, String> {
        validate_manifest(&manifest).map_err(|e| e.0)?;
        let id = manifest.id.clone();
        self.register_sync(
            Arc::new(CustomManifestPlugin {
                manifest: manifest.clone(),
            }),
            PluginOrigin::ThirdParty,
        )?;

        if let Some(pool) = &self.db {
            let now = Utc::now().to_rfc3339();
            let _ = sqlx::query(
                r"
                INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
                VALUES (?, 0, '{}', '[]', ?)
                ON CONFLICT(plugin_id) DO UPDATE SET
                    enabled = 0,
                    permissions_json = '[]',
                    updated_at = excluded.updated_at
                ",
            )
            .bind(&id)
            .bind(&now)
            .execute(pool.inner())
            .await;

            let manifest_json =
                serde_json::to_string(&manifest).unwrap_or_else(|_| String::from("{}"));
            let _ = sqlx::query(
                r"
                INSERT INTO custom_plugins (plugin_id, manifest_json, installed_at)
                VALUES (?, ?, ?)
                ON CONFLICT(plugin_id) DO UPDATE SET manifest_json = excluded.manifest_json
                ",
            )
            .bind(&id)
            .bind(manifest_json)
            .bind(&now)
            .execute(pool.inner())
            .await;
        }

        self.get(&id, true)
            .await
            .ok_or_else(|| String::from("Unknown plugin"))
    }

    /// Uninstalls a third-party custom plugin.
    pub async fn uninstall_plugin(&self, plugin_id: &str) -> Result<(), String> {
        {
            let mut guard = self
                .plugins
                .write()
                .map_err(|_| String::from("Lock poisoned"))?;
            let Some(pos) = guard
                .iter()
                .position(|p| p.plugin.manifest().id == plugin_id)
            else {
                return Err(String::from("Unknown plugin"));
            };
            if guard[pos].origin != PluginOrigin::ThirdParty {
                return Err(String::from("Only custom plugins can be uninstalled"));
            }
            guard.remove(pos);
        }

        if let Some(pool) = &self.db {
            let _ = sqlx::query("DELETE FROM plugin_configs WHERE plugin_id = ?")
                .bind(plugin_id)
                .execute(pool.inner())
                .await;
            let _ = sqlx::query("DELETE FROM custom_plugins WHERE plugin_id = ?")
                .bind(plugin_id)
                .execute(pool.inner())
                .await;
        }
        Ok(())
    }

    /// Configures `plugin_id`'s settings and approved permissions in `plugin_configs`.
    pub async fn configure(
        &self,
        plugin_id: &str,
        enabled: Option<bool>,
        config: Option<Value>,
        permissions: Option<Vec<String>>,
    ) -> Result<(), PluginErrorClassification> {
        let plugin = {
            let guard = self.plugins.read().ok();
            guard
                .and_then(|g| {
                    g.iter()
                        .find(|s| s.plugin.manifest().id == plugin_id)
                        .map(|s| s.plugin.clone())
                })
                .ok_or_else(|| PluginErrorClassification {
                    status: PluginErrorStatus::PluginError,
                    message: String::from("Unknown plugin"),
                })?
        };

        let manifest = plugin.manifest();
        let declared_perms: HashSet<&str> = manifest
            .permissions
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(String::as_str)
            .collect();

        if let Some(ref req_perms) = permissions {
            for p in req_perms {
                if !declared_perms.contains(p.as_str()) {
                    return Err(PluginErrorClassification {
                        status: PluginErrorStatus::PermissionDenied,
                        message: String::from("Plugin is missing an approved permission"),
                    });
                }
            }
        }

        let db_rows = self.load_db_rows().await;
        let (prev_enabled, prev_cfg, prev_perms) = db_rows
            .get(plugin_id)
            .cloned()
            .unwrap_or((false, json!({}), Vec::new()));

        let next_cfg = config.unwrap_or(prev_cfg);
        plugin.validate_config(&next_cfg)?;
        let next_perms = permissions.unwrap_or(prev_perms);
        let next_enabled = enabled.unwrap_or(prev_enabled);

        if let Some(pool) = &self.db {
            let now = Utc::now().to_rfc3339();
            let cfg_str =
                serde_json::to_string(&next_cfg).unwrap_or_else(|_| String::from("{}"));
            let perms_str =
                serde_json::to_string(&next_perms).unwrap_or_else(|_| String::from("[]"));

            let _ = sqlx::query(
                r"
                INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(plugin_id) DO UPDATE SET
                    enabled = excluded.enabled,
                    config_json = excluded.config_json,
                    permissions_json = excluded.permissions_json,
                    updated_at = excluded.updated_at
                ",
            )
            .bind(plugin_id)
            .bind(i64::from(next_enabled))
            .bind(cfg_str)
            .bind(perms_str)
            .bind(now)
            .execute(pool.inner())
            .await;
        }

        Ok(())
    }

    /// Enables `plugin_id` after verifying all required configuration fields.
    pub async fn enable(&self, plugin_id: &str) -> Result<(), PluginErrorClassification> {
        let plugin = {
            let guard = self.plugins.read().ok();
            guard
                .and_then(|g| {
                    g.iter()
                        .find(|s| s.plugin.manifest().id == plugin_id)
                        .map(|s| s.plugin.clone())
                })
                .ok_or_else(|| PluginErrorClassification {
                    status: PluginErrorStatus::PluginError,
                    message: String::from("Unknown plugin"),
                })?
        };

        let db_rows = self.load_db_rows().await;
        let (_, cfg, perms) = db_rows
            .get(plugin_id)
            .cloned()
            .unwrap_or((false, json!({}), Vec::new()));

        if !missing_required_fields(plugin.manifest(), &cfg).is_empty() {
            if let Ok(mut guard) = self.plugins.write() {
                if let Some(st) = guard
                    .iter_mut()
                    .find(|s| s.plugin.manifest().id == plugin_id)
                {
                    st.status = String::from("error");
                    st.error = Some(String::from("not_configured"));
                }
            }
            return Err(PluginErrorClassification {
                status: PluginErrorStatus::NotConfigured,
                message: String::from("Plugin is misconfigured"),
            });
        }

        let approved: HashSet<String> = perms.into_iter().collect();
        if let Err(err) = plugin.on_enable(&cfg, &approved).await {
            if let Ok(mut guard) = self.plugins.write() {
                if let Some(st) = guard
                    .iter_mut()
                    .find(|s| s.plugin.manifest().id == plugin_id)
                {
                    st.status = String::from("error");
                    st.error = Some(err.status.as_str().to_owned());
                }
            }
            self.append_log(plugin_id, "error", &format!("enable failed: {}", err.message));
            return Err(err);
        }

        if let Ok(mut guard) = self.plugins.write() {
            if let Some(st) = guard
                .iter_mut()
                .find(|s| s.plugin.manifest().id == plugin_id)
            {
                st.status = String::from("enabled");
                st.error = None;
            }
        }

        if let Some(pool) = &self.db {
            let now = Utc::now().to_rfc3339();
            let _ = sqlx::query(
                r"
                INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
                VALUES (?, 1, '{}', '[]', ?)
                ON CONFLICT(plugin_id) DO UPDATE SET
                    enabled = 1,
                    updated_at = excluded.updated_at
                ",
            )
            .bind(plugin_id)
            .bind(now)
            .execute(pool.inner())
            .await;
        }

        Ok(())
    }

    /// Disables `plugin_id`.
    pub async fn disable(&self, plugin_id: &str) -> Result<(), String> {
        {
            let mut guard = self
                .plugins
                .write()
                .map_err(|_| String::from("Lock poisoned"))?;
            let Some(st) = guard
                .iter_mut()
                .find(|s| s.plugin.manifest().id == plugin_id)
            else {
                return Err(String::from("Unknown plugin"));
            };
            st.status = String::from("disabled");
            st.ui_extensions.clear();
        }

        if let Some(pool) = &self.db {
            let now = Utc::now().to_rfc3339();
            let _ = sqlx::query(
                r"
                INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
                VALUES (?, 0, '{}', '[]', ?)
                ON CONFLICT(plugin_id) DO UPDATE SET
                    enabled = 0,
                    updated_at = excluded.updated_at
                ",
            )
            .bind(plugin_id)
            .bind(now)
            .execute(pool.inner())
            .await;
        }

        Ok(())
    }

    /// Lists all registered plugins (`admin == true` includes redacted config, logs, and errors).
    pub async fn list(&self, admin: bool) -> Vec<Value> {
        let db_rows = self.load_db_rows().await;
        let states: Vec<PluginRuntimeState> = self
            .plugins
            .read()
            .map(|g| g.clone())
            .unwrap_or_default();

        states
            .into_iter()
            .map(|st| {
                let m = st.plugin.manifest();
                let (db_enabled, cfg, approved_perms) = db_rows
                    .get(&m.id)
                    .cloned()
                    .unwrap_or((false, json!({}), Vec::new()));

                let missing = missing_required_fields(m, &cfg);
                let status = if db_enabled && st.status == "disabled" {
                    "enabled"
                } else {
                    st.status.as_str()
                };
                let health = if status == "error" {
                    "error"
                } else if status == "enabled" {
                    "healthy"
                } else if !missing.is_empty() {
                    "unconfigured"
                } else {
                    "disabled"
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
                    "approvedPermissions": approved_perms,
                    "enabled": db_enabled,
                    "status": status,
                    "health": health,
                    "config": if admin { redact_plugin_config(m, &cfg) } else { json!({}) },
                    "configFields": config_fields,
                    "configRequired": missing.iter().map(|f| &f.key).collect::<Vec<_>>(),
                    "uiExtensions": st.ui_extensions,
                });

                if admin {
                    let recent_logs: Vec<&PluginLog> =
                        st.logs.iter().rev().take(10).rev().collect();
                    item["logs"] = json!(recent_logs);
                    item["error"] = json!(st.error);
                }

                item
            })
            .collect()
    }

    /// Retrieves a single plugin descriptor by `plugin_id`.
    pub async fn get(&self, plugin_id: &str, admin: bool) -> Option<Value> {
        self.list(admin)
            .await
            .into_iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(plugin_id))
    }

    /// Runs the connectivity/configuration test for `plugin_id`.
    pub async fn test(&self, plugin_id: &str) -> Result<Value, String> {
        let plugin = {
            let guard = self.plugins.read().ok();
            guard
                .and_then(|g| {
                    g.iter()
                        .find(|s| s.plugin.manifest().id == plugin_id)
                        .map(|s| s.plugin.clone())
                })
                .ok_or_else(|| String::from("Unknown plugin"))?
        };

        let db_rows = self.load_db_rows().await;
        let (_, cfg, perms) = db_rows
            .get(plugin_id)
            .cloned()
            .unwrap_or((false, json!({}), Vec::new()));

        if !missing_required_fields(plugin.manifest(), &cfg).is_empty() {
            return Ok(json!({
                "id": plugin_id,
                "ok": false,
                "status": "not_configured",
                "message": "Plugin is not fully configured",
            }));
        }

        let approved: HashSet<String> = perms.into_iter().collect();
        match plugin.test(&cfg, &approved).await {
            Ok((ok, msg)) => Ok(json!({
                "id": plugin_id,
                "ok": ok,
                "status": if ok { "success" } else { "provider_unavailable" },
                "message": msg,
            })),
            Err(classified) => Ok(json!({
                "id": plugin_id,
                "ok": false,
                "status": classified.status.as_str(),
                "message": classified.message,
            })),
        }
    }
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
                    "Configures spotDL downloads and Spotify playlist imports: audio format, Spotify credentials, optional YouTube cookies, and binary paths.",
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
                                    label: String::from("Best source quality (M4A) — recommended"),
                                },
                                PluginConfigOption {
                                    value: json!("m4a"),
                                    label: String::from("M4A — original bitrate"),
                                },
                                PluginConfigOption {
                                    value: json!("opus"),
                                    label: String::from("Opus — original bitrate"),
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
                            description: None,
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
        let fmt = config.get("outputFormat").and_then(Value::as_str);
        SpotDLOutputFormat::parse(fmt).map_err(|msg| PluginErrorClassification {
            status: PluginErrorStatus::NotConfigured,
            message: msg,
        })?;
        Ok(())
    }
}
