use std::{
    collections::{BTreeMap, HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_json::Value;
use tokio::{fs, io::AsyncReadExt, time::Instant};

use super::{
    input::Operand,
    playlist_files::{
        LibraryRecordingLookup, MAX_PLAYLIST_ARTIFACT_BYTES, PublicationJournal, navidrome_path,
        publish_staged_track, read_playlist_artifact, regular_library_file,
    },
    playlist_timeout::{PlaylistDeadline, PlaylistImportTimeout, within_phase},
    progress::{DownloadTelemetry, ProviderRetries, is_transient_provider_error, monitor_download},
    repository::{ImportEntry, ImportEntryStatus, ManifestDownload, SpotifyImportTrackMetadata},
    spotdl::{
        AudioSearch, BATCH_INPUT, OCCURRENCES_FILE, SpotDLDownloaderAdapter, TrackImportRequest,
        canonical_spotify_url, downloader_error_message, downloader_failure_code,
        scan_downloaded_audio_files,
    },
};
use crate::providers::traits::ImportedTrackMatch;

use crate::{
    audio::AudioTaggerService,
    db::DbPool,
    providers::MusicBackend,
    tasks::{TaskError, TaskRunContext},
};

const CHECKPOINT: &str = "musicdeck-checkpoint.json";
const RESOLVED_SONGS: &str = "musicdeck-resolved.spotdl";
const DOWNLOAD_BATCH: usize = 48;
const MAX_OCCURRENCES: usize = 50_000;

fn execution_error(error: impl std::fmt::Display) -> TaskError {
    TaskError::ExecutionFailed(error.to_string())
}

pub(super) async fn open_stage(
    stage: &Path,
    music_root: Option<&Path>,
) -> Result<PathBuf, TaskError> {
    fs::create_dir_all(stage).await.map_err(execution_error)?;
    let info = fs::symlink_metadata(stage).await.map_err(execution_error)?;
    let canonical = fs::canonicalize(stage).await.map_err(execution_error)?;
    if !info.is_dir()
        || music_root
            .is_some_and(|root| root.starts_with(&canonical) || canonical.starts_with(root))
    {
        return Err(execution_error(
            "Acquisition staging must be outside the shared music library",
        ));
    }
    Ok(canonical)
}

pub(super) async fn load(stage: &Path) -> Result<Option<ManifestDownload>, TaskError> {
    match read_playlist_artifact(&stage.join(CHECKPOINT)).await {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(execution_error),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(execution_error(error)),
    }
}

pub(super) async fn save(stage: &Path, manifest: &ManifestDownload) -> Result<(), TaskError> {
    let path = stage.join(CHECKPOINT);
    let bytes = serde_json::to_vec(manifest).map_err(execution_error)?;
    tokio::task::spawn_blocking(move || crate::config::durable_bytes(&path, &bytes))
        .await
        .map_err(execution_error)?
        .map_err(execution_error)
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct SourceOccurrence {
    name: Option<String>,
    artist: Option<String>,
    artists: Option<Vec<String>>,
    url: Option<String>,
    song_id: Option<String>,
    album_name: Option<String>,
    album_artist: Option<String>,
    duration: Option<f64>,
    isrc: Option<String>,
    list_name: Option<String>,
    list_position: Option<usize>,
    list_length: Option<usize>,
    list_url: Option<String>,
    disc_number: Option<u32>,
    track_number: Option<u32>,
}

pub(super) fn recording_url(url: &str) -> Option<String> {
    canonical_spotify_url(url)
        .ok()
        .filter(|url| url.contains("/track/"))
}

pub(super) fn occurrence_manifest(
    json: &str,
    exact_playlist: bool,
) -> Result<ManifestDownload, TaskError> {
    let mut sources: Vec<Option<SourceOccurrence>> =
        serde_json::from_str(json).map_err(execution_error)?;
    if !exact_playlist && sources.len() > 1 {
        let list = sources
            .first()
            .and_then(|source| source.as_ref())
            .and_then(|source| source.list_url.clone());
        if list.is_some()
            && sources.iter().all(|source| {
                source
                    .as_ref()
                    .is_some_and(|source| source.list_url == list && source.list_position.is_some())
            })
        {
            sources.sort_by_key(|source| source.as_ref().and_then(|source| source.list_position));
        } else if sources.iter().all(|source| {
            source
                .as_ref()
                .is_some_and(|source| source.track_number.is_some())
        }) && sources.windows(2).all(|pair| {
            pair[0]
                .as_ref()
                .and_then(|source| source.album_name.as_ref())
                == pair[1]
                    .as_ref()
                    .and_then(|source| source.album_name.as_ref())
        }) {
            sources.sort_by_key(|source| {
                source
                    .as_ref()
                    .map(|source| (source.disc_number, source.track_number))
            });
        }
    }
    let mut sorted = BTreeMap::new();
    let mut expected = sources.len();
    let mut name = None;
    for (index, source) in sources.into_iter().enumerate() {
        let source = source.unwrap_or_default();
        let position = if exact_playlist {
            source
                .list_position
                .filter(|position| *position > 0)
                .ok_or_else(|| {
                    execution_error("Spotify playlist metadata is missing its occurrence positions")
                })?
        } else {
            index + 1
        };
        if exact_playlist {
            expected = expected.max(source.list_length.unwrap_or(0)).max(position);
        }
        if expected > MAX_OCCURRENCES {
            return Err(execution_error("Source has too many track occurrences"));
        }
        if name.is_none() {
            name = source
                .list_name
                .clone()
                .filter(|name| !name.trim().is_empty());
        }
        if sorted.insert(position, source).is_some() {
            return Err(execution_error(
                "Spotify playlist returned the same occurrence position twice",
            ));
        }
    }
    if expected == 0 {
        return Err(execution_error("Source contains no tracks"));
    }
    let mut first = HashMap::new();
    let entries = (1..=expected)
        .map(|position| {
            let row = sorted.remove(&position).unwrap_or_default();
            let url = row.url.as_deref().and_then(recording_url).or_else(|| {
                row.song_id
                    .as_ref()
                    .and_then(|id| recording_url(&format!("https://open.spotify.com/track/{id}")))
            });
            let duplicate_of = url.as_ref().and_then(|url| {
                let earlier = *first.entry(url.clone()).or_insert(position);
                (earlier != position).then_some(earlier)
            });
            let missing = url.is_none();
            ImportEntry {
                position,
                source: SpotifyImportTrackMetadata {
                    position,
                    url: url.unwrap_or_default(),
                    title: row.name.unwrap_or_default(),
                    artist: row.artist.unwrap_or_default(),
                    artists: row.artists.unwrap_or_default(),
                    album: row.album_name,
                    album_artist: row.album_artist,
                    duration: row.duration.unwrap_or_default(),
                    isrc: row.isrc,
                    year: None,
                    artwork_url: None,
                },
                status: if missing {
                    ImportEntryStatus::FailedMetadataMissing
                } else {
                    ImportEntryStatus::Pending
                },
                error: missing
                    .then(|| "Spotify did not expose an audio track for this occurrence".into()),
                error_code: None,
                file_path: None,
                library_path: None,
                library_reused: false,
                provider_track_id: None,
                duplicate_of,
                requires_scan: None,
                catalog: None,
            }
        })
        .collect();
    Ok(ManifestDownload {
        entries,
        expected_count: expected,
        name: name.map(|name| name.chars().take(200).collect()),
        indexed_connection: None,
    })
}

pub(super) async fn discover<F>(
    context: &TaskRunContext,
    downloader: &SpotDLDownloaderAdapter,
    stage: &Path,
    operands: &[Operand],
    exact_playlist: bool,
    end: Instant,
    report: impl Fn(DownloadTelemetry) -> F,
) -> Result<ManifestDownload, TaskError>
where
    F: Future<Output = ()> + Send,
{
    let mut manifest = ManifestDownload {
        entries: Vec::new(),
        expected_count: 0,
        name: None,
        indexed_connection: None,
    };
    let mut retries = ProviderRetries::default();
    let mut resolved_songs = Vec::<Value>::new();
    let mut resolved_bytes = 0usize;
    let report_stage = |stage| {
        report(DownloadTelemetry {
            stage,
            ..Default::default()
        })
    };
    for operand in operands {
        let request = TrackImportRequest {
            output_directory: stage.to_path_buf(),
            operands: vec![operand.clone()],
            ..Default::default()
        };
        let json = loop {
            let result = within_phase(context, end, "source discovery", async {
                downloader
                    .resolve_sources(&request, context.cancel_token(), report_stage)
                    .await
                    .map_err(execution_error)
            })
            .await;
            match result {
                Ok(json) => break json,
                Err(error) => {
                    let message = error.to_string();
                    let code = downloader_failure_code(&message).unwrap_or("general");
                    if !retries.wait(context, end, code, report_stage).await? {
                        return Err(error);
                    }
                }
            }
        };
        let collection = occurrence_manifest(&json, exact_playlist)?;
        resolved_bytes = resolved_bytes.saturating_add(json.len());
        if operands.len() > 1 && resolved_bytes as u64 <= MAX_PLAYLIST_ARTIFACT_BYTES {
            resolved_songs
                .extend(serde_json::from_str::<Vec<Value>>(&json).map_err(execution_error)?);
        } else {
            resolved_songs.clear();
        }
        let offset = manifest.entries.len();
        manifest.expected_count += collection.expected_count;
        if manifest.expected_count > MAX_OCCURRENCES {
            return Err(execution_error("Source has too many track occurrences"));
        }
        manifest.name = manifest.name.or(collection.name);
        manifest
            .entries
            .extend(collection.entries.into_iter().map(|mut entry| {
                entry.position += offset;
                entry.source.position = entry.position;
                entry.duplicate_of = entry.duplicate_of.map(|position| position + offset);
                entry
            }));
    }
    if !resolved_songs.is_empty() {
        let path = stage.join(RESOLVED_SONGS);
        let bytes = serde_json::to_vec(&resolved_songs).map_err(execution_error)?;
        let saved =
            tokio::task::spawn_blocking(move || crate::config::durable_bytes(&path, &bytes))
                .await
                .map_err(execution_error)
                .and_then(|result| result.map_err(execution_error));
        if let Err(error) = saved {
            tracing::debug!(%error, "Could not save combined spotDL metadata");
        }
    }
    save(stage, &manifest).await?;
    Ok(manifest)
}

async fn load_resolved_songs(stage: &Path) -> HashMap<String, Value> {
    let json = match read_playlist_artifact(&stage.join(RESOLVED_SONGS)).await {
        Ok(json) => json,
        Err(_) => match read_playlist_artifact(&stage.join(OCCURRENCES_FILE)).await {
            Ok(json) => json,
            Err(_) => return HashMap::new(),
        },
    };
    let Ok(rows) = serde_json::from_str::<Vec<Value>>(&json) else {
        return HashMap::new();
    };
    let mut songs = HashMap::new();
    for mut row in rows {
        let Some(url) = row["url"].as_str().and_then(recording_url) else {
            continue;
        };
        if row["song_id"].as_str() != url.rsplit('/').next() {
            continue;
        }
        // Keep the entire native metadata row, but let spotDL select audio
        // through the requested providers on each attempt.
        row["url"] = Value::String(url.clone());
        row["download_url"] = Value::Null;
        songs.entry(url).or_insert(row);
    }
    songs
}

fn staged_recording_id(file: &Path) -> Option<&str> {
    let id = file
        .file_stem()?
        .to_str()?
        .rsplit_once(" [")?
        .1
        .strip_suffix(']')?;
    (!id.is_empty() && id.len() <= 64 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        .then_some(id)
}

pub(super) async fn verify_file(
    file: &Path,
    source: &SpotifyImportTrackMetadata,
    tagger: &AudioTaggerService,
) -> bool {
    let Ok(info) = fs::symlink_metadata(file).await else {
        return false;
    };
    if !info.is_file() || info.len() == 0 {
        return false;
    }
    if file
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("wav"))
    {
        let Ok(mut audio) = fs::File::open(file).await else {
            return false;
        };
        let mut header = [0; 12];
        if audio.read_exact(&mut header).await.is_err()
            || &header[..4] != b"RIFF"
            || &header[8..] != b"WAVE"
        {
            return false;
        }
        let declared = u64::from(u32::from_le_bytes(header[4..8].try_into().unwrap()));
        if declared < 36 || declared + 8 > info.len() {
            return false;
        }
        if source.duration <= 0.0 {
            return true;
        }
    }
    let Ok(tags) = tagger.inspect_recording(file).await else {
        return false;
    };
    if let (Some(expected), Some(actual)) = (
        recording_url(&source.url),
        tags.source_url.as_deref().and_then(recording_url),
    ) && expected != actual
    {
        return false;
    }
    tags.duration.is_some_and(|duration| {
        duration.is_finite()
            && duration > 0.0
            && (source.duration <= 0.0
                || (duration - source.duration).abs() <= 3.0_f64.max(source.duration * 0.02))
    })
}

pub(super) async fn harvest(
    context: &TaskRunContext,
    stage: &Path,
    files: impl IntoIterator<Item = PathBuf>,
    manifest: &mut ManifestDownload,
    tagger: &AudioTaggerService,
) -> Result<(), TaskError> {
    let cancel = context.cancel_token();
    let mut candidates: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for file in files {
        if let Some(id) = staged_recording_id(&file) {
            candidates.entry(id.to_owned()).or_default().push(file);
        }
    }
    let mut chosen: HashMap<String, Option<String>> = HashMap::new();
    for entry in &mut manifest.entries {
        context.throw_if_cancelled()?;
        if entry.file_path.is_some() || entry.library_path.is_some() {
            continue;
        }
        let Some(id) = entry
            .source
            .url
            .strip_prefix("https://open.spotify.com/track/")
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        if !chosen.contains_key(id) {
            let mut verified = None;
            if let Some(files) = candidates.get_mut(id) {
                files.sort();
                for path in files {
                    let candidate = async {
                        let file = fs::canonicalize(path).await.ok()?;
                        (file.starts_with(stage) && verify_file(&file, &entry.source, tagger).await)
                            .then_some(file)
                    };
                    if let Some(file) = cancel
                        .run_until_cancelled(candidate)
                        .await
                        .ok_or(TaskError::Cancelled)?
                    {
                        verified = Some(file.to_string_lossy().into_owned());
                        break;
                    }
                }
            }
            chosen.insert(id.to_owned(), verified);
        }
        if let Some(file) = chosen.get(id).and_then(|file| file.clone()) {
            entry.file_path = Some(file);
            entry.status = ImportEntryStatus::Downloaded;
            entry.error = None;
            entry.error_code = None;
        }
    }
    Ok(())
}

pub(super) async fn prepare_existing(
    context: &TaskRunContext,
    tagger: &AudioTaggerService,
    db: &DbPool,
    stage: &Path,
    music: Option<&Path>,
    manifest: &mut ManifestDownload,
) -> Result<(), TaskError> {
    let cancel = context.cancel_token();
    let mut library_paths = HashMap::<String, Option<String>>::new();
    let mut verified_library = HashMap::new();
    let mut verified_staging = HashMap::new();
    let mut lookup = if let Some(root) = music {
        let mut urls: Vec<_> = manifest
            .entries
            .iter()
            .map(|entry| entry.source.url.as_str())
            .filter(|url| !url.is_empty())
            .collect();
        urls.sort_unstable();
        urls.dedup();
        Some(
            cancel
                .run_until_cancelled(LibraryRecordingLookup::load(db, root, &urls))
                .await
                .ok_or(TaskError::Cancelled)?
                .map_err(execution_error)?,
        )
    } else {
        None
    };
    for (index, entry) in manifest.entries.iter_mut().enumerate() {
        context.throw_if_cancelled()?;
        if index % 32 == 0 || context.is_paused() {
            context.checkpoint().await?;
        }
        if let Some((root, lookup)) = music.zip(lookup.as_mut()) {
            if let Some(path) = entry.library_path.as_deref() {
                let valid = match verified_library.get(path) {
                    Some(valid) => *valid,
                    None => {
                        let valid = regular_library_file(root, Path::new(path)).await.is_some();
                        verified_library.insert(path.to_owned(), valid);
                        valid
                    }
                };
                // A surviving file can have a different Navidrome ID after a rescan
                // or database rebuild. Reconcile it with the current batch.
                entry.provider_track_id = None;
                if valid {
                    continue;
                }
                entry.library_path = None;
            }
            if !entry.source.url.is_empty() && !library_paths.contains_key(&entry.source.url) {
                let found = cancel
                    .run_until_cancelled(lookup.find(&entry.source, tagger))
                    .await
                    .ok_or(TaskError::Cancelled)?
                    .map_err(execution_error)?;
                library_paths.insert(
                    entry.source.url.clone(),
                    found.as_deref().and_then(navidrome_path),
                );
            }
            if let Some(path) = library_paths
                .get(&entry.source.url)
                .and_then(|path| path.clone())
            {
                entry.library_path = Some(path);
                entry.library_reused = true;
                entry.requires_scan = Some(false);
                entry.status = ImportEntryStatus::Downloaded;
                entry.error = None;
                entry.error_code = None;
                continue;
            }
        }
        if let Some(path) = entry.file_path.as_deref() {
            if !verified_staging.contains_key(path) {
                let mut valid = false;
                if let Ok(file) = fs::canonicalize(path).await
                    && file.starts_with(stage)
                {
                    valid = cancel
                        .run_until_cancelled(verify_file(&file, &entry.source, tagger))
                        .await
                        .ok_or(TaskError::Cancelled)?;
                }
                verified_staging.insert(path.to_owned(), valid);
            }
            let valid = verified_staging.get(path) == Some(&true);
            if !valid {
                entry.file_path = None;
            }
        }
    }
    Ok(())
}

pub(super) async fn fetch_missing<F>(
    context: &TaskRunContext,
    downloader: &SpotDLDownloaderAdapter,
    db: &DbPool,
    stage: &Path,
    music: Option<&Path>,
    manifest: &mut ManifestDownload,
    mode: PlaylistImportTimeout,
    end: Instant,
    report: impl Fn(DownloadTelemetry) -> F,
) -> Result<Option<TaskError>, TaskError>
where
    F: Future<Output = ()> + Send,
{
    let tagger = downloader.tagger();
    prepare_existing(context, &tagger, db, stage, music, manifest).await?;
    let cancel = context.cancel_token();
    let files = cancel
        .run_until_cancelled(scan_downloaded_audio_files(stage))
        .await
        .ok_or(TaskError::Cancelled)?
        .map_err(execution_error)?;
    harvest(context, stage, files, manifest, &tagger).await?;
    save(stage, manifest).await?;

    let missing = |entry: &&ImportEntry| entry.file_path.is_none() && entry.library_path.is_none();
    let mut seen = HashSet::new();
    let targets: Vec<_> = manifest
        .entries
        .iter()
        .filter(missing)
        .filter_map(|entry| recording_url(&entry.source.url))
        .filter(|url| seen.insert(url.clone()))
        .collect();
    if targets.is_empty() {
        return Ok(None);
    }
    let resolved_songs = load_resolved_songs(stage).await;
    let mut last_error = None;
    let mut retries = ProviderRetries::default();
    for (search, urls) in [
        (AudioSearch::Standard, targets),
        (AudioSearch::Edition, Vec::new()),
        (AudioSearch::SoundCloud, Vec::new()),
    ] {
        let urls = if search != AudioSearch::Standard {
            seen.clear();
            manifest
                .entries
                .iter()
                .filter(missing)
                .filter(|entry| {
                    matches!(
                        entry.error_code.as_deref(),
                        Some("no-match" | "source-unavailable" | "recording-mismatch")
                    ) && entry.source.duration.is_finite()
                        && entry.source.duration > 0.0
                        && !entry.source.title.trim().is_empty()
                        && !entry.source.artist.trim().is_empty()
                        && (search != AudioSearch::Edition
                            || entry
                                .source
                                .album
                                .as_deref()
                                .is_some_and(|album| !album.trim().is_empty()))
                })
                .filter_map(|entry| recording_url(&entry.source.url))
                .filter(|url| seen.insert(url.clone()))
                .collect()
        } else {
            urls
        };
        for chunk in urls.chunks(DOWNLOAD_BATCH) {
            let mut pending = chunk.to_vec();
            while !pending.is_empty() {
                context.checkpoint().await?;
                if Instant::now() >= end {
                    return Ok(Some(execution_error(format!(
                        "spotDL failed (download-timeout): {}",
                        downloader_error_message("download-timeout")
                    ))));
                }
                let directory = stage.join(format!("download-{}", uuid::Uuid::new_v4().simple()));
                fs::create_dir(&directory).await.map_err(execution_error)?;
                let saved = pending
                    .iter()
                    .map(|url| resolved_songs.get(url))
                    .collect::<Option<Vec<_>>>();
                if let Some(rows) = &saved {
                    let bytes = serde_json::to_vec(rows).map_err(execution_error)?;
                    fs::write(directory.join(BATCH_INPUT), bytes)
                        .await
                        .map_err(execution_error)?;
                }
                let request = TrackImportRequest {
                    output_directory: directory.clone(),
                    playlist_m3u_name: Some("batch.m3u8".into()),
                    operands: pending
                        .iter()
                        .cloned()
                        .map(|url| Operand::Spotify { url })
                        .collect(),
                    audio_search: search,
                    saved_batch: saved.is_some(),
                    timeout_ms: Some(mode.maximum_ms().unwrap_or(0)),
                    ..Default::default()
                };
                tracing::debug!(
                    search = ?search,
                    tracks = pending.len(),
                    saved_metadata = request.saved_batch,
                    "Downloading spotDL batch"
                );
                let done = manifest
                    .entries
                    .iter()
                    .filter(|entry| !missing(entry))
                    .count();
                let expected = manifest.expected_count;
                let deadline = PlaylistDeadline::new(mode, None, Instant::now());
                let result = monitor_download(
                    context,
                    downloader,
                    &request,
                    Some(deadline),
                    end,
                    |mut update| {
                        update.expected = Some(expected);
                        update.downloaded = done + update.downloaded;
                        report(update)
                    },
                )
                .await;
                // The runner already enumerated staged audio, including on
                // timeout or a nonzero exit. Recover it without a second walk.
                let (files, track_errors, failure) = match result {
                    Ok(output) => (
                        output.files,
                        output.track_errors,
                        output.failure.map(execution_error),
                    ),
                    Err(TaskError::Cancelled) => return Err(TaskError::Cancelled),
                    Err(error) => (
                        cancel
                            .run_until_cancelled(scan_downloaded_audio_files(&directory))
                            .await
                            .ok_or(TaskError::Cancelled)?
                            .map_err(execution_error)?,
                        HashMap::new(),
                        Some(error),
                    ),
                };
                let staged: HashSet<_> = files
                    .iter()
                    .filter_map(|file| staged_recording_id(file).map(ToOwned::to_owned))
                    .collect();
                harvest(context, stage, files, manifest, &tagger).await?;
                let message = failure.as_ref().map(ToString::to_string);
                let batch_code = message.as_deref().and_then(downloader_failure_code);
                let mut transient = HashSet::new();
                let mut codes = HashSet::new();
                for entry in manifest
                    .entries
                    .iter_mut()
                    .filter(|entry| pending.contains(&entry.source.url))
                {
                    if entry.file_path.is_some() || entry.library_path.is_some() {
                        continue;
                    }
                    let id = entry.source.url.rsplit('/').next().unwrap_or_default();
                    let code = track_errors
                        .get(id)
                        .copied()
                        .or(batch_code.filter(|code| *code != "general"))
                        .or_else(|| staged.contains(id).then_some("recording-mismatch"))
                        .unwrap_or("general");
                    codes.insert(code);
                    if is_transient_provider_error(code) {
                        transient.insert(entry.source.url.clone());
                    }
                    entry.status = ImportEntryStatus::FailedDownload;
                    entry.error = Some(downloader_error_message(code).into());
                    entry.error_code = Some(code.into());
                }
                save(stage, manifest).await?;
                if codes.is_empty() {
                    break;
                }
                let common = (codes.len() == 1)
                    .then(|| codes.iter().next().copied())
                    .flatten();
                let retry_code = ["rate-limited", "provider-timeout", "provider-network"]
                    .into_iter()
                    .find(|code| codes.contains(code));
                let summary_code = batch_code
                    .filter(|code| *code != "general")
                    .or(common)
                    .or(retry_code);
                last_error = summary_code
                    .map(|code| {
                        execution_error(format!(
                            "spotDL failed ({code}): {}",
                            downloader_error_message(code)
                        ))
                    })
                    .or(failure)
                    .or(last_error);
                let fatal = matches!(
                    batch_code.or(common),
                    Some(
                        "provider-forbidden"
                            | "bot-challenge"
                            | "auth-required"
                            | "missing-js-runtime"
                            | "missing-downloader"
                            | "missing-converter"
                            | "downloader-dependency"
                            | "downloader-cache"
                    )
                );
                if fatal {
                    return Ok(last_error);
                }
                if let Some(code) = retry_code {
                    let downloaded = manifest
                        .entries
                        .iter()
                        .filter(|entry| !missing(entry))
                        .count();
                    if retries
                        .wait(context, end, code, |stage| {
                            report(DownloadTelemetry {
                                stage,
                                expected: Some(expected),
                                downloaded,
                                ..Default::default()
                            })
                        })
                        .await?
                    {
                        pending.retain(|url| transient.contains(url));
                        continue;
                    }
                    let whole_batch_failed =
                        pending.len() == chunk.len() && transient.len() == chunk.len();
                    if code == "rate-limited"
                        || (whole_batch_failed
                            && is_transient_provider_error(common.unwrap_or_default()))
                    {
                        return Ok(last_error);
                    }
                }
                break;
            }
        }
    }
    Ok(last_error)
}

pub(super) async fn publish(
    context: &TaskRunContext,
    journal: &PublicationJournal<'_>,
    stage: &Path,
    root: &Path,
    manifest: &mut ManifestDownload,
    tagger: &AudioTaggerService,
) -> Result<(), TaskError> {
    let mut files = HashMap::<String, (String, bool)>::new();
    let mut changed = 0;
    for index in 0..manifest.entries.len() {
        context.throw_if_cancelled()?;
        if index % 32 == 0 || context.is_paused() {
            context.checkpoint().await?;
        }
        let entry = &mut manifest.entries[index];
        if entry.library_path.is_some() {
            continue;
        }
        let Some(staged) = entry.file_path.as_deref() else {
            continue;
        };
        let result = match files.get(staged) {
            Some((path, requires_scan)) => Ok((path.clone(), true, *requires_scan)),
            None => publish_staged_track(
                root,
                stage,
                Path::new(staged),
                &entry.source,
                tagger,
                journal,
            )
            .await
            .and_then(|published| {
                navidrome_path(&published.path)
                    .map(|path| (path, published.reused, !published.reused))
                    .ok_or_else(|| std::io::Error::other("Invalid publication path"))
            }),
        };
        match result {
            Ok((path, reused, requires_scan)) => {
                entry.library_reused = reused;
                files.insert(staged.to_owned(), (path.clone(), requires_scan));
                entry.library_path = Some(path);
                entry.requires_scan = Some(requires_scan);
                entry.status = ImportEntryStatus::Downloaded;
                entry.error = None;
            }
            Err(error) => {
                tracing::warn!(job_id = journal.job_id, position = entry.position, %error, "Could not publish staged audio");
                entry.status = ImportEntryStatus::FailedTagging;
                entry.error = Some("Could not save audio to the shared music directory".into());
            }
        }
        changed += 1;
        if changed % 32 == 0 {
            save(stage, manifest).await?;
        }
    }
    save(stage, manifest).await
}

pub(super) async fn index<F>(
    context: &TaskRunContext,
    provider: &dyn MusicBackend,
    connection_id: &str,
    stage: &Path,
    root: &Path,
    manifest: &mut ManifestDownload,
    mut report: impl FnMut(usize) -> F,
) -> Result<(), TaskError>
where
    F: Future<Output = ()> + Send,
{
    if manifest.indexed_connection.as_deref() != Some(connection_id) {
        for entry in &mut manifest.entries {
            entry.provider_track_id = None;
        }
        manifest.indexed_connection = Some(connection_id.to_owned());
    }
    context.checkpoint().await?;
    let needs_scan = manifest
        .entries
        .iter()
        .any(|entry| entry.library_path.is_some() && entry.requires_scan != Some(false));
    let pending: HashSet<_> = manifest
        .entries
        .iter()
        .filter(|entry| entry.requires_scan != Some(false) || entry.provider_track_id.is_none())
        .filter_map(|entry| entry.library_path.as_deref())
        .collect();
    let reconcile = || async {
        provider
            .reconcile_imported_tracks(root, &pending)
            .await
            .map_err(|error| {
                execution_error(format!(
                    "Could not reconcile imported files in Navidrome: {error}"
                ))
            })
    };
    let mut matches = HashMap::new();
    if !pending.is_empty() {
        if !needs_scan {
            matches = reconcile().await?;
        }
        let scan = needs_scan || pending.iter().any(|path| !matches.contains_key(*path));
        tracing::debug!(
            paths = pending.len(),
            scan,
            "Reconciling acquisition files with Navidrome"
        );
        if scan {
            context.checkpoint().await?;
            provider
                .scan_library()
                .await
                .map_err(|error| execution_error(format!("Navidrome scan failed: {error}")))?;
            matches = reconcile().await?;
        }
    }
    let mut indexed = 0;
    let mut next_report = Instant::now();
    for index in 0..manifest.entries.len() {
        context.throw_if_cancelled()?;
        if index % 32 == 0 || context.is_paused() {
            context.checkpoint().await?;
        }
        let entry = &mut manifest.entries[index];
        let Some(path) = entry.library_path.clone() else {
            continue;
        };
        if entry.requires_scan != Some(false) || entry.provider_track_id.is_none() {
            if let Some(ImportedTrackMatch::Matched(id)) = matches.get(&path) {
                entry.provider_track_id = Some(id.clone());
                entry.requires_scan = Some(false);
                entry.status = ImportEntryStatus::Ready;
                entry.error = None;
                entry.error_code = None;
            } else {
                let (code, message) = if matches!(
                    matches.get(&path),
                    Some(ImportedTrackMatch::Ambiguous)
                ) {
                    (
                        "indexing-ambiguous",
                        format!(
                            "Navidrome reported multiple possible matches for {path}. Check the shared music mount and Report Real Path."
                        ),
                    )
                } else {
                    (
                        "indexing-failed",
                        format!(
                            "Navidrome did not index {path}. Check the shared music mount and Report Real Path."
                        ),
                    )
                };
                entry.status = ImportEntryStatus::FailedIndexing;
                entry.error = Some(message);
                entry.error_code = Some(code.into());
                entry.provider_track_id = None;
            }
        }
        if entry.provider_track_id.is_some() {
            indexed += 1;
        }
        if Instant::now() >= next_report {
            save(stage, manifest).await?;
            report(indexed).await;
            next_report = Instant::now() + std::time::Duration::from_secs(1);
        }
    }
    save(stage, manifest).await
}
