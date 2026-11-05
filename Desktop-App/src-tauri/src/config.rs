use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_SERVER_URL: &str = "http://localhost:8080";
const CONFIG_FILE_NAME: &str = "desktop-config.json";

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub server_url: String,
    pub close_to_tray: bool,
    pub start_minimized: bool,
    #[serde(default = "default_true")]
    pub auto_check_updates: bool,
    #[serde(default)]
    pub session_cookie: Option<String>,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            server_url: DEFAULT_SERVER_URL.to_string(),
            close_to_tray: true,
            start_minimized: false,
            auto_check_updates: true,
            session_cookie: None,
        }
    }
}

pub fn normalize_server_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    let with_scheme = if !trimmed.contains("://") {
        let host_part = trimmed.split('/').next().unwrap_or("");
        if host_part.is_empty() {
            return Err("Server URL must include a valid host".to_string());
        }
        // If user entered a bare IP or hostname without a port (e.g. "192.168.2.38"),
        // default to Docker's published web port 8080.
        if !host_part.contains(':') {
            format!("http://{host_part}:8080")
        } else {
            format!("http://{trimmed}")
        }
    } else {
        trimmed.to_string()
    };

    if !with_scheme.starts_with("http://") && !with_scheme.starts_with("https://") {
        return Err("Server URL must start with http:// or https://".to_string());
    }

    let after_scheme = with_scheme
        .strip_prefix("http://")
        .or_else(|| with_scheme.strip_prefix("https://"))
        .unwrap_or("");

    if after_scheme.is_empty() || after_scheme.starts_with('/') {
        return Err("Server URL must include a valid host".to_string());
    }

    Ok(with_scheme)
}

pub fn candidate_server_urls(raw: &str) -> Result<Vec<String>, String> {
    let primary = normalize_server_url(raw)?;
    if primary.is_empty() {
        return Err("Server URL is required".to_string());
    }

    let mut candidates = vec![primary.clone()];
    let (scheme, rest) = if let Some(s) = primary.strip_prefix("http://") {
        ("http://", s)
    } else if let Some(s) = primary.strip_prefix("https://") {
        ("https://", s)
    } else {
        return Ok(candidates);
    };

    // Only auto-probe alternate ports when no custom subpath is present.
    if !rest.contains('/') {
        let host_only = rest.split(':').next().unwrap_or(rest);
        if !host_only.is_empty() {
            for fallback in [
                format!("{scheme}{host_only}:8080"),
                format!("{scheme}{host_only}:4534"),
                format!("{scheme}{host_only}"),
            ] {
                if !candidates.contains(&fallback) {
                    candidates.push(fallback);
                }
            }
        }
    }

    Ok(candidates)
}

pub fn config_file_path(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join(CONFIG_FILE_NAME)
}

pub fn load_config(app_config_dir: &Path) -> DesktopConfig {
    let path = config_file_path(app_config_dir);
    let Ok(contents) = fs::read_to_string(&path) else {
        return DesktopConfig::default();
    };

    let Ok(mut parsed) = serde_json::from_str::<DesktopConfig>(&contents) else {
        return DesktopConfig::default();
    };

    if let Ok(normalized) = normalize_server_url(&parsed.server_url) {
        if !normalized.is_empty() {
            parsed.server_url = normalized;
        } else {
            parsed.server_url = DEFAULT_SERVER_URL.to_string();
        }
    } else {
        parsed.server_url = DEFAULT_SERVER_URL.to_string();
    }

    parsed
}

pub fn save_config(app_config_dir: &Path, config: &DesktopConfig) -> Result<DesktopConfig, String> {
    let normalized_url = normalize_server_url(&config.server_url)?;
    let updated = DesktopConfig {
        server_url: if normalized_url.is_empty() {
            DEFAULT_SERVER_URL.to_string()
        } else {
            normalized_url
        },
        close_to_tray: config.close_to_tray,
        start_minimized: config.start_minimized,
        auto_check_updates: config.auto_check_updates,
        session_cookie: config.session_cookie.clone(),
    };

    fs::create_dir_all(app_config_dir)
        .map_err(|err| format!("Failed to create desktop config directory: {err}"))?;
    let payload = serde_json::to_string_pretty(&updated)
        .map_err(|err| format!("Failed to serialize desktop config: {err}"))?;
    fs::write(config_file_path(app_config_dir), payload)
        .map_err(|err| format!("Failed to write desktop config: {err}"))?;

    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_valid_http_and_https_urls() {
        assert_eq!(
            normalize_server_url("  http://localhost:4534/  ").unwrap(),
            "http://localhost:4534"
        );
        assert_eq!(
            normalize_server_url("https://music.example.com///").unwrap(),
            "https://music.example.com"
        );
        assert_eq!(
            normalize_server_url("192.168.2.38").unwrap(),
            "http://192.168.2.38:8080"
        );
        assert_eq!(
            normalize_server_url("192.168.2.38:8080/").unwrap(),
            "http://192.168.2.38:8080"
        );
        let candidates = candidate_server_urls("http://192.168.2.38:4534").unwrap();
        assert_eq!(
            candidates,
            vec![
                "http://192.168.2.38:4534".to_string(),
                "http://192.168.2.38:8080".to_string(),
                "http://192.168.2.38".to_string()
            ]
        );
    }

    #[test]
    fn rejects_invalid_schemes_or_missing_hosts() {
        assert!(normalize_server_url("ftp://localhost:4534").is_err());
        assert!(normalize_server_url("http://").is_err());
        assert!(normalize_server_url("https:///api").is_err());
    }
}
