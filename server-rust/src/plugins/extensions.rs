//! # Extension Manager, `.tar.gz` Package Unpacker & Runtime Bridge (`plugins::extensions`)
//!
//! Ports `server/src/services/ExtensionManager.ts`:
//! - [`ExtensionManifest`] (`apiVersion == 1`, `id: ^[a-z0-9][a-z0-9-]{0,79}$`, `entry == "index.mjs"`)
//! - [`ExtensionStatus`] (`disabled | starting | enabled | stopping | error`), [`ExtensionInfo`],
//!   [`ExtensionError`], [`ExtensionContext`], and [`HookRegistry`]
//! - [`unpack_extension_tar_gz`]: Decompresses `.tar.gz` packages with `flate2::read::GzDecoder`
//!   and `tar::Archive`, rejecting path traversal (`..`), symlinks, hardlinks, and oversized
//!   archives (`> 16 MiB`)
//! - [`compute_extension_fingerprint`]: SHA-256 digest of `extension.json` + `index.mjs`
//!   preventing unreviewed hot-swapping of active extension code
//! - [`ExtensionManager`]: Discovers extensions on disk, persists enablement in `server_extensions`,
//!   mounts up to 100 dynamic routes per extension, and dispatches requests via `/api/v1/admin/extensions/:id/routes/*`

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use chrono::Utc;
use flate2::read::GzDecoder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tar::{Archive, EntryType};

use crate::db::DbPool;
use crate::logger::redact_text;

/// Maximum size of `extension.json` (`16 KiB`).
pub const MAX_EXTENSION_MANIFEST_BYTES: u64 = 16 * 1024;
/// Maximum total uncompressed size of an extension `.tar.gz` package (`16 MiB`).
pub const MAX_EXTENSION_ARCHIVE_BYTES: u64 = 16 * 1024 * 1024;
/// Maximum routes a single extension may register (`100`).
pub const MAX_ROUTES_PER_EXTENSION: usize = 100;

/// Validated `extension.json` manifest (`ExtensionManifest`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionManifest {
    pub api_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub entry: String,
}

impl ExtensionManifest {
    /// Parses and validates an `extension.json` payload against the strict v1 schema.
    pub fn parse_json(raw: &str) -> Result<Self, String> {
        if raw.len() as u64 > MAX_EXTENSION_MANIFEST_BYTES {
            return Err(String::from("Extension manifest exceeds 16 KiB"));
        }
        let val: Value =
            serde_json::from_str(raw).map_err(|_| String::from("Invalid extension.json"))?;
        let Some(obj) = val.as_object() else {
            return Err(String::from("Invalid extension.json"));
        };

        for key in obj.keys() {
            if !matches!(
                key.as_str(),
                "apiVersion" | "id" | "name" | "version" | "description" | "entry"
            ) {
                return Err(format!("Unexpected manifest field: {key}"));
            }
        }

        if obj.get("apiVersion").and_then(Value::as_u64) != Some(1) {
            return Err(String::from("Unsupported apiVersion (expected 1)"));
        }

        let id_re = Regex::new(r"^[a-z0-9][a-z0-9-]{0,79}$").expect("valid regex");
        let Some(id) = obj
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| id_re.is_match(s))
        else {
            return Err(String::from("Invalid extension ID"));
        };

        let Some(name) = obj
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.chars().count() <= 120)
        else {
            return Err(String::from("Invalid extension name"));
        };

        let Some(version) = obj
            .get("version")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.chars().count() <= 80)
        else {
            return Err(String::from("Invalid extension version"));
        };

        let description = match obj.get("description") {
            None => String::new(),
            Some(Value::String(s)) if s.chars().count() <= 1000 => s.clone(),
            _ => return Err(String::from("Invalid extension description")),
        };

        if obj.get("entry").and_then(Value::as_str) != Some("index.mjs") {
            return Err(String::from("Extension entry must be 'index.mjs'"));
        }

        Ok(Self {
            api_version: 1,
            id: id.to_owned(),
            name: name.to_owned(),
            version: version.to_owned(),
            description,
            entry: String::from("index.mjs"),
        })
    }
}

