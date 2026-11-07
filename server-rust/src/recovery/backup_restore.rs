//! # Atomic System Backup, `.tar.gz` Archive Bundling & Crash-Safe Restore (`recovery::backup_restore`)
//!
//! Ports `server/src/services/BackupRestoreService.ts`:
//! - [`MAX_BACKUP_UPLOAD`] (`256 MiB`), [`MAX_EXPANDED_BYTES`] (`1 GiB`), [`MAX_MANIFEST_BYTES`] (`2 MiB`)
//! - [`BackupManifestFile`], [`BackupManifest`], [`BackupFile`], [`RecoveryStatus`], [`RecoveryError`]
//! - [`compute_database_schema_hash`]: Computes a deterministic SHA-256 fingerprint of
//!   `sqlite_master` (`WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)
//! - [`is_valid_backup_archive_path`]: Allowlists `database.sqlite`, `config.json`, and
//!   `artwork/<safe-name>.{json,png,jpg,jpeg,webp,gif,avif}`
//! - [`recover_interrupted_restore`]: Roll-forward / roll-back crash recovery executed on startup
//!   before opening SQLite if `recovery/journal.json` is present
//! - [`BackupRestoreService`]:
//!   - `create_backup`: Captures an online SQLite snapshot via `VACUUM INTO`, verifies
//!     `PRAGMA integrity_check` + `PRAGMA foreign_key_check` + active admin presence,
//!     bundles `manifest.json`, `database.sqlite`, `config.json`, and `artwork/*` into a
//!     level-6 gzipped `.tar.gz` archive (`system-<uuid>.tar.gz`)
//!   - `unpack_and_validate_restore`: Verifies every entry against `manifest.json` SHA-256
//!     checksums, schema hash parity, and SQLite integrity before committing

use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Row};
use tar::{Archive, Builder, EntryType, Header};
use uuid::Uuid;

use crate::config::{AppConfig, SystemOverrides, durable_json, sync_directory};
use crate::db::DbPool;
use super::{RestoreGuard, RestoreState};

/// Maximum compressed backup upload size (`256 MiB`).
pub const MAX_BACKUP_UPLOAD: u64 = 256 * 1024 * 1024;
/// Maximum uncompressed archive expansion size (`1 GiB`).
pub const MAX_EXPANDED_BYTES: u64 = 1024 * 1024 * 1024;
/// Maximum `manifest.json` size inside a backup archive (`2 MiB`).
pub const MAX_MANIFEST_BYTES: usize = 2 * 1024 * 1024;
/// Canonical 16-byte SQLite 3 file header magic string (`"SQLite format 3\0"`).
pub const SQLITE_HEADER_MAGIC: &[u8; 16] = b"SQLite format 3\0";
/// Minimum byte length of a valid SQLite 3 database header (`100` bytes).
pub const MIN_SQLITE_FILE_BYTES: usize = 100;

/// Individual file entry inside [`BackupManifest::files`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifestFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// Verified backup archive manifest (`manifest.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    /// Must equal `"musicdeck-system"`.
    pub format: String,
    /// Must equal `1`.
    pub version: u32,
    pub created_at: String,
    pub schema: String,
    pub files: Vec<BackupManifestFile>,
    pub media_included: bool,
}

/// Metadata descriptor for a stored `.tar.gz` backup archive (`BackupFile`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub id: String,
    pub filename: String,
    pub bytes: u64,
    pub created_at: String,
    /// `"system" | "safety"`.
    pub kind: String,
}

/// Recovery operation status persisted in `recovery/status.json` (`RecoveryStatus`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    /// `"idle" | "validating" | "backup" | "stopping" | "installing" | "restarting" | "complete" | "failed"`.
    pub state: String,
    pub message: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safety_backup_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Crash-recovery journal persisted at `recovery/journal.json` during an active restore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryJournal {
    pub version: u32,
    pub id: String,
    /// `"installing" | "committed" | "rolled-back"`.
    pub phase: String,
    pub had_config: bool,
    pub had_artwork: bool,
    pub replace_artwork: bool,
}

/// Structured error returned by [`BackupRestoreService`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct RecoveryError {
    pub message: String,
    pub status_code: u16,
}

impl RecoveryError {
    /// Creates a new [`RecoveryError`].
    #[must_use]
    pub fn new(message: impl Into<String>, status_code: u16) -> Self {
        Self {
            message: message.into(),
            status_code,
        }
    }
}

/// System directory layout derived from [`AppConfig::database_path`].
#[derive(Debug, Clone)]
pub struct SystemRecoveryPaths {
    pub root: PathBuf,
    pub database: PathBuf,
    pub configuration: PathBuf,
    pub artwork: PathBuf,
    pub backups: PathBuf,
    pub recovery: PathBuf,
}

impl SystemRecoveryPaths {
    /// Resolves all system recovery paths from `database_path`.
    #[must_use]
    pub fn from_database_path(database_path: &str) -> Self {
        let db_path = PathBuf::from(database_path);
        let root = db_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        Self {
            configuration: root.join("config.json"),
            artwork: root.join("artwork"),
            backups: root.join("backups"),
            recovery: root.join("recovery"),
            database: db_path,
            root,
        }
    }
}

/// Validates whether `name` is an allowed entry path inside a system backup `.tar.gz`.
#[must_use]
pub fn is_valid_backup_archive_path(name: &str) -> bool {
    if name.is_empty()
        || name.len() > 1024
        || name.contains('\0')
        || name.contains('\\')
        || name.contains(':')
        || name.starts_with('/')
    {
        return false;
    }
    if Path::new(name).components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) | Component::CurDir
        )
    }) {
        return false;
    }
    if name == "database.sqlite" || name == "config.json" {
        return true;
    }
    if name
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return false;
    }
    let art_re =
        Regex::new(r"(?i)^artwork/[a-zA-Z0-9_./ -]+\.(?:json|png|jpe?g|webp|gif|avif)$")
            .expect("valid regex");
    art_re.is_match(name)
}

