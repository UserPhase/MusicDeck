//! # Plugin Manifest Schema, Permission Guardrails & Error Classification (`plugins::manifest`)
//!
//! Ports `server/src/plugins/plugin-manifest.ts` and `server/src/plugins/plugin-errors.ts`:
//! - [`CURRENT_MANIFEST_VERSION`] (`1`)
//! - [`PLUGIN_CAPABILITIES`], [`PLUGIN_PERMISSIONS`], and [`PLUGIN_EVENTS`]
//! - [`PluginConfigField`], [`PluginConfigSpec`], [`PluginManifest`] (`MusicDeckPluginManifest`),
//!   [`UIExtension`], and [`ManifestValidationError`]
//! - [`parse_custom_manifest`] and [`validate_manifest`]
//! - [`PluginErrorStatus`], [`PluginErrorClassification`], [`classify_plugin_error`],
//!   and [`http_status_for_plugin_error`]

use axum::http::StatusCode;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Supported custom plugin manifest schema version (`1`).
pub const CURRENT_MANIFEST_VERSION: u32 = 1;

/// Exhaustive allowlist of plugin capability identifiers (`PLUGIN_CAPABILITIES`).
pub const PLUGIN_CAPABILITIES: [&str; 14] = [
    "search",
    "catalog",
    "source",
    "acquisition",
    "recommendation",
    "metadata",
    "artwork",
    "lyrics",
    "scrobble",
    "import",
    "library-insight",
    "automation",
    "ui",
    "theme",
];

/// Exhaustive allowlist of plugin permission identifiers (`PLUGIN_PERMISSIONS`).
pub const PLUGIN_PERMISSIONS: [&str; 13] = [
    "library.acquire",
    "library.read",
    "library.write",
    "history.read",
    "playlist.read",
    "playlist.write",
    "playback.start",
    "network.request",
    "external-source.play",
    "user.read",
    "settings.read",
    "settings.write",
    "ui.register",
];

/// Exhaustive allowlist of lifecycle and playback events (`PLUGIN_EVENTS`).
pub const PLUGIN_EVENTS: [&str; 18] = [
    "track.started",
    "track.completed",
    "track.skipped",
    "playback.paused",
    "playback.stopped",
    "queue.changed",
    "playlist.created",
    "playlist.updated",
    "favorite.changed",
    "library.updated",
    "search.performed",
    "acquisition.created",
    "acquisition.started",
    "acquisition.progress",
    "acquisition.completed",
    "acquisition.failed",
    "acquisition.cancelled",
    "library.imported",
];

/// Validated plugin permission type alias (`PluginPermission`).
pub type PluginPermission = String;
/// Validated plugin capability type alias (`PluginCapability`).
pub type PluginCapability = String;

/// Option entry for a `"select"` [`PluginConfigField`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigOption {
    pub label: String,
    pub value: Value,
}

/// Configuration field descriptor inside a [`PluginManifest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigField {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub field_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<PluginConfigOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub secret: bool,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
}

/// Configuration section of a [`PluginManifest`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigSpec {
    #[serde(default)]
    pub fields: Vec<PluginConfigField>,
}

/// Validated plugin manifest (`MusicDeckPluginManifest` / `PluginManifest`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub capabilities: Vec<PluginCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Vec<PluginPermission>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<PluginConfigSpec>,
}

/// UI slot registration declared by a `"ui"`-capable plugin (`UIExtension`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UIExtension {
    /// `"home" | "explore" | "artist" | "album" | "track" | "now-playing" | "settings"`.
    pub location: String,
    pub id: String,
    pub title: String,
}

/// Error returned when an untrusted `manifest.json` fails schema validation.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ManifestValidationError(pub String);

/// Validates an in-memory [`PluginManifest`].
pub fn validate_manifest(manifest: &PluginManifest) -> Result<(), ManifestValidationError> {
    let id_re = Regex::new(r"(?i)^[a-z0-9][a-z0-9._-]*$").expect("valid regex");
    if !id_re.is_match(&manifest.id) {
        return Err(ManifestValidationError(String::from("Invalid plugin ID")));
    }
    if manifest.name.trim().is_empty() || manifest.version.trim().is_empty() {
        return Err(ManifestValidationError(String::from(
            "Plugin name and version are required",
        )));
    }
    if manifest.capabilities.is_empty() {
        return Err(ManifestValidationError(String::from(
            "Plugin must declare at least one capability",
        )));
    }
    for cap in &manifest.capabilities {
        if !PLUGIN_CAPABILITIES.contains(&cap.as_str()) {
            return Err(ManifestValidationError(format!(
                "Unsupported plugin capability: {cap}"
            )));
        }
    }
    for perm in manifest.permissions.as_deref().unwrap_or(&[]) {
        if !PLUGIN_PERMISSIONS.contains(&perm.as_str()) {
            return Err(ManifestValidationError(format!(
                "Unsupported plugin permission: {perm}"
            )));
        }
    }
    Ok(())
}

