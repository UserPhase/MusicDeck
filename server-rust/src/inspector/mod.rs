//! # Zero-Copy Binary Audio Header Inspector (`inspector`)
//!
//! Complete Rust port of `server/src/services/AudioMetadataInspector.ts`.
//!
//! ## Supported Binary Container & Frame Formats ([`inspect_audio_header`])
//! Inspects a bounded prefix (up to `64 KiB`) of delivered stream bytes without
//! full audio decoding or heap-heavy allocations:
//! 1. **FLAC (`fLaC`)**:
//!    - Bytes `0..4 == b"fLaC"`, `(data[4] & 0x7F) == 0` (`STREAMINFO`), 24-bit big-endian
//!      block length `data[5..8] == 34`, total prefix $\ge 42$ bytes.
//!    - Packed 64-bit big-endian integer at bytes `18..26`:
//!      - Bits `63..44` (20 bits): `sample_rate_hz`
//!      - Bits `43..41` (3 bits): `channels - 1`
//!      - Bits `40..36` (5 bits): `bit_depth - 1`
//!      - Bits `35..0` (36 bits): `total_samples`
//!    - Reports `codec = "FLAC"`, `container = "FLAC"`, `lossless = true`, and
//!      `bitrate_kbps = None` (never mistaking uncompressed PCM rate for FLAC bitrate).
//! 2. **WAV / RIFF (`RIFF` ... `WAVE` ... `fmt `)**:
//!    - Bytes `0..4 == b"RIFF"`, bytes `8..12 == b"WAVE"`, total prefix $\ge 36$ bytes.
//!    - Walks little-endian chunks starting at offset `12` (`chunk_size` at `offset + 4`)
//!      with word-alignment padding (`size + (size & 1)`).
//!    - On `b"fmt "` (`size >= 16`): reads `format_tag` (`1` = integer PCM, `3` = IEEE float,
//!      `0xFFFE` = `WAVE_FORMAT_EXTENSIBLE` with subformat `1`/`3` at `offset + 32`),
//!      `channels` (`u16` LE at `+ 10`), `sample_rate_hz` (`u32` LE at `+ 12`),
//!      `byte_rate` (`u32` LE at `+ 16` $\rightarrow \text{kbps} = \text{byte\_rate} \times 8 / 1000$),
//!      and `bit_depth` (`u16` LE at `+ 22`).
//! 3. **OGG (`OggS`) — Opus & Vorbis**:
//!    - Bytes `0..4 == b"OggS"`, total prefix $\ge 36$ bytes.
//!    - **Opus (`OpusHead`)**: Channel count at `offset + 9`, fixed `48000` Hz sample rate.
//!    - **Vorbis (`\x01vorbis`)**: Channel count at `offset + 11`, `sample_rate_hz` (`u32` LE
//!      at `offset + 12`), nominal bitrate (`i32` LE at `offset + 20` $/ 1000$).
//! 4. **ISO Base Media / MP4 (`ftyp` / `moov` / `trak` / `mdia` / `minf` / `stbl` / `stsd`)**:
//!    - Bytes `4..8 == b"ftyp"`. Walks nested big-endian atoms (`depth <= 10`) into `stsd`
//!      sample descriptions (`alac` or `mp4a`, version `0` at `+ 16`).
//!    - For `alac`, inspects the nested `alac` specific config box (`length >= 36`) at
//!      `child + 17` (`bit_depth`), `child + 21` (`channels`), `child + 28` (`bitrate_kbps`),
//!      and `child + 32` (`sample_rate_hz`).
//! 5. **ID3v2 Tag Skip + ADTS AAC & MPEG Layer III (MP3)**:
//!    - Skips leading `ID3` synchsafe 28-bit tag headers (`10 + synchsafe_len + footer`).
//!    - Scans up to `4096` bytes for 11/12-bit sync words (`0xFF`):
//!      - **ADTS AAC** (`(b1 & 0xF6) == 0xF0`): Extracts sample rate table index, channel
//!        configuration, and validates 13-bit frame size $\ge 7$.
//!      - **MP3** (`(b1 & 0xE0) == 0xE0`, Layer III): Extracts MPEG-1/2/2.5 sample rate and
//!        channel mode while keeping `bitrate_kbps = None` to avoid reporting a single VBR
//!        frame's bitrate as the track average.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::providers::models::{AudioMetadataSummary, AudioStreamInfo};

/// Maximum number of concurrent stream observations retained in [`AudioMetadataInspector`].
pub const MAX_OBSERVATIONS: usize = 500;

/// Observation TTL (`30` minutes in milliseconds).
pub const OBSERVATION_TTL_MS: u64 = 30 * 60 * 1_000;

/// Maximum prefix bytes buffered while waiting to identify an audio container header (`64 KiB`).
pub const MAX_HEADER_INSPECTION_BYTES: usize = 65_536;

