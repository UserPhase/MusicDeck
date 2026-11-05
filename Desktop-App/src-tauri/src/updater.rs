use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub const DEFAULT_UPDATE_MANIFEST_URL: &str =
    "https://github.com/UserPhase/MusicDeck/releases/download/desktop-latest/latest.json";

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const CURRENT_BUILD_SHA: &str = env!("MUSICDECK_BUILD_SHA");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateManifest {
    pub version: String,
    pub build_id: Option<String>,
    pub published_at: Option<String>,
    pub notes: Option<String>,
    pub installer_url: String,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResponse {
    pub update_available: bool,
    pub current_version: String,
    pub current_build_id: Option<String>,
    pub latest_version: Option<String>,
    pub build_id: Option<String>,
    pub published_at: Option<String>,
    pub notes: Option<String>,
    pub installer_url: Option<String>,
    pub sha256: Option<String>,
    pub error: Option<String>,
}

fn parse_semver_tuple(version: &str) -> Option<(u64, u64, u64)> {
    let cleaned = version.trim().trim_start_matches('v');
    let core = cleaned.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    Some((major, minor, patch))
}

pub fn is_update_available(
    current_version: &str,
    latest_version: &str,
    current_build_id: Option<&str>,
    latest_build_id: Option<&str>,
) -> bool {
    if let (Some(curr), Some(latest)) = (
        parse_semver_tuple(current_version),
        parse_semver_tuple(latest_version),
    ) {
        if latest > curr {
            return true;
        }
        if latest < curr {
            return false;
        }
    } else if latest_version.trim() != current_version.trim() {
        return true;
    }

    let curr_sha = current_build_id.map(str::trim).filter(|s| !s.is_empty());
    let latest_sha = latest_build_id.map(str::trim).filter(|s| !s.is_empty());
    if let (Some(c), Some(l)) = (curr_sha, latest_sha) {
        return !c.eq_ignore_ascii_case(l);
    }

    false
}

pub fn validate_installer_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("https://") {
        return Err("Update installer URL must use HTTPS".to_string());
    }

    let without_scheme = trimmed.strip_prefix("https://").unwrap_or("");
    let host = without_scheme.split('/').next().unwrap_or("").to_ascii_lowercase();
    let allowed_host = host == "github.com"
        || host.ends_with(".github.com")
        || host.ends_with(".githubusercontent.com");

    if !allowed_host {
        return Err("Update installer must be hosted on GitHub Releases".to_string());
    }

    let path_part = without_scheme.split('?').next().unwrap_or("");
    if !path_part.ends_with(".exe") && !path_part.ends_with(".msi") {
        return Err("Update installer URL must point to a .exe or .msi package".to_string());
    }

    Ok(trimmed.to_string())
}

pub fn compute_sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

pub async fn check_for_updates(manifest_url: Option<&str>) -> UpdateCheckResponse {
    let target_url = manifest_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_UPDATE_MANIFEST_URL);

    let current_build = if CURRENT_BUILD_SHA.trim().is_empty() {
        None
    } else {
        Some(CURRENT_BUILD_SHA.trim().to_string())
    };

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(format!("MusicDeck-Desktop/{CURRENT_VERSION}"))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            return UpdateCheckResponse {
                update_available: false,
                current_version: CURRENT_VERSION.to_string(),
                current_build_id: current_build,
                latest_version: None,
                build_id: None,
                published_at: None,
                notes: None,
                installer_url: None,
                sha256: None,
                error: Some(format!("Failed to initialize update client: {err}")),
            }
        }
    };

    match client.get(target_url).send().await {
        Ok(response) if response.status().is_success() => {
            match response.json::<UpdateManifest>().await {
                Ok(manifest) => {
                    let available = is_update_available(
                        CURRENT_VERSION,
                        &manifest.version,
                        current_build.as_deref(),
                        manifest.build_id.as_deref(),
                    );
                    UpdateCheckResponse {
                        update_available: available,
                        current_version: CURRENT_VERSION.to_string(),
                        current_build_id: current_build,
                        latest_version: Some(manifest.version),
                        build_id: manifest.build_id,
                        published_at: manifest.published_at,
                        notes: manifest.notes,
                        installer_url: Some(manifest.installer_url),
                        sha256: manifest.sha256,
                        error: None,
                    }
                }
                Err(err) => UpdateCheckResponse {
                    update_available: false,
                    current_version: CURRENT_VERSION.to_string(),
                    current_build_id: current_build,
                    latest_version: None,
                    build_id: None,
                    published_at: None,
                    notes: None,
                    installer_url: None,
                    sha256: None,
                    error: Some(format!("Invalid update manifest format: {err}")),
                },
            }
        }
        Ok(response) => UpdateCheckResponse {
            update_available: false,
            current_version: CURRENT_VERSION.to_string(),
            current_build_id: current_build,
            latest_version: None,
            build_id: None,
            published_at: None,
            notes: None,
            installer_url: None,
            sha256: None,
            error: Some(format!("Update server returned HTTP {}", response.status())),
        },
        Err(err) => UpdateCheckResponse {
            update_available: false,
            current_version: CURRENT_VERSION.to_string(),
            current_build_id: current_build,
            latest_version: None,
            build_id: None,
            published_at: None,
            notes: None,
            installer_url: None,
            sha256: None,
            error: Some(format!("Could not check for updates: {err}")),
        },
    }
}

