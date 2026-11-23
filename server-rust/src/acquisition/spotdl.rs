//! # SpotDL Downloader Adapter, URL Policy & Progress Stream Parser (`acquisition::spotdl`)
//!
//! Ports:
//! - `server/src/domain/spotdl-format.ts`:
//!   - [`SpotDLOutputFormat`] (`best | mp3 | flac | m4a | ogg | opus | wav`) and [`spotdl_format_args`]
//! - `server/src/domain/acquisition-url-policy.ts`:
//!   - [`canonical_spotify_url`], [`canonical_manual_acquisition_url`], [`validate_spotdl_request`]
//! - `server/src/domain/spotdl-downloader-adapter.ts`:
//!   - [`SPOTDL_LIBRARY_TEMPLATE`] (`"{artists}/{album}/{artists} - {title}.{output-ext}"`)
//!   - [`parse_spotdl_progress`]: Extracts `stage`, `percent`, `speed_bytes_per_second`,
//!     `bytes_downloaded`, and `total_bytes` from live `spotdl` stdout/stderr lines
//!   - [`classify_spotdl_error`] and [`SpotDLDownloaderAdapter`]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use regex::Regex;
use serde::{Deserialize, Serialize};
use url::Url;

use super::input::{Operand, supports_direct_manual};
use crate::db::DbPool;
use crate::services::privacy::{PrivacyCategory, PrivacyManager};
use crate::tasks::{DefaultProcessRunner, ProcessError, ProcessOptions, ProcessRunner};
use tokio_util::sync::CancellationToken;

/// Shared on-disk relative path template for spotDL downloads and playlist imports.
pub const SPOTDL_LIBRARY_TEMPLATE: &str =
    "{artists}/{album}/{artists} - {title} [{track-id}].{output-ext}";

/// Output containers shared by spotDL and the Deezer downloader.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SpotDLOutputFormat {
    #[default]
    Best,
    Mp3,
    Flac,
    M4a,
    Ogg,
    Opus,
    Wav,
}

impl SpotDLOutputFormat {
    /// Parses a format string (`"best" | "mp3" | "flac" | "m4a" | "ogg" | "opus" | "wav"`).
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
            return Ok(Self::Best);
        };
        match s.to_ascii_lowercase().as_str() {
            "best" => Ok(Self::Best),
            "mp3" => Ok(Self::Mp3),
            "flac" => Ok(Self::Flac),
            "m4a" => Ok(Self::M4a),
            "ogg" => Ok(Self::Ogg),
            "opus" => Ok(Self::Opus),
            "wav" => Ok(Self::Wav),
            _ => Err(String::from("Choose a supported download audio format")),
        }
    }

    pub(crate) fn from_plugin_config(config: &serde_json::Value) -> Result<Self, String> {
        match config.get("outputFormat") {
            None | Some(serde_json::Value::Null) => Ok(Self::default()),
            Some(serde_json::Value::String(format)) => Self::parse(Some(format)),
            Some(_) => Err(String::from("Choose a supported download audio format")),
        }
    }

    /// On-disk extension and concrete `spotdl --format` argument.
    #[must_use]
    pub const fn container_arg(self) -> &'static str {
        match self {
            Self::Best | Self::M4a => "m4a",
            Self::Mp3 => "mp3",
            Self::Flac => "flac",
            Self::Ogg => "ogg",
            Self::Opus => "opus",
            Self::Wav => "wav",
        }
    }

    pub(super) const fn ytdlp_format_arg(self) -> &'static str {
        match self {
            Self::Ogg => "vorbis",
            _ => self.container_arg(),
        }
    }

    /// Bitrate argument passed to `spotdl --bitrate`.
    #[must_use]
    pub const fn bitrate_arg(self) -> &'static str {
        match self {
            Self::Mp3 => "320k",
            Self::Ogg => "auto",
            _ => "disable",
        }
    }
}

/// Returns the `["--format", <container>, "--bitrate", <bitrate>]` CLI flags for `format`.
#[must_use]
pub fn spotdl_format_args(format: SpotDLOutputFormat) -> Vec<String> {
    vec![
        String::from("--format"),
        format.container_arg().to_owned(),
        String::from("--bitrate"),
        format.bitrate_arg().to_owned(),
    ]
}

/// Error returned when an acquisition URL or search query violates security policy.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Invalid or unsupported acquisition input")]
pub struct AcquisitionValidationError;

fn parse_safe_https_url(raw: &str) -> Result<Url, AcquisitionValidationError> {
    if raw.len() > 2048
        || !raw.starts_with("https://")
        || raw
            .bytes()
            .any(|b| b <= 0x1F || b == 0x7F || b == b' ' || b == b'\\' || b == b'|')
    {
        return Err(AcquisitionValidationError);
    }
    let parsed = Url::parse(raw).map_err(|_| AcquisitionValidationError)?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
    {
        return Err(AcquisitionValidationError);
    }
    let host = parsed.host_str().ok_or(AcquisitionValidationError)?;
    if host.ends_with('.') {
        return Err(AcquisitionValidationError);
    }
    Ok(parsed)
}

/// Validates and canonicalizes an `https://open.spotify.com/{track|album|playlist}/{id}` URL.
pub fn canonical_spotify_url(raw: &str) -> Result<String, AcquisitionValidationError> {
    let url = parse_safe_https_url(raw)?;
    if url.host_str() != Some("open.spotify.com") {
        return Err(AcquisitionValidationError);
    }
    static SPOTIFY_PATH: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(
            r"^/(?:intl-[a-zA-Z0-9-]+/)?(track|album|playlist|artist)/([a-zA-Z0-9]{1,64})/?$",
        )
        .expect("valid regex")
    });
    let caps = SPOTIFY_PATH
        .captures(url.path())
        .ok_or(AcquisitionValidationError)?;
    let kind = caps.get(1).unwrap().as_str();
    let id = caps.get(2).unwrap().as_str();
    Ok(format!("https://open.spotify.com/{kind}/{id}"))
}

