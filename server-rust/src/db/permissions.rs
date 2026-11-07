//! # SQLite File & Directory Permission Hardening (`db::permissions`)
//!
//! Complete Rust port of `server/src/db/file-permissions.ts`.
//!
//! ## Security Guarantees
//! 1. **Private Data Directory (`0700` / `rwx------`)**:
//!    - When creating a missing parent directory for the SQLite database file,
//!      [`prepare_database_path`] applies mode `0700` explicitly on Unix platforms
//!      (bypassing permissive process `umask` settings).
//!    - Pre-existing directories are never forcibly `chmod`-ed or `chown`-ed; if a
//!      pre-existing directory permits group or world access (`mode & 0o077 != 0`),
//!      an actionable warning is recorded in [`crate::logger::server_logs`].
//! 2. **Symlink Rejection**:
//!    - [`protect_database_file`] inspects `std::fs::symlink_metadata` (`lstat`) before
//!      touching permissions. Symbolic links or special files (FIFOs, sockets, devices)
//!      are rejected immediately with [`DbError::UnsafeFileType`] so an attacker with
//!      write access to a shared directory cannot trick the server into `chmod`-ing
//!      or opening an arbitrary target file.
//! 3. **Database & WAL Sidecar Mode Enforcement (`0600` / `rw-------`)**:
//!    - [`protect_database_files`] enforces mode `0600` across the primary database file
//!      and all SQLite journal sidecars (`""`, `"-wal"`, `"-shm"`, `"-journal"`).
//!    - Post-`chmod` verification checks whether the underlying filesystem honored `0600`
//!      (e.g., NFS/CIFS/vfat mounts that silently ignore POSIX mode changes) and logs
//!      a structured warning if group/other bits remain set.

use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::db::DbError;
use crate::logger::{LogInput, LogLevel, LogSource, server_logs};

/// Restrictive Unix directory permission mask (`rwx------`).
pub const DIR_MODE_PRIVATE: u32 = 0o700;

/// Restrictive Unix database file permission mask (`rw-------`).
pub const FILE_MODE_PRIVATE: u32 = 0o600;

/// Group and world permission bitmask (`---rwxrwx`) used to detect overly permissive modes.
pub const GROUP_OTHER_MASK: u32 = 0o077;

/// All SQLite file suffixes that must be protected alongside the main database file.
pub const SQLITE_SIDECAR_SUFFIXES: [&str; 4] = ["", "-wal", "-shm", "-journal"];

fn record_permission_warning(message: &str, file: &Path, code: Option<&str>) {
    let mut meta = Map::new();
    meta.insert(
        String::from("file"),
        Value::String(file.to_string_lossy().into_owned()),
    );
    if let Some(err_code) = code {
        meta.insert(
            String::from("code"),
            Value::String(err_code.to_owned()),
        );
    }

    let _ = server_logs().push(LogInput {
        level: LogLevel::Warn,
        source: LogSource::Server,
        message: message.to_owned(),
        stack: None,
        meta: Some(meta),
        time: None,
    });
}

/// Prepares the parent directory (`0700`), pre-creates the SQLite database file (`0600`)
/// if absent, and hardens permissions across the database and its sidecar files.
pub fn prepare_database_path(database_path: &Path) -> Result<(), DbError> {
    let resolved = if database_path.is_absolute() {
        database_path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(database_path)
    };

    let directory = resolved.parent().ok_or_else(|| {
        DbError::InvalidPath(format!(
            "Database path '{}' does not have a valid parent directory",
            resolved.display()
        ))
    })?;

    let dir_existed = directory.exists();
    if !dir_existed {
        create_private_directory_all(directory)?;
    }

    verify_directory_permissions(directory, dir_existed)?;
    touch_exclusive_database_file(&resolved)?;
    protect_database_files(&resolved)?;

    Ok(())
}