/// Validates that an archive entry path does not contain path-traversal (zip-slip) sequences.
pub fn validate_archive_entry_path_safety(raw_path: &Path) -> Result<String, RecoveryError> {
    let raw_str = raw_path
        .to_str()
        .ok_or_else(|| RecoveryError::new("Invalid archive entry path encoding.", 400))?;
    if raw_str.is_empty()
        || raw_str.len() > 1024
        || raw_str.contains('\0')
        || raw_str.contains('\\')
        || raw_str.contains(':')
        || raw_str.starts_with('/')
    {
        return Err(RecoveryError::new(
            "Archive entry path rejected due to path traversal protection.",
            400,
        ));
    }
    for comp in raw_path.components() {
        if matches!(
            comp,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) | Component::CurDir
        ) {
            return Err(RecoveryError::new(
                "Archive entry path rejected due to path traversal protection.",
                400,
            ));
        }
    }
    if raw_str != "manifest.json" && !is_valid_backup_archive_path(raw_str) {
        return Err(RecoveryError::new(
            "Backup archive contains an unexpected or disallowed file path.",
            400,
        ));
    }
    Ok(raw_str.to_owned())
}

/// Validates that `db_file` is a regular file beginning with the 16-byte SQLite 3 header magic
/// (`"SQLite format 3\0"`) and is at least 100 bytes long.
pub fn validate_sqlite_header_magic(db_file: &Path) -> Result<(), RecoveryError> {
    let meta = std::fs::symlink_metadata(db_file).map_err(|_| {
        RecoveryError::new(
            "Backup database file is missing or unreadable.",
            400,
        )
    })?;
    if !meta.is_file() || meta.file_type().is_symlink() || (meta.len() as usize) < MIN_SQLITE_FILE_BYTES {
        return Err(RecoveryError::new(
            "Backup database failed SQLite header magic byte validation.",
            400,
        ));
    }
    let mut file = std::fs::File::open(db_file).map_err(|_| {
        RecoveryError::new(
            "Backup database file could not be opened for header inspection.",
            400,
        )
    })?;
    let mut header = [0_u8; MIN_SQLITE_FILE_BYTES];
    file.read_exact(&mut header).map_err(|_| {
        RecoveryError::new(
            "Backup database failed SQLite header magic byte validation.",
            400,
        )
    })?;
    if &header[..16] != SQLITE_HEADER_MAGIC {
        return Err(RecoveryError::new(
            "Backup database failed SQLite header magic byte validation.",
            400,
        ));
    }
    Ok(())
}

/// Parses and validates a staged `config.json` file into [`SystemOverrides`].
pub fn parse_and_validate_staged_config(config_path: &Path) -> Result<SystemOverrides, RecoveryError> {
    let meta = std::fs::symlink_metadata(config_path).map_err(|_| {
        RecoveryError::new("Backup config.json is missing or unreadable.", 400)
    })?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 1024 * 1024 {
        return Err(RecoveryError::new("Backup config.json exceeds allowed size limits.", 400));
    }
    let raw = std::fs::read_to_string(config_path).map_err(|_| {
        RecoveryError::new("Backup config.json could not be read.", 400)
    })?;
    let mut val: Value = serde_json::from_str(&raw).map_err(|_| {
        RecoveryError::new("Backup config.json contains invalid JSON.", 400)
    })?;
    if let Some(obj) = val.as_object_mut() {
        obj.entry(String::from("version")).or_insert_with(|| json!(1));
    }
    let overrides: SystemOverrides = serde_json::from_value(val).map_err(|e| {
        RecoveryError::new(format!("Invalid backup config.json schema: {e}"), 400)
    })?;
    overrides.validate().map_err(|e| {
        RecoveryError::new(format!("Invalid backup configuration: {e}"), 400)
    })?;
    Ok(overrides)
}

/// Completed outcome of an atomic backup restoration (`BackupRestoreService::restore_from_archive`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    pub operation_id: String,
    pub safety_backup_id: String,
    pub manifest: BackupManifest,
    pub restored_config: SystemOverrides,
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut sha = Sha256::new();
    sha.update(bytes);
    format!("{:x}", sha.finalize())
}

/// Computes the deterministic SHA-256 schema fingerprint of a SQLite database (`databaseSchema`).
pub async fn compute_database_schema_hash(pool: &DbPool) -> Result<String, RecoveryError> {
    let rows = sqlx::query(
        r"
        SELECT type, name, tbl_name, sql
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
        ",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(|e| RecoveryError::new(format!("Could not read database schema: {e}"), 500))?;

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let r_type: Option<String> = row.try_get("type").ok();
        let name: Option<String> = row.try_get("name").ok();
        let tbl_name: Option<String> = row.try_get("tbl_name").ok();
        let sql: Option<String> = row.try_get("sql").ok();
        items.push(json!({
            "type": r_type,
            "name": name,
            "tbl_name": tbl_name,
            "sql": sql,
        }));
    }

    let serialized = serde_json::to_string(&items).unwrap_or_default();
    Ok(sha256_bytes(serialized.as_bytes()))
}

/// Recovers an interrupted restore if `recovery/journal.json` exists on startup.
pub fn recover_interrupted_restore(database_path: &str) -> Result<bool, RecoveryError> {
    super::rollback::recover(database_path, true)
}

/// Service managing system `.tar.gz` backups, integrity verification, and atomic restoration.
#[derive(Clone)]
pub struct BackupRestoreService {
    db: Option<DbPool>,
    config: Arc<AppConfig>,
    paths: SystemRecoveryPaths,
    restore_state: RestoreState,
}

impl std::fmt::Debug for BackupRestoreService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BackupRestoreService")
            .field("paths", &self.paths)
            .finish()
    }
}