/// Validates and canonicalizes a manual YouTube, SoundCloud, or Bandcamp acquisition URL.
pub fn canonical_manual_acquisition_url(raw: &str) -> Result<String, AcquisitionValidationError> {
    let url = parse_safe_https_url(raw)?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();

    let is_yt = matches!(
        host.as_str(),
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com"
    );
    let is_youtu_be = matches!(host.as_str(), "youtu.be" | "www.youtu.be");

    if is_yt || is_youtu_be {
        let id_re = Regex::new(r"^[a-zA-Z0-9_-]{1,100}$").expect("valid regex");
        let path_re =
            Regex::new(r"^/(shorts|live|embed)/([a-zA-Z0-9_-]{1,100})/?$").expect("valid regex");

        let video_id = if is_youtu_be {
            Some(url.path().trim_start_matches('/').to_owned())
        } else if url.path() == "/watch" {
            url.query_pairs()
                .find(|(k, _)| k == "v")
                .map(|(_, v)| v.into_owned())
        } else {
            path_re
                .captures(url.path())
                .and_then(|c| c.get(2))
                .map(|m| m.as_str().to_owned())
        };

        if let Some(vid) = video_id.filter(|v| id_re.is_match(v)) {
            let host = if host == "music.youtube.com" {
                "music.youtube.com"
            } else {
                "www.youtube.com"
            };
            return Ok(format!("https://{host}/watch?v={vid}"));
        }

        if is_yt && url.path() == "/playlist" {
            let list_re = Regex::new(r"^[a-zA-Z0-9_-]{1,150}$").expect("valid regex");
            if let Some((_, list_id)) = url.query_pairs().find(|(k, _)| k == "list") {
                if list_re.is_match(&list_id) {
                    return Ok(format!("https://www.youtube.com/playlist?list={list_id}"));
                }
            }
        }
        return Err(AcquisitionValidationError);
    }

    let is_soundcloud = matches!(
        host.as_str(),
        "soundcloud.com" | "www.soundcloud.com" | "m.soundcloud.com"
    );
    let bandcamp_re =
        Regex::new(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.bandcamp\.com$").expect("valid regex");
    let is_bandcamp = bandcamp_re.is_match(&host);

    let sc_path_re = Regex::new(r"^/[a-zA-Z0-9_-]+/[a-zA-Z0-9_/-]+/?$").expect("valid regex");
    let bc_path_re = Regex::new(r"^/(track|album)/[a-zA-Z0-9_-]+/?$").expect("valid regex");

    if (is_soundcloud && sc_path_re.is_match(url.path()))
        || (is_bandcamp && bc_path_re.is_match(url.path()))
    {
        return Ok(format!("https://{host}{}", url.path()));
    }

    Err(AcquisitionValidationError)
}

/// Request specification for acquiring a single track or playlist (`DownloadRequest` / `TrackImportRequest`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackImportRequest {
    pub spotify_track_url: Option<String>,
    pub spotify_track_id: Option<String>,
    pub source_url: Option<String>,
    pub query: Option<String>,
    pub output_directory: PathBuf,
    pub filename_template: Option<String>,
    pub playlist_m3u_name: Option<String>,
    pub broaden_audio_search: bool,
    pub timeout_ms: Option<u64>,
    #[serde(skip)]
    pub(crate) operands: Vec<Operand>,
    #[serde(skip)]
    pub(crate) saved_batch: bool,
    #[serde(skip)]
    pub(crate) audio_search: AudioSearch,
}

pub(super) const BATCH_INPUT: &str = "musicdeck-batch-input.spotdl";
pub(super) const OCCURRENCES_FILE: &str = "musicdeck-occurrences.spotdl";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum AudioSearch {
    #[default]
    Standard,
    Edition,
    SoundCloud,
}

/// Validates a [`TrackImportRequest`] against the acquisition URL & query security policy.
pub fn validate_spotdl_request(
    request: &TrackImportRequest,
) -> Result<(), AcquisitionValidationError> {
    if let Some(ref src) = request.source_url {
        canonical_manual_acquisition_url(src)?;
    }
    if let Some(ref sp_url) = request.spotify_track_url {
        canonical_spotify_url(sp_url)?;
    }
    if let Some(ref sp_id) = request.spotify_track_id {
        let id_re = Regex::new(r"^[a-zA-Z0-9]{1,64}$").expect("valid regex");
        if !id_re.is_match(sp_id) {
            return Err(AcquisitionValidationError);
        }
    }
    if let Some(ref raw_query) = request.query {
        let q = raw_query.trim();
        if q.starts_with("https://open.spotify.com/") {
            canonical_spotify_url(q)?;
        } else {
            validate_search_query(q)?;
        }
    }
    Ok(())
}

pub(super) fn validate_search_query(q: &str) -> Result<(), AcquisitionValidationError> {
    let forbidden = Regex::new(r"(?i)^[-/\\.]|[|\x00-\x1f\x7f]|[a-z][a-z0-9+.-]*://|(?:https?|file|ftp|sftp|data|gopher|spotify|album|artist|playlist):")
        .expect("valid regex");
    let lower = q.to_ascii_lowercase();
    if q.is_empty()
        || q.len() > 2000
        || forbidden.is_match(q)
        || lower.ends_with(".spotdl")
        || matches!(
            lower.as_str(),
            "saved"
                | "all-user-playlists"
                | "all-saved-playlists"
                | "all-user-followed-artists"
                | "all-user-saved-albums"
        )
    {
        return Err(AcquisitionValidationError);
    }
    Ok(())
}

/// Real-time download progress telemetry parsed from `spotdl` output (`AcquisitionProgress`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionProgress {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_downloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_bytes_per_second: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn parse_byte_size_with_unit(val_str: &str, unit_str: &str) -> Option<u64> {
    let val = val_str.parse::<f64>().ok()?;
    if !val.is_finite() || val < 0.0 {
        return None;
    }
    let u = unit_str.to_ascii_uppercase();
    let mult = if u.starts_with('K') {
        1024.0
    } else if u.starts_with('M') {
        1024.0 * 1024.0
    } else if u.starts_with('G') {
        1024.0 * 1024.0 * 1024.0
    } else if u.starts_with('T') {
        1024.0 * 1024.0 * 1024.0 * 1024.0
    } else {
        1.0
    };
    Some((val * mult).round() as u64)
}

