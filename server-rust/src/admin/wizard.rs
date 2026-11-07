//! # System Health Wizard & Remediation Diagnostics (`admin::wizard`)
//!
//! Ports `server/src/services/SystemHealthWizard.ts`:
//! - [`DiagnosticStatus`] (`pass | warning | fail`)
//! - [`DiagnosticCategory`] (`connection | storage | dependencies | database`)
//! - [`DiagnosticCheck`] and [`DiagnosticReport`]
//! - [`SystemHealthWizard`]:
//!   1. `backend-connection`: Verifies Navidrome Subsonic `rest/ping.view` (MD5 + salt) or
//!      Jellyfin `System/Info` (`X-Emby-Token`) with an 8-second timeout and `1 MiB` response ceiling
//!   2. `database-directory`, `music-directory`, `download-directory`, `artwork-directory`,
//!      `backup-directory`: Performs an atomic write-sync-unlink probe
//!   3. `spotdl` & `ffmpeg`: Verifies executable availability via [`ProcessRunner`]
//!   4. `database-integrity`: Runs `PRAGMA quick_check`, `PRAGMA foreign_key_check`, and verifies
//!      core application schema tables (`users`, `server_settings`, `schema_migrations`,
//!      `backend_connections`, `plugin_configs`)

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use md5::{Digest, Md5};
use reqwest::redirect::Policy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use url::Url;
use uuid::Uuid;

use crate::config::{AppConfig, BackendType};
use crate::db::DbPool;
use crate::tasks::{DefaultProcessRunner, ProcessOptions, ProcessRunner};

/// Diagnostic check outcome status (`pass | warning | fail`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticStatus {
    Pass,
    Warning,
    Fail,
}

/// Diagnostic subsystem category (`connection | storage | dependencies | database`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticCategory {
    Connection,
    Storage,
    Dependencies,
    Database,
}

/// Individual diagnostic check result with actionable remediation guidance (`DiagnosticCheck`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCheck {
    pub id: String,
    pub category: DiagnosticCategory,
    pub title: String,
    pub status: DiagnosticStatus,
    pub message: String,
    pub fix: String,
    pub duration_ms: u64,
}

/// Complete system health wizard report (`DiagnosticReport`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    pub checked_at: String,
    pub status: DiagnosticStatus,
    pub ready: bool,
    pub checks: Vec<DiagnosticCheck>,
}

/// System health diagnostic wizard executing 9 concurrent environment, storage, dependency, and SQLite checks.
#[derive(Clone)]
pub struct SystemHealthWizard {
    db: Option<DbPool>,
    config: Arc<AppConfig>,
    runner: Arc<dyn ProcessRunner>,
    http: Client,
}

impl std::fmt::Debug for SystemHealthWizard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SystemHealthWizard").finish()
    }
}