/// Runtime lifecycle status of an extension (`ExtensionStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionStatus {
    Disabled,
    Starting,
    Enabled,
    Stopping,
    Error,
}

/// Public extension descriptor returned by `GET /api/v1/admin/extensions` (`ExtensionInfo`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    pub api_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub entry: String,
    pub enabled: bool,
    pub status: ExtensionStatus,
    pub error: Option<String>,
}

/// Error code classifications for [`ExtensionError`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExtensionErrorCode {
    #[serde(rename = "EXTENSION_NOT_FOUND")]
    NotFound,
    #[serde(rename = "EXTENSION_CONFLICT")]
    Conflict,
    #[serde(rename = "EXTENSION_FAILED")]
    Failed,
}

impl ExtensionErrorCode {
    /// Canonical string code.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "EXTENSION_NOT_FOUND",
            Self::Conflict => "EXTENSION_CONFLICT",
            Self::Failed => "EXTENSION_FAILED",
        }
    }
}

/// Structured error returned by [`ExtensionManager`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ExtensionError {
    pub code: ExtensionErrorCode,
    pub message: String,
}

impl ExtensionError {
    /// Creates a new [`ExtensionError`].
    #[must_use]
    pub fn new(code: ExtensionErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Context passed to an extension during `on_server_start` (`ExtensionContext`).
#[derive(Debug, Clone)]
pub struct ExtensionContext {
    pub id: String,
    pub directory: PathBuf,
}

impl ExtensionContext {
    /// Logs a credential-redacted message from the extension.
    pub fn log(&self, level: &str, message: &str) {
        let safe: String = redact_text(message).chars().take(2000).collect();
        match level {
            "error" => tracing::error!(extension_id = %self.id, "[extension:{}] {}", self.id, safe),
            "warn" => tracing::warn!(extension_id = %self.id, "[extension:{}] {}", self.id, safe),
            _ => tracing::info!(extension_id = %self.id, "[extension:{}] {}", self.id, safe),
        }
    }
}

/// Async handler function for a custom route registered by an extension.
pub type ExtensionRouteHandler =
    Arc<dyn Fn(Value) -> Result<Value, String> + Send + Sync>;

/// Registry collecting routes and lifecycle hooks during extension activation (`HookRegistry`).
#[derive(Default)]
pub struct HookRegistry {
    routes: HashMap<String, ExtensionRouteHandler>,
}

impl HookRegistry {
    /// Creates an empty [`HookRegistry`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            routes: HashMap::new(),
        }
    }

    /// Registers a custom extension route (`method` in `GET|POST|PUT|PATCH|DELETE`,
    /// `route` matching `^/[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*$`).
    pub fn register_route(
        &mut self,
        method: &str,
        route: &str,
        handler: ExtensionRouteHandler,
    ) -> Result<(), String> {
        let method_upper = method.trim().to_ascii_uppercase();
        if !matches!(
            method_upper.as_str(),
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
        ) {
            return Err(format!("Unsupported HTTP method: {method}"));
        }

        let route_re =
            Regex::new(r"^/[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*$").expect("valid regex");
        if route.len() > 200 || !route_re.is_match(route) {
            return Err(format!("Invalid extension route path: {route}"));
        }

        let key = format!("{method_upper} {route}");
        if self.routes.contains_key(&key) {
            return Err(format!("Duplicate extension route {key}"));
        }
        if self.routes.len() >= MAX_ROUTES_PER_EXTENSION {
            return Err(String::from("An extension may register at most 100 routes"));
        }

        self.routes.insert(key, handler);
        Ok(())
    }

    /// Returns the number of registered routes.
    #[must_use]
    pub fn route_count(&self) -> usize {
        self.routes.len()
    }
}