/// Parses a single stdout/stderr line from `spotdl` into an [`AcquisitionProgress`] update.
///
/// Mirrors `parseSpotDLProgress(line)` in `server/src/domain/spotdl-downloader-adapter.ts`.
#[must_use]
pub fn parse_spotdl_progress(line: &str) -> Option<AcquisitionProgress> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    let mut progress = AcquisitionProgress::default();
    let mut matched = false;

    if lower.contains("converting") {
        progress.stage = Some(String::from("converting"));
        matched = true;
    } else if lower.contains("skipping") && lower.contains("(file already exists)") {
        progress.stage = Some(String::from("processing"));
        matched = true;
    } else if lower.contains("tagging")
        || lower.contains("applying tags")
        || lower.contains(": embedding")
    {
        progress.stage = Some(String::from("tagging"));
        matched = true;
    } else if lower.contains("downloading") {
        progress.stage = Some(String::from("downloading"));
        matched = true;
    } else if lower.contains("processing") {
        progress.stage = Some(String::from("processing"));
        matched = true;
    }

    static PERCENT: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"(\d{1,3}(?:\.\d+)?)%").expect("valid regex"));
    if let Some(caps) = PERCENT.captures(trimmed) {
        if let Ok(p) = caps[1].parse::<f64>() {
            if (0.0..=100.0).contains(&p) {
                progress.percent = Some(p.round());
                matched = true;
            }
        }
    }

    static SPEED: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"(?i)(\d+(?:\.\d+)?)\s*([kmgt]i?b)/s").expect("valid regex")
    });
    if let Some(caps) = SPEED.captures(trimmed) {
        if let Some(bps) = parse_byte_size_with_unit(&caps[1], &caps[2]) {
            progress.speed_bytes_per_second = Some(bps);
            matched = true;
        }
    }

    static BYTES: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"(?i)(\d+(?:\.\d+)?)\s*([kmgt]i?b)\s*/\s*(\d+(?:\.\d+)?)\s*([kmgt]i?b)")
            .expect("valid regex")
    });
    if let Some(caps) = BYTES.captures(trimmed) {
        progress.bytes_downloaded = parse_byte_size_with_unit(&caps[1], &caps[2]);
        progress.total_bytes = parse_byte_size_with_unit(&caps[3], &caps[4]);
        matched = true;
    }

    if lower.starts_with("downloaded ") {
        progress.percent = Some(100.0);
        progress.stage = Some(String::from("processing"));
        matched = true;
    }

    if matched || super::playlist_timeout::PlaylistProgress::from_log(trimmed).is_some() {
        progress.message = Some(trimmed.to_owned());
        Some(progress)
    } else {
        None
    }
}

/// Classifies a `spotdl` failure output into a canonical error code.
#[must_use]
pub fn classify_spotdl_error(output: &str) -> &'static str {
    let lower = output.to_ascii_lowercase();
    if [
        "rate/request limit",
        "rate limit",
        "too many requests",
        "http 429",
        "http error 429",
        "status code 429",
        "response [429]",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        "rate-limited"
    } else if [
        "confirm you\u{2019}re not a bot",
        "confirm you're not a bot",
        "confirm you are not a bot",
        "bot challenge",
        "captcha",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        "bot-challenge"
    } else if [
        "no supported javascript runtime",
        "no javascript runtime",
        "javascript runtime is required",
        "deno is not installed",
        "deno executable not found",
        "javascript challenge provider",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        "missing-js-runtime"
    } else if [
        "cookies are required",
        "use --cookies",
        "cookie file is invalid",
        "does not look like a netscape format cookies file",
        "could not find cookies database",
        "invalid_grant",
        "access token expired",
        "login required",
        "age-restricted",
        "http error 401",
        "invalid client",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        "auth-required"
    } else if [
        "http 403",
        "http error 403",
        "status code 403",
        "403 forbidden",
        "response [403]",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        "provider-forbidden"
    } else if [
        "ffmpeg not found",
        "ffmpeg was not found",
        "ffmpeg is not installed",
        "ffprobe and ffmpeg not found",
        "ffmpeg and ffprobe not found",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        "missing-converter"
    } else if [
        "no module named 'yt_dlp'",
        "no module named 'ytmusicapi'",
        "no module named 'spotipy'",
        "update yt-dlp",
        "yt-dlp is outdated",
        "unable to extract initial player response",
        "yt-dlp-ejs is not installed",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        "downloader-dependency"
    } else if [
        "permissionerror",
        "permission denied",
        "database is locked",
        "database disk image is malformed",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
        && [
            ".spotdl",
            "yt-dlp/cache",
            "yt-dlp\\cache",
            "cookie",
            "cache",
        ]
        .iter()
        .any(|pattern| lower.contains(pattern))
    {
        "downloader-cache"
    } else if [
        "timed out",
        "timeouterror",
        "readtimeout",
        "connecttimeout",
        "http error 504",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        "provider-timeout"
    } else if [
        "invalid data found when processing input",
        "error opening input",
        "moov atom not found",
        "invalid input",
        "error decoding",
        "invalid audio",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        "bad-media-input"
    } else if [
        "ffmpegerror",
        "ffmpeg exited",
        "ffmpeg conversion failed",
        "conversion failed",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        "ffmpeg-error"
    } else if [
        "no results found",
        "no match found",
        "could not match",
        "could not find audio for",
        "no audio source found",
        "no matching song",
        "no matches found",
        "no album matches found on spotify",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        "no-match"
    } else if [
        "requested format is not available",
        "video unavailable",
        "private video",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        "source-unavailable"
    } else if [
        "connection reset",
        "remote end closed connection",
        "connection refused",
        "temporary failure in name resolution",
        "name or service not known",
        "network is unreachable",
        "http error 502",
        "http error 503",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        "provider-network"
    } else {
        "general"
    }
}

pub(super) fn downloader_error_message(code: &str) -> &'static str {
    match code {
        "rate-limited" => {
            "The source provider is rate limiting downloads. Try again after the cooldown."
        }
        "bot-challenge" => {
            "The source provider returned a bot challenge. Check the downloader's runtime and sign-in configuration."
        }
        "missing-js-runtime" => {
            "The downloader could not find a supported JavaScript runtime for the source."
        }
        "auth-required" => "The source provider requires valid sign-in credentials or cookies.",
        "provider-forbidden" => {
            "The source provider refused the request (HTTP 403). Wait for the cooldown and check provider access before retrying."
        }
        "missing-converter" => "FFmpeg is missing or could not be found by the downloader.",
        "downloader-dependency" => {
            "The downloader has a missing or incompatible dependency. Update the server's spotDL and yt-dlp installation."
        }
        "downloader-cache" => {
            "The downloader could not access its cache or cookies. Check that the server can read the cookie file and write to the downloader cache."
        }
        "bad-media-input" => "The conversion tool could not open or decode the downloaded audio.",
        "ffmpeg-error" => "FFmpeg failed while converting the audio.",
        "no-match" => "The downloader could not match this recording to an audio source.",
        "catalog-unavailable" => {
            "Deezer did not return complete metadata for the requested release."
        }
        "catalog-limit" => "The Deezer downloader supports batches of up to 100 tracks.",
        "catalog-ambiguous" => {
            "Multiple YouTube Music recordings fit the Deezer metadata. Choose a specific source to avoid the wrong version."
        }
        "catalog-no-match" => {
            "YouTube Music did not return a recording matching the Deezer title, artist, album and duration."
        }
        "catalog-runtime" => {
            "The Deezer downloader needs Python with ytmusicapi, yt-dlp, and Mutagen installed. Check PYTHON_PATH."
        }
        "catalog-tagging" => "Could not write or verify Deezer audio tags.",
        "download-format-missing" => {
            "The downloader did not produce audio in the configured format."
        }
        "source-unavailable" => {
            "The matched recording or media format is unavailable from the source provider."
        }
        "recording-mismatch" => {
            "The downloaded audio could not be verified against the requested recording and duration."
        }
        "provider-network" => {
            "The downloader lost its connection to the source provider. Check the server's internet connection and retry."
        }
        "provider-timeout" => {
            "The source provider did not respond in time. Retry when the provider is reachable."
        }
        "missing-downloader" => {
            "The server could not launch spotDL. Check its configured executable path."
        }
        "download-timeout" => {
            "The download reached its time limit. Retry to resume missing tracks."
        }
        _ => "The downloader did not produce usable audio.",
    }
}