pub async fn download_and_verify_installer(
    installer_url: &str,
    expected_sha256: Option<&str>,
) -> Result<PathBuf, String> {
    let validated_url = validate_installer_url(installer_url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .user_agent(format!("MusicDeck-Desktop/{CURRENT_VERSION}"))
        .build()
        .map_err(|err| format!("Failed to initialize download client: {err}"))?;

    let response = client
        .get(&validated_url)
        .send()
        .await
        .map_err(|err| format!("Failed to download update installer: {err}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Installer download failed with HTTP {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("Failed to read installer payload: {err}"))?;

    if let Some(expected) = expected_sha256.map(str::trim).filter(|s| !s.is_empty()) {
        let actual = compute_sha256_hex(&bytes);
        if !actual.eq_ignore_ascii_case(expected) {
            return Err("Downloaded installer failed SHA-256 integrity verification".to_string());
        }
    }

    let extension = if validated_url.split('?').next().unwrap_or("").ends_with(".msi") {
        "msi"
    } else {
        "exe"
    };
    let target_path = std::env::temp_dir().join(format!("MusicDeck-Update-Setup.{extension}"));
    fs::write(&target_path, &bytes)
        .map_err(|err| format!("Failed to save update installer to disk: {err}"))?;

    Ok(target_path)
}

pub fn launch_installer(installer_path: &Path) -> Result<(), String> {
    let ext = installer_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("exe")
        .to_ascii_lowercase();

    if ext == "msi" {
        Command::new("msiexec")
            .arg("/i")
            .arg(installer_path)
            .arg("/passive")
            .spawn()
            .map_err(|err| format!("Failed to launch MSI update installer: {err}"))?;
    } else {
        Command::new(installer_path)
            .spawn()
            .map_err(|err| format!("Failed to launch update installer: {err}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions_and_build_ids_accurately() {
        assert!(is_update_available("0.1.0", "0.2.0", None, None));
        assert!(!is_update_available("0.2.0", "0.1.0", None, None));
        assert!(!is_update_available("0.1.0", "0.1.0", None, None));
        assert!(is_update_available(
            "0.1.0",
            "0.1.0",
            Some("abc111"),
            Some("def222")
        ));
        assert!(!is_update_available(
            "0.1.0",
            "0.1.0",
            Some("abc111"),
            Some("ABC111")
        ));
    }

    #[test]
    fn validates_github_installer_urls() {
        assert!(validate_installer_url(
            "https://github.com/UserPhase/MusicDeck/releases/download/desktop-latest/MusicDeck_0.1.0_x64-setup.exe"
        )
        .is_ok());
        assert!(validate_installer_url("http://github.com/UserPhase/MusicDeck/setup.exe").is_err());
        assert!(validate_installer_url("https://evil.example.com/setup.exe").is_err());
    }
}