impl BackupRestoreService {
    /// Creates a new [`BackupRestoreService`].
    #[must_use]
    pub fn new(db: Option<DbPool>, config: Arc<AppConfig>) -> Self {
        let paths = SystemRecoveryPaths::from_database_path(config.database_path());
        Self {
            db,
            config,
            paths,
            restore_state: RestoreState::default(),
        }
    }

    #[must_use]
    pub fn with_restore_state(mut self, state: RestoreState) -> Self {
        self.restore_state = state;
        self
    }

    fn ensure_recovery_complete(&self) -> Result<(), RecoveryError> {
        if self.paths.recovery.join("journal.json").exists() {
            return Err(RecoveryError::new(
                "An unfinished recovery journal must be recovered before another backup or restore. Restart the server to complete recovery.",
                409,
            ));
        }
        Ok(())
    }

    /// Reads the current [`RecoveryStatus`] from `recovery/status.json` (or `"idle"` if absent).
    pub fn status(&self) -> Result<RecoveryStatus, RecoveryError> {
        let status_file = self.paths.recovery.join("status.json");
        if !status_file.exists() {
            return Ok(RecoveryStatus {
                state: String::from("idle"),
                message: String::from("Ready"),
                updated_at: Utc::now().to_rfc3339(),
                safety_backup_id: None,
                error: None,
            });
        }
        let raw = std::fs::read_to_string(&status_file)
            .map_err(|_| RecoveryError::new("Invalid recovery status file.", 500))?;
        serde_json::from_str::<RecoveryStatus>(&raw)
            .map_err(|_| RecoveryError::new("Invalid recovery status file.", 500))
    }

    fn write_status(&self, state: &str, message: &str, safety_backup_id: Option<String>) {
        let _ = std::fs::create_dir_all(&self.paths.recovery);
        let status = RecoveryStatus {
            state: state.to_owned(),
            message: message.to_owned(),
            updated_at: Utc::now().to_rfc3339(),
            safety_backup_id,
            error: None,
        };
        if let Ok(val) = serde_json::to_value(status) {
            let _ = durable_json(&self.paths.recovery.join("status.json"), &val);
        }
    }

    /// Lists all `system-<uuid>.tar.gz` and `safety-<uuid>.tar.gz` archives in `backups/`.
    pub async fn list_backups(&self) -> Vec<BackupFile> {
        if !self.paths.backups.exists() {
            return Vec::new();
        }
        let Ok(mut rd) = tokio::fs::read_dir(&self.paths.backups).await else {
            return Vec::new();
        };
        let re =
            Regex::new(r"^(system|safety)-([0-9a-f-]{36})\.tar\.gz$").expect("valid regex");
        let mut files = Vec::new();

        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(caps) = re.captures(&name) else {
                continue;
            };
            let kind = caps[1].to_owned();
            let id = caps[2].to_owned();
            if Uuid::parse_str(&id).is_err() {
                continue;
            }
            let Ok(meta) = tokio::fs::symlink_metadata(entry.path()).await else {
                continue;
            };
            if !meta.is_file() || meta.file_type().is_symlink() {
                continue;
            }
            let created_at = meta
                .modified()
                .ok()
                .map_or_else(|| Utc::now().to_rfc3339(), |t| DateTime::<Utc>::from(t).to_rfc3339());
            files.push(BackupFile {
                id,
                filename: name,
                bytes: meta.len(),
                created_at,
                kind,
            });
        }

