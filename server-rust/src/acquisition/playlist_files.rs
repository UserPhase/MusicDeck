use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::config::AppConfig;
use crate::providers::BackendRegistry;

#[derive(Clone)]
pub(super) struct AcquisitionLibrary {
    pub config: Arc<RwLock<Arc<AppConfig>>>,
    pub providers: BackendRegistry,
}

pub(super) fn staging_path(root: &Path, id: &str) -> io::Result<PathBuf> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(io::Error::other("Invalid acquisition job ID"));
    }
    std::path::absolute(root.join(id))
}

pub(super) async fn publish_staged_track(
    root: &Path,
    collection: &Path,
    stage: &Path,
    source: &Path,
) -> io::Result<PathBuf> {
    let path = source
        .strip_prefix(stage)
        .map_err(|_| io::Error::other("Downloaded file is outside staging"))?;
    let destination = collection.join(path);
    publish_track(root, &destination, source).await?;
    Ok(destination)
}

pub(super) async fn cleanup_staging(dir: &Path) {
    if let Err(err) = tokio::fs::remove_dir_all(dir).await {
        if err.kind() != io::ErrorKind::NotFound {
            tracing::warn!(error = %err, "Could not clean up acquisition staging");
        }
    }
}

const MAX_PLAYLIST_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;

pub(super) async fn read_playlist_artifact(path: &Path) -> io::Result<String> {
    if !tokio::fs::symlink_metadata(path).await?.is_file() {
        return Err(io::Error::other(
            "spotDL playlist artifact is not a regular file",
        ));
    }
    let mut text = String::new();
    tokio::fs::File::open(path)
        .await?
        .take(MAX_PLAYLIST_ARTIFACT_BYTES + 1)
        .read_to_string(&mut text)
        .await?;
    if text.len() as u64 > MAX_PLAYLIST_ARTIFACT_BYTES {
        return Err(io::Error::other(
            "spotDL playlist artifact exceeds the size limit",
        ));
    }
    Ok(text)
}

/// Copies into a temporary sibling and publishes it atomically without replacing existing audio.
pub(super) async fn publish_track(root: &Path, relative: &Path, source: &Path) -> io::Result<()> {
    let (root, relative, source) = (
        root.to_path_buf(),
        relative.to_path_buf(),
        source.to_path_buf(),
    );
    tokio::task::spawn_blocking(move || copy_track(&root, &relative, &source))
        .await
        .map_err(io::Error::other)?
}

fn copy_track(root: &Path, relative: &Path, source: &Path) -> io::Result<()> {
    if relative.as_os_str().is_empty()
        || !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(io::Error::other(
            "Import destination must be relative to the music root",
        ));
    }
    let mut parent = root.to_path_buf();
    for part in relative.parent().unwrap_or(Path::new("")).components() {
        let directory = parent.join(part);
        let created = match fs::create_dir(&directory) {
            Ok(()) => true,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => false,
            Err(err) => return Err(err),
        };
        if !fs::symlink_metadata(&directory)?.is_dir()
            || !fs::canonicalize(&directory)?.starts_with(root)
        {
            return Err(io::Error::other(
                "Import destination directory escapes the music root",
            ));
        }
        if created {
            sync_directory(&parent)?;
        }
        parent = directory;
    }

    let destination = root.join(relative);
    let meta = fs::symlink_metadata(source)?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(io::Error::other(
            "Downloaded audio is not a non-empty regular file",
        ));
    }
    let mut builder = tempfile::Builder::new();
    builder.prefix(".musicdeck-").suffix(".part");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o644));
    }
    let mut temp = builder.tempfile_in(&parent)?;
    if io::copy(&mut fs::File::open(source)?, temp.as_file_mut())? != meta.len() {
        return Err(io::Error::other("Downloaded audio changed during the copy"));
    }
    temp.as_file().sync_all()?;

    match temp.persist_noclobber(&destination) {
        Ok(_) => {}
        Err(err) if err.error.kind() == io::ErrorKind::AlreadyExists => {
            let existing = fs::symlink_metadata(&destination)?;
            if !existing.is_file()
                || existing.len() != meta.len()
                || file_digest(err.file.path())? != file_digest(&destination)?
            {
                return Err(io::Error::other(
                    "Different audio already exists at the import destination",
                ));
            }
        }
        Err(err) => return Err(err.error),
    }
    let published = fs::symlink_metadata(&destination)?;
    if !published.is_file() || published.len() != meta.len() {
        return Err(io::Error::other(
            "Could not verify audio at the import destination",
        ));
    }
    sync_directory(&parent)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    fs::File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_: &Path) -> io::Result<()> {
    Ok(())
}

fn file_digest(path: &Path) -> io::Result<Vec<u8>> {
    let mut digest = Sha256::new();
    let mut input = fs::File::open(path)?;
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let len = input.read(&mut buffer)?;
        if len == 0 {
            return Ok(digest.finalize().to_vec());
        }
        digest.update(&buffer[..len]);
    }
}

pub(super) fn navidrome_path(relative: &Path) -> Option<String> {
    let parts: Option<Vec<&str>> = relative
        .components()
        .map(|part| match part {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect();
    parts.map(|parts| parts.join("/"))
}

/// M3U entries are untrusted. Paths must resolve to files discovered by the downloader in staging.
pub(super) async fn staged_playlist_path(stage: &Path, raw: &str) -> Option<PathBuf> {
    let path = tokio::fs::canonicalize(stage.join(raw)).await.ok()?;
    (path.starts_with(stage) && path != stage).then_some(path)
}