/// Standardized technical audio properties extracted from either provider metadata
/// or raw delivered container headers (`AudioMetadata` / `AudioProperties`).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMetadata {
    /// Canonical uppercase codec identifier (`"FLAC"`, `"ALAC"`, `"PCM"`, `"MP3"`, `"AAC"`, `"OPUS"`, `"VORBIS"`).
    pub codec: Option<String>,
    /// Uppercase container format (`"FLAC"`, `"WAV"`, `"OGG"`, `"MP4"`, `"MP3"`, `"ADTS"`).
    pub container: Option<String>,
    /// Bitrate in kbps (when authoritative across the stream/container).
    pub bitrate_kbps: Option<u32>,
    /// Sample rate in Hz (`44100`, `48000`, `96000`, etc.).
    pub sample_rate_hz: Option<u32>,
    /// Bit depth per sample (`16`, `24`, `32`), typically present for lossless codecs.
    pub bit_depth: Option<u32>,
    /// Audio channel count (`1`, `2`, `6`, `8`).
    pub channels: Option<u32>,
    /// Whether the codec is lossless (`Some(true)` for FLAC/ALAC/PCM/WAV/AIFF).
    pub lossless: Option<bool>,
}

/// Alias matching `AudioProperties` in `server/src/services/AudioMetadataInspector.ts`.
pub type AudioProperties = AudioMetadata;

/// Delivery mode observed on an active audio stream.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StreamOutputMode {
    /// Stream matches source audio without transcoding.
    DirectStream,
    /// Delivered codec, sample rate, bit depth, or channels differ from source metadata.
    Transcoded,
    /// Stream mode has not been verified yet.
    #[default]
    Unknown,
}

/// Evidence classification for [`StreamInspectionOutput`].
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InspectionEvidence {
    /// Direct delivery confirmed by provider and header inspection.
    ProviderDirect,
    /// Active conversion detected by comparing source vs. delivered header properties.
    ObservedConversion,
    /// Unverified (e.g., mid-file range request or pending header).
    #[default]
    Unverified,
}

/// Observed output stream properties and transcoding verdict.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInspectionOutput {
    /// Flattened audio properties of the output stream.
    #[serde(flatten)]
    pub properties: AudioMetadata,
    /// Delivery mode (`DIRECT_STREAM`, `TRANSCODED`, `UNKNOWN`).
    pub mode: StreamOutputMode,
    /// Evidence basis (`provider-direct`, `observed-conversion`, `unverified`).
    pub evidence: InspectionEvidence,
    /// Human-readable reason when transcoded or bitrate-capped.
    pub transcode_reason: Option<String>,
    /// `Some(true)` if output sample rate is lower than source sample rate.
    pub downsampled: Option<bool>,
    /// Requested bitrate cap in kbps, if any.
    pub requested_bitrate_kbps: Option<u32>,
    /// `true` if binary header inspection succeeded on the delivered stream.
    pub observed: bool,
}

/// Stream delivery state.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryState {
    /// No stream bytes observed yet.
    #[default]
    Waiting,
    /// Actively delivering audio chunks.
    Streaming,
    /// Stream reached EOF cleanly.
    Finished,
    /// Client cancelled/closed the stream.
    Cancelled,
    /// Upstream or transport error occurred.
    Error,
}

/// Throughput and byte delivery telemetry for an inspected stream.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamDeliveryMetrics {
    /// Total bytes delivered during this observation.
    pub bytes: u64,
    /// Rolling throughput in kbps over the active window.
    pub bitrate_kbps: Option<f64>,
    /// Rolling window duration in seconds (typically `5.0`).
    pub window_seconds: f64,
    /// Current stream lifecycle state.
    pub state: DeliveryState,
}

/// Complete stream inspection report returned by `/api/v1/playback/inspect`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInspection {
    /// Inspected track ID.
    pub track_id: String,
    /// Client-supplied inspection correlation ID.
    pub inspection_id: String,
    /// Source file properties reported by the provider.
    pub source: AudioMetadata,
    /// Non-fatal error message if source metadata lookup failed.
    pub source_error: Option<String>,
    /// Observed output properties and transcoding verdict.
    pub output: StreamInspectionOutput,
    /// Real-time byte delivery and throughput metrics.
    pub delivery: StreamDeliveryMetrics,
}

/// Normalizes a raw codec string into a canonical uppercase MusicDeck codec name,
/// matching `codecName()` in `server/src/services/AudioMetadataInspector.ts`.
#[must_use]
pub fn codec_name(raw: Option<&str>) -> Option<String> {
    let val = raw?.trim();
    if val.is_empty() {
        return None;
    }
    let upper = val.to_ascii_uppercase();
    let stripped = upper.strip_prefix("X-").unwrap_or(&upper);

    if matches!(stripped, "MPEG" | "MP3" | "MPEG3") {
        return Some(String::from("MP3"));
    }
    if matches!(stripped, "MP4A" | "AAC" | "AACP" | "MP4") {
        return if stripped == "MP4" {
            None
        } else {
            Some(String::from("AAC"))
        };
    }
    if stripped.starts_with("PCM_") || matches!(stripped, "WAVE" | "WAV" | "LPCM") {
        return Some(String::from("PCM"));
    }
    if matches!(
        stripped,
        "FLAC" | "ALAC" | "OPUS" | "VORBIS" | "AAC" | "AIFF" | "PCM"
    ) {
        return Some(stripped.to_owned());
    }
    None
}

