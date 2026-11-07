//! # Audio Container Tag Inspection & Atomic Metadata Repair (`audio::tagger`)
//!
//! Ports `server/src/services/media/audioTaggerService.ts`:
//! - [`CanonicalAudioMetadata`] and [`AudioTagMetadata`] (`AudioTagInspection`)
//! - [`is_supported_audio_file`], [`is_invalid_artist`], [`is_placeholder_album_artist`],
//!   and [`needs_metadata_repair`]
//! - [`AudioTaggerService`]:
//!   - Inspects ID3v2, MP4 (`©nam`/`©ART`/`covr`), FLAC, and Vorbis/Opus tags via `ffprobe`
//!     or Mutagen (`NATIVE_TAG_INSPECT`)
//!   - Atomically repairs missing or placeholder metadata in a temporary staging file,
//!     verifies untouched frames/pictures, flushes to disk, and renames over the target

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::audio::loudness::safe_music_path;
use crate::tasks::{DefaultProcessRunner, ProcessOptions, ProcessRunner};

/// Supported audio container file extensions for metadata inspection & repair.
pub const SUPPORTED_AUDIO_EXTENSIONS: [&str; 7] =
    ["mp3", "flac", "m4a", "mp4", "ogg", "opus", "wav"];

/// Returns `true` if `file_path` has a supported audio container extension.
#[must_use]
pub fn is_supported_audio_file(file_path: &Path) -> bool {
    let Some(ext) = file_path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let lower = ext.to_ascii_lowercase();
    SUPPORTED_AUDIO_EXTENSIONS.contains(&lower.as_str())
}

fn normalize_nfkc_lower(value: &str) -> String {
    value.nfkc().collect::<String>().trim().to_lowercase()
}

fn clean_str(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn extract_four_digit_year(value: Option<&str>) -> Option<String> {
    let raw = value?;
    let re = Regex::new(r"\b(\d{4})\b").expect("valid regex");
    re.captures(raw)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_owned())
}

/// Returns `true` if `value` is empty or a generic placeholder artist (`"unknown"`, `"unknown artist"`, `"various artists"`).
#[must_use]
pub fn is_invalid_artist(value: Option<&str>) -> bool {
    let Some(raw) = value else {
        return true;
    };
    let norm = normalize_nfkc_lower(raw);
    norm.is_empty()
        || matches!(
            norm.as_str(),
            "unknown" | "unknown artist" | "<unknown>" | "various" | "various artists" | "va"
        )
}

/// Returns `true` if `value` is a generic placeholder album artist (`"unknown"`, `"unknown artist"`).
#[must_use]
pub fn is_placeholder_album_artist(value: Option<&str>) -> bool {
    let Some(raw) = value else {
        return false;
    };
    let norm = normalize_nfkc_lower(raw);
    matches!(norm.as_str(), "unknown" | "unknown artist" | "<unknown>")
}

/// Canonical expected track metadata used to verify or repair an audio file's embedded tags.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalAudioMetadata {
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    #[serde(default)]
    pub album_artist: Option<String>,
    #[serde(default)]
    pub year: Option<String>,
    #[serde(default)]
    pub isrc: Option<String>,
    #[serde(default)]
    pub artwork_url: Option<String>,
}

/// Inspected embedded audio tag metadata (`AudioTagInspection` / `AudioTagMetadata`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTagMetadata {
    pub artist: Option<String>,
    pub album_artist: Option<String>,
    pub title: Option<String>,
    pub album: Option<String>,
    pub year: Option<String>,
    pub isrc: Option<String>,
    pub has_artwork: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artwork_hashes: Option<Vec<String>>,
}

fn tag_matches(actual: Option<&str>, expected: Option<&str>) -> bool {
    let Some(exp) = clean_str(expected) else {
        return true;
    };
    let Some(act) = clean_str(actual) else {
        return false;
    };
    normalize_nfkc_lower(&act) == normalize_nfkc_lower(&exp)
}

