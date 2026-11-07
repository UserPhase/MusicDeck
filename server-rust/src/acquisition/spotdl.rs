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

use crate::tasks::{DefaultProcessRunner, ProcessError, ProcessOptions, ProcessRunner};

/// Shared on-disk relative path template for spotDL downloads and playlist imports.
pub const SPOTDL_LIBRARY_TEMPLATE: &str = "{artists}/{album}/{artists} - {title}.{output-ext}";

/// Supported spotDL output container formats (`SpotDLOutputFormat`).
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
            _ => Err(String::from("Choose a supported spotDL audio format")),
        }
    }

    /// Concrete container argument passed to `spotdl --format`.
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
    let re = Regex::new(r"^/(track|album|playlist)/([a-zA-Z0-9]{1,64})/?$").expect("valid regex");
    let caps = re
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
            return Ok(format!("https://www.youtube.com/watch?v={vid}"));
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

    let sc_path_re =
        Regex::new(r"^/[a-zA-Z0-9_-]+/[a-zA-Z0-9_/-]+/?$").expect("valid regex");
    let bc_path_re =
        Regex::new(r"^/(track|album)/[a-zA-Z0-9_-]+/?$").expect("valid regex");

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
            let forbidden_scheme = Regex::new(
                r"(?i)^[-/\\.]|[|\x00-\x1f\x7f]|[a-z][a-z0-9+.-]*://|(?:https?|file|ftp|sftp|data|gopher|spotify):",
            )
            .expect("valid regex");
            if q.is_empty() || q.len() > 2000 || forbidden_scheme.is_match(q) {
                return Err(AcquisitionValidationError);
            }
        }
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
    } else if lower.contains("metadata")
        || lower.contains("tagging")
        || lower.contains("applying tags")
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

    let pct_re = Regex::new(r"(\d{1,3}(?:\.\d+)?)%").expect("valid regex");
    if let Some(caps) = pct_re.captures(trimmed) {
        if let Ok(p) = caps[1].parse::<f64>() {
            if (0.0..=100.0).contains(&p) {
                progress.percent = Some(p.round());
                matched = true;
            }
        }
    }

    let speed_re =
        Regex::new(r"(?i)(\d+(?:\.\d+)?)\s*([kmgt]i?b)/s").expect("valid regex");
    if let Some(caps) = speed_re.captures(trimmed) {
        if let Some(bps) = parse_byte_size_with_unit(&caps[1], &caps[2]) {
            progress.speed_bytes_per_second = Some(bps);
            matched = true;
        }
    }

    let bytes_re = Regex::new(
        r"(?i)(\d+(?:\.\d+)?)\s*([kmgt]i?b)\s*/\s*(\d+(?:\.\d+)?)\s*([kmgt]i?b)",
    )
    .expect("valid regex");
    if let Some(caps) = bytes_re.captures(trimmed) {
        progress.bytes_downloaded = parse_byte_size_with_unit(&caps[1], &caps[2]);
        progress.total_bytes = parse_byte_size_with_unit(&caps[3], &caps[4]);
        matched = true;
    }

    if lower.starts_with("downloaded ") {
        progress.percent = Some(100.0);
        progress.stage = Some(String::from("processing"));
        matched = true;
    }

    if matched {
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
    if lower.contains("rate/request limit")
        || lower.contains("rate limit")
        || lower.contains("http 429")
        || lower.contains("too many requests")
    {
        "rate-limited"
    } else if lower.contains("sign in to confirm")
        || lower.contains("cookies")
        || lower.contains("login required")
        || lower.contains("age-restricted")
    {
        "auth-required"
    } else if lower.contains("no results found")
        || lower.contains("audioProviderError")
        || lower.contains("could not match")
    {
        "no-match"
    } else if lower.contains("ffmpeg") && (lower.contains("not found") || lower.contains("error")) {
        "ffmpeg-error"
    } else {
        "general"
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
    Process(#[from] ProcessError),
    #[error("{0}")]
    Download(String),
}

/// Adapter orchestrating `spotdl` CLI executions via [`ProcessRunner`].
#[derive(Clone)]
pub struct SpotDLDownloaderAdapter {
    spotdl_path: String,
    ffmpeg_path: String,
    output_format: SpotDLOutputFormat,
    runner: Arc<dyn ProcessRunner>,
    timeout_ms: u64,
    client_id: Option<String>,
    client_secret: Option<String>,
    cookie_file: Option<String>,
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
            output_format: SpotDLOutputFormat::Best,
            runner: Arc::new(DefaultProcessRunner::new()),
            timeout_ms: 300_000,
            client_id: None,
            client_secret: None,
            cookie_file: None,
        }
    }

    /// Creates a new [`SpotDLDownloaderAdapter`] with a custom [`ProcessRunner`].
    #[must_use]
    pub fn with_runner(runner: Arc<dyn ProcessRunner>) -> Self {
        let mut s = Self::new();
        s.runner = runner;
        s
    }

    /// Overrides the executable; otherwise `SPOTDL_PATH` or `spotdl` on PATH is used.
    #[must_use]
    pub fn with_spotdl_path(mut self, path: impl Into<String>) -> Self {
        self.spotdl_path = path.into();
        self
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
        self.output_format = output_format;
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
            (Some(m), None) => m,
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
        if request.broaden_audio_search {
            args.extend([
                String::from("soundcloud"),
                String::from("youtube"),
                String::from("youtube-music"),
            ]);
        } else {
            args.extend([String::from("youtube-music"), String::from("youtube")]);
        }

        args.extend([
            String::from("--id3-separator"),
            String::from("; "),
            String::from("--log-level"),
            String::from("DEBUG"),
            String::from("--output"),
            output_template,
        ]);
        args.extend(spotdl_format_args(self.output_format));
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
                String::from("--save-file"),
                String::from("musicdeck-source.spotdl"),
                String::from("--save-errors"),
                String::from("musicdeck-errors.txt"),
            ]);
        }

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

        args.extend([String::from("download"), target]);
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

    pub(crate) async fn download_checked<F>(
        &self,
        request: &TrackImportRequest,
        on_progress: F,
    ) -> Result<Vec<PathBuf>, SpotDLDownloadError>
    where
        F: Fn(AcquisitionProgress) + Send + Sync + 'static,
    {
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

        let res = self
            .runner
            .run(
                &self.spotdl_path,
                &args,
                ProcessOptions {
                    cwd: Some(request.output_directory.clone()),
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
            )
            .await?;

        if res.exit_code != Some(0) {
            let combined = format!("{}\n{}", res.stdout, res.stderr);
            let code = classify_spotdl_error(&combined);
            return Err(SpotDLDownloadError::Download(format!(
                "spotDL failed ({code}): exit {:?}",
                res.exit_code
            )));
        }

        let files = scan_downloaded_audio_files(&request.output_directory).await;
        if files.is_empty() {
            return Err(SpotDLDownloadError::Download(String::from(
                "spotDL exited successfully but produced no audio files",
            )));
        }
        Ok(files)
    }
}

async fn scan_downloaded_audio_files(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(curr) = stack.pop() {
        let Ok(mut rd) = tokio::fs::read_dir(&curr).await else {
            continue;
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let path = entry.path();
            let Ok(ft) = entry.file_type().await else {
                continue;
            };
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() && crate::audio::is_supported_audio_file(&path) {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}
