//! Opt-in acquisition from Deezer metadata and a verified YouTube Music recording.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::{fs, time::Instant};
use unicode_normalization::UnicodeNormalization;

use super::input::DeezerTarget;
use super::progress::{DownloadTelemetry, ProviderRetries};
use super::repository::{
    ImportEntry, ImportEntryStatus, ManifestDownload, SpotifyImportTrackMetadata,
};
use super::spotdl::{
    SpotDLDownloaderAdapter, SpotDLOutputFormat, classify_spotdl_error, downloader_error_message,
    downloader_failure_code,
};
use crate::db::DbPool;
use crate::tasks::{
    ProcessError, ProcessExecutionResult, ProcessOptions, TaskError, TaskRunContext,
};

const MAX_TRACKS: usize = 100;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const BRIDGE: &str = include_str!("catalog_audio.py");
type ProviderResult<T> = Result<T, &'static str>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct CatalogTrackDetails {
    track_number: Option<u32>,
    disc_number: Option<u32>,
    explicit: Option<bool>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct DeezerArtist {
    name: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct DeezerAlbum {
    id: u64,
    title: String,
    artist: DeezerArtist,
    release_date: Option<String>,
    cover_big: Option<String>,
    nb_tracks: Option<usize>,
    tracks: DeezerTracks,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct DeezerTracks {
    data: Vec<DeezerTrack>,
    next: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct DeezerTrack {
    id: u64,
    title: String,
    artist: DeezerArtist,
    album: Option<Box<DeezerAlbum>>,
    duration: u32,
    isrc: Option<String>,
    track_position: Option<u32>,
    disk_number: Option<u32>,
    explicit_lyrics: Option<bool>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Candidates {
    ambiguous: bool,
    tracks: Vec<Candidate>,
}

#[derive(Deserialize)]
struct Candidate {
    video_id: Option<String>,
    title: Option<String>,
    artists: Vec<String>,
    album: Option<String>,
    year: Option<String>,
    duration: Option<f64>,
    explicit: Option<bool>,
}

fn key(text: &str) -> String {
    text.nfkc()
        .flat_map(char::to_lowercase)
        .filter(|ch| ch.is_alphanumeric())
        .collect()
}

fn valid_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn edition_matches(entry: &ImportEntry, row: &Candidate) -> bool {
    row.year
        .as_ref()
        .zip(entry.source.year.as_ref())
        .is_none_or(|(a, b)| a == b)
        && row
            .explicit
            .zip(entry.catalog.as_ref().and_then(|meta| meta.explicit))
            .is_none_or(|(a, b)| a == b)
}

fn choose_video(entry: &ImportEntry, candidates: &Candidates) -> ProviderResult<String> {
    if candidates.ambiguous {
        return Err("catalog-ambiguous");
    }
    let source = &entry.source;
    let title = key(&source.title);
    let artist = key(&source.artist);
    let album = key(source.album.as_deref().unwrap_or_default());
    let tolerance = (source.duration * 0.02).clamp(2.0, 5.0);
    let mut ids = candidates
        .tracks
        .iter()
        .filter(|row| {
            row.title
                .as_deref()
                .is_some_and(|value| key(value) == title)
                && row.artists.iter().any(|value| key(value) == artist)
                && row
                    .album
                    .as_deref()
                    .is_some_and(|value| key(value) == album)
                && row
                    .duration
                    .is_some_and(|value| (value - source.duration).abs() <= tolerance)
                && edition_matches(entry, row)
        })
        .filter_map(|row| row.video_id.as_deref().filter(|id| valid_video_id(id)));
    let first = ids.next().ok_or("catalog-no-match")?;
    if ids.any(|id| id != first) {
        return Err("catalog-ambiguous");
    }
    Ok(first.to_owned())
}

fn failure(code: &str) -> TaskError {
    TaskError::ExecutionFailed(format!(
        "Deezer download failed ({code}): {}",
        downloader_error_message(code)
    ))
}

fn filesystem(error: impl std::fmt::Display) -> TaskError {
    tracing::debug!(%error, "Could not manage Deezer staging files");
    TaskError::ExecutionFailed("Could not prepare Deezer staging files".into())
}

pub(super) struct CatalogAudio<'a> {
    http: reqwest::Client,
    downloader: &'a SpotDLDownloaderAdapter,
    db: &'a DbPool,
    context: &'a TaskRunContext,
    stage: &'a Path,
    end: Instant,
    python: String,
    output_format: SpotDLOutputFormat,
    retries: ProviderRetries,
}

impl<'a> CatalogAudio<'a> {
    pub fn new(
        downloader: &'a SpotDLDownloaderAdapter,
        db: &'a DbPool,
        context: &'a TaskRunContext,
        stage: &'a Path,
        end: Instant,
    ) -> Result<Self, TaskError> {
        let output_format = downloader
            .output_format()
            .map_err(|error| TaskError::Validation(error.to_owned()))?;
        let http = reqwest::Client::builder()
            .user_agent("MusicDeck")
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| failure("provider-network"))?;
        let python = std::env::var("PYTHON_PATH").unwrap_or_else(|_| {
            if cfg!(windows) {
                "python".into()
            } else {
                "python3".into()
            }
        });
        Ok(Self {
            http,
            downloader,
            db,
            context,
            stage,
            end,
            python,
            output_format,
            retries: ProviderRetries::default(),
        })
    }

    async fn body(&self, url: &str) -> ProviderResult<Vec<u8>> {
        let classify = |error: reqwest::Error| {
            if error.is_timeout() {
                "provider-timeout"
            } else {
                "provider-network"
            }
        };
        let remaining = self.end.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("download-timeout");
        }
        let mut response = self
            .http
            .get(url)
            .timeout(remaining.min(Duration::from_secs(15)))
            .send()
            .await
            .map_err(classify)?;
        let status = response.status();
        if status.as_u16() == 429 {
            return Err("rate-limited");
        }
        if status.is_server_error() {
            return Err("provider-network");
        }
        if !status.is_success()
            || response
                .content_length()
                .is_some_and(|n| n > MAX_RESPONSE as u64)
        {
            return Err("catalog-unavailable");
        }
        let mut bytes = Vec::new();
        while let Some(part) = response.chunk().await.map_err(classify)? {
            if part.len() > MAX_RESPONSE - bytes.len() {
                return Err("catalog-unavailable");
            }
            bytes.extend_from_slice(&part);
        }
        Ok(bytes)
    }

    async fn deezer<T: serde::de::DeserializeOwned>(&self, path: &str) -> ProviderResult<T> {
        let body = self.body(&format!("https://api.deezer.com/{path}")).await?;
        let value: serde_json::Value =
            serde_json::from_slice(&body).map_err(|_| "catalog-unavailable")?;
        if let Some(error) = value.get("error") {
            return Err(if error["code"].as_u64() == Some(4) {
                "rate-limited"
            } else {
                "catalog-unavailable"
            });
        }
        serde_json::from_value(value).map_err(|_| "catalog-unavailable")
    }

    async fn process(
        &self,
        directory: &Path,
        args: &[String],
        otherwise: &'static str,
    ) -> Result<ProviderResult<ProcessExecutionResult>, TaskError> {
        let (runner, _, _) = self.downloader.catalog_tools();
        let remaining = self.end.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(Err("download-timeout"));
        }
        let mut options = ProcessOptions {
            cwd: Some(directory.into()),
            cancel_token: Some(self.context.cancel_token()),
            timeout_ms: Some(remaining.as_millis().clamp(1, 65_000) as u64),
            ..Default::default()
        };
        options
            .env
            .insert("PYTHONIOENCODING".into(), "utf-8".into());
        let result = runner.run(&self.python, args, options).await;
        Ok(match result {
            Err(ProcessError::Cancelled) => return Err(TaskError::Cancelled),
            Err(ProcessError::SpawnFailed { .. }) => Err("catalog-runtime"),
            Err(ProcessError::TimedOut(_)) => Err(if Instant::now() >= self.end {
                "download-timeout"
            } else {
                "provider-timeout"
            }),
            Err(_) => Err(otherwise),
            Ok(result) if result.exit_code == Some(0) => Ok(result),
            Ok(result) => {
                let details = format!("{}\n{}", result.stderr, result.stdout);
                let code = if details.contains("ModuleNotFoundError")
                    || details.contains("No module named yt_dlp")
                {
                    "catalog-runtime"
                } else {
                    match classify_spotdl_error(&details) {
                        "general" => otherwise,
                        code => code,
                    }
                };
                Err(code)
            }
        })
    }

    async fn search(
        &self,
        mode: &str,
        artist: &str,
        album: &str,
        title: &str,
    ) -> Result<ProviderResult<Candidates>, TaskError> {
        let args = ["-c", BRIDGE, mode, artist, album, title].map(str::to_owned);
        Ok(self
            .process(self.stage, &args, "catalog-unavailable")
            .await?
            .and_then(|output| {
                serde_json::from_str(&output.stdout).map_err(|_| "catalog-unavailable")
            }))
    }

    async fn album(&self, id: u64) -> ProviderResult<DeezerAlbum> {
        let mut album: DeezerAlbum = self.deezer(&format!("album/{id}")).await?;
        if album.id != id {
            return Err("catalog-unavailable");
        }
        if album.nb_tracks.is_some_and(|count| count > MAX_TRACKS) {
            return Err("catalog-limit");
        }
        if album.tracks.next.is_some()
            || album
                .nb_tracks
                .is_some_and(|n| n != album.tracks.data.len())
        {
            album.tracks = self
                .deezer(&format!("album/{id}/tracks?limit={MAX_TRACKS}"))
                .await?;
        }
        if album.tracks.next.is_some()
            || album
                .nb_tracks
                .is_some_and(|n| n != album.tracks.data.len())
        {
            return Err("catalog-unavailable");
        }
        Ok(album)
    }

    pub async fn discover(&self, targets: &[DeezerTarget]) -> Result<ManifestDownload, TaskError> {
        if targets.len() > MAX_TRACKS {
            return Err(failure("catalog-limit"));
        }
        let mut entries = Vec::new();
        let mut seen = HashSet::new();
        for target in targets {
            self.context.checkpoint().await?;
            let (album, tracks) = match *target {
                DeezerTarget::Track(id) => {
                    let mut track: DeezerTrack =
                        self.deezer(&format!("track/{id}")).await.map_err(failure)?;
                    if track.id != id {
                        return Err(failure("catalog-unavailable"));
                    }
                    let album = track
                        .album
                        .take()
                        .ok_or_else(|| failure("catalog-unavailable"))?;
                    // Single-track responses provide album art and release date, without the track list.
                    (*album, vec![track])
                }
                DeezerTarget::Album(id) => {
                    let mut album = self.album(id).await.map_err(failure)?;
                    let tracks = std::mem::take(&mut album.tracks.data);
                    (album, tracks)
                }
            };
            for (index, mut track) in tracks.into_iter().enumerate() {
                if matches!(target, DeezerTarget::Album(_)) {
                    track.track_position.get_or_insert(index as u32 + 1);
                }
                if !seen.insert(track.id) {
                    continue;
                }
                if entries.len() >= MAX_TRACKS {
                    return Err(failure("catalog-limit"));
                }
                entries.push(entry(&album, track, entries.len() + 1));
            }
        }
        if entries.is_empty() {
            return Err(failure("catalog-unavailable"));
        }
        Ok(ManifestDownload {
            expected_count: entries.len(),
            entries,
            name: None,
            indexed_connection: None,
        })
    }

    async fn cover(&self, url: &str) -> Option<PathBuf> {
        let parsed = url::Url::parse(url).ok()?;
        if parsed.scheme() != "https"
            || parsed.host_str() != Some("cdn-images.dzcdn.net")
                && parsed.host_str() != Some("cdns-images.dzcdn.net")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.port_or_known_default() != Some(443)
            || !parsed.path().starts_with("/images/cover/")
        {
            return None;
        }
        let bytes = self.body(url).await.ok()?;
        if !bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            return None;
        }
        let path = self
            .stage
            .join(format!("cover-{}.jpg", uuid::Uuid::new_v4().simple()));
        fs::write(&path, bytes).await.ok()?;
        Some(path)
    }

    async fn transfer(
        &self,
        item: &ImportEntry,
        id: &str,
        cover: Option<&Path>,
    ) -> Result<ProviderResult<PathBuf>, TaskError> {
        let work = tempfile::tempdir_in(self.stage).map_err(filesystem)?;
        let (_, ffmpeg, _) = self.downloader.catalog_tools();
        let format = self.output_format;
        let extension = format.container_arg();
        let quality = match format {
            SpotDLOutputFormat::Mp3 => format.bitrate_arg(),
            _ => "0",
        };
        let mut args: Vec<String> = [
            "-m",
            "yt_dlp",
            "--ignore-config",
            "--no-playlist",
            "--socket-timeout",
            "12",
            "--retries",
            "0",
            "--fragment-retries",
            "0",
            "--extractor-retries",
            "0",
            "--max-filesize",
            "100M",
            "-f",
            "bestaudio/best",
            "-x",
            "--audio-format",
            format.ytdlp_format_arg(),
            "--audio-quality",
            quality,
            "-o",
            "audio.%(ext)s",
        ]
        .map(str::to_owned)
        .into();
        let tool_name = |name: &str| {
            if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.to_owned()
            }
        };
        let converter = if ffmpeg != "ffmpeg" {
            Some(PathBuf::from(ffmpeg))
        } else {
            local_spotdl_tool(&tool_name("ffmpeg"))
        };
        if let Some(converter) = converter {
            args.extend([
                "--ffmpeg-location".into(),
                converter.to_string_lossy().into_owned(),
            ]);
        }
        if let Some(deno) = local_spotdl_tool(&tool_name("deno")) {
            args.extend(["--js-runtimes".into(), format!("deno:{}", deno.display())]);
        }
        args.extend([
            "--".into(),
            format!("https://music.youtube.com/watch?v={id}"),
        ]);
        if let Err(code) = self
            .process(work.path(), &args, "source-unavailable")
            .await?
        {
            return Ok(Err(code));
        }
        let filename = format!("audio.{extension}");
        let audio = work.path().join(&filename);
        if !fs::symlink_metadata(&audio)
            .await
            .is_ok_and(|meta| meta.is_file() && meta.len() > 0)
        {
            return Ok(Err("download-format-missing"));
        }
        let source = &item.source;
        let details = item.catalog.as_ref();
        let payload = serde_json::json!({
            "title": source.title, "artist": source.artist, "album": source.album,
            "album_artist": source.album_artist, "year": source.year, "isrc": source.isrc, "url": source.url,
            "track_number": details.and_then(|meta| meta.track_number),
            "disc_number": details.and_then(|meta| meta.disc_number),
        }).to_string();
        let args = [
            "-c".into(),
            BRIDGE.into(),
            "tag".into(),
            filename,
            payload,
            cover.map_or_else(String::new, |path| path.to_string_lossy().into_owned()),
        ];
        if let Err(code) = self.process(work.path(), &args, "catalog-tagging").await? {
            return Ok(Err(code));
        }
        let tagger = self.downloader.tagger();
        let Ok(tags) = tagger.inspect_recording(&audio).await else {
            return Ok(Err("catalog-tagging"));
        };
        if tags.source_url.as_deref() != Some(source.url.as_str())
            || (cover.is_some() && !tags.metadata.has_artwork)
            || !tags.duration.is_some_and(|duration| {
                (duration - source.duration).abs() <= (source.duration * 0.02).clamp(2.0, 5.0)
            })
        {
            return Ok(Err("recording-mismatch"));
        }
        let target = self
            .stage
            .join(format!("deezer-{}.{extension}", uuid::Uuid::new_v4().simple()));
        fs::rename(audio, &target).await.map_err(filesystem)?;
        Ok(Ok(target))
    }

    async fn video(
        &self,
        item: &ImportEntry,
        albums: &mut HashMap<(String, String), Candidates>,
    ) -> Result<ProviderResult<String>, TaskError> {
        let source = &item.source;
        let artist = source.album_artist.as_deref().unwrap_or(&source.artist);
        let album = source.album.as_deref().unwrap_or_default();
        let key = (artist.to_owned(), album.to_owned());
        let candidates = match albums.entry(key) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                match self.search("album", artist, album, "").await? {
                    Ok(candidates) => entry.insert(candidates),
                    Err(code) => return Ok(Err(code)),
                }
            }
        };
        let result = choose_video(item, candidates);
        if result != Err("catalog-no-match") {
            return Ok(result);
        }
        let conflicts: HashSet<_> = candidates
            .tracks
            .iter()
            .filter(|candidate| !edition_matches(item, candidate))
            .filter_map(|candidate| candidate.video_id.as_deref())
            .collect();
        Ok(self
            .search("song", &source.artist, album, &source.title)
            .await?
            .and_then(|mut candidates| {
                candidates.tracks.retain(|candidate| {
                    candidate
                        .video_id
                        .as_deref()
                        .is_none_or(|id| !conflicts.contains(id))
                });
                choose_video(item, &candidates)
            }))
    }

    async fn retry<F>(
        &mut self,
        code: &str,
        report: impl FnOnce(&'static str) -> F,
    ) -> Result<bool, TaskError>
    where
        F: Future<Output = ()>,
    {
        if matches!(
            code,
            "rate-limited" | "provider-forbidden" | "bot-challenge"
        ) {
            super::admission::note_provider_failure(self.db, code).await;
            return Ok(false);
        }
        self.retries
            .wait(self.context, self.end, code, report)
            .await
    }

    pub async fn acquire<F>(
        mut self,
        targets: &[DeezerTarget],
        cached: Option<ManifestDownload>,
        root: Option<&Path>,
        report: impl Fn(DownloadTelemetry) -> F,
    ) -> Result<(ManifestDownload, Option<TaskError>), TaskError>
    where
        F: Future<Output = ()> + Send,
    {
        let cancel = self.context.cancel_token();
        tokio::time::timeout_at(
            self.end,
            super::admission::wait_for_provider(self.db, &cancel, || {
                report(DownloadTelemetry {
                    stage: "provider_cooldown",
                    ..Default::default()
                })
            }),
        )
        .await
        .map_err(|_| failure("download-timeout"))?
        .map_err(|error| match error {
            ProcessError::Cancelled => TaskError::Cancelled,
            _ => failure("provider-network"),
        })?;
        let mut manifest = if let Some(manifest) = cached {
            manifest
        } else {
            loop {
                report(DownloadTelemetry {
                    stage: "discovering",
                    ..Default::default()
                })
                .await;
                match self.discover(targets).await {
                    Ok(manifest) => break manifest,
                    Err(error) => {
                        let message = error.to_string();
                        let code = downloader_failure_code(&message).unwrap_or("general");
                        if !self
                            .retry(code, |stage| {
                                report(DownloadTelemetry {
                                    stage,
                                    ..Default::default()
                                })
                            })
                            .await?
                        {
                            return Err(error);
                        }
                    }
                }
            }
        };
        let tagger = self.downloader.tagger();
        super::resume::prepare_existing(
            self.context,
            &tagger,
            self.db,
            self.stage,
            root,
            &mut manifest,
        )
        .await?;
        super::resume::save(self.stage, &manifest).await?;
        let mut covers = HashMap::new();
        let mut albums = HashMap::new();
        let mut last_error = None;
        let expected = manifest.expected_count;
        let mut ready = manifest
            .entries
            .iter()
            .filter(|e| e.library_path.is_some() || e.file_path.is_some())
            .count();
        for index in 0..manifest.entries.len() {
            self.context.checkpoint().await?;
            let item = &manifest.entries[index];
            if item.file_path.is_some()
                || item.library_path.is_some()
                || item.status == ImportEntryStatus::FailedMetadataMissing
            {
                continue;
            }
            let progress = |stage, downloaded| {
                report(DownloadTelemetry {
                    stage,
                    downloaded,
                    expected: Some(expected),
                    percent: Some(80.0 * downloaded as f64 / expected.max(1) as f64),
                    ..Default::default()
                })
            };
            let outcome = loop {
                if Instant::now() >= self.end {
                    break Err("download-timeout");
                }
                progress("download", ready).await;
                let result = match self.video(item, &mut albums).await? {
                    Ok(id) => {
                        let cover = if let Some(url) = item.source.artwork_url.as_deref() {
                            match covers.entry(url.to_owned()) {
                                std::collections::hash_map::Entry::Occupied(entry) => {
                                    entry.into_mut()
                                }
                                std::collections::hash_map::Entry::Vacant(entry) => {
                                    entry.insert(self.cover(url).await)
                                }
                            }
                            .as_deref()
                        } else {
                            None
                        };
                        self.transfer(item, &id, cover).await?
                    }
                    Err(code) => Err(code),
                };
                if let Err(code) = result {
                    if self.retry(code, |stage| progress(stage, ready)).await? {
                        continue;
                    }
                }
                break result;
            };
            let item = &mut manifest.entries[index];
            let stop = match outcome {
                Ok(file) => {
                    ready += 1;
                    item.file_path = Some(file.to_string_lossy().into_owned());
                    item.status = ImportEntryStatus::Downloaded;
                    item.error = None;
                    item.error_code = None;
                    false
                }
                Err(code) => {
                    item.status = ImportEntryStatus::FailedDownload;
                    item.error_code = Some(code.into());
                    item.error = Some(downloader_error_message(code).into());
                    last_error = Some(failure(code));
                    matches!(
                        code,
                        "rate-limited"
                            | "download-timeout"
                            | "provider-forbidden"
                            | "bot-challenge"
                            | "auth-required"
                            | "catalog-runtime"
                            | "missing-converter"
                            | "missing-js-runtime"
                    )
                }
            };
            super::resume::save(self.stage, &manifest).await?;
            if stop {
                break;
            }
        }
        Ok((manifest, last_error))
    }
}