        files.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        files
    }

    /// Resolves the physical path of a backup archive by UUID.
    pub async fn backup_path(&self, id: &str) -> Result<PathBuf, RecoveryError> {
        if Uuid::parse_str(id).is_err() {
            return Err(RecoveryError::new("Invalid backup ID.", 400));
        }
        let backups = self.list_backups().await;
        let found = backups
            .into_iter()
            .find(|b| b.id == id)
            .ok_or_else(|| RecoveryError::new("Backup not found.", 404))?;
        Ok(self.paths.backups.join(found.filename))
    }

    /// Creates an atomic `.tar.gz` system backup containing `manifest.json`, `database.sqlite`,
    /// `config.json`, and any valid `artwork/*` files.
    pub async fn create_backup(&self) -> Result<BackupFile, RecoveryError> {
        self.capture_archive("system").await
    }

    /// Captures a `"system"` or `"safety"` backup archive.
    pub async fn capture_archive(&self, kind: &str) -> Result<BackupFile, RecoveryError> {
        let guard = self.restore_state.try_acquire()?;
        self.capture_archive_guarded(kind, &guard).await
    }

    pub(crate) async fn capture_archive_guarded(
        &self,
        kind: &str,
        guard: &RestoreGuard,
    ) -> Result<BackupFile, RecoveryError> {
        self.restore_state.validate(guard)?;
        self.ensure_recovery_complete()?;
        if self.config.database_path() == ":memory:" {
            return Err(RecoveryError::new(
                "System recovery requires a persistent SQLite database.",
                409,
            ));
        }
        let pool = self
            .db
            .as_ref()
            .ok_or_else(|| RecoveryError::new("Database is unavailable.", 503))?;
        self.capture_archive_inner(pool, kind).await
    }

    async fn capture_archive_inner(
        &self,
        pool: &DbPool,
        kind: &str,
    ) -> Result<BackupFile, RecoveryError> {
        for dir in [&self.paths.root, &self.paths.recovery, &self.paths.backups] {
            tokio::fs::create_dir_all(dir)
                .await
                .map_err(|_| RecoveryError::new("Could not create recovery directories.", 500))?;
        }

        self.write_status("backup", "Creating a consistent SQLite snapshot.", None);

        let id = Uuid::new_v4().to_string();
        let stage_dir = self.paths.recovery.join(format!("backup-{id}"));
        tokio::fs::create_dir_all(&stage_dir)
            .await
            .map_err(|_| RecoveryError::new("Could not create backup staging directory.", 500))?;

        let filename = format!("{kind}-{id}.tar.gz");
        let final_path = self.paths.backups.join(&filename);
        let partial_path = self.paths.backups.join(format!("{filename}.partial"));

        let outcome: Result<BackupFile, RecoveryError> = async {
            let db_snapshot_path = stage_dir.join("database.sqlite");
            let escaped_path = db_snapshot_path
                .to_string_lossy()
                .replace('\'', "''");
            sqlx::query(&format!("VACUUM INTO '{escaped_path}'"))
                .execute(pool.inner())
                .await
                .map_err(|e| {
                    RecoveryError::new(format!("Online SQLite snapshot failed: {e}"), 500)
                })?;

            let schema_hash = compute_database_schema_hash(pool).await?;
            Self::inspect_sqlite_snapshot(&db_snapshot_path, &schema_hash).await?;

            let cfg_snapshot = json!({
                "version": 1,
                "backend": self.config.backend,
                "musicRoot": self.config.music_root,
                "acquisitionTmpDir": self.config.acquisition_tmp_dir,
                "navidrome": {
                    "url": self.config.navidrome.url,
                    "username": self.config.navidrome.username,
                    "password": self.config.navidrome.password,
                },
                "jellyfin": {
                    "url": self.config.jellyfin.url,
                    "apiKey": self.config.jellyfin.api_key,
                },
            });
            let cfg_stage_path = stage_dir.join("config.json");
            durable_json(&cfg_stage_path, &cfg_snapshot)
                .map_err(|_| RecoveryError::new("Could not stage config.json.", 500))?;

            let mut entry_names = vec![
                String::from("database.sqlite"),
                String::from("config.json"),
            ];

            if self.paths.artwork.exists() {
                let mut stack = vec![(self.paths.artwork.clone(), String::from("artwork"))];
                while let Some((dir, prefix)) = stack.pop() {
                    let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
                        continue;
                    };
                    while let Ok(Some(item)) = rd.next_entry().await {
                        let Ok(ft) = item.file_type().await else {
                            continue;
                        };
                        if ft.is_symlink() {
                            return Err(RecoveryError::new(
                                "Artwork cache contains a symbolic link; remove it before backup.",
                                400,
                            ));
                        }
                        let item_name = item.file_name().to_string_lossy().into_owned();
                        let archive_name = format!("{prefix}/{item_name}");
                        let src_path = item.path();
                        if ft.is_dir() {
                            stack.push((src_path, archive_name));
                            continue;
                        }
                        if !ft.is_file() || !is_valid_backup_archive_path(&archive_name) {
                            continue;
                        }
                        let dst_path = stage_dir.join(&archive_name);
                        if let Some(p) = dst_path.parent() {
                            tokio::fs::create_dir_all(p).await.ok();
                        }
                        tokio::fs::copy(&src_path, &dst_path)
                            .await
                            .map_err(|_| RecoveryError::new("Failed copying artwork file.", 500))?;
                        entry_names.push(archive_name);
                    }
                }
            }

            let mut manifest_files = Vec::with_capacity(entry_names.len());
            let mut total_bytes = 0_u64;
            for name in &entry_names {
                let f_path = stage_dir.join(name);
                let data = tokio::fs::read(&f_path)
                    .await
                    .map_err(|_| RecoveryError::new("Failed reading staged backup file.", 500))?;
                total_bytes = total_bytes.saturating_add(data.len() as u64);
                if total_bytes > MAX_EXPANDED_BYTES {
                    return Err(RecoveryError::new(
                        "Backup exceeds the 1 GiB expanded size limit.",
                        400,
                    ));
                }
                manifest_files.push(BackupManifestFile {
                    path: name.clone(),
                    size: data.len() as u64,
                    sha256: sha256_bytes(&data),
                });
            }

            let created_at = Utc::now().to_rfc3339();
            let manifest = BackupManifest {
                format: String::from("musicdeck-system"),
                version: 1,
                created_at: created_at.clone(),
                schema: schema_hash,
                files: manifest_files,
                media_included: false,
            };

            let manifest_json = serde_json::to_string(&manifest)
                .map_err(|_| RecoveryError::new("Failed serializing manifest.", 500))?;
            if manifest_json.len() > MAX_MANIFEST_BYTES {
                return Err(RecoveryError::new(
                    "Artwork inventory exceeds the archive manifest limit.",
                    400,
                ));
            }

            let mut tar_gz_bytes = Vec::new();
            {
                let encoder = GzEncoder::new(&mut tar_gz_bytes, Compression::new(6));
                let mut builder = Builder::new(encoder);

                let mut h_man = Header::new_gnu();
                h_man.set_size(manifest_json.len() as u64);
                h_man.set_mode(0o600);
                h_man.set_cksum();
                builder
                    .append_data(&mut h_man, "manifest.json", manifest_json.as_bytes())
                    .map_err(|_| RecoveryError::new("Failed writing manifest to archive.", 500))?;

                for name in &entry_names {
                    let f_bytes = tokio::fs::read(stage_dir.join(name))
                        .await
                        .map_err(|_| RecoveryError::new("Failed reading staged file.", 500))?;
                    let mut header = Header::new_gnu();
                    header.set_size(f_bytes.len() as u64);
                    header.set_mode(0o600);
                    header.set_cksum();
                    builder
                        .append_data(&mut header, name, f_bytes.as_slice())
                        .map_err(|_| RecoveryError::new("Failed appending archive entry.", 500))?;
                }

                builder
                    .finish()
                    .map_err(|_| RecoveryError::new("Failed finalizing tar archive.", 500))?;
            }

            let compressed_bytes = tar_gz_bytes.len() as u64;
            if compressed_bytes > MAX_BACKUP_UPLOAD {
                return Err(RecoveryError::new(
                    "Compressed backup exceeds the 256 MiB restore-upload limit.",
                    400,
                ));
            }

            tokio::fs::write(&partial_path, &tar_gz_bytes)
                .await
                .map_err(|_| RecoveryError::new("Failed writing backup archive.", 500))?;
            tokio::fs::rename(&partial_path, &final_path)
                .await
                .map_err(|_| RecoveryError::new("Failed publishing backup archive.", 500))?;

            self.write_status("complete", "System backup created.", None);

            Ok(BackupFile {
                id,
                filename,
                bytes: compressed_bytes,
                created_at,
                kind: kind.to_owned(),
            })
        }
        .await;

        let _ = tokio::fs::remove_file(&partial_path).await;
        let _ = tokio::fs::remove_dir_all(&stage_dir).await;

        if outcome.is_err() {
            self.write_status("failed", "Backup failed; live data was not changed.", None);
        }
        outcome
    }

    async fn inspect_sqlite_snapshot(
        snapshot_path: &Path,
        expected_schema: &str,
    ) -> Result<(), RecoveryError> {
        validate_sqlite_header_magic(snapshot_path)?;

        let path_str = snapshot_path.to_string_lossy().into_owned();
        let snap_pool = DbPool::connect_file(&path_str, false)
            .await
            .map_err(|_| {
                RecoveryError::new(
                    "Backup database failed SQLite integrity or foreign-key validation.",
                    400,
                )
            })?;

        let res: Result<(), RecoveryError> = async {
            let actual_schema = compute_database_schema_hash(&snap_pool).await?;
            if actual_schema != expected_schema {
                return Err(RecoveryError::new(
                    "Backup database schema does not match this MusicDeck build. Restore using the matching version first.",
                    400,
                ));
            }

            let ic_rows = sqlx::query("PRAGMA integrity_check")
                .fetch_all(snap_pool.inner())
                .await
                .map_err(|_| {
                    RecoveryError::new(
                        "Backup database failed SQLite integrity or foreign-key validation.",
                        400,
                    )
                })?;
            if ic_rows.len() != 1
                || ic_rows[0].try_get::<String, _>(0).unwrap_or_default() != "ok"
            {
                return Err(RecoveryError::new(
                    "Backup database failed SQLite integrity or foreign-key validation.",
                    400,
                ));
            }

            let fk_rows = sqlx::query("PRAGMA foreign_key_check")
                .fetch_all(snap_pool.inner())
                .await
                .map_err(|_| {
                    RecoveryError::new(
                        "Backup database failed SQLite integrity or foreign-key validation.",
                        400,
                    )
                })?;
            if !fk_rows.is_empty() {
                return Err(RecoveryError::new(
                    "Backup database failed SQLite integrity or foreign-key validation.",
                    400,
                ));
            }

            let admin_count: i64 = sqlx::query(
                "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0",
            )
            .fetch_one(snap_pool.inner())
            .await
            .ok()
            .and_then(|r| r.try_get("count").ok())
            .unwrap_or(0);

            if admin_count == 0 {
                return Err(RecoveryError::new(
                    "Backup has no active administrator account.",
                    400,
                ));
            }

            Ok(())
        }
        .await;

        snap_pool.close().await;
        res
    }

    /// Unpacks a `.tar.gz` backup archive into `stage_dir`, verifying `manifest.json`,
    /// per-file SHA-256 digests, schema hash compatibility, and SQLite integrity.
    pub async fn unpack_and_validate_restore(
        &self,
        archive_bytes: &[u8],
        stage_dir: &Path,
    ) -> Result<BackupManifest, RecoveryError> {
        if archive_bytes.is_empty() {
            return Err(RecoveryError::new("Backup file is empty.", 400));
        }
        if archive_bytes.len() as u64 > MAX_BACKUP_UPLOAD {
            return Err(RecoveryError::new("Backup upload exceeds 256 MiB.", 413));
        }

        let Some(pool) = &self.db else {
            return Err(RecoveryError::new("Database is unavailable.", 503));
        };
        let expected_schema = compute_database_schema_hash(pool).await?;

        std::fs::create_dir_all(stage_dir)
            .map_err(|_| RecoveryError::new("Could not create restore staging directory.", 500))?;

        let manifest: BackupManifest = {
            let decoder = GzDecoder::new(archive_bytes);
            let mut archive = Archive::new(decoder);
            let mut manifest_opt: Option<BackupManifest> = None;
            let mut expected_files: HashMap<String, BackupManifestFile> = HashMap::new();
            let mut seen_files: HashMap<String, (u64, String)> = HashMap::new();
            let mut total_expanded = 0_u64;

            let entries = archive
                .entries()
                .map_err(|_| RecoveryError::new("Backup archive could not be unpacked.", 400))?;

            for entry_res in entries {
                let mut entry = entry_res.map_err(|_| {
                    RecoveryError::new("Backup archive could not be unpacked.", 400)
                })?;
                if entry.header().entry_type() != EntryType::Regular {
                    return Err(RecoveryError::new(
                        "Backup archive may contain only regular files.",
                        400,
                    ));
                }
                let raw_entry_path = entry
                    .path()
                    .map_err(|_| RecoveryError::new("Invalid archive entry path.", 400))?
                    .into_owned();
                let entry_name = validate_archive_entry_path_safety(&raw_entry_path)?;

                if manifest_opt.is_none() {
                    if entry_name != "manifest.json" {
                        return Err(RecoveryError::new(
                            "Backup archive must begin with manifest.json.",
                            400,
                        ));
                    }
                    let mut m_bytes = Vec::new();
                    entry.read_to_end(&mut m_bytes).map_err(|_| {
                        RecoveryError::new("Backup archive could not be unpacked.", 400)
                    })?;
                    if m_bytes.len() > MAX_MANIFEST_BYTES {
                        return Err(RecoveryError::new("Backup manifest is too large.", 400));
                    }
                    let parsed: BackupManifest = serde_json::from_slice(&m_bytes)
                        .map_err(|_| RecoveryError::new("Invalid backup manifest.", 400))?;
                    if parsed.format != "musicdeck-system"
                        || parsed.version != 1
                        || parsed.media_included
                        || parsed.files.len() < 2
                    {
                        return Err(RecoveryError::new("Invalid backup manifest.", 400));
                    }
                    for f in &parsed.files {
                        if !is_valid_backup_archive_path(&f.path)
                            || expected_files.insert(f.path.clone(), f.clone()).is_some()
                        {
                            return Err(RecoveryError::new(
                                "Backup manifest contains an invalid or duplicate file path.",
                                400,
                            ));
                        }
                    }
                    if !expected_files.contains_key("database.sqlite")
                        || !expected_files.contains_key("config.json")
                    {
                        return Err(RecoveryError::new(
                            "Backup manifest must include database.sqlite and config.json.",
                            400,
                        ));
                    }
                    manifest_opt = Some(parsed);
                    continue;
                }

                let Some(expected) = expected_files.get(&entry_name) else {
                    return Err(RecoveryError::new(
                        "Backup archive contains an unexpected file.",
                        400,
                    ));
                };
                if seen_files.contains_key(&entry_name) {
                    return Err(RecoveryError::new(
                        "Backup archive contains a duplicate file.",
                        400,
                    ));
                }

                let mut file_bytes = Vec::new();
                entry.read_to_end(&mut file_bytes).map_err(|_| {
                    RecoveryError::new("Backup archive could not be unpacked.", 400)
                })?;
                total_expanded = total_expanded.saturating_add(file_bytes.len() as u64);
                if total_expanded > MAX_EXPANDED_BYTES {
                    return Err(RecoveryError::new(
                        "Backup archive exceeds the 1 GiB expanded size limit.",
                        400,
                    ));
                }

                let digest = sha256_bytes(&file_bytes);
                if file_bytes.len() as u64 != expected.size || digest != expected.sha256 {
                    return Err(RecoveryError::new(
                        format!("Backup checksum mismatch for {entry_name}."),
                        400,
                    ));
                }

                let target = stage_dir.join(&entry_name);
                if !target.starts_with(stage_dir) {
                    return Err(RecoveryError::new(
                        "Archive entry path escaped staging directory boundary.",
                        400,
                    ));
                }
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                std::fs::write(&target, &file_bytes)
                    .map_err(|_| RecoveryError::new("Could not stage unpacked file.", 500))?;
                seen_files.insert(entry_name, (file_bytes.len() as u64, digest));
            }

            let Some(manifest) = manifest_opt else {
                return Err(RecoveryError::new(
                    "Backup archive is incomplete or failed checksum verification.",
                    400,
                ));
            };
            if seen_files.len() != expected_files.len() {
                return Err(RecoveryError::new(
                    "Backup archive is incomplete or failed checksum verification.",
                    400,
                ));
            }
            if manifest.schema != expected_schema {
                return Err(RecoveryError::new(
                    "Backup database schema does not match this MusicDeck build.",
                    400,
                ));
            }
            manifest
        };

        parse_and_validate_staged_config(&stage_dir.join("config.json"))?;
        Self::inspect_sqlite_snapshot(&stage_dir.join("database.sqlite"), &expected_schema).await?;
        Ok(manifest)
    }

    /// Unpacks, pre-flight validates, and atomically installs a `.tar.gz` backup archive
    /// over the active SQLite database, `config.json`, and `artwork/` directory with
    /// crash-recovery journal and safety backup protection.
    pub async fn restore_from_archive(
        &self,
        archive_bytes: &[u8],
    ) -> Result<RestoreOutcome, RecoveryError> {
        let guard = self.restore_state.try_acquire()?;
        self.restore_from_archive_guarded(archive_bytes, &guard)
            .await
    }

    pub(crate) async fn restore_from_archive_guarded(
        &self,
        archive_bytes: &[u8],
        guard: &RestoreGuard,
    ) -> Result<RestoreOutcome, RecoveryError> {
        self.restore_state.validate(guard)?;
        self.ensure_recovery_complete()?;
        if self.config.database_path() == ":memory:" {
            return Err(RecoveryError::new(
                "System recovery requires a persistent SQLite database.",
                409,
            ));
        }
        let pool = self
            .db
            .as_ref()
            .ok_or_else(|| RecoveryError::new("Database is unavailable.", 503))?;
        self.restore_from_archive_inner(pool, archive_bytes).await
    }

    async fn prepare_rollback(
        &self,
        pool: &DbPool,
        stage: &Path,
        had_config: bool,
    ) -> Result<(), RecoveryError> {
        // Copying only the main WAL-mode database file can omit committed transactions.
        let old_db = stage.join("old-database.sqlite");
        let escaped = old_db.to_string_lossy().replace('\'', "''");
        sqlx::query(&format!("VACUUM INTO '{escaped}'"))
            .execute(pool.inner())
            .await
            .map_err(|error| {
                RecoveryError::new(
                    format!("Could not prepare consistent rollback database: {error}"),
                    500,
                )
            })?;
        flush_file(&old_db)?;
        if had_config {
            let old_config = stage.join("old-config.json");
            tokio::fs::copy(&self.paths.configuration, &old_config)
                .await
                .map_err(|error| {
                    RecoveryError::new(
                        format!("Could not prepare rollback configuration: {error}"),
                        500,
                    )
                })?;
            flush_file(&old_config)?;
        }
        sync_directory(stage).map_err(|error| {
            RecoveryError::new(format!("Could not flush rollback staging: {error}"), 500)
        })?;
        Ok(())
    }

    async fn restore_from_archive_inner(
        &self,
        pool: &DbPool,
        archive_bytes: &[u8],
    ) -> Result<RestoreOutcome, RecoveryError> {
        for dir in [&self.paths.root, &self.paths.recovery, &self.paths.backups] {
            tokio::fs::create_dir_all(dir)
                .await
                .map_err(|_| RecoveryError::new("Could not create recovery directories.", 500))?;
        }

        let op_id = Uuid::new_v4().to_string();
        let stage_dir = self.paths.recovery.join(&op_id);

        self.write_status(
            "validating",
            "Validating the archive and SQLite database before stopping the server.",
            None,
        );

        let manifest = match self
            .unpack_and_validate_restore(archive_bytes, &stage_dir)
            .await
        {
            Ok(m) => m,
            Err(err) => {
                let _ = tokio::fs::remove_dir_all(&stage_dir).await;
                self.write_status(
                    "failed",
                    "Backup validation failed; live data was not changed.",
                    None,
                );
                return Err(err);
            }
        };

        let restored_config = match parse_and_validate_staged_config(&stage_dir.join("config.json"))
        {
            Ok(cfg) => cfg,
            Err(err) => {
                let _ = tokio::fs::remove_dir_all(&stage_dir).await;
                self.write_status(
                    "failed",
                    "Backup validation failed; live data was not changed.",
                    None,
                );
                return Err(err);
            }
        };

        let staged_db_path = stage_dir.join("database.sqlite");
        {
            let staged_path_str = staged_db_path.to_string_lossy().into_owned();
            if let Ok(staged_pool) = DbPool::connect_file(&staged_path_str, false).await {
                let _ = sqlx::query("DELETE FROM sessions")
                    .execute(staged_pool.inner())
                    .await;
                let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                    .execute(staged_pool.inner())
                    .await;
                staged_pool.close().await;
            }
        }

        let safety = match self.capture_archive_inner(pool, "safety").await {
            Ok(s) => s,
            Err(err) => {
                let _ = tokio::fs::remove_dir_all(&stage_dir).await;
                self.write_status(
                    "failed",
                    "Could not create pre-restore safety backup; live data was not changed.",
                    None,
                );
                return Err(err);
            }
        };

        for target in [
            &self.paths.database,
            &self.paths.configuration,
            &self.paths.artwork,
        ] {
            if let Ok(meta) = std::fs::symlink_metadata(target) {
                if meta.file_type().is_symlink() {
                    let _ = tokio::fs::remove_dir_all(&stage_dir).await;
                    return Err(RecoveryError::new(
                        "Restore targets must not be symbolic links.",
                        400,
                    ));
                }
            }
        }

        let had_config = self.paths.configuration.exists();
        let had_artwork = self.paths.artwork.exists();
        if let Err(error) = self.prepare_rollback(pool, &stage_dir, had_config).await {
            let _ = tokio::fs::remove_dir_all(&stage_dir).await;
            self.write_status(
                "failed",
                "Could not prepare rollback snapshots; live data was not changed.",
                Some(safety.id),
            );
            return Err(error);
        }
        let journal = RecoveryJournal {
            version: 1,
            id: op_id.clone(),
            phase: String::from("installing"),
            had_config,
            had_artwork,
            replace_artwork: true,
        };
        let journal_file = self.paths.recovery.join("journal.json");
        durable_json(&journal_file, &journal)
            .map_err(|_| RecoveryError::new("Could not write recovery journal.", 500))?;

        self.write_status(
            "installing",
            "Installing the staged database and configuration with rollback protection.",
            Some(safety.id.clone()),
        );

        let install_res: Result<(), RecoveryError> = async {
            if had_artwork {
                // One rename archives the complete original tree; no partial old-artwork copy.
                tokio::fs::rename(&self.paths.artwork, stage_dir.join("old-artwork"))
                    .await
                    .map_err(|error| {
                        RecoveryError::new(
                            format!("Could not archive original artwork: {error}"),
                            500,
                        )
                    })?;
                sync_directory(&self.paths.root).map_err(|error| {
                    RecoveryError::new(format!("Could not flush artwork move: {error}"), 500)
                })?;
                sync_directory(&stage_dir).map_err(|error| {
                    RecoveryError::new(format!("Could not flush rollback artwork: {error}"), 500)
                })?;
            }

            // 1. Atomically install config.json
            durable_json(&self.paths.configuration, &restored_config)
                .map_err(|_| RecoveryError::new("Failed installing restored config.json.", 500))?;

            // 2. Atomically install artwork/*
            let staged_artwork = stage_dir.join("artwork");
            if self.paths.artwork.exists() {
                tokio::fs::remove_dir_all(&self.paths.artwork)
                    .await
                    .map_err(|_| {
                        RecoveryError::new("Failed replacing existing artwork directory.", 500)
                    })?;
            }
            if staged_artwork.exists() {
                copy_dir_recursive(&staged_artwork, &self.paths.artwork).await?;
            }

            // 3. Atomically replace SQLite database contents and flush to disk
            Self::sync_sqlite_from_staged_snapshot(pool, &staged_db_path).await?;
            sync_directory(&self.paths.root).map_err(|error| {
                RecoveryError::new(format!("Could not flush restored files: {error}"), 500)
            })?;
            Ok(())
        }
        .await;

        if let Err(error) = install_res {
            // The pool is live: restore rows transactionally, never replace its open file.
            let database_rollback = Self::sync_sqlite_from_staged_snapshot(
                pool,
                &stage_dir.join("old-database.sqlite"),
            )
            .await;
            let files_rollback = super::rollback::restore_files(self.config.database_path());
            let rollback = database_rollback
                .and(files_rollback.map(|_| ()))
                .and_then(|_| {
                    super::rollback::recover(self.config.database_path(), false).map(|_| ())
                });
            if let Err(rollback_error) = rollback {
                tracing::error!(error = %error, rollback_error = %rollback_error, "Restore rollback incomplete; preserving recovery journal and staging");
                self.write_status("failed", "Rollback is incomplete. Recovery files were retained; restart to retry recovery.", Some(safety.id));
                return Err(RecoveryError::new(
                    format!("Restore failed and rollback could not complete: {rollback_error}"),
                    500,
                ));
            }
            self.write_status(
                "failed",
                "Restore failed. Original database, configuration, and artwork were restored.",
                Some(safety.id),
            );
            return Err(error);
        }

        let committed_journal = RecoveryJournal {
            phase: String::from("committed"),
            ..journal
        };
        durable_json(&journal_file, &committed_journal).map_err(|error| RecoveryError::new(
            format!("Restore installed, but the commit journal could not be made durable: {error}. Recovery files were retained; restart to finish recovery."), 500))?;
        super::rollback::recover(self.config.database_path(), false)?;
        self.write_status(
            "complete",
            "Restore complete. Sign in using an administrator account from the backup.",
            Some(safety.id.clone()),
        );

        Ok(RestoreOutcome {
            operation_id: op_id,
            safety_backup_id: safety.id,
            manifest,
            restored_config,
        })
    }

    async fn sync_sqlite_from_staged_snapshot(
        pool: &DbPool,
        staged_db_path: &Path,
    ) -> Result<(), RecoveryError> {
        let escaped_stage = staged_db_path.to_string_lossy().replace('\'', "''");
        let mut conn = pool.inner().acquire().await.map_err(|e| {
            RecoveryError::new(format!("Could not acquire database connection: {e}"), 500)
        })?;

        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&mut *conn)
            .await
            .map_err(|e| RecoveryError::new(format!("Failed disabling foreign keys: {e}"), 500))?;

        if let Err(error) =
            sqlx::query(&format!("ATTACH DATABASE '{escaped_stage}' AS restore_src"))
                .execute(&mut *conn)
                .await
        {
            if sqlx::query("PRAGMA foreign_keys = ON")
                .execute(&mut *conn)
                .await
                .is_err()
            {
                let _ = conn.close().await;
            }
            return Err(RecoveryError::new(
                format!("Failed attaching staged database: {error}"),
                500,
            ));
        }

        let sync_res: Result<(), RecoveryError> = async {
            let mut tx = conn.begin().await.map_err(|e| {
                RecoveryError::new(format!("Failed starting restore transaction: {e}"), 500)
            })?;

            let table_rows = sqlx::query(
                "SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| RecoveryError::new(format!("Failed reading database tables: {e}"), 500))?;

            let tables: Vec<String> = table_rows
                .into_iter()
                .filter_map(|r| r.try_get::<String, _>("name").ok())
                .collect();

            for tbl in &tables {
                let quoted = tbl.replace('"', "\"\"");
                sqlx::query(&format!("DELETE FROM main.\"{quoted}\""))
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| {
                        RecoveryError::new(format!("Failed clearing table {tbl}: {e}"), 500)
                    })?;
            }

            for tbl in &tables {
                let quoted = tbl.replace('"', "\"\"");
                sqlx::query(&format!(
                    "INSERT INTO main.\"{quoted}\" SELECT * FROM restore_src.\"{quoted}\""
                ))
                .execute(&mut *tx)
                .await
                .map_err(|e| {
                    RecoveryError::new(format!("Failed restoring table {tbl}: {e}"), 500)
                })?;
            }

            tx.commit().await.map_err(|e| {
                RecoveryError::new(format!("Failed committing restored database: {e}"), 500)
            })?;
            Ok(())
        }
        .await;

        let detached = sqlx::query("DETACH DATABASE restore_src")
            .execute(&mut *conn)
            .await;
        let reenabled = sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&mut *conn)
            .await;
        if let Err(error) = detached.and(reenabled) {
            // Never return a connection with disabled constraints or an attached snapshot.
            let _ = conn.close().await;
            return Err(RecoveryError::new(
                format!("Could not clean restore connection: {error}"),
                500,
            ));
        }
        sync_res?;
        let checkpoint = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(&mut *conn)
            .await
            .map_err(|error| {
                RecoveryError::new(
                    format!("Could not checkpoint restored database: {error}"),
                    500,
                )
            })?;
        let busy: i64 = checkpoint.try_get(0).map_err(|error| {
            RecoveryError::new(format!("Invalid restore checkpoint result: {error}"), 500)
        })?;
        if busy != 0 {
            return Err(RecoveryError::new(
                "SQLite restore checkpoint is busy; recovery snapshots were retained.",
                500,
            ));
        }
        Ok(())
    }
}

async fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), RecoveryError> {
    let mut stack = vec![(src.to_path_buf(), dst.to_path_buf())];
    while let Some((curr_src, curr_dst)) = stack.pop() {
        tokio::fs::create_dir_all(&curr_dst)
            .await
            .map_err(|_| RecoveryError::new("Failed creating directory during restore.", 500))?;
        let mut rd = tokio::fs::read_dir(&curr_src)
            .await
            .map_err(|_| RecoveryError::new("Failed reading staged directory.", 500))?;
        while let Some(entry) = rd.next_entry().await.map_err(|error| {
            RecoveryError::new(format!("Failed reading staged entry: {error}"), 500)
        })? {
            let ft = entry
                .file_type()
                .await
                .map_err(|_| RecoveryError::new("Failed inspecting staged entry.", 500))?;
            if ft.is_symlink() {
                return Err(RecoveryError::new(
                    "Symbolic links are not permitted in restore directories.",
                    400,
                ));
            }
            let next_src = entry.path();
            let next_dst = curr_dst.join(entry.file_name());
            if ft.is_dir() {
                stack.push((next_src, next_dst));
            } else if ft.is_file() {
                tokio::fs::copy(&next_src, &next_dst)
                    .await
                    .map_err(|_| RecoveryError::new("Failed copying restored file.", 500))?;
                flush_file(&next_dst)?;
            }
        }
        sync_directory(&curr_dst).map_err(|error| {
            RecoveryError::new(format!("Failed flushing artwork directory: {error}"), 500)
        })?;
    }
    Ok(())
}

fn flush_file(path: &Path) -> Result<(), RecoveryError> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| RecoveryError::new(format!("Could not flush recovery file: {error}"), 500))
}
