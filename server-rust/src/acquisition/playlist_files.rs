use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use super::repository::SpotifyImportTrackMetadata;
use super::spotdl::canonical_spotify_url;
use crate::audio::tagger::RecordingTags;
use crate::audio::{AudioTaggerService, is_supported_audio_file};
use crate::config::AppConfig;
use crate::providers::{BackendRegistry, RegisteredProvider};
use crate::{db::DbPool, tasks::TaskError};

#[derive(Clone)]
pub(super) struct AcquisitionLibrary {
    pub config: Arc<RwLock<Arc<AppConfig>>>,
    pub providers: BackendRegistry,
}

pub(super) struct PublishedTrack {
    pub path: PathBuf,
    pub reused: bool,
}

impl AcquisitionLibrary {
    pub(super) async fn ready(
        &self,
        config: &AppConfig,
    ) -> Result<(RegisteredProvider, PathBuf), TaskError> {
        let error = |message: String| TaskError::ExecutionFailed(message);
        let backend = self
            .providers
            .get_primary()
            .map_err(|err| error(format!("Configure Navidrome before importing: {err}")))?;
        if backend.provider_type != "navidrome" {
            return Err(error(
                "Acquisitions require Navidrome as the primary backend".into(),
            ));
        }
        let root = tokio::fs::canonicalize(&config.music_root)
            .await
            .map_err(|err| error(format!("Could not open the shared music directory: {err}")))?;
        let writable_root = root.clone();
        tokio::task::spawn_blocking(move || tempfile::tempfile_in(writable_root))
            .await
            .map_err(|err| error(err.to_string()))?
            .map_err(|err| {
                error(format!(
                    "Could not write to the shared music directory: {err}"
                ))
            })?;
        backend
            .provider
            .check_import_library()
            .await
            .map_err(|err| error(format!("Navidrome library is not ready: {err}")))?;
        Ok((backend, root))
    }
}

/// A write-ahead receipt survives failed scans, interrupted publishes, and job-history retention.
pub(super) struct PublicationJournal<'a> {
    pub db: &'a DbPool,
    pub job_id: &'a str,
}

pub(super) async fn regular_library_file(root: &Path, path: &Path) -> Option<PathBuf> {
    if !path
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let absolute = root.join(path);
    let info = tokio::fs::symlink_metadata(&absolute).await.ok()?;
    let canonical = tokio::fs::canonicalize(&absolute).await.ok()?;
    (info.is_file()
        && info.len() > 0
        && canonical.starts_with(root)
        && is_supported_audio_file(&canonical))
    .then_some(canonical)
}

type AlbumTitles = HashMap<String, Vec<PathBuf>>;

pub(super) struct LibraryRecordingLookup<'a> {
    root: &'a Path,
    receipts: HashMap<String, Vec<(String, Vec<u8>)>>,
    albums: HashMap<PathBuf, AlbumTitles>,
}

impl<'a> LibraryRecordingLookup<'a> {
    pub async fn load(db: &DbPool, root: &'a Path, urls: &[&str]) -> io::Result<Self> {
        let mut receipts = HashMap::<String, Vec<(String, Vec<u8>)>>::new();
        let root_key = root.to_string_lossy();
        for batch in urls.chunks(400) {
            let mut query = sqlx::QueryBuilder::new(
                "SELECT spotify_url,path,digest FROM acquisition_library_files WHERE root=",
            );
            query
                .push_bind(root_key.as_ref())
                .push(" AND spotify_url IN (");
            {
                let mut urls = query.separated(", ");
                for url in batch {
                    urls.push_bind(*url);
                }
            }
            query.push(") ORDER BY spotify_url,created_at DESC,path");
            let rows: Vec<(String, String, Vec<u8>)> = query
                .build_query_as()
                .fetch_all(db.inner())
                .await
                .map_err(io::Error::other)?;
            for (url, path, digest) in rows {
                let entries = receipts.entry(url).or_default();
                if entries.len() < 32 {
                    entries.push((path, digest));
                }
            }
        }
        Ok(Self {
            root,
            receipts,
            albums: HashMap::new(),
        })
    }