fn is_lossless_codec(codec: &str) -> bool {
    matches!(codec, "FLAC" | "ALAC" | "PCM" | "WAV" | "AIFF")
}

const fn positive_u32(val: Option<u32>) -> Option<u32> {
    match val {
        Some(v) if v > 0 => Some(v),
        _ => None,
    }
}

/// Converts provider-reported [`AudioMetadataSummary`] into normalized [`AudioMetadata`],
/// matching `sourceProperties()` in `server/src/services/AudioMetadataInspector.ts`.
#[must_use]
pub fn source_properties(metadata: Option<&AudioMetadataSummary>) -> AudioMetadata {
    let Some(meta) = metadata else {
        return AudioMetadata::default();
    };
    let codec = codec_name(meta.codec.as_deref());
    let container = meta
        .container
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(30).collect::<String>().to_ascii_uppercase());
    let lossless = codec.as_deref().map(is_lossless_codec);

    AudioMetadata {
        codec,
        container,
        bitrate_kbps: positive_u32(meta.bitrate_kbps),
        sample_rate_hz: positive_u32(meta.sample_rate_hz),
        bit_depth: positive_u32(meta.bit_depth),
        channels: positive_u32(meta.channels),
        lossless,
    }
}

/// Parses a bounded byte slice from the beginning of an audio stream to extract
/// container and codec properties (`FLAC`, `WAV`, `OGG` Opus/Vorbis, `MP4` ALAC/AAC,
/// `ADTS` AAC, and `MP3` with `ID3v2` skip).
///
/// Never panics on truncated, corrupted, or arbitrary binary input.
#[must_use]
pub fn inspect_audio_header(data: &[u8]) -> Option<AudioMetadata> {
    // 1. FLAC (`fLaC` + STREAMINFO block type 0 of length 34)
    if data.len() >= 42
        && &data[0..4] == b"fLaC"
        && (data[4] & 0x7F) == 0
        && read_u24_be(&data[5..8]) == 34
    {
        let packed = u64::from_be_bytes(data[18..26].try_into().ok()?);
        let sample_rate_hz = u32::try_from(packed >> 44).ok();
        let channels = u32::try_from(((packed >> 41) & 0x07) + 1).ok();
        let bit_depth = u32::try_from(((packed >> 36) & 0x1F) + 1).ok();

        return Some(AudioMetadata {
            codec: Some(String::from("FLAC")),
            container: Some(String::from("FLAC")),
            bitrate_kbps: None,
            sample_rate_hz: positive_u32(sample_rate_hz),
            bit_depth: positive_u32(bit_depth),
            channels: positive_u32(channels),
            lossless: Some(true),
        });
    }

    // 2. WAV (`RIFF` ... `WAVE` ... `fmt `)
    if data.len() >= 36 && &data[0..4] == b"RIFF" && &data[8..12] == b"WAVE" {
        let mut offset = 12usize;
        while offset.saturating_add(24) <= data.len() {
            let size = u32::from_le_bytes(data[offset + 4..offset + 8].try_into().ok()?) as usize;
            if &data[offset..offset + 4] == b"fmt " && size >= 16 {
                let code = u16::from_le_bytes(data[offset + 8..offset + 10].try_into().ok()?);
                let is_pcm = code == 1
                    || code == 3
                    || (code == 65_534
                        && size >= 40
                        && offset.saturating_add(48) <= data.len()
                        && matches!(
                            u16::from_le_bytes(data[offset + 32..offset + 34].try_into().ok()?),
                            1 | 3
                        ));
                let channels = u32::from(u16::from_le_bytes(
                    data[offset + 10..offset + 12].try_into().ok()?,
                ));
                let sample_rate_hz =
                    u32::from_le_bytes(data[offset + 12..offset + 16].try_into().ok()?);
                let byte_rate =
                    u32::from_le_bytes(data[offset + 16..offset + 20].try_into().ok()?);
                let bit_depth = u32::from(u16::from_le_bytes(
                    data[offset + 22..offset + 24].try_into().ok()?,
                ));

                return Some(AudioMetadata {
                    codec: is_pcm.then(|| String::from("PCM")),
                    container: Some(String::from("WAV")),
                    bitrate_kbps: positive_u32(Some(byte_rate.saturating_mul(8) / 1000)),
                    sample_rate_hz: positive_u32(Some(sample_rate_hz)),
                    bit_depth: if is_pcm {
                        positive_u32(Some(bit_depth))
                    } else {
                        None
                    },
                    channels: positive_u32(Some(channels)),
                    lossless: is_pcm.then_some(true),
                });
            }
            let padded = size.saturating_add(size % 2);
            offset = offset.saturating_add(8).saturating_add(padded);
        }
    }

    // 3. OGG (`OggS`) — Opus (`OpusHead`) or Vorbis (`\x01vorbis`)
    if data.len() >= 36 && &data[0..4] == b"OggS" {
        if let Some(opus_offset) = find_subslice(data, b"OpusHead")
            && data.len() >= opus_offset + 19
        {
            return Some(AudioMetadata {
                codec: Some(String::from("OPUS")),
                container: Some(String::from("OGG")),
                bitrate_kbps: None,
                sample_rate_hz: Some(48_000),
                bit_depth: None,
                channels: positive_u32(Some(u32::from(data[opus_offset + 9]))),
                lossless: Some(false),
            });
        }

        let vorbis_magic = [1u8, b'v', b'o', b'r', b'b', b'i', b's'];
        if let Some(vorbis_offset) = find_subslice(data, &vorbis_magic)
            && data.len() >= vorbis_offset + 28
        {
            let channels = u32::from(data[vorbis_offset + 11]);
            let sample_rate_hz = u32::from_le_bytes(
                data[vorbis_offset + 12..vorbis_offset + 16].try_into().ok()?,
            );
            let nominal_bitrate = i32::from_le_bytes(
                data[vorbis_offset + 20..vorbis_offset + 24].try_into().ok()?,
            );
            let bitrate_kbps = (nominal_bitrate > 0)
                .then(|| u32::try_from(nominal_bitrate / 1000).ok())
                .flatten();

            return Some(AudioMetadata {
                codec: Some(String::from("VORBIS")),
                container: Some(String::from("OGG")),
                bitrate_kbps: positive_u32(bitrate_kbps),
                sample_rate_hz: positive_u32(Some(sample_rate_hz)),
                bit_depth: None,
                channels: positive_u32(Some(channels)),
                lossless: Some(false),
            });
        }
    }

    // 4. MP4 / M4A (`ftyp` box followed by `moov`/`trak`/`mdia`/`minf`/`stbl`/`stsd`)
    if data.len() >= 12 && &data[4..8] == b"ftyp" {
        if let Some(mp4_props) = walk_mp4_boxes(data, 0, data.len(), 0) {
            return Some(mp4_props);
        }
    }

    // 5. Optional ID3v2 header skip + ADTS AAC or MPEG Layer III (MP3) frame sync
    let mut start = 0usize;
    if data.len() >= 10 && &data[0..3] == b"ID3" {
        let synchsafe = ((usize::from(data[6] & 0x7F)) << 21)
            | ((usize::from(data[7] & 0x7F)) << 14)
            | ((usize::from(data[8] & 0x7F)) << 7)
            | usize::from(data[9] & 0x7F);
        start = 10 + synchsafe;
        if (data[5] & 0x10) != 0 {
            start += 10;
        }
    }

    let limit = data.len().saturating_sub(7).min(start.saturating_add(4096));
    let mut index = start;
    while index < limit {
        if data[index] != 0xFF {
            index += 1;
            continue;
        }
        let second = data[index + 1];

        // ADTS AAC sync (`(second & 0xF6) == 0xF0`)
        if (second & 0xF6) == 0xF0 {
            const ADTS_RATES: [u32; 16] = [
                96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000,
                7350, 0, 0, 0,
            ];
            let rate_idx = usize::from((data[index + 2] >> 2) & 0x0F);
            let rate = ADTS_RATES[rate_idx];
            let raw_channels = ((data[index + 2] & 1) << 2) | (data[index + 3] >> 6);
            let frame_size = ((usize::from(data[index + 3] & 0x03)) << 11)
                | (usize::from(data[index + 4]) << 3)
                | usize::from(data[index + 5] >> 5);

            if rate > 0 && raw_channels > 0 && frame_size >= 7 {
                let channels = if raw_channels == 7 {
                    8
                } else {
                    u32::from(raw_channels)
                };
                return Some(AudioMetadata {
                    codec: Some(String::from("AAC")),
                    container: Some(String::from("ADTS")),
                    bitrate_kbps: None,
                    sample_rate_hz: Some(rate),
                    bit_depth: None,
                    channels: Some(channels),
                    lossless: Some(false),
                });
            }
        }

        // MPEG Layer III (MP3) sync (`(second & 0xE0) == 0xE0`)
        let version = (second >> 3) & 0x03;
        let layer = (second >> 1) & 0x03;
        let rate_index = usize::from((data[index + 2] >> 2) & 0x03);
        let bit_index = data[index + 2] >> 4;
        if (second & 0xE0) == 0xE0
            && version != 1
            && layer == 1
            && rate_index < 3
            && bit_index > 0
            && bit_index < 15
        {
            const MP3_BASE_RATES: [u32; 3] = [44100, 48000, 32000];
            let divisor = if version == 3 {
                1
            } else if version == 2 {
                2
            } else {
                4
            };
            let rate = MP3_BASE_RATES[rate_index] / divisor;
            let channels = if (data[index + 3] >> 6) == 3 { 1 } else { 2 };

            return Some(AudioMetadata {
                codec: Some(String::from("MP3")),
                container: Some(String::from("MP3")),
                bitrate_kbps: None,
                sample_rate_hz: Some(rate),
                bit_depth: None,
                channels: Some(channels),
                lossless: Some(false),
            });
        }

        index += 1;
    }

    None
}