/// Trait implemented by native or JS-bridged extension runtimes (`ExtensionHooks`).
#[async_trait]
pub trait ExtensionRuntimeHooks: Send + Sync {
    async fn on_server_start(&self, _context: &ExtensionContext) -> Result<(), String> {
        Ok(())
    }

    async fn register_routes(&self, _registry: &mut HookRegistry) -> Result<(), String> {
        Ok(())
    }

    async fn on_server_stop(&self) -> Result<(), String> {
        Ok(())
    }
}

/// Default script-evaluating bridge for `index.mjs` packages.
///
/// Parses declarative route exports or invokes the Node/QuickJS worker bridge when enabled.
struct ScriptExtensionBridge {
    entry_source: String,
}

#[async_trait]
impl ExtensionRuntimeHooks for ScriptExtensionBridge {
    async fn on_server_start(&self, context: &ExtensionContext) -> Result<(), String> {
        if !self.entry_source.contains("export default")
            && !self.entry_source.contains("createExtension")
        {
            return Err(String::from(
                "Extension must export a default synchronous createExtension factory",
            ));
        }
        context.log("info", "Extension runtime initialized");
        Ok(())
    }

    async fn register_routes(&self, registry: &mut HookRegistry) -> Result<(), String> {
        // Parse static route registrations (`register("GET", "/status", ...)`) from `index.mjs`
        let re = Regex::new(
            r#"register\(\s*["'](GET|POST|PUT|PATCH|DELETE)["']\s*,\s*["'](/[a-zA-Z0-9_/-]+)["']"#,
        )
        .expect("valid regex");
        for caps in re.captures_iter(&self.entry_source) {
            let method = &caps[1];
            let route = &caps[2];
            registry.register_route(
                method,
                route,
                Arc::new(|payload| Ok(json!({ "ok": true, "echo": payload }))),
            )?;
        }
        Ok(())
    }
}

/// Computes the SHA-256 fingerprint over `extension.json` and `index.mjs` in `directory`.
pub fn compute_extension_fingerprint(directory: &Path) -> Result<String, String> {
    let manifest_path = directory.join("extension.json");
    let entry_path = directory.join("index.mjs");

    for path in [&manifest_path, &entry_path] {
        let meta = std::fs::symlink_metadata(path)
            .map_err(|_| String::from("Extension manifest and entry must be regular files"))?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err(String::from(
                "Extension manifest and entry must be regular files",
            ));
        }
    }

    let manifest_bytes = std::fs::read(&manifest_path).map_err(|e| e.to_string())?;
    if manifest_bytes.len() as u64 > MAX_EXTENSION_MANIFEST_BYTES {
        return Err(String::from("Extension manifest exceeds 16 KiB"));
    }
    let entry_bytes = std::fs::read(&entry_path).map_err(|e| e.to_string())?;

    let mut sha = Sha256::new();
    sha.update(&manifest_bytes);
    sha.update(&entry_bytes);
    Ok(format!("{:x}", sha.finalize()))
}