pub(super) fn downloader_failure_code(message: &str) -> Option<&str> {
    if message.starts_with("Failed to spawn process ") {
        return Some("missing-downloader");
    }
    message
        .split_once("spotDL failed (")
        .or_else(|| message.split_once("Deezer download failed ("))
        .and_then(|(_, suffix)| suffix.split_once("): "))
        .map(|(code, _)| code)
}

async fn error_by_track(
    output: &str,
    started: std::time::SystemTime,
) -> HashMap<String, &'static str> {
    static CONVERSION_LOG: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"ffmpeg_error_[0-9-]{19}\.txt").expect("valid regex")
    });
    let details: HashMap<_, _> = output.lines().filter_map(track_error_line).collect();
    let mut references = HashMap::new();
    for details in details.values() {
        if let Some(report) = CONVERSION_LOG.find(details) {
            *references.entry(report.as_str()).or_insert(0) += 1;
        }
    }
    let mut errors = HashMap::new();
    for (id, details) in details {
        let mut code = classify_spotdl_error(details);
        if code == "ffmpeg-error"
            && let Some(report) = CONVERSION_LOG.find(details)
            && references.get(report.as_str()) == Some(&1)
            && let Some(report_code) = read_conversion_code(report.as_str(), started).await
        {
            code = report_code;
        }
        errors.insert(id.to_owned(), code);
    }
    errors
}

fn track_error_line(line: &str) -> Option<(&str, &str)> {
    let (_, tail) = line.split_once("https://open.spotify.com/track/")?;
    let (id, details) = tail.split_once(" - ")?;
    (!id.is_empty() && id.len() <= 64 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        .then_some((id, details))
}

pub(super) async fn saved_track_errors(
    directory: &Path,
    started: std::time::SystemTime,
) -> HashMap<String, &'static str> {
    let path = directory.join("musicdeck-errors.txt");
    if !tokio::fs::symlink_metadata(&path).await.is_ok_and(|info| {
        info.is_file() && info.modified().is_ok_and(|modified| modified >= started)
    }) {
        return HashMap::new();
    }
    let output = super::playlist_files::read_playlist_artifact(&path)
        .await
        .unwrap_or_default();
    error_by_track(&output, started).await
}

async fn read_conversion_code(
    filename: &str,
    started: std::time::SystemTime,
) -> Option<&'static str> {
    let home = PathBuf::from(std::env::var_os(if cfg!(windows) {
        "USERPROFILE"
    } else {
        "HOME"
    })?);
    let mut root = home.join(".spotdl");
    if cfg!(target_os = "linux") {
        let xdg = home.join(".config/spotdl");
        if tokio::fs::metadata(&xdg)
            .await
            .is_ok_and(|info| info.is_dir())
        {
            root = xdg;
        }
    }
    let report = root.join("errors").join(filename);
    let info = tokio::fs::symlink_metadata(&report).await.ok()?;
    if !info.is_file() || info.len() > 128 * 1024 || info.modified().ok()? < started {
        return None;
    }
    let canonical = tokio::fs::canonicalize(&report).await.ok()?;
    let parent = tokio::fs::canonicalize(&home).await.ok()?;
    if !canonical.starts_with(parent) {
        return None;
    }
    let contents = super::playlist_files::read_playlist_artifact(&canonical)
        .await
        .ok()?;
    match classify_spotdl_error(&contents) {
        code @ ("bad-media-input" | "missing-converter") => Some(code),
        _ => None,
    }
}

/// Diagnostic probe result returned by [`SpotDLDownloaderAdapter::detect_binaries`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotDLDiagnosticResult {
    pub spotdl_installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spotdl_version: Option<String>,
    pub ffmpeg_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ffmpeg_version: Option<String>,
    pub spotdl_path: String,
    pub ffmpeg_path: String,
}

/// Internal distinction between subprocess failures and individual download failures.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SpotDLDownloadError {
    #[error(transparent)]
    Process(ProcessError),
    #[error("{0}")]
    Download(String),
    #[error("spotDL failed ({code}): {message}")]
    Classified {
        code: &'static str,
        message: &'static str,
    },
}

impl SpotDLDownloadError {
    fn classified(code: &'static str) -> Self {
        Self::Classified {
            code,
            message: downloader_error_message(code),
        }
    }
}

impl From<ProcessError> for SpotDLDownloadError {
    fn from(error: ProcessError) -> Self {
        match error {
            ProcessError::SpawnFailed { .. } => Self::classified("missing-downloader"),
            ProcessError::TimedOut(_) => Self::classified("download-timeout"),
            error => Self::Process(error),
        }
    }
}

/// Adapter orchestrating `spotdl` CLI executions via [`ProcessRunner`].
#[derive(Clone)]
pub struct SpotDLDownloaderAdapter {
    spotdl_path: String,
    ffmpeg_path: String,
    output_format: Result<SpotDLOutputFormat, String>,
    runner: Arc<dyn ProcessRunner>,
    timeout_ms: u64,
    client_id: Option<String>,
    client_secret: Option<String>,
    cookie_file: Option<String>,
    cookie_temp: Option<Arc<tempfile::TempPath>>,
    privacy: Option<PrivacyManager>,
    startup_error: Option<String>,
    cooldown_db: Option<DbPool>,
}