/// Determines whether `tags` requires repair to match `expected` (`server/src/services/media/audioTaggerService.ts`).
#[must_use]
pub fn needs_metadata_repair(
    tags: &AudioTagMetadata,
    expected: &CanonicalAudioMetadata,
) -> bool {
    let expected_artists: Vec<String> = expected
        .artists
        .iter()
        .map(|a| a.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();

    let actual_artists: Vec<String> = tags
        .artist
        .as_deref()
        .unwrap_or("")
        .split(';')
        .flat_map(|part| part.split(" / "))
        .map(normalize_nfkc_lower)
        .filter(|s| !s.is_empty())
        .collect();

    let expected_year = extract_four_digit_year(expected.year.as_deref());
    let actual_year = extract_four_digit_year(tags.year.as_deref());

    let expected_album_artist = clean_str(expected.album_artist.as_deref())
        .or_else(|| expected_artists.first().cloned());

    is_invalid_artist(tags.artist.as_deref())
        || expected_artists
            .iter()
            .any(|artist| !actual_artists.contains(&normalize_nfkc_lower(artist)))
        || !tag_matches(tags.title.as_deref(), Some(&expected.title))
        || !tag_matches(tags.album.as_deref(), Some(&expected.album))
        || !tag_matches(
            tags.album_artist.as_deref(),
            expected_album_artist.as_deref(),
        )
        || is_placeholder_album_artist(tags.album_artist.as_deref())
        || (expected_year.is_some()
            && !tag_matches(actual_year.as_deref(), expected_year.as_deref()))
        || (clean_str(expected.isrc.as_deref()).is_some()
            && !tag_matches(tags.isrc.as_deref(), expected.isrc.as_deref()))
        || (clean_str(expected.artwork_url.as_deref()).is_some() && !tags.has_artwork)
}

/// Embedded Python Mutagen inspection script (`NATIVE_TAG_INSPECT`).
pub const NATIVE_TAG_INSPECT: &str = r#"
import sys, json, base64, hashlib
from mutagen import File
from mutagen.id3 import ID3
from mutagen.flac import Picture
filename = sys.argv[1]
audio = File(filename)
if audio is None: raise RuntimeError('Unsupported or invalid audio file')
tags = audio.tags or {}
def value(*keys):
    for key in keys:
        try: item = tags.get(key)
        except (KeyError, ValueError): continue
        if item is None: continue
        item = getattr(item, 'text', item)
        if not isinstance(item, (list, tuple)): item = [item]
        values = [v.decode('utf-8', 'replace') if isinstance(v, bytes) else str(v) for v in item]
        result = '; '.join(v.strip() for v in values if v.strip())
        if result: return result
    return None
if isinstance(tags, ID3):
    image_data = [frame.data for frame in tags.getall('APIC')]
elif getattr(audio, 'pictures', None):
    image_data = [picture.data for picture in audio.pictures]
elif tags.get('covr'):
    image_data = [bytes(image) for image in tags.get('covr')]
elif tags.get('metadata_block_picture'):
    image_data = []
    for encoded in tags.get('metadata_block_picture'):
        try: image_data.append(Picture(base64.b64decode(encoded)).data)
        except (ValueError, TypeError): pass
else:
    image_data = []
artwork = [hashlib.sha256(data).hexdigest() for data in image_data if data]
print(json.dumps({
    'artist': value('TPE1', '\xa9ART', 'artist'),
    'albumArtist': value('TPE2', 'aART', 'albumartist', 'album_artist'),
    'title': value('TIT2', '\xa9nam', 'title'),
    'album': value('TALB', '\xa9alb', 'album'),
    'year': value('TDRC', 'TYER', '\xa9day', 'date', 'year'),
    'isrc': value('TSRC', '----:com.apple.iTunes:ISRC', '----:spotdl:ISRC', 'isrc'),
    'hasArtwork': bool(artwork),
    'artworkHashes': artwork
}))
"#;

/// Service inspecting and repairing embedded audio tags across MP3, FLAC, M4A/MP4, OGG, Opus, and WAV containers.
#[derive(Clone)]
pub struct AudioTaggerService {
    runner: Arc<dyn ProcessRunner>,
    ffprobe_bin: String,
    ffmpeg_bin: String,
    python_bin: String,
}

impl std::fmt::Debug for AudioTaggerService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioTaggerService")
            .field("ffprobe_bin", &self.ffprobe_bin)
            .field("python_bin", &self.python_bin)
            .finish()
    }
}

