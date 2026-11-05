use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_SERVER_URL: &str = "http://localhost:4534";
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
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            server_url: DEFAULT_SERVER_URL.to_string(),
            close_to_tray: true,
            start_minimized: false,
            auto_check_updates: true,
        }
    }
}

pub fn normalize_server_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("Server URL must start with http:// or https://".to_string());
    }

    let after_scheme = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .unwrap_or("");

    if after_scheme.is_empty() || after_scheme.starts_with('/') {
        return Err("Server URL must include a valid host".to_string());
    }

    Ok(trimmed.to_string())
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
    }

    #[test]
    fn rejects_invalid_schemes_or_missing_hosts() {
        assert!(normalize_server_url("ftp://localhost:4534").is_err());
        assert!(normalize_server_url("http://").is_err());
        assert!(normalize_server_url("https:///api").is_err());
    }
}