impl std::fmt::Debug for SpotDLDownloaderAdapter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpotDLDownloaderAdapter")
            .field("spotdl_path", &self.spotdl_path)
            .field("ffmpeg_path", &self.ffmpeg_path)
            .field("output_format", &self.output_format)
            .finish()
    }
}

impl Default for SpotDLDownloaderAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl SpotDLDownloaderAdapter {
    /// Creates a new [`SpotDLDownloaderAdapter`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            spotdl_path: std::env::var("SPOTDL_PATH").unwrap_or_else(|_| String::from("spotdl")),
            ffmpeg_path: std::env::var("FFMPEG_PATH").unwrap_or_else(|_| String::from("ffmpeg")),
            output_format: Ok(SpotDLOutputFormat::Best),
            runner: Arc::new(DefaultProcessRunner::new()),
            timeout_ms: 300_000,
            client_id: None,
            client_secret: None,
            cookie_file: None,
            cookie_temp: None,
            privacy: None,
            startup_error: None,
            cooldown_db: None,
        }
    }

    /// Creates a new [`SpotDLDownloaderAdapter`] with a custom [`ProcessRunner`].
    #[must_use]
    pub fn with_runner(runner: Arc<dyn ProcessRunner>) -> Self {
        let mut s = Self::new();
        s.runner = runner;
        s
    }

    pub(super) fn tagger(&self) -> crate::audio::AudioTaggerService {
        crate::audio::AudioTaggerService::with_runner(Arc::clone(&self.runner))
    }

    pub(super) fn catalog_tools(&self) -> (&dyn ProcessRunner, &str, Option<&PrivacyManager>) {
        (
            self.runner.as_ref(),
            &self.ffmpeg_path,
            self.privacy.as_ref(),
        )
    }

    pub(super) fn output_format(&self) -> Result<SpotDLOutputFormat, &str> {
        self.output_format.as_ref().copied().map_err(String::as_str)
    }

    /// Overrides the executable; otherwise `SPOTDL_PATH` or `spotdl` on PATH is used.
    #[must_use]
    pub fn with_spotdl_path(mut self, path: impl Into<String>) -> Self {
        self.spotdl_path = path.into();
        self
    }

    pub(crate) async fn with_saved_settings(mut self, db: Option<&DbPool>) -> Self {
        self.cooldown_db = db.cloned();
        if let Err(err) = self.load_settings(db).await {
            self.startup_error = Some(err);
        }
        self
    }

    async fn load_settings(&mut self, db: Option<&DbPool>) -> Result<(), String> {
        let Some(db) = db else {
            return Ok(());
        };
        let saved = sqlx::query_as::<_, (bool, String)>(
            "SELECT enabled, config_json FROM plugin_configs WHERE plugin_id = 'spotdl-downloader'",
        )
        .fetch_optional(db.inner())
        .await
        .map_err(|_| "Could not load downloader settings")
        .and_then(|row| {
            row.map(|(enabled, raw)| {
                serde_json::from_str::<serde_json::Value>(&raw)
                    .map(|config| (enabled, config))
                    .map_err(|_| "Invalid saved downloader settings")
            })
            .transpose()
        })
        .inspect_err(|error| {
            self.output_format = Err((*error).to_owned());
        })?;
        let Some((enabled, config)) = saved else {
            return Ok(());
        };
        self.output_format = SpotDLOutputFormat::from_plugin_config(&config);
        self.output_format().map_err(str::to_owned)?;
        if !enabled {
            return Err("The spotDL Downloader plugin is disabled".into());
        }
        let setting = |key: &str| {
            config[key]
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        if let Some(path) = setting("spotdlPath") {
            self.spotdl_path = executable_path(path)?;
        }
        if let Some(path) = setting("ffmpegPath") {
            self.ffmpeg_path = executable_path(path)?;
        }
        self.client_id = setting("clientId").map(str::to_owned);
        self.client_secret = setting("clientSecret").map(str::to_owned);
        if self.client_id.is_some() != self.client_secret.is_some() {
            return Err("Configure both Spotify client ID and client secret".into());
        }
        if let Some(cookies) = setting("youtubeCookies") {
            use std::io::Write as _;
            let mut file = tempfile::Builder::new()
                .prefix("musicdeck-cookies-")
                .tempfile()
                .map_err(|_| "Could not create a private spotDL cookie file")?;
            writeln!(file, "{cookies}").map_err(|_| "Could not write spotDL cookie file")?;
            let path = file.into_temp_path();
            self.cookie_file = Some(path.to_string_lossy().into_owned());
            self.cookie_temp = Some(Arc::new(path));
        }
        Ok(())
    }

    pub(crate) fn with_privacy(mut self, privacy: Option<PrivacyManager>) -> Self {
        self.privacy = privacy;
        self
    }

    pub(crate) fn tool_paths(&self) -> Result<(&str, &str), &str> {
        if let Some(error) = self.startup_error.as_deref() {
            return Err(error);
        }
        Ok((&self.spotdl_path, &self.ffmpeg_path))
    }

    /// Configures Spotify API credentials and output format.
    pub fn configure(
        &mut self,
        client_id: Option<String>,
        client_secret: Option<String>,
        cookie_file: Option<String>,
        output_format: SpotDLOutputFormat,
    ) {
        self.client_id = client_id;
        self.client_secret = client_secret;
        self.cookie_file = cookie_file;
        self.output_format = Ok(output_format);
    }

    /// Builds the `spotdl` command-line argument array for `request`.
    pub fn build_cli_args(
        &self,
        request: &TrackImportRequest,
    ) -> Result<Vec<String>, AcquisitionValidationError> {
        validate_spotdl_request(request)?;

        let manual_url = request
            .source_url
            .as_deref()
            .map(canonical_manual_acquisition_url)
            .transpose()?;
        let spotify_url = match (&request.spotify_track_url, &request.spotify_track_id) {
            (Some(u), _) => Some(canonical_spotify_url(u)?),
            (None, Some(id)) => Some(format!("https://open.spotify.com/track/{id}")),
            (None, None) => None,
        };

        let target = match (manual_url, spotify_url) {
            (Some(m), Some(s)) => format!("{m}|{s}"),
            (None, Some(s)) => s,
            (Some(m), None) if supports_direct_manual(&m) => m,
            (Some(_), None) => return Err(AcquisitionValidationError),
            (None, None) if !request.operands.is_empty() => String::new(),
            (None, None) => {
                let q = request
                    .query
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or(AcquisitionValidationError)?;
                if q.starts_with("https://open.spotify.com/") {
                    canonical_spotify_url(q)?
                } else {
                    q.to_owned()
                }
            }
        };

        let output_template = request.filename_template.clone().unwrap_or_else(|| {
            request
                .output_directory
                .join(SPOTDL_LIBRARY_TEMPLATE)
                .to_string_lossy()
                .into_owned()
        });

        let mut args = vec![String::from("--simple-tui"), String::from("--audio")];
        if request.audio_search == AudioSearch::SoundCloud {
            args.push("soundcloud".into());
        } else if request.broaden_audio_search {
            args.extend([
                String::from("soundcloud"),
                String::from("youtube"),
                String::from("youtube-music"),
            ]);
        } else {
            args.extend([String::from("youtube-music"), String::from("youtube")]);
        }
        if request.audio_search == AudioSearch::Edition {
            args.extend(["--search-query".into(), "{artist} - {title} {album}".into()]);
        }
        // Up to two acquisition jobs can run at once. Narrow fallback requests
        // also use fewer workers so hard-to-match tracks don't flood providers.
        let threads = if request.audio_search == AudioSearch::Standard {
            "3"
        } else {
            "2"
        };
        args.extend(["--threads".into(), threads.into()]);

        args.extend([
            String::from("--id3-separator"),
            String::from("; "),
            String::from("--log-level"),
            String::from("DEBUG"),
            String::from("--output"),
            output_template,
        ]);
        let format = self.output_format().map_err(|_| AcquisitionValidationError)?;
        args.extend(spotdl_format_args(format));
        args.extend([
            String::from("--detect-formats"),
            String::from("mp3"),
            String::from("flac"),
            String::from("m4a"),
            String::from("ogg"),
            String::from("opus"),
            String::from("wav"),
            String::from("--generate-lrc"),
            String::from("--overwrite"),
            String::from("skip"),
            String::from("--max-retries"),
            String::from("5"),
            String::from("--print-errors"),
        ]);

        if let Some(ref m3u) = request.playlist_m3u_name {
            let m3u_re = Regex::new(r"^[a-zA-Z0-9_-]+\.m3u8?$").expect("valid regex");
            if !m3u_re.is_match(m3u) {
                return Err(AcquisitionValidationError);
            }
            args.extend([
                String::from("--m3u"),
                m3u.clone(),
                String::from("--add-unavailable"),
            ]);
        }

        args.extend([
            "--save-file".into(),
            "musicdeck-source.spotdl".into(),
            "--save-errors".into(),
            "musicdeck-errors.txt".into(),
        ]);
        if self.ffmpeg_path != "ffmpeg" {
            args.extend([String::from("--ffmpeg"), self.ffmpeg_path.clone()]);
        }
        if let (Some(cid), Some(csec)) = (&self.client_id, &self.client_secret) {
            args.extend([
                String::from("--client-id"),
                cid.clone(),
                String::from("--client-secret"),
                csec.clone(),
            ]);
        }
        if let Some(ref cookie) = self.cookie_file {
            args.extend([String::from("--cookie-file"), cookie.clone()]);
        }

        args.push("download".into());
        if request.saved_batch {
            args.push(BATCH_INPUT.into());
        } else if request.operands.is_empty() {
            args.push(target);
        } else {
            for operand in &request.operands {
                args.push(
                    operand
                        .cli_value()
                        .map_err(|_| AcquisitionValidationError)?,
                );
            }
        }
        Ok(args)
    }

    /// Probes `spotdl --version` and `ffmpeg -version`.
    pub async fn detect_binaries(&self) -> SpotDLDiagnosticResult {
        let mut spotdl_installed = false;
        let mut spotdl_version = None;
        let mut ffmpeg_available = false;
        let mut ffmpeg_version = None;

        if let Ok(res) = self
            .runner
            .run(
                &self.spotdl_path,
                &[String::from("--version")],
                ProcessOptions {
                    timeout_ms: Some(5_000),
                    ..ProcessOptions::default()
                },
            )
            .await
        {
            if res.exit_code == Some(0) && !res.stdout.trim().is_empty() {
                spotdl_installed = true;
                spotdl_version = res.stdout.lines().next().map(|l| l.trim().to_owned());
            }
        }

        if let Ok(res) = self
            .runner
            .run(
                &self.ffmpeg_path,
                &[String::from("-version")],
                ProcessOptions {
                    timeout_ms: Some(5_000),
                    ..ProcessOptions::default()
                },
            )
            .await
        {
            if res.exit_code == Some(0) && !res.stdout.trim().is_empty() {
                ffmpeg_available = true;
                ffmpeg_version = res.stdout.lines().next().map(|l| l.trim().to_owned());
            }
        }

        SpotDLDiagnosticResult {
            spotdl_installed,
            spotdl_version,
            ffmpeg_available,
            ffmpeg_version,
            spotdl_path: self.spotdl_path.clone(),
            ffmpeg_path: self.ffmpeg_path.clone(),
        }
    }

    /// Exercises local conversion and the runtime dependencies without an upstream request.
    pub(crate) async fn probe_runtime(&self) -> (bool, bool, bool) {
        let options = || ProcessOptions {
            timeout_ms: Some(5_000),
            ..ProcessOptions::default()
        };
        let ffmpeg_args = [
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=8000:cl=mono",
            "-t",
            "0.05",
            "-c:a",
            "pcm_s16le",
            "-f",
            "null",
            "-",
        ]
        .map(str::to_owned);
        let python_args = ["-c", "import spotdl, yt_dlp, ytmusicapi, mutagen; from spotdl.utils.deno import is_deno_installed; raise SystemExit(0 if is_deno_installed() else 2)"]
            .map(str::to_owned);
        let deno_args = ["--version".to_owned()];
        let python = if cfg!(windows) { "python" } else { "python3" };
        let (converter, packages, deno) = tokio::join!(
            self.runner.run(&self.ffmpeg_path, &ffmpeg_args, options()),
            self.runner.run(python, &python_args, options()),
            self.runner.run("deno", &deno_args, options()),
        );
        let converter_ok = converter.is_ok_and(|result| result.exit_code == Some(0));
        let python_status = packages.ok().and_then(|result| result.exit_code);
        (
            converter_ok,
            matches!(python_status, Some(0 | 2)),
            python_status == Some(0) || deno.is_ok_and(|result| result.exit_code == Some(0)),
        )
    }

    /// Executes a `spotdl` download request, invoking `on_progress` as stdout/stderr lines arrive.
    pub async fn download<F>(
        &self,
        request: &TrackImportRequest,
        on_progress: F,
    ) -> Result<Vec<PathBuf>, String>
    where
        F: Fn(AcquisitionProgress) + Send + Sync + 'static,
    {
        self.download_checked(request, on_progress)
            .await
            .map_err(|err| err.to_string())
    }

    /// Resolves source metadata before any audio work starts.
    pub(super) async fn resolve_sources<F>(
        &self,
        request: &TrackImportRequest,
        cancel: CancellationToken,
        report_stage: impl Fn(&'static str) -> F,
    ) -> Result<String, SpotDLDownloadError>
    where
        F: std::future::Future<Output = ()>,
    {
        if let Some(error) = &self.startup_error {
            return Err(SpotDLDownloadError::Download(error.clone()));
        }
        let path = request.output_directory.join(OCCURRENCES_FILE);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(SpotDLDownloadError::Download(err.to_string())),
        }
        let mut args = self
            .build_cli_args(request)
            .map_err(|err| SpotDLDownloadError::Download(err.to_string()))?;
        let operation = args.len() - request.operands.len().max(1) - 1;
        args[operation] = "save".into();
        let save = args
            .iter()
            .position(|arg| arg == "--save-file")
            .expect("save-file argument");
        args[save + 1] = OCCURRENCES_FILE.into();
        // An empty list disables lyrics lookups during metadata discovery.
        args.insert(save, "--lyrics".into());
        if let Some(db) = &self.cooldown_db {
            super::admission::wait_for_provider(db, &cancel, || report_stage("provider_cooldown"))
                .await?;
        }
        report_stage("discovering").await;
        let run = self.runner.run(
            &self.spotdl_path,
            &args,
            ProcessOptions {
                cwd: Some(request.output_directory.clone()),
                cancel_token: Some(cancel),
                timeout_ms: Some(request.timeout_ms.unwrap_or(self.timeout_ms)),
                ..Default::default()
            },
        );
        let result = if let Some(privacy) = &self.privacy {
            privacy
                .run_external(PrivacyCategory::Imports, run)
                .await
                .map_err(|err| SpotDLDownloadError::Download(err.to_string()))??
        } else {
            run.await?
        };
        let code = classify_spotdl_error(&format!("{}\n{}", result.stdout, result.stderr));
        if result.exit_code != Some(0) {
            if let Some(db) = &self.cooldown_db {
                super::admission::note_provider_failure(db, code).await;
            }
            return Err(SpotDLDownloadError::classified(code));
        }
        match super::playlist_files::read_playlist_artifact(&path).await {
            Ok(json) => Ok(json),
            Err(_) => {
                if let Some(db) = &self.cooldown_db {
                    super::admission::note_provider_failure(db, code).await;
                }
                Err(if code == "general" {
                    SpotDLDownloadError::Download(
                        "spotDL did not return source track details. Check the playlist URL and server credentials.".into(),
                    )
                } else {
                    SpotDLDownloadError::classified(code)
                })
            }
        }
    }

    pub(crate) async fn download_checked<F>(
        &self,
        request: &TrackImportRequest,
        on_progress: F,
    ) -> Result<Vec<PathBuf>, SpotDLDownloadError>
    where
        F: Fn(AcquisitionProgress) + Send + Sync + 'static,
    {
        let output = self
            .download_with_cancel(request, CancellationToken::new(), on_progress)
            .await?;
        if let Some(error) = output.failure {
            return Err(error);
        }
        Ok(output.files)
    }

    pub(super) async fn download_with_cancel<F>(
        &self,
        request: &TrackImportRequest,
        cancel: CancellationToken,
        on_progress: F,
    ) -> Result<DownloadOutput, SpotDLDownloadError>
    where
        F: Fn(AcquisitionProgress) + Send + Sync + 'static,
    {
        if let Some(error) = &self.startup_error {
            return Err(SpotDLDownloadError::Download(error.clone()));
        }
        let args = self
            .build_cli_args(request)
            .map_err(|e| SpotDLDownloadError::Download(e.to_string()))?;
        tokio::fs::create_dir_all(&request.output_directory)
            .await
            .map_err(|e| SpotDLDownloadError::Download(e.to_string()))?;

        let cb_arc = Arc::new(on_progress);
        let cb_out = Arc::clone(&cb_arc);
        let cb_err = Arc::clone(&cb_arc);

        let mut env = HashMap::new();
        env.insert(String::from("COLUMNS"), String::from("240"));
        env.insert(String::from("NO_COLOR"), String::from("1"));

        if let Some(db) = &self.cooldown_db {
            super::admission::wait_for_provider(db, &cancel, || {
                cb_arc(AcquisitionProgress {
                    stage: Some("provider_cooldown".into()),
                    ..Default::default()
                });
                std::future::ready(())
            })
            .await?;
        }
        cb_arc(AcquisitionProgress {
            stage: Some("downloading".into()),
            ..Default::default()
        });
        let error_log = request.output_directory.join("musicdeck-errors.txt");
        match tokio::fs::remove_file(&error_log).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(SpotDLDownloadError::Download(
                    "Could not prepare downloader diagnostics in the staging directory".into(),
                ));
            }
        }
        let started = std::time::SystemTime::now();
        let work = self.runner.run(
            &self.spotdl_path,
            &args,
            ProcessOptions {
                cwd: Some(request.output_directory.clone()),
                cancel_token: Some(cancel),
                env,
                timeout_ms: Some(request.timeout_ms.unwrap_or(self.timeout_ms)),
                on_stdout_line: Some(Arc::new(move |line| {
                    if let Some(p) = parse_spotdl_progress(line) {
                        cb_out(p);
                    }
                })),
                on_stderr_line: Some(Arc::new(move |line| {
                    if let Some(p) = parse_spotdl_progress(line) {
                        cb_err(p);
                    }
                })),
                ..ProcessOptions::default()
            },
        );
        let res = if let Some(privacy) = &self.privacy {
            privacy
                .run_external(PrivacyCategory::Imports, work)
                .await
                .map_err(|err| SpotDLDownloadError::Download(err.to_string()))?
        } else {
            work.await
        };
        let saved_errors = super::playlist_files::read_playlist_artifact(&error_log)
            .await
            .unwrap_or_default();
        let (combined, exit_failed, process_failure) = match res {
            Ok(res) => (
                format!("{}\n{}\n{saved_errors}", res.stdout, res.stderr),
                res.exit_code != Some(0),
                None,
            ),
            Err(ProcessError::Cancelled) => return Err(ProcessError::Cancelled.into()),
            Err(error) => (saved_errors, true, Some(SpotDLDownloadError::from(error))),
        };
        let track_errors = error_by_track(&combined, started).await;
        let global = combined
            .lines()
            .filter(|line| track_error_line(line).is_none())
            .collect::<Vec<_>>()
            .join("\n");
        let mut code = classify_spotdl_error(&global);
        if let Some(&first) = track_errors.values().next() {
            if track_errors.values().all(|value| *value == first)
                && (code == "general" || (code == "ffmpeg-error" && first == "bad-media-input"))
            {
                code = first;
            }
        }
        if let Some(db) = &self.cooldown_db {
            let cooldown = ["rate-limited", "bot-challenge", "provider-forbidden"]
                .into_iter()
                .find(|category| {
                    (exit_failed && code == *category)
                        || track_errors.values().any(|value| value == category)
                });
            if let Some(category) = cooldown {
                super::admission::note_provider_failure(db, category).await;
            }
        }

        let files = scan_downloaded_audio_files(&request.output_directory)
            .await
            .map_err(|err| {
                SpotDLDownloadError::Download(format!("Could not read spotDL output: {err}"))
            })?;
        let failure = process_failure.or_else(|| {
            if exit_failed {
                Some(SpotDLDownloadError::classified(code))
            } else if files.is_empty()
                && (track_errors.is_empty() || request.playlist_m3u_name.is_none())
            {
                Some(if code == "general" {
                    SpotDLDownloadError::Download(
                        "spotDL exited successfully but produced no audio files".into(),
                    )
                } else {
                    SpotDLDownloadError::classified(code)
                })
            } else {
                None
            }
        });
        Ok(DownloadOutput {
            files,
            track_errors,
            failure,
        })
    }
}