impl Default for AudioTaggerService {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioTaggerService {
    /// Creates a new [`AudioTaggerService`].
    #[must_use]
    pub fn new() -> Self {
        let ffmpeg_bin = std::env::var("FFMPEG_PATH").unwrap_or_else(|_| String::from("ffmpeg"));
        let ffprobe_bin = std::env::var("FFPROBE_PATH").unwrap_or_else(|_| String::from("ffprobe"));
        let python_bin = std::env::var("PYTHON_PATH").unwrap_or_else(|_| {
            if cfg!(windows) {
                String::from("python")
            } else {
                String::from("python3")
            }
        });
        Self {
            runner: Arc::new(DefaultProcessRunner::new()),
            ffprobe_bin,
            ffmpeg_bin,
            python_bin,
        }
    }

    /// Creates a new [`AudioTaggerService`] with a custom [`ProcessRunner`].
    #[must_use]
    pub fn with_runner(runner: Arc<dyn ProcessRunner>) -> Self {
        let mut s = Self::new();
        s.runner = runner;
        s
    }

    /// Inspects embedded tags in `file_path` using `ffprobe` (or native Mutagen for `.ogg`/`.opus`).
    pub async fn inspect(&self, file_path: &Path) -> Result<AudioTagMetadata, String> {
        if !is_supported_audio_file(file_path) {
            return Err(String::from(
                "Unsupported audio container for metadata inspection",
            ));
        }

        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "ogg" || ext == "opus" {
            return self.inspect_native(file_path).await;
        }

        let args = vec![
            String::from("-v"),
            String::from("error"),
            String::from("-show_entries"),
            String::from("format_tags:stream=codec_type:stream_disposition=attached_pic"),
            String::from("-of"),
            String::from("json"),
            file_path.to_string_lossy().into_owned(),
        ];

        match self
            .runner
            .run(
                &self.ffprobe_bin,
                &args,
                ProcessOptions {
                    timeout_ms: Some(15_000),
                    ..ProcessOptions::default()
                },
            )
            .await
        {
            Ok(res) if res.exit_code == Some(0) => Self::parse_ffprobe_json(&res.stdout),
            Ok(res) => Err(format!(
                "Could not inspect audio metadata: {}",
                res.stderr.trim()
            )),
            Err(_) => self.inspect_native(file_path).await,
        }
    }

    /// Parses the JSON output of `ffprobe -show_entries format_tags:stream=codec_type:stream_disposition=attached_pic`.
    pub fn parse_ffprobe_json(stdout: &str) -> Result<AudioTagMetadata, String> {
        let parsed: Value = serde_json::from_str(stdout)
            .map_err(|_| String::from("Invalid ffprobe JSON output"))?;

        let mut lower_tags: HashMap<String, String> = HashMap::new();
        if let Some(obj) = parsed
            .get("format")
            .and_then(|f| f.get("tags"))
            .and_then(Value::as_object)
        {
            for (k, v) in obj {
                if let Some(s) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    lower_tags.insert(k.to_ascii_lowercase(), s.to_owned());
                }
            }
        }

        let lookup = |keys: &[&str]| -> Option<String> {
            keys.iter()
                .find_map(|k| lower_tags.get(&k.to_ascii_lowercase()).cloned())
        };

        let has_artwork = parsed
            .get("streams")
            .and_then(Value::as_array)
            .is_some_and(|streams| {
                streams.iter().any(|s| {
                    s.get("disposition")
                        .and_then(|d| d.get("attached_pic"))
                        .and_then(Value::as_i64)
                        == Some(1)
                })
            });

        Ok(AudioTagMetadata {
            artist: lookup(&["artist", "tpe1"]),
            album_artist: lookup(&["album_artist", "albumartist", "tpe2"]),
            title: lookup(&["title", "tit2"]),
            album: lookup(&["album", "talb"]),
            year: lookup(&["date", "year", "tdrc", "tyer"]),
            isrc: lookup(&["isrc", "tsrc", "----:com.apple.itunes:isrc"]),
            has_artwork,
            artwork_hashes: None,
        })
    }

    async fn inspect_native(&self, file_path: &Path) -> Result<AudioTagMetadata, String> {
        let args = vec![
            String::from("-c"),
            String::from(NATIVE_TAG_INSPECT),
            file_path.to_string_lossy().into_owned(),
        ];
        let res = self
            .runner
            .run(
                &self.python_bin,
                &args,
                ProcessOptions {
                    timeout_ms: Some(15_000),
                    ..ProcessOptions::default()
                },
            )
            .await
            .map_err(|e| format!("Audio metadata inspection could not start {}: {e}", self.python_bin))?;

        if res.exit_code != Some(0) {
            return Err(format!(
                "Could not inspect audio with spotDL's Python ({}): {}",
                self.python_bin,
                res.stderr.trim()
            ));
        }

        let meta: AudioTagMetadata = serde_json::from_str(&res.stdout)
            .map_err(|_| String::from("Native audio metadata inspector returned invalid data"))?;
        Ok(meta)
    }