fn walk_mp4_boxes(data: &[u8], start: usize, end: usize, depth: usize) -> Option<AudioMetadata> {
    if depth > 10 {
        return None;
    }
    let mut offset = start;
    while offset.saturating_add(8) <= end {
        let size = u32::from_be_bytes(data[offset..offset + 4].try_into().ok()?) as usize;
        if size < 8 || offset.saturating_add(size) > end {
            break;
        }
        let box_type = &data[offset + 4..offset + 8];
        if matches!(box_type, b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl") {
            if let Some(found) = walk_mp4_boxes(data, offset + 8, offset + size, depth + 1) {
                return Some(found);
            }
        }
        if box_type == b"stsd" && size >= 16 {
            if let Some(found) = walk_mp4_boxes(data, offset + 16, offset + size, depth + 1) {
                return Some(found);
            }
        }
        if matches!(box_type, b"alac" | b"mp4a") && size >= 36 {
            let is_alac = box_type == b"alac";
            let version = u16::from_be_bytes(data[offset + 16..offset + 18].try_into().ok()?);
            if version != 0 {
                return None;
            }
            let channels = u32::from(u16::from_be_bytes(
                data[offset + 24..offset + 26].try_into().ok()?,
            ));
            let sample_size = u32::from(u16::from_be_bytes(
                data[offset + 26..offset + 28].try_into().ok()?,
            ));
            let sample_rate_hz =
                u32::from_be_bytes(data[offset + 32..offset + 36].try_into().ok()?) >> 16;

            let mut props = AudioMetadata {
                codec: is_alac.then(|| String::from("ALAC")),
                container: Some(String::from("MP4")),
                bitrate_kbps: None,
                sample_rate_hz: positive_u32(Some(sample_rate_hz)),
                bit_depth: if is_alac {
                    positive_u32(Some(sample_size))
                } else {
                    None
                },
                channels: positive_u32(Some(channels)),
                lossless: is_alac.then_some(true),
            };

            // Inspect child boxes for the authoritative ALAC specific config (`alac` atom >= 36 bytes)
            let mut child = offset + 36;
            while child.saturating_add(8) <= offset + size {
                let child_len =
                    u32::from_be_bytes(data[child..child + 4].try_into().ok()?) as usize;
                if child_len < 8 || child.saturating_add(child_len) > offset + size {
                    break;
                }
                if is_alac && &data[child + 4..child + 8] == b"alac" && child_len >= 36 {
                    props.bit_depth = positive_u32(Some(u32::from(data[child + 17])));
                    props.channels = positive_u32(Some(u32::from(data[child + 21])));
                    let avg_bitrate =
                        u32::from_be_bytes(data[child + 28..child + 32].try_into().ok()?);
                    props.bitrate_kbps = positive_u32(Some(avg_bitrate / 1000));
                    let alac_rate =
                        u32::from_be_bytes(data[child + 32..child + 36].try_into().ok()?);
                    props.sample_rate_hz = positive_u32(Some(alac_rate));
                }
                child += child_len;
            }
            return Some(props);
        }
        offset += size;
    }
    None
}