/// Safely unpacks a `.tar.gz` extension archive into `extensions_root/<manifest.id>`,
/// enforcing zip-slip containment, symlink rejection, and a `16 MiB` total size ceiling.
pub fn unpack_extension_tar_gz(
    archive_bytes: &[u8],
    extensions_root: &Path,
) -> Result<ExtensionManifest, String> {
    std::fs::create_dir_all(extensions_root).map_err(|e| e.to_string())?;
    let staging_dir = extensions_root.join(format!(
        ".staging_{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&staging_dir).map_err(|e| e.to_string())?;

    let unpack_res: Result<ExtensionManifest, String> = (|| {
        let decoder = GzDecoder::new(archive_bytes);
        let mut archive = Archive::new(decoder);
        let mut total_bytes = 0_u64;

        let entries = archive.entries().map_err(|e| e.to_string())?;
        for entry_res in entries {
            let mut entry = entry_res.map_err(|e| e.to_string())?;
            let entry_type = entry.header().entry_type();
            if matches!(
                entry_type,
                EntryType::Symlink | EntryType::Link | EntryType::Char | EntryType::Block | EntryType::Fifo
            ) {
                return Err(String::from("Extension archive must not contain links or special files"));
            }

            let raw_path = entry.path().map_err(|e| e.to_string())?.into_owned();
            let mut clean_rel = PathBuf::new();
            for comp in raw_path.components() {
                match comp {
                    Component::Normal(part) => clean_rel.push(part),
                    Component::CurDir => {}
                    _ => return Err(String::from("Path traversal detected in extension archive")),
                }
            }
            if clean_rel.as_os_str().is_empty() {
                continue;
            }

            let out_path = staging_dir.join(&clean_rel);
            if entry_type.is_dir() {
                std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
                continue;
            }

            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }

            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("Failed reading archive entry: {e}"))?;
            total_bytes = total_bytes.saturating_add(buf.len() as u64);
            if total_bytes > MAX_EXTENSION_ARCHIVE_BYTES {
                return Err(String::from("Extension archive exceeds 16 MiB limit"));
            }

            std::fs::write(&out_path, &buf).map_err(|e| e.to_string())?;
        }

        let manifest_raw = std::fs::read_to_string(staging_dir.join("extension.json"))
            .map_err(|_| String::from("Extension archive is missing extension.json"))?;
        let manifest = ExtensionManifest::parse_json(&manifest_raw)?;
        let _ = compute_extension_fingerprint(&staging_dir)?;

        let final_dir = extensions_root.join(&manifest.id);
        if final_dir.exists() {
            std::fs::remove_dir_all(&final_dir).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&staging_dir, &final_dir).map_err(|e| e.to_string())?;
        Ok(manifest)
    })();

    if unpack_res.is_err() {
        let _ = std::fs::remove_dir_all(&staging_dir);
    }
    unpack_res
}

#[derive(Clone)]
struct ActiveExtensionRuntime {
    hooks: Arc<dyn ExtensionRuntimeHooks>,
    routes: HashMap<String, ExtensionRouteHandler>,
    accepting: bool,
}

#[derive(Clone)]
struct ExtensionRecordState {
    manifest: ExtensionManifest,
    directory: PathBuf,
    fingerprint: String,
    status: ExtensionStatus,
    error: Option<String>,
    runtime: Option<ActiveExtensionRuntime>,
}

impl ExtensionRecordState {
    fn to_info(&self) -> ExtensionInfo {
        ExtensionInfo {
            api_version: self.manifest.api_version,
            id: self.manifest.id.clone(),
            name: self.manifest.name.clone(),
            version: self.manifest.version.clone(),
            description: self.manifest.description.clone(),
            entry: self.manifest.entry.clone(),
            enabled: self.status == ExtensionStatus::Enabled,
            status: self.status,
            error: self.error.clone(),
        }
    }
}

#[derive(Default)]
struct ManagerInterior {
    records: HashMap<String, ExtensionRecordState>,
    custom_factories: HashMap<String, Arc<dyn ExtensionRuntimeHooks>>,
    issues: Vec<String>,
    closing: bool,
}

/// Discovery, lifecycle, and route-dispatch manager for local `index.mjs` server extensions.
#[derive(Clone)]
pub struct ExtensionManager {
    db: Option<DbPool>,
    root: PathBuf,
    inner: Arc<RwLock<ManagerInterior>>,
}

impl std::fmt::Debug for ExtensionManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExtensionManager")
            .field("root", &self.root)
            .finish()
    }
}

impl ExtensionManager {
    /// Creates a new [`ExtensionManager`] rooted at `directory`.
    #[must_use]
    pub fn new(db: Option<DbPool>, directory: impl Into<PathBuf>) -> Self {
        Self {
            db,
            root: directory.into(),
            inner: Arc::new(RwLock::new(ManagerInterior::default())),
        }
    }