    /// Verifies `file_path`'s tags against `expected` and atomically rewrites the file via FFmpeg `-c copy`
    /// inside a sibling staging directory if repairs are needed.
    pub async fn verify_and_tag(
        &self,
        file_path: &Path,
        expected: &CanonicalAudioMetadata,
        root_directory: Option<&Path>,
    ) -> Result<(bool, AudioTagMetadata), String> {
        let physical = if let Some(root) = root_directory {
            safe_music_path(root, file_path, false)?
        } else {
            std::fs::canonicalize(file_path).map_err(|e| e.to_string())?
        };

        let artists: Vec<String> = expected
            .artists
            .iter()
            .map(|a| a.trim())
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        if artists.is_empty() || expected.title.trim().is_empty() || expected.album.trim().is_empty() {
            return Err(String::from("Canonical track metadata is incomplete"));
        }

        let initial = self.inspect(&physical).await?;
        if !needs_metadata_repair(&initial, expected) {
            return Ok((false, initial));
        }

        let parent = physical
            .parent()
            .ok_or_else(|| String::from("Invalid audio file parent"))?;
        let file_name = physical
            .file_name()
            .ok_or_else(|| String::from("Invalid audio filename"))?;
        let staging_dir = parent.join(format!(".musicdeck-tag-{}", Uuid::new_v4().simple()));
        tokio::fs::create_dir_all(&staging_dir)
            .await
            .map_err(|e| e.to_string())?;
        let temp_file = staging_dir.join(file_name);

        let joined_artists = artists.join("; ");
        let album_artist = clean_str(expected.album_artist.as_deref())
            .unwrap_or_else(|| artists[0].clone());

        let mut args = vec![
            String::from("-nostdin"),
            String::from("-hide_banner"),
            String::from("-loglevel"),
            String::from("error"),
            String::from("-y"),
            String::from("-i"),
            physical.to_string_lossy().into_owned(),
            String::from("-map"),
            String::from("0"),
            String::from("-c"),
            String::from("copy"),
            String::from("-metadata"),
            format!("title={}", expected.title.trim()),
            String::from("-metadata"),
            format!("artist={joined_artists}"),
            String::from("-metadata"),
            format!("album_artist={album_artist}"),
            String::from("-metadata"),
            format!("album={}", expected.album.trim()),
        ];

        if let Some(yr) = extract_four_digit_year(expected.year.as_deref()) {
            args.push(String::from("-metadata"));
            args.push(format!("date={yr}"));
        }
        if let Some(isrc) = clean_str(expected.isrc.as_deref()) {
            args.push(String::from("-metadata"));
            args.push(format!("isrc={isrc}"));
        }
        args.push(temp_file.to_string_lossy().into_owned());

        let run_res = self
            .runner
            .run(
                &self.ffmpeg_bin,
                &args,
                ProcessOptions {
                    timeout_ms: Some(30_000),
                    ..ProcessOptions::default()
                },
            )
            .await;

        let inspect_res = match run_res {
            Ok(res) if res.exit_code == Some(0) => {
                let rechecked = self.inspect(&temp_file).await;
                if let Ok(ref tags) = rechecked {
                    let mut check_expected = expected.clone();
                    check_expected.artwork_url = None;
                    if !needs_metadata_repair(tags, &check_expected) {
                        tokio::fs::rename(&temp_file, &physical)
                            .await
                            .map_err(|e| e.to_string())?;
                    } else {
                        let _ = tokio::fs::remove_dir_all(&staging_dir).await;
                        return Err(String::from("Repaired audio file failed tag verification"));
                    }
                }
                rechecked
            }
            Ok(res) => Err(format!("Tag repair failed: {}", res.stderr.trim())),
            Err(err) => Err(err.to_string()),
        };

        let _ = tokio::fs::remove_dir_all(&staging_dir).await;
        Ok((true, inspect_res?))
    }
}
