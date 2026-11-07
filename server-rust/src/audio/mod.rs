//! # Audio DSP Analysis, Tag Repair & Library Storage Optimizer (`audio`)
//!
//! Exports EBU R128 loudness normalization (`loudness`), FFmpeg `silencedetect`
//! boundary trim analysis (`silence`), embedded container tag inspection/repair (`tagger`),
//! and provenance-verified FLAC-to-MP3 library shrinkage (`shrink`).

pub mod loudness;
pub mod shrink;
pub mod silence;
pub mod tagger;

pub use loudness::{
    LOUDNESS_CACHE_TTL_MS, LOUDNESS_TARGET, LibraryAnalysisScanService, LibraryScanStatus,
    LoudnessMeasurement, LoudnessMetadata, LoudnessService, MAX_LOUDNESS_INPUT_BYTES,
    ScanParametersConflict, TRUE_PEAK_LIMIT, is_allowed_preview, loudness_measurement_key,
    loudness_stream_cache_key, measured_playback_gain, parse_loudness, playback_identity,
    safe_music_path,
};
pub use shrink::{
    ShrinkFailure, ShrinkOptions, ShrinkResult, ffmpeg_shrink_args, rewrite_manifest_references,
    shrink_spotdl_library,
};
pub use silence::{
    DEFAULT_MIN_SILENCE_SECONDS, DEFAULT_SILENCE_THRESHOLD_DB, SilenceAnalysisRow,
    SilenceAnalysisService, SilenceInterval, SilenceParameters, SilenceTrimBounds,
    derive_trim_bounds, parse_duration_seconds, parse_silence_intervals,
};
pub use tagger::{
    AudioTagMetadata, AudioTaggerService, CanonicalAudioMetadata, NATIVE_TAG_INSPECT,
    SUPPORTED_AUDIO_EXTENSIONS, is_invalid_artist, is_placeholder_album_artist,
    is_supported_audio_file, needs_metadata_repair,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ebu_r128_loudness_and_computes_headroom_safe_gain() {
        let stderr = r#"
[Parsed_loudnorm_0 @ 0x7f8]
{
    "input_i" : "-12.40",
    "input_tp" : "0.20",
    "input_lra" : "8.10",
    "input_thresh" : "-22.90",
    "output_i" : "-16.00",
    "output_tp" : "-1.00",
    "output_lra" : "7.50",
    "output_thresh" : "-26.50",
    "normalization_type" : "dynamic",
    "target_offset" : "0.00"
}
"#;
        let m = parse_loudness(stderr).expect("parse loudnorm JSON");
        assert_eq!(m.integrated_lufs(), Some(-12.4));
        assert_eq!(m.true_peak_db(), Some(0.2));

        // Target -16.0 - (-12.4) = -3.6 dB; peak headroom -1.0 - 0.2 = -1.2 dB -> min is -3.6 dB
        let gain = measured_playback_gain(-12.4, 0.2, -16.0);
        assert!((gain - (-3.6)).abs() < 1e-6);

        // Quiet track (-24.0 LUFS) with high peak (-0.5 dBTP) is clamped by true peak headroom (-1.0 - (-0.5) = -0.5 dB)
        let peak_clamped = measured_playback_gain(-24.0, -0.5, -16.0);
        assert!((peak_clamped - (-0.5)).abs() < 1e-6);
    }

    #[test]
    fn parses_silence_intervals_and_derives_leading_trailing_trim_bounds() {
        let stderr = r"
  Duration: 00:03:20.50, start: 0.000000, bitrate: 320 kb/s
[silencedetect @ 0x1] silence_start: 0.01
[silencedetect @ 0x1] silence_end: 1.26 | silence_duration: 1.25
[silencedetect @ 0x1] silence_start: 95.00
[silencedetect @ 0x1] silence_end: 96.50 | silence_duration: 1.50
[silencedetect @ 0x1] silence_start: 198.00
";
        let duration = parse_duration_seconds(stderr);
        assert_eq!(duration, Some(200.5));

        let intervals = parse_silence_intervals(stderr);
        assert_eq!(intervals.len(), 3);
        assert_eq!(intervals[0].start, 0.01);
        assert_eq!(intervals[0].end, Some(1.26));
        assert_eq!(intervals[2].start, 198.0);
        assert_eq!(intervals[2].end, None);

        let bounds = derive_trim_bounds(&intervals, duration);
        assert!((bounds.leading_silence_seconds - 1.25).abs() < 1e-6);
        assert!((bounds.trailing_silence_seconds - 2.50).abs() < 1e-6);
    }

    #[test]
    fn detects_when_audio_tags_require_metadata_repair() {
        let expected = CanonicalAudioMetadata {
            title: String::from("Instant Crush"),
            artists: vec![
                String::from("Daft Punk"),
                String::from("Julian Casablancas"),
            ],
            album: String::from("Random Access Memories"),
            album_artist: Some(String::from("Daft Punk")),
            year: Some(String::from("2013-05-17")),
            isrc: Some(String::from("USQX91300105")),
            artwork_url: Some(String::from("https://e-cdns-images.dzcdn.net/cover.jpg")),
        };

        let complete_tags = AudioTagMetadata {
            artist: Some(String::from("Daft Punk; Julian Casablancas")),
            album_artist: Some(String::from("Daft Punk")),
            title: Some(String::from("Instant Crush")),
            album: Some(String::from("Random Access Memories")),
            year: Some(String::from("2013")),
            isrc: Some(String::from("USQX91300105")),
            has_artwork: true,
            artwork_hashes: None,
        };
        assert!(!needs_metadata_repair(&complete_tags, &expected));

        let missing_featured_artist = AudioTagMetadata {
            artist: Some(String::from("Daft Punk")),
            ..complete_tags.clone()
        };
        assert!(needs_metadata_repair(&missing_featured_artist, &expected));

        let placeholder_artist = AudioTagMetadata {
            artist: Some(String::from("Unknown Artist")),
            ..complete_tags
        };
        assert!(needs_metadata_repair(&placeholder_artist, &expected));
    }
}