pub(super) struct DownloadOutput {
    pub files: Vec<PathBuf>,
    pub track_errors: HashMap<String, &'static str>,
    pub failure: Option<SpotDLDownloadError>,
}

fn executable_path(raw: &str) -> Result<String, String> {
    let path = Path::new(raw);
    if path.is_absolute() || !raw.contains(['/', '\\']) {
        return Ok(raw.to_owned());
    }
    std::path::absolute(path)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|_| "Could not resolve configured tool path".into())
}

pub(super) async fn scan_downloaded_audio_files(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(curr) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&curr).await?;
        while let Some(entry) = rd.next_entry().await? {
            let path = entry.path();
            let ft = entry.file_type().await?;
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file()
                && crate::audio::is_supported_audio_file(&path)
                && entry.metadata().await?.len() > 0
            {
                found.push(path);
            }
        }
    }
    found.sort();
    Ok(found)
}

#[cfg(test)]
mod settings_tests {
    use super::*;

    #[test]
    fn shared_output_formats_normalize_to_downloader_arguments_and_extensions() {
        use serde_json::json;

        for (setting, extension, ytdlp_format) in [
            ("best", "m4a", "m4a"),
            (" M4A ", "m4a", "m4a"),
            ("mp3", "mp3", "mp3"),
            ("flac", "flac", "flac"),
            ("ogg", "ogg", "vorbis"),
            ("opus", "opus", "opus"),
            ("wav", "wav", "wav"),
        ] {
            let format = SpotDLOutputFormat::from_plugin_config(&json!({"outputFormat": setting}))
                .unwrap();
            assert_eq!(format.container_arg(), extension);
            assert_eq!(spotdl_format_args(format)[1], extension);
            assert_eq!(format.ytdlp_format_arg(), ytdlp_format);
        }
        for config in [
            json!({}),
            json!({"outputFormat": null}),
            json!({"outputFormat": " "}),
        ] {
            assert_eq!(
                SpotDLOutputFormat::from_plugin_config(&config),
                Ok(SpotDLOutputFormat::Best)
            );
        }
        for invalid in [json!("aac"), json!(320)] {
            assert!(
                SpotDLOutputFormat::from_plugin_config(&json!({"outputFormat": invalid})).is_err()
            );
        }
    }

