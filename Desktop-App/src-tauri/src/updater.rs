use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};
use tempfile::TempPath;
use tokio::io::AsyncWriteExt;

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

pub fn validate_installer_url(url: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(url.trim()).map_err(|_| "Invalid update installer URL")?;
    if url.scheme() != "https" {
        return Err("Update installer URL must use HTTPS".to_string());
    }

    let allowed_host = url.host_str().is_some_and(|host| {
        host == "github.com"
            || host.ends_with(".github.com")
            || host.ends_with(".githubusercontent.com")
    });

    if !allowed_host || !url.username().is_empty() || url.password().is_some() {
        return Err("Update installer must be hosted on GitHub Releases".to_string());
    }

    if !url.path().ends_with(".exe") && !url.path().ends_with(".msi") {
        return Err("Update installer URL must point to a .exe or .msi package".to_string());
    }

    Ok(url)
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "stage",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdateStatus {
    Downloading {
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    },
    Verifying,
    Installing,
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
    report: impl Fn(UpdateStatus),
) -> Result<TempPath, String> {
    let validated_url = validate_installer_url(installer_url)?;
    let expected = expected_sha256
        .map(str::trim)
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("The update is missing a valid SHA-256 checksum")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .https_only(true)
        .user_agent(format!("MusicDeck-Desktop/{CURRENT_VERSION}"))
        .build()
        .map_err(|err| format!("Failed to initialize download client: {err}"))?;

    let extension = if validated_url.path().ends_with(".msi") {
        ".msi"
    } else {
        ".exe"
    };
    let mut response = client
        .get(validated_url)
        .send()
        .await
        .map_err(|err| format!("Failed to download update installer: {err}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Installer download failed with HTTP {}",
            response.status()
        ));
    }

    let (file, installer_path) = tempfile::Builder::new()
        .prefix("MusicDeck-Update-")
        .suffix(extension)
        .tempfile()
        .map_err(|err| format!("Failed to create temporary update file: {err}"))?
        .into_parts();
    let mut file = tokio::fs::File::from_std(file);
    let mut hasher = Sha256::new();
    let total_bytes = response.content_length().filter(|total| *total > 0);
    let mut downloaded_bytes = 0;
    let mut last_report = Instant::now();
    report(UpdateStatus::Downloading {
        downloaded_bytes,
        total_bytes,
    });
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("Failed to read installer payload: {err}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|err| format!("Failed to save update installer: {err}"))?;
        hasher.update(&chunk);
        downloaded_bytes += chunk.len() as u64;
        if last_report.elapsed() >= Duration::from_millis(100) {
            report(UpdateStatus::Downloading {
                downloaded_bytes,
                total_bytes,
            });
            last_report = Instant::now();
        }
    }
    file.flush()
        .await
        .map_err(|err| format!("Failed to save update installer: {err}"))?;
    drop(file);

    report(UpdateStatus::Verifying);
    let actual = format!("{:x}", hasher.finalize());
    if downloaded_bytes == 0 || !actual.eq_ignore_ascii_case(expected) {
        return Err("Downloaded installer failed SHA-256 integrity verification".to_string());
    }

    Ok(installer_path)
}

fn installer_command(installer_path: &Path) -> Command {
    if installer_path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("msi"))
    {
        let mut command = Command::new("msiexec.exe");
        command
            .arg("/i")
            .arg(installer_path)
            .args(["/passive", "/norestart", "AUTOLAUNCHAPP=1"]);
        command
    } else {
        let mut command = Command::new(installer_path);
        // Tauri's NSIS installer shows progress, upgrades in place and relaunches on success.
        command.args(["/P", "/UPDATE", "/R"]);
        command
    }
}

pub fn launch_installer(installer_path: TempPath) -> Result<(), String> {
    // Keep the verified package available to the installer after MusicDeck exits.
    let installer_path = installer_path
        .keep()
        .map_err(|err| format!("Failed to prepare verified installer: {err}"))?;
    if let Err(err) = installer_command(&installer_path).spawn() {
        let _ = fs::remove_file(installer_path);
        return Err(format!("Failed to launch update installer: {err}"));
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
        assert!(validate_installer_url("https://user@github.com/setup.exe").is_err());
    }

    #[test]
    fn reports_byte_counts_in_the_update_event() {
        let status = UpdateStatus::Downloading {
            downloaded_bytes: 512,
            total_bytes: Some(1024),
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({
                "stage": "downloading", "downloadedBytes": 512, "totalBytes": 1024,
            })
        );
    }

    #[test]
    fn starts_windows_installers_with_progress_and_relaunch() {
        let nsis = Path::new("MusicDeck Update.exe");
        let command = installer_command(nsis);
        assert_eq!(command.get_program(), nsis.as_os_str());
        assert!(command.get_args().eq(["/P", "/UPDATE", "/R"]));

        let msi = Path::new("MusicDeck Update.msi");
        let command = installer_command(msi);
        assert_eq!(command.get_program(), "msiexec.exe");
        assert!(command.get_args().eq([
            "/i",
            "MusicDeck Update.msi",
            "/passive",
            "/norestart",
            "AUTOLAUNCHAPP=1",
        ]));
    }
}