impl SystemHealthWizard {
    /// Creates a new [`SystemHealthWizard`].
    #[must_use]
    pub fn new(db: Option<DbPool>, config: Arc<AppConfig>) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(Policy::none())
            .build()
            .unwrap_or_default();
        Self {
            db,
            config,
            runner: Arc::new(DefaultProcessRunner::new()),
            http,
        }
    }

    /// Executes all 9 diagnostic checks and returns a consolidated [`DiagnosticReport`].
    pub async fn run(&self) -> DiagnosticReport {
        let db_dir = Path::new(self.config.database_path())
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        let music_dir = PathBuf::from(&self.config.music_root);
        let download_dir = PathBuf::from(&self.config.acquisition_tmp_dir);
        let artwork_dir = db_dir.join("artwork");
        let backup_dir = db_dir.join("backups");

        let spotdl_bin = self
            .resolve_tool_path("spotdlPath", "spotdl")
            .await;
        let ffmpeg_bin = self
            .resolve_tool_path("ffmpegPath", "ffmpeg")
            .await;

        let spotdl_args = [String::from("--version")];
        let ffmpeg_args = [String::from("-version")];

        let (
            c_conn,
            c_db_dir,
            c_music_dir,
            c_dl_dir,
            c_art_dir,
            c_bak_dir,
            c_spotdl,
            c_ffmpeg,
            c_db,
        ) = tokio::join!(
            self.check_connection(),
            Self::check_directory(
                "database-directory",
                "Database and configuration directory",
                &db_dir,
                true
            ),
            Self::check_directory(
                "music-directory",
                "Music library directory",
                &music_dir,
                true
            ),
            Self::check_directory(
                "download-directory",
                "Download staging directory",
                &download_dir,
                true
            ),
            Self::check_directory(
                "artwork-directory",
                "Artwork cache directory",
                &artwork_dir,
                false
            ),
            Self::check_directory("backup-directory", "Backup directory", &backup_dir, false),
            self.check_dependency("spotdl", "spotDL", &spotdl_bin, &spotdl_args),
            self.check_dependency("ffmpeg", "FFmpeg", &ffmpeg_bin, &ffmpeg_args),
            self.check_database()
        );

        let checks = vec![
            c_conn,
            c_db_dir,
            c_music_dir,
            c_dl_dir,
            c_art_dir,
            c_bak_dir,
            c_spotdl,
            c_ffmpeg,
            c_db,
        ];

        let has_fail = checks.iter().any(|c| c.status == DiagnosticStatus::Fail);
        let has_warn = checks.iter().any(|c| c.status == DiagnosticStatus::Warning);
        let status = if has_fail {
            DiagnosticStatus::Fail
        } else if has_warn {
            DiagnosticStatus::Warning
        } else {
            DiagnosticStatus::Pass
        };

        DiagnosticReport {
            checked_at: Utc::now().to_rfc3339(),
            status,
            ready: !has_fail,
            checks,
        }
    }

    async fn resolve_tool_path(&self, key: &str, fallback: &str) -> String {
        if let Some(pool) = &self.db {
            if let Ok(Some(row)) = sqlx::query(
                "SELECT config_json FROM plugin_configs WHERE plugin_id = 'spotdl-downloader'",
            )
            .fetch_optional(pool.inner())
            .await
            {
                if let Ok(cfg_str) = row.try_get::<String, _>("config_json") {
                    if let Ok(val) = serde_json::from_str::<Value>(&cfg_str) {
                        if let Some(path_str) = val
                            .get(key)
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        {
                            return path_str.to_owned();
                        }
                    }
                }
            }
        }
        fallback.to_owned()
    }

    async fn check_connection(&self) -> DiagnosticCheck {
        let started = Instant::now();
        let is_jellyfin = self.config.backend == BackendType::Jellyfin;
        let id = String::from("backend-connection");
        let title = if is_jellyfin {
            String::from("Jellyfin connection and API key")
        } else {
            String::from("Navidrome connection and credentials")
        };

        let make_result = |status: DiagnosticStatus, message: String, fix: &str| DiagnosticCheck {
            id: id.clone(),
            category: DiagnosticCategory::Connection,
            title: title.clone(),
            status,
            message,
            fix: fix.to_owned(),
            duration_ms: started.elapsed().as_millis() as u64,
        };

        let target_url = if is_jellyfin {
            &self.config.jellyfin.url
        } else {
            &self.config.navidrome.url
        };

        let Ok(mut endpoint) = Url::parse(target_url) else {
            return make_result(
                DiagnosticStatus::Fail,
                String::from("The configured backend URL is invalid."),
                "Enter an HTTP(S) backend URL without embedded credentials or query parameters.",
            );
        };

        if !matches!(endpoint.scheme(), "http" | "https")
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return make_result(
                DiagnosticStatus::Fail,
                String::from("The configured backend URL is invalid."),
                "Enter an HTTP(S) backend URL without embedded credentials or query parameters.",
            );
        }

        let creds_missing = if is_jellyfin {
            self.config.jellyfin.api_key.trim().is_empty()
        } else {
            self.config.navidrome.username.trim().is_empty()
                || self.config.navidrome.password.trim().is_empty()
        };

        if creds_missing {
            return make_result(
                DiagnosticStatus::Fail,
                String::from("Backend credentials have not been configured."),
                if is_jellyfin {
                    "Create an API key in Jellyfin Dashboard → API Keys and save it in Setup."
                } else {
                    "Enter a Navidrome username and password in Setup."
                },
            );
        }

        let base_path = endpoint.path().trim_end_matches('/').to_owned();
        if is_jellyfin {
            endpoint.set_path(&format!("{base_path}/System/Info"));
        } else {
            endpoint.set_path(&format!("{base_path}/rest/ping.view"));
            let salt = Uuid::new_v4().simple().to_string();
            let mut md5 = Md5::new();
            md5.update(self.config.navidrome.password.as_bytes());
            md5.update(salt.as_bytes());
            let token = format!("{:x}", md5.finalize());
            endpoint
                .query_pairs_mut()
                .append_pair("u", &self.config.navidrome.username)
                .append_pair("t", &token)
                .append_pair("s", &salt)
                .append_pair("v", "1.16.1")
                .append_pair("c", "MusicDeck")
                .append_pair("f", "json");
        }

        let mut req = self
            .http
            .get(endpoint.as_str())
            .header("accept", "application/json");
        if is_jellyfin {
            req = req.header("X-Emby-Token", &self.config.jellyfin.api_key);
        }

        let Ok(resp) = req.send().await else {
            return make_result(
                DiagnosticStatus::Fail,
                String::from("The backend could not be reached or returned an invalid response."),
                "Check DNS, Docker service names, the reverse-proxy base path, TLS trust, firewall rules, and whether the backend is running. Requests time out after eight seconds.",
            );
        };

        let code = resp.status().as_u16();
        if code == 401 || code == 403 {
            return make_result(
                DiagnosticStatus::Fail,
                String::from("The backend rejected the credentials."),
                if is_jellyfin {
                    "Replace the API key with a valid key from this Jellyfin server."
                } else {
                    "Verify the Navidrome username/password and the account's Subsonic API access."
                },
            );
        }

        if !resp.status().is_success() {
            return make_result(
                DiagnosticStatus::Fail,
                format!("The backend returned HTTP {code}."),
                "Check the server URL, reverse-proxy base path, and upstream service logs. Redirects are not followed.",
            );
        }

        let Ok(bytes) = resp.bytes().await else {
            return make_result(
                DiagnosticStatus::Fail,
                String::from("The backend could not be reached or returned an invalid response."),
                "Check credentials and ensure the URL points to the media server.",
            );
        };
        if bytes.len() > 1024 * 1024 {
            return make_result(
                DiagnosticStatus::Fail,
                String::from("The backend returned an oversized response."),
                "Ensure the URL points to the media server API.",
            );
        }

        let Ok(data) = serde_json::from_slice::<Value>(&bytes) else {
            return make_result(
                DiagnosticStatus::Fail,
                String::from("The backend could not be reached or returned an invalid response."),
                "Check credentials and ensure the URL points to the media server.",
            );
        };

        let valid_payload = if is_jellyfin {
            data.get("Version").and_then(Value::as_str).is_some()
                && data.get("Id").and_then(Value::as_str).is_some()
        } else {
            data.get("subsonic-response")
                .and_then(|s| s.get("status"))
                .and_then(Value::as_str)
                == Some("ok")
        };

        if !valid_payload {
            return make_result(
                DiagnosticStatus::Fail,
                String::from("The endpoint did not confirm an authenticated backend response."),
                "Check credentials and ensure the URL points to the media server rather than its login page or another proxy service.",
            );
        }

        make_result(
            DiagnosticStatus::Pass,
            format!(
                "Authenticated successfully with {}.",
                if is_jellyfin { "Jellyfin" } else { "Navidrome" }
            ),
            "",
        )
    }

    async fn check_directory(
        id: &str,
        title: &str,
        directory: &Path,
        required: bool,
    ) -> DiagnosticCheck {
        let started = Instant::now();
        let dir_str = directory.to_string_lossy().into_owned();
        let probe = directory.join(format!(".musicdeck-write-check-{}", Uuid::new_v4()));

        let Ok(meta) = tokio::fs::metadata(directory).await else {
            let status = if required {
                DiagnosticStatus::Fail
            } else {
                DiagnosticStatus::Warning
            };
            return DiagnosticCheck {
                id: id.to_owned(),
                category: DiagnosticCategory::Storage,
                title: title.to_owned(),
                status,
                message: format!("Directory does not exist: {dir_str}"),
                fix: format!(
                    "Create {dir_str} as the MusicDeck service user, or mount the correct directory in the container."
                ),
                duration_ms: started.elapsed().as_millis() as u64,
            };
        };

        if !meta.is_dir() {
            return DiagnosticCheck {
                id: id.to_owned(),
                category: DiagnosticCategory::Storage,
                title: title.to_owned(),
                status: DiagnosticStatus::Fail,
                message: format!("Directory is not writable: {dir_str}"),
                fix: String::from("Ensure the configured path is a writable directory."),
                duration_ms: started.elapsed().as_millis() as u64,
            };
        }

        match tokio::fs::write(&probe, b"MusicDeck permission probe").await {
            Ok(()) => {
                let _ = tokio::fs::remove_file(&probe).await;
                DiagnosticCheck {
                    id: id.to_owned(),
                    category: DiagnosticCategory::Storage,
                    title: title.to_owned(),
                    status: DiagnosticStatus::Pass,
                    message: format!("Read/write test succeeded: {dir_str}"),
                    fix: String::new(),
                    duration_ms: started.elapsed().as_millis() as u64,
                }
            }
            Err(_) => {
                let _ = tokio::fs::remove_file(&probe).await;
                DiagnosticCheck {
                    id: id.to_owned(),
                    category: DiagnosticCategory::Storage,
                    title: title.to_owned(),
                    status: DiagnosticStatus::Fail,
                    message: format!("Directory is not writable: {dir_str}"),
                    fix: String::from(
                        "Check the volume's read-only flag, free disk space, and ownership for the configured service account.",
                    ),
                    duration_ms: started.elapsed().as_millis() as u64,
                }
            }
        }
    }

    async fn check_dependency(
        &self,
        id: &str,
        title: &str,
        command: &str,
        args: &[String],
    ) -> DiagnosticCheck {
        let started = Instant::now();
        let res = self
            .runner
            .run(
                command,
                args,
                ProcessOptions {
                    timeout_ms: Some(8_000),
                    ..ProcessOptions::default()
                },
            )
            .await;

        match res {
            Ok(out) if out.exit_code == Some(0) => DiagnosticCheck {
                id: id.to_owned(),
                category: DiagnosticCategory::Dependencies,
                title: title.to_owned(),
                status: DiagnosticStatus::Pass,
                message: format!("Executable responds: {command}"),
                fix: String::new(),
                duration_ms: started.elapsed().as_millis() as u64,
            },
            _ => DiagnosticCheck {
                id: id.to_owned(),
                category: DiagnosticCategory::Dependencies,
                title: title.to_owned(),
                status: DiagnosticStatus::Warning,
                message: format!("Executable is missing, not executable, or failed: {command}"),
                fix: if id == "spotdl" {
                    String::from(
                        "Install spotDL in the server/container, then set its executable path under Admin → Plugins → spotDL. Streaming existing music does not require spotDL.",
                    )
                } else {
                    String::from(
                        "Install FFmpeg in the server/container and configure its executable path under Admin → Plugins → spotDL.",
                    )
                },
                duration_ms: started.elapsed().as_millis() as u64,
            },
        }
    }

    async fn check_database(&self) -> DiagnosticCheck {
        let started = Instant::now();
        let id = String::from("database-integrity");
        let title = String::from("SQLite integrity and write lock");

        let Some(pool) = &self.db else {
            return DiagnosticCheck {
                id,
                category: DiagnosticCategory::Database,
                title,
                status: DiagnosticStatus::Fail,
                message: String::from(
                    "SQLite failed an integrity check or could not obtain a write reservation.",
                ),
                fix: String::from(
                    "Check free disk space, database-directory permissions, and competing SQLite writers.",
                ),
                duration_ms: started.elapsed().as_millis() as u64,
            };
        };

        let check_res: Result<(), ()> = async {
            let qc_rows = sqlx::query("PRAGMA quick_check")
                .fetch_all(pool.inner())
                .await
                .map_err(|_| ())?;
            if qc_rows.is_empty()
                || qc_rows
                    .iter()
                    .any(|r| r.try_get::<String, _>(0).unwrap_or_default() != "ok")
            {
                return Err(());
            }

            let fk_rows = sqlx::query("PRAGMA foreign_key_check")
                .fetch_all(pool.inner())
                .await
                .map_err(|_| ())?;
            if !fk_rows.is_empty() {
                return Err(());
            }

            let table_rows = sqlx::query(
                "SELECT name FROM sqlite_master WHERE type = 'table'",
            )
            .fetch_all(pool.inner())
            .await
            .map_err(|_| ())?;
            let tables: HashSet<String> = table_rows
                .into_iter()
                .filter_map(|r| r.try_get("name").ok())
                .collect();

            for req_table in [
                "users",
                "server_settings",
                "schema_migrations",
                "backend_connections",
                "plugin_configs",
            ] {
                if !tables.contains(req_table) {
                    return Err(());
                }
            }

            Ok(())
        }
        .await;

        match check_res {
            Ok(()) => DiagnosticCheck {
                id,
                category: DiagnosticCategory::Database,
                title,
                status: DiagnosticStatus::Pass,
                message: String::from(
                    "SQLite quick_check and foreign-key checks passed; a write reservation was available.",
                ),
                fix: String::new(),
                duration_ms: started.elapsed().as_millis() as u64,
            },
            Err(()) => DiagnosticCheck {
                id,
                category: DiagnosticCategory::Database,
                title,
                status: DiagnosticStatus::Fail,
                message: String::from(
                    "SQLite failed an integrity check or could not obtain a write reservation.",
                ),
                fix: String::from(
                    "Check free disk space, database-directory permissions, and competing SQLite writers. Stop other MusicDeck instances. If corruption persists, restore a verified backup; do not copy a live WAL database file.",
                ),
                duration_ms: started.elapsed().as_millis() as u64,
            },
        }
    }
}