fn read_u24_be(bytes: &[u8]) -> u32 {
    (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2])
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ============================================================================
// Stateful Stream Observation Tracker (`AudioMetadataInspector`)
// ============================================================================

#[derive(Debug, Clone)]
struct ThroughputSample {
    time_ms: u64,
    bytes: u64,
}

#[derive(Debug, Clone)]
struct StreamObservation {
    updated_at_ms: u64,
    bytes: u64,
    state: DeliveryState,
    samples: Vec<ThroughputSample>,
    header_buf: Vec<u8>,
    from_start: bool,
    observed_properties: Option<AudioMetadata>,
    pipe: Option<AudioStreamInfo>,
    source: Option<AudioMetadata>,
    source_failed: bool,
}

/// Bounded in-memory stream observation registry tracking active audio streams
/// for the Now Playing Audio Signal Inspector (`/api/v1/playback/inspect`).
#[derive(Clone)]
pub struct AudioMetadataInspector {
    observations: Arc<Mutex<HashMap<(String, String, String), StreamObservation>>>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl std::fmt::Debug for AudioMetadataInspector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioMetadataInspector").finish()
    }
}

impl Default for AudioMetadataInspector {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioMetadataInspector {
    /// Creates a new [`AudioMetadataInspector`] using the system clock.
    #[must_use]
    pub fn new() -> Self {
        Self::with_clock(Arc::new(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        }))
    }

    /// Creates a new [`AudioMetadataInspector`] with an injectable millisecond clock.
    #[must_use]
    pub fn with_clock(clock: Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        Self {
            observations: Arc::new(Mutex::new(HashMap::new())),
            clock,
        }
    }