    pub async fn find(
        &mut self,
        source: &SpotifyImportTrackMetadata,
        inspector: &AudioTaggerService,
    ) -> io::Result<Option<PathBuf>> {
        let root = self.root;
        let catalog_url = deezer_track_url(&source.url);
        let catalog = catalog_url.is_some();
        let url = catalog_url.or_else(|| spotify_track_url(&source.url));
        if let Some(saved) = url.as_ref().and_then(|url| self.receipts.get(url)) {
            for (path, digest) in saved {
                let relative = PathBuf::from(path.as_str());
                if let Some(file) = regular_library_file(root, &relative).await
                    && digest_file(file)
                        .await
                        .is_ok_and(|actual| actual.as_slice() == digest)
                {
                    return Ok(Some(relative));
                }
            }
        }
        if url.is_none() && source.isrc.is_none() {
            return Ok(None);
        }
        // Playlist pages may omit the album. Reuse an exact source URL from the
        // artist's other album directories before requesting network enrichment.
        let artist_only = !catalog
            && source
                .album
                .as_deref()
                .is_none_or(|album| album.trim().is_empty());
        let album = if artist_only {
            PathBuf::from(sanitize_segment(&source.artist, "Unknown Artist"))
        } else {
            library_album(source)
        };
        if !self.albums.contains_key(&album) {
            let titles = if artist_only {
                artist_titles(root, &album).await?
            } else {
                album_titles(root, &album).await?
            };
            self.albums.insert(album.clone(), titles);
        }
        let title = sanitize_segment(&source.title, "Unknown Track").to_lowercase();
        let mut matched = None;
        for relative in self.albums[&album].get(&title).into_iter().flatten() {
            let Some(file) = regular_library_file(root, relative).await else {
                continue;
            };
            let Ok(tags) = inspector.inspect_recording(&file).await else {
                continue;
            };
            let actual_url = tags.source_url.as_deref().and_then(if catalog {
                deezer_track_url
            } else {
                spotify_track_url
            });
            let exact_url = url
                .as_ref()
                .zip(actual_url.as_ref())
                .is_some_and(|(a, b)| a == b);
            let isrc_match = source
                .isrc
                .as_deref()
                .and_then(normalize_isrc)
                .zip(tags.metadata.isrc.as_deref().and_then(normalize_isrc))
                .is_some_and(|(a, b)| a == b);
            // Exact source identity wins. ISRC-only reuse also needs edition metadata and duration.
            if exact_url {
                return Ok(Some(relative.clone()));
            }
            if actual_url.is_none()
                && isrc_match
                && tags
                    .metadata
                    .title
                    .as_deref()
                    .is_some_and(|title| title.eq_ignore_ascii_case(&source.title))
                && tags
                    .metadata
                    .album
                    .as_deref()
                    .zip(source.album.as_deref())
                    .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
                && tags.duration.is_some_and(|duration| {
                    source.duration > 0.0 && (duration - source.duration).abs() <= 2.0
                })
            {
                // Keep looking for an exact Spotify match even if the ISRC
                // candidates turn out to be ambiguous.
                match matched {
                    None => matched = Some(Some(relative.clone())),
                    Some(_) => matched = Some(None),
                }
            }
        }
        Ok(matched.flatten())
    }
}

async fn artist_titles(root: &Path, artist: &Path) -> io::Result<AlbumTitles> {
    let mut titles = album_titles(root, artist).await?;
    let Ok(directory) = tokio::fs::canonicalize(root.join(artist)).await else {
        return Ok(titles);
    };
    if !directory.starts_with(root) || !directory.is_dir() {
        return Ok(titles);
    }
    let mut entries = tokio::fs::read_dir(directory).await?;
    while let Some(entry) = entries.next_entry().await? {
        if entry.file_type().await?.is_dir() {
            for (title, paths) in album_titles(root, &artist.join(entry.file_name())).await? {
                titles.entry(title).or_default().extend(paths);
            }
        }
    }
    Ok(titles)
}