fn entry(album: &DeezerAlbum, track: DeezerTrack, position: usize) -> ImportEntry {
    let ready = track.id > 0
        && track.duration > 0
        && !key(&track.title).is_empty()
        && !key(&track.artist.name).is_empty()
        && !key(&album.title).is_empty();
    let album_artist = if album.artist.name.is_empty() {
        track.artist.name.clone()
    } else {
        album.artist.name.clone()
    };
    ImportEntry {
        position,
        source: SpotifyImportTrackMetadata {
            position,
            url: format!("https://www.deezer.com/track/{}", track.id),
            title: track.title,
            artists: vec![track.artist.name.clone()],
            artist: track.artist.name,
            duration: f64::from(track.duration),
            album: Some(album.title.clone()),
            album_artist: Some(album_artist),
            year: album
                .release_date
                .as_deref()
                .and_then(|date| date.get(..4))
                .filter(|year| year.bytes().all(|b| b.is_ascii_digit()) && *year != "0000")
                .map(ToOwned::to_owned),
            artwork_url: album.cover_big.clone(),
            isrc: track.isrc,
        },
        status: if ready {
            ImportEntryStatus::Pending
        } else {
            ImportEntryStatus::FailedMetadataMissing
        },
        error: None,
        error_code: None,
        file_path: None,
        library_path: None,
        library_reused: false,
        provider_track_id: None,
        duplicate_of: None,
        requires_scan: None,
        catalog: Some(CatalogTrackDetails {
            track_number: track.track_position,
            disc_number: track.disk_number,
            explicit: track.explicit_lyrics,
        }),
    }
}