/// Validates an untrusted JSON value into a [`PluginManifest`] (`parseCustomManifest`).
pub fn parse_custom_manifest(raw: &Value) -> Result<PluginManifest, ManifestValidationError> {
    let Some(obj) = raw.as_object() else {
        return Err(ManifestValidationError(String::from(
            "Malformed plugin manifest",
        )));
    };

    let version_num = obj.get("manifestVersion").and_then(Value::as_u64);
    if version_num != Some(u64::from(CURRENT_MANIFEST_VERSION)) {
        let disp = obj
            .get("manifestVersion")
            .map_or_else(|| String::from("undefined"), Value::to_string);
        return Err(ManifestValidationError(format!(
            "Unsupported manifest version: {disp}"
        )));
    }

    let id_re = Regex::new(r"(?i)^[a-z0-9][a-z0-9._-]*$").expect("valid regex");
    let Some(id) = obj
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| id_re.is_match(s))
    else {
        return Err(ManifestValidationError(String::from("Invalid plugin ID")));
    };

    let Some(name) = obj
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    else {
        return Err(ManifestValidationError(String::from(
            "Plugin name is required",
        )));
    };

    let Some(version) = obj
        .get("version")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    else {
        return Err(ManifestValidationError(String::from(
            "Plugin version is required",
        )));
    };

    let description = match obj.get("description") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            return Err(ManifestValidationError(String::from(
                "Malformed plugin manifest: description must be a string",
            )))
        }
    };

    let author = match obj.get("author") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            return Err(ManifestValidationError(String::from(
                "Malformed plugin manifest: author must be a string",
            )))
        }
    };

    let Some(cap_arr) = obj
        .get("capabilities")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
    else {
        return Err(ManifestValidationError(String::from(
            "Plugin must declare at least one capability",
        )));
    };

    let mut capabilities = Vec::with_capacity(cap_arr.len());
    for cap in cap_arr {
        let Some(cap_str) = cap.as_str() else {
            return Err(ManifestValidationError(format!(
                "Unknown plugin capability: {cap}"
            )));
        };
        if !PLUGIN_CAPABILITIES.contains(&cap_str) {
            return Err(ManifestValidationError(format!(
                "Unknown plugin capability: {cap_str}"
            )));
        }
        capabilities.push(cap_str.to_owned());
    }

    let mut permissions = Vec::new();
    if let Some(perm_val) = obj.get("permissions").filter(|v| !v.is_null()) {
        let Some(perm_arr) = perm_val.as_array() else {
            return Err(ManifestValidationError(String::from(
                "Malformed plugin manifest: permissions must be an array",
            )));
        };
        for perm in perm_arr {
            let Some(perm_str) = perm.as_str() else {
                return Err(ManifestValidationError(format!(
                    "Unknown plugin permission: {perm}"
                )));
            };
            if !PLUGIN_PERMISSIONS.contains(&perm_str) {
                return Err(ManifestValidationError(format!(
                    "Unknown plugin permission: {perm_str}"
                )));
            }
            permissions.push(perm_str.to_owned());
        }
    }

    let mut fields = Vec::new();
    if let Some(cfg_val) = obj.get("configuration").filter(|v| !v.is_null()) {
        let Some(cfg_obj) = cfg_val.as_object() else {
            return Err(ManifestValidationError(String::from(
                "Malformed plugin manifest: configuration must be an object",
            )));
        };
        for (key, field_val) in cfg_obj {
            let Some(f_obj) = field_val.as_object() else {
                return Err(ManifestValidationError(format!(
                    "Malformed configuration field: {key}"
                )));
            };
            let Some(f_type) = f_obj.get("type").and_then(Value::as_str) else {
                return Err(ManifestValidationError(format!(
                    "Unknown configuration field type for {key}: undefined"
                )));
            };
            if !matches!(
                f_type,
                "string" | "number" | "boolean" | "select" | "url" | "secret"
            ) {
                return Err(ManifestValidationError(format!(
                    "Unknown configuration field type for {key}: {f_type}"
                )));
            }
            fields.push(PluginConfigField {
                key: key.clone(),
                label: Some(
                    f_obj
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or(key)
                        .to_owned(),
                ),
                field_type: Some(f_type.to_owned()),
                options: None,
                description: None,
                secret: f_type == "secret",
                required: f_obj
                    .get("required")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                default: f_obj.get("default").cloned(),
            });
        }
    }

    Ok(PluginManifest {
        id: id.to_owned(),
        name: name.to_owned(),
        version: version.to_owned(),
        description,
        author,
        capabilities,
        permissions: Some(permissions),
        config: (!fields.is_empty()).then_some(PluginConfigSpec { fields }),
    })
}