async fn album_titles(root: &Path, album: &Path) -> io::Result<AlbumTitles> {
    let mut titles = HashMap::<String, Vec<PathBuf>>::new();
    let Ok(directory) = tokio::fs::canonicalize(root.join(album)).await else {
        return Ok(titles);
    };
    if !directory.starts_with(root) {
        return Ok(titles);
    }
    let mut entries = tokio::fs::read_dir(directory).await?;
    while let Some(entry) = entries.next_entry().await? {
        let relative = album.join(entry.file_name());
        if !is_supported_audio_file(&relative) {
            continue;
        }
        if let Some(stem) = relative
            .file_stem()
            .and_then(|name| name.to_str())
            .map(str::to_lowercase)
        {
            titles
                .entry(stem.clone())
                .or_default()
                .push(relative.clone());
            if let Some((base, suffix)) = stem.rsplit_once(" [")
                && suffix.ends_with(']')
            {
                titles.entry(base.to_owned()).or_default().push(relative);
            }
        }
    }
    Ok(titles)
}

fn library_album(metadata: &SpotifyImportTrackMetadata) -> PathBuf {
    PathBuf::from(sanitize_segment(&metadata.artist, "Unknown Artist")).join(sanitize_segment(
        metadata.album.as_deref().unwrap_or_default(),
        "Unknown Album",
    ))
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
    stage: &Path,
    source: &Path,
    metadata: &SpotifyImportTrackMetadata,
    inspector: &AudioTaggerService,
    journal: &PublicationJournal<'_>,
) -> io::Result<PublishedTrack> {
    let source_info = tokio::fs::symlink_metadata(source).await?;
    let source = tokio::fs::canonicalize(source).await?;
    if !source.starts_with(stage) || !source_info.is_file() || source_info.len() == 0 {
        return Err(io::Error::other(
            "Downloaded audio is outside staging or invalid",
        ));
    }
    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|_| is_supported_audio_file(&source))
        .ok_or_else(|| io::Error::other("Unsupported downloaded audio format"))?
        .to_ascii_lowercase();
    let title = sanitize_segment(&metadata.title, "Unknown Track");
    let relative_album = library_album(metadata);
    let directory = checked_album_directory(root, &relative_album).await?;
    let plain_name = format!("{title}.{extension}");
    let folded_title = title.to_lowercase();
    let spotify_url = spotify_track_url(&metadata.url);
    let mut tags = None;
    let mut digest = None;
    let mut collision_number = 0;
    let mut contested = HashSet::new();

    loop {
        let mut occupied = contested.clone();
        let mut files = tokio::fs::read_dir(&directory).await?;
        while let Some(entry) = files.next_entry().await? {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            occupied.insert(name.to_lowercase());
            let path = entry.path();
            let stem = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default()
                .to_lowercase();
            let same_title = stem == folded_title
                || stem
                    .strip_prefix(&folded_title)
                    .is_some_and(|suffix| suffix.starts_with(" [") && suffix.ends_with(']'));
            if !same_title || !is_supported_audio_file(&path) || !entry.file_type().await?.is_file()
            {
                continue;
            }
            let file = entry.metadata().await?;
            if file.len() == 0
                || !tokio::fs::canonicalize(&path)
                    .await?
                    .starts_with(&directory)
            {
                continue;
            }
            let staged_tags = match &tags {
                Some(tags) => tags,
                None => tags.insert(
                    inspector
                        .inspect_recording(&source)
                        .await
                        .unwrap_or_default(),
                ),
            };
            let existing = inspector.inspect_recording(&path).await.unwrap_or_default();
            match recording_match(&existing, staged_tags, metadata, spotify_url.as_deref()) {
                Some(true) => {
                    return Ok(PublishedTrack {
                        path: relative_album.join(name),
                        reused: true,
                    });
                }
                Some(false) => continue,
                None => {}
            }
            if file.len() == source_info.len() {
                let source_digest = load_digest(&mut digest, &source).await?;
                if source_digest == digest_file(path).await? {
                    return Ok(PublishedTrack {
                        path: relative_album.join(name),
                        reused: true,
                    });
                }
            }
        }

        let filename = if !occupied.contains(&plain_name.to_lowercase()) {
            plain_name.clone()
        } else {
            let suffix = match spotify_url
                .as_deref()
                .and_then(|url| url.rsplit('/').next())
            {
                Some(id) => id[..id.len().min(8)].to_owned(),
                None => load_digest(&mut digest, &source).await?[..5]
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
            };
            loop {
                let candidate = if collision_number == 0 {
                    format!("{title} [{suffix}].{extension}")
                } else {
                    format!("{title} [{suffix}-{collision_number}].{extension}")
                };
                if !occupied.contains(&candidate.to_lowercase()) {
                    break candidate;
                }
                collision_number += 1;
            }
        };
        let relative = relative_album.join(&filename);
        let file_digest = load_digest(&mut digest, &source).await?;
        sqlx::query("INSERT OR IGNORE INTO acquisition_library_files(root,path,digest,spotify_url,job_id,created_at) VALUES (?,?,?,?,?,?)")
            .bind(root.to_string_lossy().as_ref())
            .bind(navidrome_path(&relative).ok_or_else(|| io::Error::other("Invalid publication path"))?)
            .bind(file_digest.as_slice()).bind(spotify_url.as_deref()).bind(journal.job_id)
            .bind(chrono::Utc::now().to_rfc3339()).execute(journal.db.inner()).await.map_err(io::Error::other)?;
        match publish_track(root, &relative, &source).await {
            Ok(()) => {
                return Ok(PublishedTrack {
                    path: relative,
                    reused: false,
                });
            }
            // A concurrent publisher won this filename. Recheck its identity before choosing another.
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                contested.insert(filename.to_lowercase());
            }
            Err(err) => return Err(err),
        }
    }
}

