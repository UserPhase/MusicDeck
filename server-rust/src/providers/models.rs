//! # Unified Music Domain Models & Stream Payloads (`providers::models`)
//!
//! Canonical Rust data structures matching `server/src/types.ts`,
//! `server/src/backends/catalog-provider.ts`, and `server/src/backends/stream-provider.ts`.

use http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};

/// Cross-provider catalog identity hints (MusicBrainz UUID, ISRC, UPC).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityHints {
    /// MusicBrainz recording, release, or artist UUID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub music_brainz_id: Option<String>,
    /// International Standard Recording Code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isrc: Option<String>,
    /// Universal Product Code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upc: Option<String>,
}

/// Individual artist credit on a multi-artist track.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackArtistCredit {
    /// Optional provider/library artist ID.
    pub id: Option<String>,
    /// Credited artist display name.
    pub name: String,
}

/// Technical audio stream properties reported by the upstream media backend.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMetadataSummary {
    /// Audio codec name (e.g., `"flac"`, `"mp3"`, `"aac"`, `"opus"`).
    pub codec: Option<String>,
    /// Container format suffix (e.g., `"flac"`, `"mp3"`, `"m4a"`).
    pub container: Option<String>,
    /// Nominal or average bitrate in kbps.
    pub bitrate_kbps: Option<u32>,
    /// Sample rate in Hz (e.g., `44100`, `48000`, `96000`).
    pub sample_rate_hz: Option<u32>,
    /// Bit depth per sample (e.g., `16`, `24`).
    pub bit_depth: Option<u32>,
    /// Audio channel count (e.g., `2`).
    pub channels: Option<u32>,
}

/// ReplayGain loudness metadata embedded in track tags.
#[derive(Debug, Default, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayGainMetadata {
    /// Track gain adjustment in dB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_gain_db: Option<f64>,
    /// Linear peak amplitude of the track.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_peak: Option<f64>,
    /// Album gain adjustment in dB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_gain_db: Option<f64>,
    /// Linear peak amplitude of the album.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_peak: Option<f64>,
}

/// EBU R128 loudness measurement attached to a track.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessMetadata {
    /// Integrated loudness in LUFS.
    pub integrated_lufs: f64,
    /// True peak in dBTP.
    pub true_peak_db: f64,
}

/// Canonical MusicDeck track representation (`Track` in `server/src/types.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// Stable MusicDeck ID (`md_<nanoid>`) or provider-native ID prior to catalog stamping.
    pub id: String,
    /// Upstream provider's native track identifier.
    pub provider_id: String,
    /// Track title (`"Unknown title"` fallback).
    pub title: String,
    /// Primary artist ID, if known.
    pub artist_id: Option<String>,
    /// Display artist name (`"Unknown artist"` fallback).
    pub artist_name: String,
    /// Structured multi-artist credits when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist_credits: Option<Vec<TrackArtistCredit>>,
    /// Parent album ID, if known.
    pub album_id: Option<String>,
    /// Parent album title (`"Unknown album"` fallback).
    pub album_name: String,
    /// Track duration in whole seconds.
    pub duration_seconds: Option<u32>,
    /// Genre tags associated with the track.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genres: Option<Vec<String>>,
    /// Mood tags associated with the track.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moods: Option<Vec<String>>,
    /// Release year.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    /// Original release year (for remasters/reissues).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_release_year: Option<i32>,
    /// Tempo in beats per minute.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bpm: Option<f64>,
    /// Provider-reported total play count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub play_count: Option<u64>,
    /// Provider-reported ISO timestamp of most recent play.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_played_at: Option<String>,
    /// ISO timestamp when the track was added to the library.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_at: Option<String>,
    /// 1-based track number on the album/disc.
    pub track_number: Option<u32>,
    /// 1-based disc number on a multi-disc album.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disc_number: Option<u32>,
    /// Artwork identifier used to fetch cover art.
    pub artwork_id: Option<String>,
    /// Relative MusicDeck artwork URL (`/api/artwork/<id>`).
    pub artwork_url: Option<String>,
    /// Relative MusicDeck audio stream URL (`/api/tracks/<id>/stream`).
    pub stream_url: String,
    /// Optional upstream server label (`"navidrome"`, `"jellyfin"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_server: Option<String>,
    /// Technical codec/container/sample-rate metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_metadata: Option<AudioMetadataSummary>,
    /// ReplayGain tags.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_gain: Option<ReplayGainMetadata>,
    /// Computed linear playback normalization gain in dB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normalization_gain_db: Option<f64>,
    /// EBU R128 loudness measurements.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loudness: Option<LoudnessMetadata>,
    /// Optional related artist IDs used by the local recommendation engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub related_artist_ids: Option<Vec<String>>,
    /// Cross-provider identity hints.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_hints: Option<IdentityHints>,
}