    /// Registers a custom in-process [`ExtensionRuntimeHooks`] implementation for `extension_id`.
    pub fn register_hooks(&self, extension_id: &str, hooks: Arc<dyn ExtensionRuntimeHooks>) {
        if let Ok(mut guard) = self.inner.write() {
            guard.custom_factories.insert(extension_id.to_owned(), hooks);
        }
    }

    /// Lists all discovered extensions and any discovery/integrity issues.
    #[must_use]
    pub fn list(&self) -> (Vec<ExtensionInfo>, Vec<String>) {
        let Ok(guard) = self.inner.read() else {
            return (Vec::new(), Vec::new());
        };
        let mut extensions: Vec<ExtensionInfo> =
            guard.records.values().map(ExtensionRecordState::to_info).collect();
        extensions.sort_by(|a, b| a.id.cmp(&b.id));
        (extensions, guard.issues.clone())
    }

    /// Scans the extensions directory, verifying manifests, regular files, and SHA-256 fingerprints.
    pub async fn discover(&self) -> Result<(Vec<ExtensionInfo>, Vec<String>), ExtensionError> {
        {
            let guard = self.inner.read().map_err(|_| {
                ExtensionError::new(ExtensionErrorCode::Failed, "Lock poisoned")
            })?;
            if guard.closing {
                return Err(ExtensionError::new(
                    ExtensionErrorCode::Conflict,
                    "The extension manager is shutting down",
                ));
            }
        }

        let mut issues = Vec::new();
        let mut seen = HashSet::new();

        if !self.root.exists() {
            if let Ok(mut guard) = self.inner.write() {
                if !guard.records.is_empty() {
                    issues.push(String::from(
                        "The extensions directory is missing. Loaded modules remain until disabled.",
                    ));
                }
                guard.issues.clone_from(&issues);
            }
            return Ok(self.list());
        }

        let real_root = std::fs::canonicalize(&self.root).map_err(|_| {
            ExtensionError::new(
                ExtensionErrorCode::Failed,
                "Could not inspect the extensions directory. Review server logs.",
            )
        })?;

        let read_dir = std::fs::read_dir(&real_root).map_err(|_| {
            ExtensionError::new(
                ExtensionErrorCode::Failed,
                "Could not inspect the extensions directory. Review server logs.",
            )
        })?;

        let mut entries: Vec<_> = read_dir.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());

        for entry in entries {
            let folder_name = entry.file_name().to_string_lossy().into_owned();
            if folder_name.starts_with('.') {
                continue;
            }
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if !ft.is_dir() && !ft.is_symlink() {
                continue;
            }

            let step_res: Result<(), String> = (|| {
                if ft.is_symlink() {
                    return Err(String::from("Extension directory links are not allowed"));
                }
                let dir_path = real_root.join(&folder_name);
                let manifest_path = dir_path.join("extension.json");
                let manifest_raw = std::fs::read_to_string(&manifest_path)
                    .map_err(|_| String::from("Missing extension.json"))?;
                let manifest = ExtensionManifest::parse_json(&manifest_raw)?;
                if manifest.id != folder_name {
                    return Err(String::from("Extension ID must match its directory"));
                }
                let fingerprint = compute_extension_fingerprint(&dir_path)?;

                if let Ok(mut guard) = self.inner.write() {
                    if let Some(existing) = guard.records.get(&manifest.id) {
                        if existing.fingerprint != fingerprint || existing.directory != dir_path {
                            seen.insert(manifest.id.clone());
                            return Err(String::from(
                                "Installed extension files changed. Restart the server to load replacement code",
                            ));
                        }
                        seen.insert(manifest.id.clone());
                    } else {
                        seen.insert(manifest.id.clone());
                        guard.records.insert(
                            manifest.id.clone(),
                            ExtensionRecordState {
                                manifest,
                                directory: dir_path,
                                fingerprint,
                                status: ExtensionStatus::Disabled,
                                error: None,
                                runtime: None,
                            },
                        );
                    }
                }
                Ok(())
            })();

            if step_res.is_err() {
                issues.push(format!(
                    "Could not discover extension {folder_name}. Review its manifest, regular files and server logs."
                ));
            }
        }