fn sanitize_segment(value: &str, fallback: &str) -> String {
    let mut clean = String::new();
    for ch in value.chars() {
        let ch = if ch.is_control()
            || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        {
            ' '
        } else {
            ch
        };
        if clean.len() + ch.len_utf8() > 160 {
            break;
        }
        clean.push(ch);
    }
    let clean = clean.trim_matches(|ch: char| ch.is_whitespace() || ch == '.');
    if clean.is_empty() {
        return fallback.to_owned();
    }
    let device = clean
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    if matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (["COM", "LPT"]
            .iter()
            .any(|prefix| device.starts_with(prefix))
            && matches!(
                &device[3..],
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            ))
    {
        return format!("_{clean}");
    }
    clean.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn spotify_track_url(value: &str) -> Option<String> {
    canonical_spotify_url(value)
        .ok()
        .filter(|url| url.starts_with("https://open.spotify.com/track/"))
}

fn normalize_isrc(value: &str) -> Option<String> {
    let value: String = value.chars().filter(char::is_ascii_alphanumeric).collect();
    (value.len() == 12).then(|| value.to_ascii_uppercase())
}

fn deezer_track_url(value: &str) -> Option<String> {
    let id = value.strip_prefix("https://www.deezer.com/track/")?;
    id.parse::<u64>()
        .ok()
        .filter(|n| *n > 0 && n.to_string() == id)?;
    Some(value.to_owned())
}

/// A conflicting recording identifier takes precedence over name, duration, and byte comparison.
fn recording_match(
    existing: &RecordingTags,
    staged: &RecordingTags,
    metadata: &SpotifyImportTrackMetadata,
    spotify_url: Option<&str>,
) -> Option<bool> {
    if let Some((expected, actual)) = deezer_track_url(&metadata.url)
        .zip(existing.source_url.as_deref().and_then(deezer_track_url))
    {
        return Some(expected == actual);
    }
    let existing_url = existing.source_url.as_deref().and_then(spotify_track_url);
    let staged_url = spotify_url
        .map(str::to_owned)
        .or_else(|| staged.source_url.as_deref().and_then(spotify_track_url));
    if let Some((existing, staged)) = existing_url.zip(staged_url) {
        return Some(existing == staged);
    }
    let existing_isrc = existing.metadata.isrc.as_deref().and_then(normalize_isrc);
    let staged_isrc = metadata
        .isrc
        .as_deref()
        .and_then(normalize_isrc)
        .or_else(|| staged.metadata.isrc.as_deref().and_then(normalize_isrc));
    if let Some((existing, staged)) = existing_isrc.zip(staged_isrc) {
        return Some(existing == staged);
    }
    // In the absence of IDs, require matching tags, duration and album position.
    let equal = |actual: Option<&str>, expected: &str| {
        !expected.trim().is_empty()
            && actual.is_some_and(|actual| actual.trim().eq_ignore_ascii_case(expected.trim()))
    };
    let duration = staged.duration.unwrap_or(metadata.duration);
    if let Some((first, second)) = existing.track_number.zip(staged.track_number)
        && first != 0
        && second != 0
        && equal(existing.metadata.title.as_deref(), &metadata.title)
        && equal(
            existing.metadata.artist.as_deref(),
            staged
                .metadata
                .artist
                .as_deref()
                .unwrap_or(&metadata.artist),
        )
        && equal(
            existing.metadata.album.as_deref(),
            metadata.album.as_deref().unwrap_or_default(),
        )
        && existing
            .duration
            .is_some_and(|value| value > 0.0 && duration > 0.0 && (value - duration).abs() <= 1.0)
    {
        return Some(
            first == second && existing.disc_number.unwrap_or(1) == staged.disc_number.unwrap_or(1),
        );
    }
    None
}

pub(super) async fn cleanup_staging(dir: &Path) {
    if let Err(err) = tokio::fs::remove_dir_all(dir).await {
        if err.kind() != io::ErrorKind::NotFound {
            tracing::warn!(error = %err, "Could not clean up acquisition staging");
        }
    }
}

pub(super) const MAX_PLAYLIST_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;

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

async fn checked_album_directory(root: &Path, relative: &Path) -> io::Result<PathBuf> {
    let (root, relative) = (root.to_path_buf(), relative.to_path_buf());
    tokio::task::spawn_blocking(move || create_album_directory(&root, &relative))
        .await
        .map_err(io::Error::other)?
}

/// Copies into a temporary sibling and publishes it atomically without replacing existing audio.
async fn publish_track(root: &Path, relative: &Path, source: &Path) -> io::Result<()> {
    let (root, relative, source) = (
        root.to_path_buf(),
        relative.to_path_buf(),
        source.to_path_buf(),
    );
    let cancel = tokio_util::sync::CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    tokio::task::spawn_blocking(move || copy_track(&root, &relative, &source, &cancel))
        .await
        .map_err(io::Error::other)?
}

fn create_album_directory(root: &Path, relative: &Path) -> io::Result<PathBuf> {
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
    for part in relative.components() {
        let directory = parent.join(part);
        let created = match fs::create_dir(&directory) {
            Ok(()) => true,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => false,
            Err(err) => return Err(err),
        };
        let canonical = fs::canonicalize(&directory)?;
        if !fs::symlink_metadata(&directory)?.is_dir()
            || !canonical.starts_with(&parent)
            || canonical == parent
        {
            return Err(io::Error::other(
                "Import destination directory escapes the music root",
            ));
        }
        if created {
            // The container's private umask also applies to directory creation.
            // Navidrome may traverse the shared library under another UID.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&canonical, fs::Permissions::from_mode(0o755))?;
            }
            sync_directory(&parent)?;
        }
        parent = canonical;
    }
    Ok(parent)
}