    /// Starts or resumes an observation for `(user_id, track_id, inspection_id)`.
    pub fn begin_observation(
        &self,
        user_id: &str,
        track_id: &str,
        inspection_id: &str,
        status_code: u16,
        range_header: Option<&str>,
        content_range_header: Option<&str>,
        pipe: Option<AudioStreamInfo>,
    ) {
        if !matches!(status_code, 200 | 206) {
            return;
        }

        let now = (self.clock)();
        let key = (
            user_id.to_owned(),
            track_id.to_owned(),
            inspection_id.to_owned(),
        );

        let from_start = range_header.is_none_or(|r| {
            let lower = r.trim().to_ascii_lowercase();
            lower.starts_with("bytes=0-")
        }) && content_range_header.is_none_or(|cr| {
            let lower = cr.trim().to_ascii_lowercase();
            !lower.starts_with("bytes ")
                || lower.starts_with("bytes 0-")
        });

        let mut guard = self
            .observations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Self::prune_locked(&mut guard, now);

        let old = guard.get(&key);
        let same_pipe = status_code == 206
            && old
                .and_then(|o| o.pipe.as_ref().zip(pipe.as_ref()))
                .is_some_and(|(old_p, new_p)| {
                    old_p.source_connection_id == new_p.source_connection_id
                        && old_p.direct == new_p.direct
                        && old_p.requested_bitrate_kbps == new_p.requested_bitrate_kbps
                });

        let preserved_props = if same_pipe {
            old.and_then(|o| o.observed_properties.clone())
        } else {
            None
        };
        let preserved_source = old
            .filter(|o| {
                o.pipe.as_ref().map(|p| &p.source_connection_id)
                    == pipe.as_ref().map(|p| &p.source_connection_id)
            })
            .and_then(|o| o.source.clone());

        guard.insert(
            key,
            StreamObservation {
                updated_at_ms: now,
                bytes: 0,
                state: DeliveryState::Streaming,
                samples: vec![ThroughputSample {
                    time_ms: now,
                    bytes: 0,
                }],
                header_buf: Vec::new(),
                from_start,
                observed_properties: preserved_props,
                pipe,
                source: preserved_source,
                source_failed: false,
            },
        );
        Self::prune_locked(&mut guard, now);
    }

    /// Feeds a delivered byte chunk into the observation for header parsing and bitrate tracking.
    pub fn record_chunk(&self, user_id: &str, track_id: &str, inspection_id: &str, chunk: &[u8]) {
        let now = (self.clock)();
        let key = (
            user_id.to_owned(),
            track_id.to_owned(),
            inspection_id.to_owned(),
        );

        let mut guard = self
            .observations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(obs) = guard.get_mut(&key) else {
            return;
        };

        obs.updated_at_ms = now;
        obs.bytes = obs.bytes.saturating_add(chunk.len() as u64);

        let has_multiple = obs.samples.len() > 1;
        if let Some(last) = obs.samples.last_mut()
            && now.saturating_sub(last.time_ms) < 100
            && has_multiple
        {
            last.bytes = obs.bytes;
        } else {
            obs.samples.push(ThroughputSample {
                time_ms: now,
                bytes: obs.bytes,
            });
        }

        while obs.samples.len() > 2 && obs.samples[1].time_ms < now.saturating_sub(5_000) {
            obs.samples.remove(0);
        }

        if obs.from_start
            && obs.observed_properties.is_none()
            && obs.header_buf.len() < MAX_HEADER_INSPECTION_BYTES
        {
            let remaining = MAX_HEADER_INSPECTION_BYTES - obs.header_buf.len();
            let take = chunk.len().min(remaining);
            obs.header_buf.extend_from_slice(&chunk[..take]);
            obs.observed_properties = inspect_audio_header(&obs.header_buf);
            if obs.observed_properties.is_some() {
                obs.header_buf.clear();
            }
        }
    }

    /// Marks the delivery state (`Finished`, `Cancelled`, or `Error`) of an active observation.
    pub fn finish_observation(
        &self,
        user_id: &str,
        track_id: &str,
        inspection_id: &str,
        state: DeliveryState,
    ) {
        let now = (self.clock)();
        let key = (
            user_id.to_owned(),
            track_id.to_owned(),
            inspection_id.to_owned(),
        );
        if let Ok(mut guard) = self.observations.lock()
            && let Some(obs) = guard.get_mut(&key)
        {
            obs.state = state;
            obs.updated_at_ms = now;
        }
    }