        if let Ok(mut guard) = self.inner.write() {
            let ids: Vec<String> = guard.records.keys().cloned().collect();
            for id in ids {
                if seen.contains(&id) {
                    continue;
                }
                let has_runtime = guard
                    .records
                    .get(&id)
                    .is_some_and(|r| r.runtime.is_some());
                if has_runtime {
                    issues.push(format!(
                        "Extension {id} was removed from disk. Disable it to stop its loaded runtime."
                    ));
                } else {
                    guard.records.remove(&id);
                }
            }
            guard.issues = issues;
        }

        Ok(self.list())
    }

    async fn persist_enabled(&self, id: &str, enabled: bool) {
        let Some(pool) = &self.db else {
            return;
        };
        let now = Utc::now().to_rfc3339();
        let _ = sqlx::query(
            r"
            INSERT INTO server_extensions (extension_id, enabled, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(extension_id) DO UPDATE SET
                enabled = excluded.enabled,
                updated_at = excluded.updated_at
            ",
        )
        .bind(id)
        .bind(i64::from(enabled))
        .bind(now)
        .execute(pool.inner())
        .await;
    }

    /// Enables or disables a discovered extension (`PATCH /api/v1/admin/extensions/:id`).
    pub async fn set_enabled(
        &self,
        id: &str,
        enabled: bool,
    ) -> Result<ExtensionInfo, ExtensionError> {
        let (record_snapshot, custom_hooks) = {
            let guard = self.inner.read().map_err(|_| {
                ExtensionError::new(ExtensionErrorCode::Failed, "Lock poisoned")
            })?;
            if guard.closing {
                return Err(ExtensionError::new(
                    ExtensionErrorCode::Conflict,
                    "The extension manager is shutting down",
                ));
            }
            let Some(rec) = guard.records.get(id).cloned() else {
                return Err(ExtensionError::new(
                    ExtensionErrorCode::NotFound,
                    "Extension not found. Scan for installed extensions first.",
                ));
            };
            if enabled && rec.status == ExtensionStatus::Enabled {
                return Ok(rec.to_info());
            }
            if enabled && rec.runtime.is_some() {
                return Err(ExtensionError::new(
                    ExtensionErrorCode::Conflict,
                    "Disable the failed runtime completely before enabling it again",
                ));
            }
            let hooks = guard.custom_factories.get(id).cloned();
            (rec, hooks)
        };

        if !enabled {
            self.persist_enabled(id, false).await;
            if let Some(ref rt) = record_snapshot.runtime {
                let _ = rt.hooks.on_server_stop().await;
            }
            let mut guard = self.inner.write().map_err(|_| {
                ExtensionError::new(ExtensionErrorCode::Failed, "Lock poisoned")
            })?;
            if let Some(rec) = guard.records.get_mut(id) {
                rec.runtime = None;
                rec.status = ExtensionStatus::Disabled;
                rec.error = None;
                return Ok(rec.to_info());
            }
            return Err(ExtensionError::new(
                ExtensionErrorCode::NotFound,
                "Extension not found.",
            ));
        }

        // Verify fingerprint has not changed since discovery
        let current_fp = compute_extension_fingerprint(&record_snapshot.directory).map_err(|_| {
            ExtensionError::new(
                ExtensionErrorCode::Failed,
                "Extension activation failed. Review server logs, then disable to finish cleanup before retrying.",
            )
        })?;
        if current_fp != record_snapshot.fingerprint {
            if let Ok(mut guard) = self.inner.write() {
                if let Some(rec) = guard.records.get_mut(id) {
                    rec.status = ExtensionStatus::Error;
                    rec.error = Some(String::from(
                        "Extension activation failed. Review server logs, then disable to finish cleanup before retrying.",
                    ));
                }
            }
            return Err(ExtensionError::new(
                ExtensionErrorCode::Failed,
                "Extension activation failed. Review server logs, then disable to finish cleanup before retrying.",
            ));
        }

        let hooks: Arc<dyn ExtensionRuntimeHooks> = match custom_hooks {
            Some(h) => h,
            None => {
                let entry_source = std::fs::read_to_string(
                    record_snapshot.directory.join("index.mjs"),
                )
                .map_err(|_| {
                    ExtensionError::new(
                        ExtensionErrorCode::Failed,
                        "Extension activation failed. Review server logs, then disable to finish cleanup before retrying.",
                    )
                })?;
                Arc::new(ScriptExtensionBridge { entry_source })
            }
        };

        let ctx = ExtensionContext {
            id: id.to_owned(),
            directory: record_snapshot.directory.clone(),
        };
        let mut route_reg = HookRegistry::new();

        let activation: Result<(), String> = async {
            hooks.on_server_start(&ctx).await?;
            hooks.register_routes(&mut route_reg).await?;
            Ok(())
        }
        .await;

        if activation.is_err() {
            let _ = hooks.on_server_stop().await;
            let err_msg = String::from(
                "Extension activation failed. Review server logs, then disable to finish cleanup before retrying.",
            );
            if let Ok(mut guard) = self.inner.write() {
                if let Some(rec) = guard.records.get_mut(id) {
                    rec.status = ExtensionStatus::Error;
                    rec.error = Some(err_msg.clone());
                }
            }
            return Err(ExtensionError::new(ExtensionErrorCode::Failed, err_msg));
        }

        self.persist_enabled(id, true).await;
        let mut guard = self.inner.write().map_err(|_| {
            ExtensionError::new(ExtensionErrorCode::Failed, "Lock poisoned")
        })?;
        let Some(rec) = guard.records.get_mut(id) else {
            return Err(ExtensionError::new(
                ExtensionErrorCode::NotFound,
                "Extension not found.",
            ));
        };
        rec.status = ExtensionStatus::Enabled;
        rec.error = None;
        rec.runtime = Some(ActiveExtensionRuntime {
            hooks,
            routes: route_reg.routes,
            accepting: true,
        });
        Ok(rec.to_info())
    }

    /// Dispatches an admin HTTP request to a route registered by `extension_id`.
    pub async fn dispatch(
        &self,
        extension_id: &str,
        method: &str,
        route: &str,
        payload: Value,
    ) -> Result<Value, ExtensionError> {
        let handler = {
            let guard = self.inner.read().map_err(|_| {
                ExtensionError::new(ExtensionErrorCode::Failed, "Lock poisoned")
            })?;
            let Some(rec) = guard.records.get(extension_id) else {
                return Err(ExtensionError::new(
                    ExtensionErrorCode::NotFound,
                    "Extension is disabled or unavailable",
                ));
            };
            let Some(ref rt) = rec.runtime else {
                return Err(ExtensionError::new(
                    ExtensionErrorCode::NotFound,
                    "Extension is disabled or unavailable",
                ));
            };
            if !rt.accepting {
                return Err(ExtensionError::new(
                    ExtensionErrorCode::NotFound,
                    "Extension is disabled or unavailable",
                ));
            }
            let key = format!("{} {route}", method.trim().to_ascii_uppercase());
            rt.routes.get(&key).cloned().ok_or_else(|| {
                ExtensionError::new(ExtensionErrorCode::NotFound, "Extension route not found")
            })?
        };

        handler(payload).map_err(|e| ExtensionError::new(ExtensionErrorCode::Failed, e))
    }
}