fn copy_track(
    root: &Path,
    relative: &Path,
    source: &Path,
    cancel: &tokio_util::sync::CancellationToken,
) -> io::Result<()> {
    let check_cancelled = || {
        if cancel.is_cancelled() {
            Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Audio publication was cancelled",
            ))
        } else {
            Ok(())
        }
    };
    check_cancelled()?;
    let album = relative
        .parent()
        .ok_or_else(|| io::Error::other("Missing album directory"))?;
    let parent = create_album_directory(root, album)?;
    let filename = relative
        .file_name()
        .ok_or_else(|| io::Error::other("Missing audio filename"))?;
    let destination = parent.join(filename);
    let meta = fs::symlink_metadata(source)?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(io::Error::other(
            "Downloaded audio is not a non-empty regular file",
        ));
    }
    let mut builder = tempfile::Builder::new();
    builder.prefix(".musicdeck-").suffix(".part");
    let mut temp = builder.tempfile_in(&parent)?;
    let mut input = fs::File::open(source)?;
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut copied = 0;
    loop {
        check_cancelled()?;
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        temp.write_all(&buffer[..read])?;
        copied += read as u64;
    }
    if copied != meta.len() {
        return Err(io::Error::other("Downloaded audio changed during the copy"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o644))?;
    }
    temp.as_file().sync_all()?;
    check_cancelled()?;

    temp.persist_noclobber(&destination)
        .map_err(|err| err.error)?;
    let published = fs::symlink_metadata(&destination)?;
    if !published.is_file()
        || published.len() != meta.len()
        || !fs::canonicalize(&destination)?.starts_with(&parent)
    {
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

async fn load_digest(digest: &mut Option<[u8; 32]>, path: &Path) -> io::Result<[u8; 32]> {
    if let Some(value) = digest {
        return Ok(*value);
    }
    let value = digest_file(path.to_path_buf()).await?;
    *digest = Some(value);
    Ok(value)
}

async fn digest_file(path: PathBuf) -> io::Result<[u8; 32]> {
    tokio::task::spawn_blocking(move || {
        let mut digest = Sha256::new();
        let mut input = fs::File::open(path)?;
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let len = input.read(&mut buffer)?;
            if len == 0 {
                return Ok(digest.finalize().into());
            }
            digest.update(&buffer[..len]);
        }
    })
    .await
    .map_err(io::Error::other)?
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_library_components_and_respects_filesystem_name_limits() {
        assert_eq!(
            sanitize_segment("../\\", "Unknown Artist"),
            "Unknown Artist"
        );
        assert_eq!(sanitize_segment(" . ", "Unknown Album"), "Unknown Album");
        assert_eq!(
            sanitize_segment(" A/ B\\C: D*?\"<>| .", "Unknown Track"),
            "A B C D"
        );
        assert_eq!(sanitize_segment("NUL.txt", "Unknown Track"), "_NUL.txt");
        assert!(sanitize_segment(&"🎵".repeat(50), "Unknown Track").len() <= 160);
    }

    #[cfg(unix)]
    #[test]
    fn library_directory_rejects_a_symlink_to_another_root() {
        let music = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(music.path()).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("Artist")).unwrap();
        assert!(create_album_directory(&root, Path::new("Artist/Album")).is_err());
        assert!(!outside.path().join("Album").exists());
    }

    #[cfg(unix)]
    #[test]
    fn publishes_readable_audio_under_private_umask() {
        const CHILD: &str = "MUSICDECK_TEST_PRIVATE_PUBLICATION_UMASK";
        if std::env::var_os(CHILD).is_none() {
            let module = module_path!().split_once("::").unwrap().1;
            let test_name = format!("{module}::publishes_readable_audio_under_private_umask");
            let output = std::process::Command::new("sh")
                .args(["-c", "umask 077\nexec \"$@\"", "musicdeck-test"])
                .arg(std::env::current_exe().unwrap())
                .args(["--exact", &test_name])
                .env(CHILD, "1")
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                output.status.success() && stdout.contains("1 passed"),
                "{stdout}"
            );
            return;
        }

        use std::os::unix::fs::PermissionsExt;
        let music = tempfile::tempdir().unwrap();
        let source = tempfile::NamedTempFile::new().unwrap();
        fs::write(source.path(), b"audio bytes").unwrap();
        let root = fs::canonicalize(music.path()).unwrap();
        let relative = Path::new("Artist/Album/Track.m4a");
        copy_track(&root, relative, source.path(), &Default::default()).unwrap();
        let mode = |path| fs::metadata(root.join(path)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode("Artist"), 0o755);
        assert_eq!(mode("Artist/Album"), 0o755);
        assert_eq!(mode("Artist/Album/Track.m4a"), 0o644);
    }
}