    /// Computes a [`StreamInspection`] report comparing `source_meta` with the observed
    /// stream header and rolling delivery bitrate.
    #[must_use]
    pub fn inspect_snapshot(
        &self,
        user_id: &str,
        track_id: &str,
        inspection_id: &str,
        source_meta: Result<Option<AudioMetadataSummary>, ()>,
    ) -> StreamInspection {
        let now = (self.clock)();
        let key = (
            user_id.to_owned(),
            track_id.to_owned(),
            inspection_id.to_owned(),
        );

        let mut guard = self
            .observations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Self::prune_locked(&mut guard, now);

        if let Some(obs) = guard.get_mut(&key)
            && obs.source.is_none()
            && !obs.source_failed
        {
            match source_meta {
                Ok(summary) => obs.source = Some(source_properties(summary.as_ref())),
                Err(()) => obs.source_failed = true,
            }
        }

        let obs = guard.get(&key).cloned();
        drop(guard);

        let mut source = obs
            .as_ref()
            .and_then(|o| o.source.clone())
            .unwrap_or_default();
        let observed = obs.as_ref().and_then(|o| o.observed_properties.clone());
        let pipe = obs.as_ref().and_then(|o| o.pipe.clone());

        let converted = observed.as_ref().is_some_and(|obs_p| {
            (source.codec.is_some() && obs_p.codec.is_some() && source.codec != obs_p.codec)
                || (source.sample_rate_hz.is_some()
                    && obs_p.sample_rate_hz.is_some()
                    && source.sample_rate_hz != obs_p.sample_rate_hz)
                || (source.bit_depth.is_some()
                    && obs_p.bit_depth.is_some()
                    && source.bit_depth != obs_p.bit_depth)
                || (source.channels.is_some()
                    && obs_p.channels.is_some()
                    && source.channels != obs_p.channels)
        });

        let direct = pipe.as_ref().is_some_and(|p| p.direct) && !converted;
        if direct && let Some(ref obs_p) = observed {
            if source.codec.is_none() {
                source.codec.clone_from(&obs_p.codec);
            }
            if source.container.is_none() {
                source.container.clone_from(&obs_p.container);
            }
            if source.bitrate_kbps.is_none() {
                source.bitrate_kbps = obs_p.bitrate_kbps;
            }
            if source.sample_rate_hz.is_none() {
                source.sample_rate_hz = obs_p.sample_rate_hz;
            }
            if source.bit_depth.is_none() {
                source.bit_depth = obs_p.bit_depth;
            }
            if source.channels.is_none() {
                source.channels = obs_p.channels;
            }
            if source.lossless.is_none() {
                source.lossless = obs_p.lossless;
            }
        }

        let mode = if converted {
            StreamOutputMode::Transcoded
        } else if direct {
            StreamOutputMode::DirectStream
        } else {
            StreamOutputMode::Unknown
        };

        let output_props = if direct {
            let mut merged = source.clone();
            if let Some(ref obs_p) = observed {
                if obs_p.codec.is_some() {
                    merged.codec.clone_from(&obs_p.codec);
                }
                if obs_p.container.is_some() {
                    merged.container.clone_from(&obs_p.container);
                }
                if obs_p.bitrate_kbps.is_some() {
                    merged.bitrate_kbps = obs_p.bitrate_kbps;
                }
                if obs_p.sample_rate_hz.is_some() {
                    merged.sample_rate_hz = obs_p.sample_rate_hz;
                }
                if obs_p.bit_depth.is_some() {
                    merged.bit_depth = obs_p.bit_depth;
                }
                if obs_p.channels.is_some() {
                    merged.channels = obs_p.channels;
                }
                if obs_p.lossless.is_some() {
                    merged.lossless = obs_p.lossless;
                }
            }
            merged
        } else {
            observed.clone().unwrap_or_default()
        };

        let requested_bitrate_kbps = pipe.as_ref().and_then(|p| p.requested_bitrate_kbps);
        let transcode_reason = if converted {
            Some(requested_bitrate_kbps.map_or_else(
                || String::from("Delivered audio differs from source metadata"),
                |kbps| format!("Bitrate cap requested: {kbps} kbps"),
            ))
        } else {
            requested_bitrate_kbps
                .map(|_| String::from("Bitrate cap requested; server conversion is not verified"))
        };

        let downsampled = output_props
            .sample_rate_hz
            .zip(source.sample_rate_hz)
            .map(|(out_hz, src_hz)| out_hz < src_hz);

        let (bytes, bitrate_kbps, window_seconds, state) = if let Some(ref o) = obs {
            let first = o.samples.first();
            let elapsed_s = first.map_or(0.0, |f| {
                (now.saturating_sub(f.time_ms) as f64 / 1000.0).max(0.0)
            });
            let has_recent = o
                .samples
                .iter()
                .any(|s| s.time_ms >= now.saturating_sub(5_000));
            let rate = if let Some(f) = first
                && elapsed_s >= 0.1
                && has_recent
            {
                let raw_kbps = (o.bytes.saturating_sub(f.bytes) as f64) * 8.0 / elapsed_s / 1000.0;
                Some((raw_kbps * 10.0).round() / 10.0)
            } else {
                None
            };
            (
                o.bytes,
                rate,
                (elapsed_s.min(5.0) * 10.0).round() / 10.0,
                o.state,
            )
        } else {
            (0, None, 0.0, DeliveryState::Waiting)
        };

        StreamInspection {
            track_id: track_id.to_owned(),
            inspection_id: inspection_id.to_owned(),
            source,
            source_error: obs
                .as_ref()
                .is_some_and(|o| o.source_failed)
                .then(|| {
                    String::from(
                        "Source metadata could not be loaded. Delivered header inspection remains available.",
                    )
                }),
            output: StreamInspectionOutput {
                properties: output_props,
                mode,
                evidence: if converted {
                    InspectionEvidence::ObservedConversion
                } else if direct {
                    InspectionEvidence::ProviderDirect
                } else {
                    InspectionEvidence::Unverified
                },
                transcode_reason,
                downsampled,
                requested_bitrate_kbps,
                observed: observed.is_some(),
            },
            delivery: StreamDeliveryMetrics {
                bytes,
                bitrate_kbps,
                window_seconds,
                state,
            },
        }
    }

