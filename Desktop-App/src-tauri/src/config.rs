use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::{fs, io::Write};

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
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    if trimmed
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return Err(
            "Server URL cannot contain whitespace, control characters, or backslashes".into(),
        );
    }

    let (scheme, address) = trimmed.split_once("://").unwrap_or(("http", trimmed));
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https") {
        return Err("Server URL must start with http:// or https://".into());
    }
    let authority = address.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.ends_with(':') || authority.contains('@') {
        return Err("Server URL must include a valid host and port".into());
    }
    let mut parsed = reqwest::Url::parse(&format!("{scheme}://{address}"))
        .map_err(|_| "Enter a valid HTTP or HTTPS server URL".to_string())?;
    if parsed.host().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Server URL must include a host and cannot include credentials, a query, or a fragment"
                .into(),
        );
    }
    if !trimmed.contains("://") && !authority.contains(':') {
        // A bare hostname or IPv4 address uses the Docker web port.
        parsed
            .set_port(Some(8080))
            .map_err(|()| "Invalid server port".to_string())?;
    }
    Ok(parsed.as_str().trim_end_matches('/').to_owned())
}

pub fn candidate_server_urls(raw: &str) -> Result<Vec<String>, String> {
    let primary = normalize_server_url(raw)?;
    if primary.is_empty() {
        return Err("Server URL is required".to_string());
    }

    let mut url = reqwest::Url::parse(&primary).map_err(|err| err.to_string())?;
    let mut candidates = vec![primary];
    if url.path() == "/" {
        for port in [Some(8080), Some(4534), None] {
            url.set_port(port)
                .map_err(|()| "Invalid server port".to_string())?;
            let fallback = url.as_str().trim_end_matches('/');
            if !candidates.iter().any(|candidate| candidate == fallback) {
                candidates.push(fallback.to_owned());
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

    match normalize_server_url(&parsed.server_url) {
        Ok(normalized) if !normalized.is_empty() => parsed.server_url = normalized,
        _ => {
            parsed.server_url = DEFAULT_SERVER_URL.to_string();
            parsed.session_cookie = None;
        }
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
    let mut file = tempfile::NamedTempFile::new_in(app_config_dir)
        .map_err(|err| format!("Failed to create temporary desktop config: {err}"))?;
    file.write_all(payload.as_bytes())
        .and_then(|()| file.as_file().sync_all())
        .map_err(|err| format!("Failed to write desktop config: {err}"))?;
    file.persist(config_file_path(app_config_dir))
        .map_err(|err| format!("Failed to replace desktop config: {err}"))?;

    Ok(updated)
}

pub(crate) struct DesktopConnection {
    pub(crate) config: DesktopConfig,
    ephemeral_cookie: Option<String>,
    server_generation: u64,
    next_request: u64,
    last_cookie_request: u64,
    last_settings_request: u64,
}

pub(crate) struct UpstreamRequest {
    pub(crate) server_url: String,
    pub(crate) cookie: Option<String>,
    server_generation: u64,
    sequence: u64,
}

impl UpstreamRequest {
    pub(crate) fn candidate_urls(&self) -> Result<Vec<String>, String> {
        if self.cookie.is_some() {
            return Ok(vec![self.server_url.clone()]);
        }
        candidate_server_urls(&self.server_url)
    }
}

impl DesktopConnection {
    pub(crate) fn new(config: DesktopConfig) -> Self {
        Self {
            config,
            ephemeral_cookie: None,
            server_generation: 0,
            next_request: 0,
            last_cookie_request: 0,
            last_settings_request: 0,
        }
    }

    pub(crate) fn begin_request(&mut self) -> UpstreamRequest {
        self.next_request += 1;
        UpstreamRequest {
            server_url: self.config.server_url.clone(),
            cookie: self
                .ephemeral_cookie
                .clone()
                .or_else(|| self.config.session_cookie.clone()),
            server_generation: self.server_generation,
            sequence: self.next_request,
        }
    }

    pub(crate) fn save_settings(
        &mut self,
        config_dir: &Path,
        mut candidate: DesktopConfig,
    ) -> Result<(), String> {
        let normalized = normalize_server_url(&candidate.server_url)?;
        candidate.server_url = if normalized.is_empty() {
            DEFAULT_SERVER_URL.into()
        } else {
            normalized
        };
        let server_changed = candidate.server_url != self.config.server_url;
        candidate.session_cookie = if server_changed {
            None
        } else {
            self.config.session_cookie.clone()
        };
        self.config = save_config(config_dir, &candidate)?;
        self.last_settings_request = self.next_request;
        if server_changed {
            self.server_generation += 1;
            self.ephemeral_cookie = None;
        }
        Ok(())
    }

    pub(crate) fn accept_response(
        &mut self,
        config_dir: &Path,
        request: &UpstreamRequest,
        response_base: &str,
        headers: &reqwest::header::HeaderMap,
    ) -> Result<(), String> {
        if request.server_generation != self.server_generation {
            return Err("The MusicDeck server changed while this request was in progress.".into());
        }
        let server_changed = response_base != self.config.server_url;
        if server_changed && request.sequence <= self.last_settings_request {
            return Err("Desktop settings were saved while selecting a server.".into());
        }
        let cookie = headers
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| {
                let mut parts = value.to_str().ok()?.split(';');
                let token = parts.next()?.trim().strip_prefix("musicdeck_session=")?;
                let mut persistent = false;
                let mut expired = token.is_empty();
                for attribute in parts {
                    if let Some((name, value)) = attribute.trim().split_once('=') {
                        if name.eq_ignore_ascii_case("max-age") {
                            persistent = true;
                            expired |= value.parse::<i64>().is_ok_and(|seconds| seconds <= 0);
                        } else if name.eq_ignore_ascii_case("expires") {
                            persistent = true;
                        }
                    }
                }
                Some(((!expired).then(|| token.to_owned()), persistent))
            })
            .last();
        if !server_changed && cookie.is_none() {
            return Ok(());
        }

        let (token, persistent) = cookie.unwrap_or_default();
        let current_cookie = self
            .ephemeral_cookie
            .as_ref()
            .or(self.config.session_cookie.as_ref());
        if token.is_some() && token == request.cookie && token.as_ref() != current_cookie {
            return Err("This response attempted to renew a previous MusicDeck session.".into());
        }
        let mut candidate = self.config.clone();
        candidate.server_url = response_base.to_owned();
        candidate.session_cookie = if persistent { token.clone() } else { None };
        let ephemeral_cookie = if persistent { None } else { token };
        // A newer response may have signed in or out while this request was running.
        if request.sequence <= self.last_cookie_request {
            return if candidate == self.config && ephemeral_cookie == self.ephemeral_cookie {
                Ok(())
            } else {
                Err("A newer MusicDeck session response has already been applied.".into())
            };
        }
        if candidate != self.config {
            self.config = save_config(config_dir, &candidate)?;
        }
        self.ephemeral_cookie = ephemeral_cookie;
        self.last_cookie_request = request.sequence;
        if server_changed {
            self.server_generation += 1;
        }
        Ok(())
    }
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
        for url in [
            "ftp://localhost:4534",
            "http://",
            "https:///api",
            "http:/api",
            "http://example.com:",
            "http://user:password@example.com",
            "http://@example.com",
            "https://example.com/?q=1",
            "https://example.com/#fragment",
            "http://exa\tmple.com",
            "http://\\example.com",
        ] {
            assert!(normalize_server_url(url).is_err(), "accepted {url:?}");
        }
    }

    #[test]
    fn preserves_subpaths_and_probes_ipv6_without_corrupting_the_authority() {
        assert_eq!(
            normalize_server_url("HTTPS://music.example.com/base///").unwrap(),
            "https://music.example.com/base"
        );
        assert_eq!(
            normalize_server_url("mediaserver/music/").unwrap(),
            "http://mediaserver:8080/music"
        );
        assert_eq!(
            candidate_server_urls("http://[::1]:4534").unwrap(),
            ["http://[::1]:4534", "http://[::1]:8080", "http://[::1]"]
        );
    }

    fn session_headers(value: &str) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::SET_COOKIE, value.parse().unwrap());
        headers
    }

    #[test]
    fn responses_from_an_earlier_server_generation_cannot_reinstate_its_session() {
        let dir = tempfile::tempdir().unwrap();
        let config = DesktopConfig {
            session_cookie: Some("original".into()),
            ..DesktopConfig::default()
        };
        let mut connection = DesktopConnection::new(config.clone());
        let old_request = connection.begin_request();
        assert_eq!(
            old_request.candidate_urls().unwrap(),
            [config.server_url.clone()]
        );
        let mut updated = config.clone();
        updated.server_url = "http://localhost:4534".into();
        connection.save_settings(dir.path(), updated).unwrap();
        connection
            .save_settings(dir.path(), config.clone())
            .unwrap();

        assert!(connection
            .accept_response(
                dir.path(),
                &old_request,
                &config.server_url,
                &session_headers("musicdeck_session=stale; Max-Age=3600"),
            )
            .is_err());
        assert!(connection.begin_request().cookie.is_none());
        assert!(load_config(dir.path()).session_cookie.is_none());
    }

    #[test]
    fn reordered_login_cannot_undo_a_newer_logout() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = DesktopConnection::new(DesktopConfig::default());
        let login = connection.begin_request();
        let logout = connection.begin_request();
        connection
            .accept_response(
                dir.path(),
                &logout,
                &logout.server_url,
                &session_headers("musicdeck_session=; Max-Age=0"),
            )
            .unwrap();
        assert!(connection
            .accept_response(
                dir.path(),
                &login,
                &login.server_url,
                &session_headers("musicdeck_session=stale; Max-Age=3600")
            )
            .is_err());
        assert!(connection.begin_request().cookie.is_none());
    }

    #[test]
    fn failed_settings_write_preserves_the_current_connection() {
        let dir = tempfile::tempdir().unwrap();
        let invalid_dir = dir.path().join("file");
        fs::write(&invalid_dir, "").unwrap();
        let config = DesktopConfig::default();
        let mut connection = DesktopConnection::new(config.clone());
        let login = connection.begin_request();
        connection
            .accept_response(
                dir.path(),
                &login,
                &config.server_url,
                &session_headers("musicdeck_session=ephemeral"),
            )
            .unwrap();

        let changed = DesktopConfig {
            server_url: "http://localhost:4534".into(),
            ..config.clone()
        };
        assert!(connection.save_settings(&invalid_dir, changed).is_err());
        assert_eq!(connection.config, config);
        assert_eq!(
            connection.begin_request().cookie.as_deref(),
            Some("ephemeral")
        );
    }

    #[test]
    fn fallback_response_cannot_change_an_explicitly_saved_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let config = DesktopConfig::default();
        let mut connection = DesktopConnection::new(config.clone());
        let request = connection.begin_request();
        connection
            .save_settings(dir.path(), config.clone())
            .unwrap();

        assert!(connection
            .accept_response(
                dir.path(),
                &request,
                "http://localhost:4534",
                &reqwest::header::HeaderMap::new(),
            )
            .is_err());
        assert_eq!(load_config(dir.path()), config);
    }
}