fn local_spotdl_tool(executable: &str) -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os(if cfg!(windows) {
        "USERPROFILE"
    } else {
        "HOME"
    })?);
    [
        home.join(".config/spotdl").join(executable),
        home.join(".spotdl").join(executable),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::{ProcessRunner, TaskDefinition, TaskManager, TaskStatus, TaskType};
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    fn recording(id: u64, title: &str, position: usize) -> ImportEntry {
        let album = DeezerAlbum {
            title: "Eden".into(),
            artist: DeezerArtist {
                name: "Sequin".into(),
            },
            release_date: Some("2016-02-15".into()),
            ..Default::default()
        };
        entry(
            &album,
            DeezerTrack {
                id,
                title: title.into(),
                artist: DeezerArtist {
                    name: "Sequin".into(),
                },
                duration: 215,
                explicit_lyrics: Some(false),
                ..Default::default()
            },
            position,
        )
    }

    fn candidate(id: &str, title: &str, duration: u32, year: &str) -> Value {
        json!({"video_id": id, "title": title, "artists":["Sequin"], "album":"Eden", "duration":duration, "year":year, "explicit": false})
    }

    #[test]
    fn requires_album_artist_version_duration_and_unambiguous_video() {
        let entry = recording(1, "Ellipse", 1);
        let mut tracks = vec![
            candidate("fixture0001", "Ellipse (Live)", 215, "2016"),
            candidate("fixture0002", "Ellipse", 190, "2016"),
            candidate("fixture0003", "Ellipse", 215, "2020"),
            candidate("fixture0004", "Ellipse", 214, "2016"),
        ];
        let parse =
            |tracks| serde_json::from_value::<Candidates>(json!({"tracks": tracks})).unwrap();
        assert_eq!(
            choose_video(&entry, &parse(tracks.clone())),
            Ok("fixture0004".into())
        );
        tracks.push(candidate("fixture0005", "Ellipse", 216, "2016"));
        assert_eq!(
            choose_video(&entry, &parse(tracks)),
            Err("catalog-ambiguous")
        );
    }

    #[derive(Default)]
    struct Fixture {
        rate_limited: AtomicBool,
        downloads: Mutex<Vec<(String, String, String)>>,
    }

    #[async_trait::async_trait]
    impl ProcessRunner for Fixture {
        async fn run(
            &self,
            _: &str,
            args: &[String],
            options: ProcessOptions,
        ) -> Result<ProcessExecutionResult, ProcessError> {
            let mut exit_code = Some(0);
            let mut stderr = String::new();
            let mut stdout = String::new();
            if args[0] == "-m" {
                assert_eq!(args[1], "yt_dlp");
                assert!(args.iter().any(|arg| arg == "--no-playlist"));
                let option = |name: &str| {
                    args.windows(2).find(|pair| pair[0] == name).unwrap()[1].as_str()
                };
                let format = option("--audio-format");
                let url = args.last().unwrap().to_owned();
                self.downloads.lock().unwrap().push((
                    url.clone(),
                    format.to_owned(),
                    option("--audio-quality").to_owned(),
                ));
                if url.ends_with("fixture0002") && self.rate_limited.swap(false, Ordering::SeqCst) {
                    exit_code = Some(1);
                    stderr = "HTTP Error 429: Too Many Requests".into();
                } else {
                    let path = options.cwd.unwrap().join(format!("audio.{format}"));
                    fs::write(path, b"simulated audio").await.unwrap();
                }
            } else if args[1] != BRIDGE {
                stdout = fs::read_to_string(args.last().unwrap()).await.unwrap();
            } else if args[2] == "tag" {
                let path = options.cwd.unwrap().join(&args[3]);
                assert_eq!(fs::read(&path).await.unwrap(), b"simulated audio");
                let info: Value = serde_json::from_str(&args[4]).unwrap();
                let tags = json!({"sourceUrl": info["url"], "duration": 215.0, "title": info["title"], "hasArtwork": false});
                fs::write(path, tags.to_string()).await.unwrap();
            } else {
                assert_eq!(args[2], "album");
                stdout = json!({"tracks":[
                    candidate("fixture0001", "Ellipse", 214, "2016"),
                    candidate("fixture0002", "SVU", 215, "2016"),
                    candidate("fixture0003", "Monolith", 215, "2016"),
                ]})
                .to_string();
            }
            Ok(ProcessExecutionResult {
                exit_code,
                stdout,
                stderr,
                signal: None,
            })
        }
    }

    struct Probe {
        db: DbPool,
        stage: PathBuf,
        fixture: Arc<Fixture>,
    }

    #[async_trait::async_trait]
    impl TaskDefinition for Probe {
        fn validate(&self, payload: &Value) -> bool {
            payload.is_object()
        }

        async fn run(&self, _: Value, context: TaskRunContext) -> Result<(), TaskError> {
            let downloader = SpotDLDownloaderAdapter::with_runner(self.fixture.clone())
                .with_saved_settings(Some(&self.db))
                .await;
            let cached = super::super::resume::load(&self.stage).await?;
            let (_, error) = CatalogAudio::new(
                &downloader,
                &self.db,
                &context,
                &self.stage,
                Instant::now() + Duration::from_secs(10),
            )?
            .acquire(&[], cached, None, |_| std::future::ready(()))
            .await?;
            error.map_or(Ok(()), Err)
        }
    }

    #[tokio::test]
    async fn catalog_batch_preserves_verified_tracks_and_stops_on_rate_limit() {
        let db = DbPool::connect_memory().await.unwrap();
        crate::db::run_migrations(&db, None).await.unwrap();
        sqlx::query(
            "INSERT INTO plugin_configs(plugin_id, enabled, config_json, permissions_json, updated_at)
             VALUES ('spotdl-downloader', 1, ?, '[]', CURRENT_TIMESTAMP)",
        )
        .bind(json!({"outputFormat": "mp3"}).to_string())
        .execute(db.inner())
        .await
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let stage = fs::canonicalize(directory.path()).await.unwrap();
        let initial = ManifestDownload {
            entries: vec![
                recording(1, "Ellipse", 1),
                recording(2, "SVU", 2),
                recording(3, "Monolith", 3),
            ],
            expected_count: 3,
            name: None,
            indexed_connection: None,
        };
        super::super::resume::save(&stage, &initial).await.unwrap();
        let fixture = Arc::new(Fixture::default());
        fixture.rate_limited.store(true, Ordering::SeqCst);
        let tasks = TaskManager::new(Some(db.clone()));
        tasks.initialize_tables().await;
        tasks.register(
            TaskType::SpotdlDownload,
            Arc::new(Probe {
                db: db.clone(),
                stage: stage.clone(),
                fixture: fixture.clone(),
            }),
        );
        let start = || tasks.enqueue(TaskType::SpotdlDownload, json!({}), "admin", None);
        let first = start().await.unwrap();
        let first = tasks
            .wait_for_settlement(&first.id, Duration::from_secs(6))
            .await
            .unwrap();
        assert_eq!(first.state, TaskStatus::Failed);
        let cached = super::super::resume::load(&stage).await.unwrap().unwrap();
        assert_eq!(cached.entries[0].status, ImportEntryStatus::Downloaded);
        assert_eq!(
            cached.entries[1].error_code.as_deref(),
            Some("rate-limited")
        );
        assert_eq!(cached.entries[2].status, ImportEntryStatus::Pending);
        let first_file = cached.entries[0].file_path.clone().unwrap();
        assert_eq!(Path::new(&first_file).extension().unwrap(), "mp3");
        assert_eq!(fixture.downloads.lock().unwrap().len(), 2);
        let until: i64 = sqlx::query_scalar(
            "SELECT blocked_until FROM acquisition_provider_cooldown WHERE provider='spotdl'",
        )
        .fetch_one(db.inner())
        .await
        .unwrap();
        assert!(until > chrono::Utc::now().timestamp_millis());
        sqlx::query("UPDATE acquisition_provider_cooldown SET blocked_until=0")
            .execute(db.inner())
            .await
            .unwrap();
        sqlx::query("UPDATE plugin_configs SET config_json=? WHERE plugin_id='spotdl-downloader'")
            .bind(json!({"outputFormat": " M4A "}).to_string())
            .execute(db.inner())
            .await
            .unwrap();
        let next = start().await.unwrap();
        let next = tasks
            .wait_for_settlement(&next.id, Duration::from_secs(6))
            .await
            .unwrap();
        assert_eq!(next.state, TaskStatus::Finished, "{:?}", next.error);
        let resumed = super::super::resume::load(&stage).await.unwrap().unwrap();
        assert_eq!(
            resumed.entries[0].file_path.as_deref(),
            Some(first_file.as_str())
        );
        for entry in &resumed.entries[1..] {
            assert_eq!(entry.status, ImportEntryStatus::Downloaded);
            assert_eq!(
                Path::new(entry.file_path.as_ref().unwrap()).extension().unwrap(),
                "m4a"
            );
        }
        assert_eq!(
            *fixture.downloads.lock().unwrap(),
            [
                ("fixture0001", "mp3", "320k"),
                ("fixture0002", "mp3", "320k"),
                ("fixture0002", "m4a", "0"),
                ("fixture0003", "m4a", "0"),
            ]
            .map(|(id, format, quality)| (
                format!("https://music.youtube.com/watch?v={id}"),
                format.to_owned(),
                quality.to_owned(),
            ))
        );
        tasks.close();
    }
}