/// Enforces `0600` permissions on the primary SQLite file and all sidecar files
/// (`-wal`, `-shm`, `-journal`) that currently exist on disk.
pub fn protect_database_files(database_path: &Path) -> Result<(), DbError> {
    let base_os = database_path.as_os_str();
    for suffix in SQLITE_SIDECAR_SUFFIXES {
        let mut candidate = base_os.to_os_string();
        candidate.push(suffix);
        protect_database_file(&PathBuf::from(candidate))?;
    }
    Ok(())
}

/// Validates that `file` (if present) is a regular non-symlink file and restricts its
/// Unix permissions to `0600` (`rw-------`).
pub fn protect_database_file(file: &Path) -> Result<(), DbError> {
    let metadata = match fs::symlink_metadata(file) {
        Ok(meta) => meta,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(DbError::Io {
                path: file.to_path_buf(),
                source,
            });
        }
    };

    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(DbError::UnsafeFileType {
            path: file.to_path_buf(),
        });
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let current_mode = metadata.mode();
        if (current_mode & GROUP_OTHER_MASK) == 0 {
            return Ok(());
        }

        let restricted = fs::Permissions::from_mode(FILE_MODE_PRIVATE);
        if let Err(err) = fs::set_permissions(file, restricted) {
            let code = match err.kind() {
                ErrorKind::PermissionDenied => "EPERM",
                _ => "PERMISSION_ERROR",
            };
            record_permission_warning(
                "Cannot enforce SQLite mode 0600; restrict host ACLs or correct service-account permissions.",
                file,
                Some(code),
            );
            return Ok(());
        }

        let after_meta = fs::metadata(file).map_err(|source| DbError::Io {
            path: file.to_path_buf(),
            source,
        })?;
        if (after_meta.mode() & GROUP_OTHER_MASK) != 0 {
            record_permission_warning(
                "SQLite filesystem did not enforce mode 0600; restrict host ACLs or move the database to a private filesystem.",
                file,
                None,
            );
        }
    }

    Ok(())
}

fn create_private_directory_all(directory: &Path) -> Result<(), DbError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(DIR_MODE_PRIVATE);
        builder.create(directory).map_err(|source| DbError::Io {
            path: directory.to_path_buf(),
            source,
        })?;

        // Explicitly apply 0700 to the leaf directory so a permissive process umask
        // (e.g. umask 0022) cannot leave the newly created directory at 0755.
        let _ = fs::set_permissions(directory, fs::Permissions::from_mode(DIR_MODE_PRIVATE));
    }

    #[cfg(not(unix))]
    {
        fs::create_dir_all(directory).map_err(|source| DbError::Io {
            path: directory.to_path_buf(),
            source,
        })?;
    }

    Ok(())
}

fn verify_directory_permissions(directory: &Path, existed_before: bool) -> Result<(), DbError> {
    let metadata = fs::symlink_metadata(directory).map_err(|source| DbError::Io {
        path: directory.to_path_buf(),
        source,
    })?;

    if !metadata.is_dir() {
        return Err(DbError::InvalidPath(format!(
            "Database parent path '{}' is not a directory",
            directory.display()
        )));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = existed_before;
        if (metadata.mode() & GROUP_OTHER_MASK) != 0 {
            record_permission_warning(
                "SQLite directory permits group/other access. Use a dedicated service-owned directory with mode 0700; existing directory permissions were not changed.",
                directory,
                None,
            );
        }
    }

    #[cfg(not(unix))]
    {
        let _ = existed_before;
        record_permission_warning(
            "SQLite POSIX permissions cannot be verified on Windows. Restrict the database directory, sidecars and backups to the service account with host ACLs.",
            directory,
            None,
        );
    }

    Ok(())
}

fn touch_exclusive_database_file(database_path: &Path) -> Result<(), DbError> {
    let mut open_opts = OpenOptions::new();
    open_opts.write(true).create_new(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_opts.mode(FILE_MODE_PRIVATE);
    }

    match open_opts.open(database_path) {
        Ok(file) => {
            drop(file);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(
                    database_path,
                    fs::Permissions::from_mode(FILE_MODE_PRIVATE),
                );
            }
            Ok(())
        }
        Err(err) if err.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(source) => Err(DbError::Io {
            path: database_path.to_path_buf(),
            source,
        }),
    }
}