    #[tokio::test]
    async fn saved_plugin_configuration_supplies_downloader_arguments() {
        let db = DbPool::connect_memory().await.unwrap();
        crate::db::run_migrations(&db, None).await.unwrap();
        let settings = serde_json::json!({
            "spotdlPath": "fixture-downloader",
            "ffmpegPath": "fixture-ffmpeg",
            "outputFormat": "mp3",
            "clientId": "fixture-client",
            "clientSecret": "fixture-secret",
            "youtubeCookies": "# Netscape HTTP Cookie File"
        });
        sqlx::query(
            "INSERT INTO plugin_configs(plugin_id,enabled,config_json,permissions_json,updated_at)
            VALUES ('spotdl-downloader',1,?,'[]',CURRENT_TIMESTAMP)",
        )
        .bind(settings.to_string())
        .execute(db.inner())
        .await
        .unwrap();
        let adapter = SpotDLDownloaderAdapter::new()
            .with_saved_settings(Some(&db))
            .await;
        assert_eq!(adapter.output_format(), Ok(SpotDLOutputFormat::Mp3));
        assert_eq!(
            adapter.tool_paths(),
            Ok(("fixture-downloader", "fixture-ffmpeg"))
        );
        let args = adapter
            .build_cli_args(&TrackImportRequest {
                spotify_track_url: Some("https://open.spotify.com/track/FixtureTrack".into()),
                output_directory: PathBuf::from("fixture"),
                ..Default::default()
            })
            .unwrap();
        let option = |name: &str| {
            args.windows(2)
                .find(|pair| pair[0] == name)
                .map(|pair| pair[1].as_str())
        };
        for (name, value) in [
            ("--format", "mp3"),
            ("--bitrate", "320k"),
            ("--ffmpeg", "fixture-ffmpeg"),
            ("--client-id", "fixture-client"),
            ("--client-secret", "fixture-secret"),
            ("--save-file", "musicdeck-source.spotdl"),
            ("--save-errors", "musicdeck-errors.txt"),
        ] {
            assert_eq!(option(name), Some(value));
        }
        let cookie = PathBuf::from(option("--cookie-file").unwrap());
        assert_eq!(
            std::fs::read_to_string(&cookie).unwrap().trim(),
            "# Netscape HTTP Cookie File"
        );
        drop(adapter);
        assert!(!cookie.exists());

        sqlx::query("UPDATE plugin_configs SET enabled=0 WHERE plugin_id='spotdl-downloader'")
            .execute(db.inner())
            .await
            .unwrap();
        let disabled = SpotDLDownloaderAdapter::new()
            .with_saved_settings(Some(&db))
            .await;
        assert!(disabled.tool_paths().is_err());
        assert_eq!(disabled.output_format(), Ok(SpotDLOutputFormat::Mp3));
    }
}