/// Normalized plugin diagnostic / operation failure statuses (`PluginErrorStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginErrorStatus {
    Success,
    NotConfigured,
    AuthenticationFailed,
    ProviderUnavailable,
    Timeout,
    PermissionDenied,
    PluginError,
}

impl PluginErrorStatus {
    /// Canonical lowercase snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::NotConfigured => "not_configured",
            Self::AuthenticationFailed => "authentication_failed",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::Timeout => "timeout",
            Self::PermissionDenied => "permission_denied",
            Self::PluginError => "plugin_error",
        }
    }

    /// Default client-safe message for this status.
    #[must_use]
    pub const fn default_message(self) -> &'static str {
        match self {
            Self::Success => "Plugin is ready",
            Self::NotConfigured => "Plugin is not fully configured",
            Self::AuthenticationFailed => "Authentication failed",
            Self::ProviderUnavailable => "Provider is unavailable",
            Self::Timeout => "Connection timed out",
            Self::PermissionDenied => "Plugin is missing an approved permission",
            Self::PluginError => "Plugin reported an unexpected error",
        }
    }
}

/// Classified plugin failure containing a normalized [`PluginErrorStatus`] and client-safe message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginErrorClassification {
    pub status: PluginErrorStatus,
    pub message: String,
}

/// Classifies an arbitrary error message into a client-safe [`PluginErrorClassification`].
#[must_use]
pub fn classify_plugin_error(message: &str) -> PluginErrorClassification {
    let lower = message.to_ascii_lowercase();
    let status = if lower.contains("misconfigured")
        || lower.contains("not configured")
        || (lower.contains("missing") && (lower.contains("config") || lower.contains("field")))
    {
        PluginErrorStatus::NotConfigured
    } else if lower.contains("permission") {
        PluginErrorStatus::PermissionDenied
    } else if lower.contains("authentication")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("401")
        || lower.contains("403")
        || (lower.contains("invalid")
            && (lower.contains("token")
                || lower.contains("credential")
                || lower.contains("key")))
    {
        PluginErrorStatus::AuthenticationFailed
    } else if lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("abort")
    {
        PluginErrorStatus::Timeout
    } else if lower.contains("unavailable")
        || lower.contains("unreachable")
        || lower.contains("network")
        || lower.contains("fetch failed")
        || lower.contains("econnrefused")
        || lower.contains("enotfound")
    {
        PluginErrorStatus::ProviderUnavailable
    } else {
        PluginErrorStatus::PluginError
    };

    PluginErrorClassification {
        status,
        message: status.default_message().to_owned(),
    }
}

/// Maps a [`PluginErrorStatus`] to an HTTP status code (`httpStatusForPluginError`).
#[must_use]
pub const fn http_status_for_plugin_error(status: PluginErrorStatus) -> StatusCode {
    match status {
        PluginErrorStatus::NotConfigured => StatusCode::BAD_REQUEST,
        PluginErrorStatus::PermissionDenied => StatusCode::FORBIDDEN,
        PluginErrorStatus::AuthenticationFailed => StatusCode::UNAUTHORIZED,
        PluginErrorStatus::Timeout | PluginErrorStatus::ProviderUnavailable => {
            StatusCode::BAD_GATEWAY
        }
        PluginErrorStatus::PluginError => StatusCode::INTERNAL_SERVER_ERROR,
        PluginErrorStatus::Success => StatusCode::OK,
    }
}