/// Canonical MusicDeck album representation (`Album` in `server/src/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    /// Stable MusicDeck ID or provider-native album ID.
    pub id: String,
    /// Upstream provider's native album ID.
    pub provider_id: String,
    /// Album title.
    pub name: String,
    /// Primary album artist ID.
    pub artist_id: Option<String>,
    /// Primary album artist name.
    pub artist_name: String,
    /// Release year.
    pub year: Option<i32>,
    /// Cover artwork identifier.
    pub artwork_id: Option<String>,
    /// Relative MusicDeck artwork URL (`/api/artwork/<id>`).
    pub artwork_url: Option<String>,
    /// Number of tracks on the album.
    pub song_count: u32,
    /// Optional upstream server label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_server: Option<String>,
    /// Cross-provider identity hints.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_hints: Option<IdentityHints>,
}

/// Canonical MusicDeck artist representation (`Artist` in `server/src/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    /// Stable MusicDeck ID or provider-native artist ID.
    pub id: String,
    /// Upstream provider's native artist ID.
    pub provider_id: String,
    /// Artist display name.
    pub name: String,
    /// Cover/avatar artwork ID.
    pub artwork_id: Option<String>,
    /// Relative MusicDeck artwork URL.
    pub artwork_url: Option<String>,
    /// Dedicated artist portrait URL (`getArtist` / `getArtistInfo2`), never album art.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    /// Number of albums by this artist in the library.
    pub album_count: u32,
    /// Optional total track count by this artist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub song_count: Option<u32>,
    /// Cross-provider identity hints.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_hints: Option<IdentityHints>,
}

/// Canonical MusicDeck playlist representation (`Playlist` in `server/src/types.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    /// Playlist ID.
    pub id: String,
    /// Provider-native playlist ID.
    pub provider_id: String,
    /// Playlist title.
    pub name: String,
    /// Optional playlist description/comment.
    pub description: Option<String>,
    /// Cover artwork ID.
    pub artwork_id: Option<String>,
    /// Relative MusicDeck artwork URL.
    pub artwork_url: Option<String>,
    /// Total number of tracks in the playlist.
    pub song_count: u32,
    /// Ordered tracks when hydrated (`include_tracks = true`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracks: Option<Vec<Track>>,
}

/// Input parameters for [`crate::providers::MusicBackend::update_playlist`].
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistUpdateInput {
    /// New playlist title.
    pub name: Option<String>,
    /// New playlist description.
    pub description: Option<String>,
}

/// Aggregated catalog search result across artists, albums, and tracks.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Matching artists.
    pub artists: Vec<Artist>,
    /// Matching albums.
    pub albums: Vec<Album>,
    /// Matching tracks.
    pub tracks: Vec<Track>,
}

/// Offset/limit pagination window for catalog search queries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchPagination {
    /// Zero-based item offset.
    pub offset: usize,
    /// Maximum items to return (`1..=500`).
    pub limit: usize,
}

/// Result of a provider library scan trigger/poll (`scanLibrary`).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScanResult {
    /// Whether the provider is still actively scanning.
    pub scanning: bool,
    /// Total indexed item count reported by the provider, if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
}

/// Metadata describing how an audio stream was negotiated with the upstream provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    /// `true` when streaming raw/direct source bytes without server-side transcoding.
    pub direct: bool,
    /// Requested maximum transcode bitrate in kbps, if any.
    pub requested_bitrate_kbps: Option<u32>,
    /// Source connection ID that served the stream.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_connection_id: Option<String>,
}

/// Upstream HTTP stream or artwork response returned by [`crate::providers::MusicBackend`].
#[derive(Debug)]
pub struct StreamResult {
    /// Upstream HTTP status code (`200 OK`, `206 Partial Content`, `404 Not Found`, etc.).
    pub status: StatusCode,
    /// Upstream HTTP response headers (`Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`).
    pub headers: HeaderMap,
    /// Underlying `reqwest::Response` for zero-copy chunked byte streaming to the client.
    pub response: reqwest::Response,
    /// Optional audio stream delivery descriptor.
    pub audio_stream: Option<AudioStreamInfo>,
}

/// Formats a MusicDeck relative artwork URL (`/api/artwork/<encoded_id>`).
#[must_use]
pub fn format_artwork_url(artwork_id: Option<&str>) -> Option<String> {
    let id = artwork_id?.trim();
    if id.is_empty() {
        return None;
    }
    Some(format!("/api/artwork/{}", urlencoding::encode(id)))
}

/// Formats a MusicDeck relative track stream URL (`/api/tracks/<encoded_id>/stream`).
#[must_use]
pub fn format_stream_url(track_id: &str) -> String {
    format!("/api/tracks/{}/stream", urlencoding::encode(track_id))
}

/// Type alias for [`TrackArtistCredit`].
pub type ArtistCredit = TrackArtistCredit;
/// Type alias for [`AudioMetadataSummary`].
pub type AudioMetadata = AudioMetadataSummary;
/// Type alias for [`LoudnessMetadata`].
pub type Loudness = LoudnessMetadata;

/// Buffered upstream stream response returned by preview and external source providers.
#[derive(Debug, Clone)]
pub struct UpstreamStreamResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub bytes: bytes::Bytes,
}