    fn prune_locked(
        map: &mut HashMap<(String, String, String), StreamObservation>,
        now_ms: u64,
    ) {
        map.retain(|_, v| now_ms.saturating_sub(v.updated_at_ms) <= OBSERVATION_TTL_MS);
        while map.len() > MAX_OBSERVATIONS {
            if let Some(oldest_key) = map
                .iter()
                .min_by_key(|(_, v)| v.updated_at_ms)
                .map(|(k, _)| k.clone())
            {
                map.remove(&oldest_key);
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_flac_header(rate: u32, depth: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; 42];
        bytes[0..4].copy_from_slice(b"fLaC");
        bytes[5] = 0;
        bytes[6] = 0;
        bytes[7] = 34;
        let packed: u64 =
            (u64::from(rate) << 44) | (1u64 << 41) | (u64::from(depth - 1) << 36);
        bytes[18..26].copy_from_slice(&packed.to_be_bytes());
        bytes
    }

    #[test]
    fn parses_flac_wav_ogg_mp4_alac_mp3_and_adts_headers() {
        // 1. FLAC 96kHz/24-bit
        let flac_96 = inspect_audio_header(&build_flac_header(96_000, 24)).expect("FLAC header");
        assert_eq!(flac_96.codec.as_deref(), Some("FLAC"));
        assert_eq!(flac_96.sample_rate_hz, Some(96_000));
        assert_eq!(flac_96.bit_depth, Some(24));
        assert_eq!(flac_96.channels, Some(2));
        assert_eq!(flac_96.bitrate_kbps, None);
        assert_eq!(flac_96.lossless, Some(true));

        // 2. MP3 frame sync
        let mp3 = [255u8, 251, 144, 0, 0, 0, 0, 0, 0];
        let mp3_props = inspect_audio_header(&mp3).expect("MP3 header");
        assert_eq!(mp3_props.codec.as_deref(), Some("MP3"));
        assert_eq!(mp3_props.sample_rate_hz, Some(44_100));
        assert_eq!(mp3_props.lossless, Some(false));
        assert_eq!(mp3_props.bitrate_kbps, None);

        // 3. ADTS AAC frame sync
        let adts = [255u8, 241, 80, 128, 1, 63, 252, 0, 0];
        let adts_props = inspect_audio_header(&adts).expect("ADTS header");
        assert_eq!(adts_props.codec.as_deref(), Some("AAC"));
        assert_eq!(adts_props.container.as_deref(), Some("ADTS"));
        assert_eq!(adts_props.sample_rate_hz, Some(44_100));
        assert_eq!(adts_props.channels, Some(2));

        // 4. WAV PCM 48kHz/16-bit/2ch
        let mut wav = vec![0u8; 44];
        wav[0..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        wav[12..16].copy_from_slice(b"fmt ");
        wav[16..20].copy_from_slice(&16u32.to_le_bytes());
        wav[20..22].copy_from_slice(&1u16.to_le_bytes());
        wav[22..24].copy_from_slice(&2u16.to_le_bytes());
        wav[24..28].copy_from_slice(&48_000u32.to_le_bytes());
        wav[28..32].copy_from_slice(&192_000u32.to_le_bytes());
        wav[34..36].copy_from_slice(&16u16.to_le_bytes());
        let wav_props = inspect_audio_header(&wav).expect("WAV header");
        assert_eq!(wav_props.codec.as_deref(), Some("PCM"));
        assert_eq!(wav_props.sample_rate_hz, Some(48_000));
        assert_eq!(wav_props.bitrate_kbps, Some(1536));

        // 5. Ogg Opus
        let mut ogg = vec![0u8; 60];
        ogg[0..4].copy_from_slice(b"OggS");
        ogg[28..36].copy_from_slice(b"OpusHead");
        ogg[37] = 2;
        let ogg_props = inspect_audio_header(&ogg).expect("Ogg Opus header");
        assert_eq!(ogg_props.codec.as_deref(), Some("OPUS"));
        assert_eq!(ogg_props.sample_rate_hz, Some(48_000));
        assert_eq!(ogg_props.channels, Some(2));

        // 6. Truncated/malformed buffers return None without panicking
        assert!(inspect_audio_header(&[]).is_none());
        assert!(inspect_audio_header(&[0u8; 100]).is_none());
        assert!(inspect_audio_header(&build_flac_header(44_100, 16)[..20]).is_none());
        assert!(inspect_audio_header(b"ID3\x04\x00\x00\x7f\x7f\x7f\x7f").is_none());
    }
}
