//! # Playlist Custom Artwork & 2x2 Mosaic Collage Engine (`playlists::artwork`)
//!
//! Complete Rust port of `server/src/domain/playlist-artwork.ts` enhanced with
//! native raster `image` crate 2x2 mosaic composition (`compose_raster_2x2_collage`).
//!
//! ## Cover Art Resolution Modes
//! 1. **`Custom`**: Operator/user-uploaded image stored in `playlist_artwork (playlist_id, content_type, data, updated_at)`.
//!    Always takes precedence over the automatic collage.
//! 2. **`Collage`**: Automatic 2x2 mosaic generated on demand from up to the first
//!    [`COLLAGE_TILE_COUNT`] (`4`) tracks in the playlist and cached in memory (`64` entries max).
//!
//! Both modes are addressed via an opaque token `mdplart_<16-hex-sig>_<playlist_id>`
//! so any change to custom artwork `updated_at` or to the leading 4 tracks' identities
//! automatically produces a new cache-busting URL (`/api/artwork/mdplart_...`).

use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use chrono::Utc;
use image::imageops::{FilterType, overlay};
use image::{ImageFormat, ImageReader, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::db::{DbError, DbPool};
use crate::playlists::PlaylistError;

/// Prefix for all opaque playlist artwork tokens (`"mdplart_"`).
pub const PLAYLIST_ARTWORK_PREFIX: &str = "mdplart_";

/// Number of leading tracks (`4`) sampled for a 2x2 playlist collage.
pub const COLLAGE_TILE_COUNT: usize = 4;

/// Maximum decoded byte size (`5 MiB`) for a custom playlist cover upload.
pub const MAX_CUSTOM_ARTWORK_BYTES: usize = 5 * 1024 * 1024;

/// Maximum HTTP request body size (`8 MiB`) to accommodate base64 JSON inflation.
pub const MAX_ARTWORK_REQUEST_BYTES: usize = 8 * 1024 * 1024;

/// Maximum byte size (`2 MiB`) accepted for a single tile when building a collage.
pub const MAX_TILE_BYTES: usize = 2 * 1024 * 1024;

/// Maximum number of rendered collages retained in the in-memory FIFO cache.
pub const MAX_CACHED_COLLAGES: usize = 64;

/// Default full-size square edge dimension (`600` px) for rendered collages.
pub const COLLAGE_SIZE: u32 = 600;

/// Supported quantized thumbnail sizes (`[64, 160, 300, 600]`).
pub const PLAYLIST_ARTWORK_SIZES: [u32; 4] = [64, 160, 300, COLLAGE_SIZE];

/// How a playlist's cover art was resolved (`"custom"` or `"collage"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaylistArtworkMode {
    /// User-uploaded cover stored in `playlist_artwork`.
    Custom,
    /// Automatic 2x2 mosaic of the playlist's leading tracks.
    Collage,
}

/// Public artwork metadata fields attached to a [`crate::playlists::PlaylistRecord`].
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistArtworkDescriptor {
    /// Opaque artwork ID (`mdplart_<signature>_<playlistId>`).
    pub artwork_id: Option<String>,
    /// Relative MusicDeck artwork URL (`/api/artwork/mdplart_...`).
    pub artwork_url: Option<String>,
    /// Resolution mode (`custom` or `collage`).
    pub artwork_mode: Option<PlaylistArtworkMode>,
}

/// Rendered binary artwork payload ready for HTTP delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedArtwork {
    /// Image or SVG bytes.
    pub body: Vec<u8>,
    /// MIME content type (`image/png`, `image/jpeg`, `image/webp`, `image/gif`, or `image/svg+xml`).
    pub content_type: String,
    /// Strong HTTP `ETag` computed over `body`.
    pub etag: String,
}

/// Stored custom playlist cover row from `playlist_artwork`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomPlaylistArtwork {
    /// Raw image bytes.
    pub data: Vec<u8>,
    /// Validated MIME type (`image/jpeg`, `image/png`, `image/webp`, `image/gif`).
    pub content_type: String,
    /// ISO-8601 update timestamp.
    pub updated_at: String,
}

/// Snaps a caller-supplied `size` hint to the smallest supported [`PLAYLIST_ARTWORK_SIZES`]
/// tier (`64`, `160`, `300`, or `600`), defaulting to `600`.
#[must_use]
pub fn resolve_artwork_size(requested: Option<u32>) -> u32 {
    let Some(px) = requested.filter(|&v| v > 0) else {
        return COLLAGE_SIZE;
    };
    PLAYLIST_ARTWORK_SIZES
        .into_iter()
        .find(|&tier| tier >= px)
        .unwrap_or(COLLAGE_SIZE)
}

/// Formats an opaque playlist artwork token (`mdplart_<signature>_<playlist_id>`).
#[must_use]
pub fn build_playlist_artwork_id(playlist_id: &str, signature: &str) -> String {
    format!("{PLAYLIST_ARTWORK_PREFIX}{signature}_{playlist_id}")
}

/// Parses an opaque `mdplart_<signature>_<playlist_id>` token into `(playlist_id, signature)`.
#[must_use]
pub fn parse_playlist_artwork_id(artwork_id: &str) -> Option<(String, String)> {
    let rest = artwork_id.strip_prefix(PLAYLIST_ARTWORK_PREFIX)?;
    let sep = rest.find('_')?;
    if sep == 0 || sep + 1 >= rest.len() {
        return None;
    }
    let signature = rest[..sep].to_owned();
    let playlist_id = rest[sep + 1..].to_owned();
    Some((playlist_id, signature))
}

/// Validates and decodes a `data:<mime>;base64,<payload>` string for custom playlist artwork.
///
/// Accepts `image/jpeg`, `image/png`, `image/webp`, and `image/gif` up to `5 MiB`.
#[must_use]
pub fn parse_image_data_url(raw: &str) -> Option<(Vec<u8>, String)> {
    let trimmed = raw.trim();
    let rest = trimmed.strip_prefix("data:")?;
    let (meta, b64_part) = rest.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?.trim().to_ascii_lowercase();

    if !matches!(
        mime.as_str(),
        "image/jpeg" | "image/png" | "image/webp" | "image/gif"
    ) {
        return None;
    }

    let clean_b64: String = b64_part
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if clean_b64.is_empty() {
        return None;
    }

    let decoded = BASE64_STANDARD.decode(clean_b64).ok()?;
    if decoded.is_empty() || decoded.len() > MAX_CUSTOM_ARTWORK_BYTES {
        return None;
    }

    Some((decoded, mime))
}

/// Computes a 16-character hex digest signature over `parts` separated by NUL bytes.
#[must_use]
pub fn signature_of(parts: &[&str]) -> String {
    let joined = parts.join("\u{0000}");
    let digest = Sha256::digest(joined.as_bytes());
    let mut hex = String::with_capacity(16);
    for byte in &digest[..8] {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

fn compute_etag(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(32);
    for byte in &digest[..16] {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    format!("\"plart-{hex}\"")
}

/// Composes a 2x2 raster PNG mosaic of dimension `size x size` from 0..=4 raw tile image buffers
/// using the `image` crate (`RgbaImage` + `FilterType::Lanczos3`).
///
/// ### Quadrant Layout & Fallback Rules
/// - **0 valid tiles**: Returns a solid `#181818` dark canvas of `size x size`.
/// - **1 valid tile**: Scales the single image to fill the entire `size x size` frame (`(0, 0)`).
/// - **2 or 3 valid tiles**: Cycles available tiles (`tiles[i % tiles.len()]`) across all four
///   quadrants `[(0, 0), (half, 0), (0, half), (half, half)]` so no quadrant is left blank.
/// - **4 valid tiles**: Places each tile in its respective quadrant:
///   - Top-Left: `(0, 0)`
///   - Top-Right: `(half, 0)`
///   - Bottom-Left: `(0, half)`
///   - Bottom-Right: `(half, half)`
pub fn compose_raster_2x2_collage(
    raw_tiles: &[Vec<u8>],
    size: u32,
) -> Result<RenderedArtwork, PlaylistError> {
    let edge = resolve_artwork_size(Some(size));
    let half = (edge / 2).max(1);
    let mut canvas = RgbaImage::from_pixel(edge, edge, Rgba([0x18, 0x18, 0x18, 0xFF]));

    let decoded_tiles: Vec<image::DynamicImage> = raw_tiles
        .iter()
        .take(COLLAGE_TILE_COUNT)
        .filter(|b| !b.is_empty() && b.len() <= MAX_TILE_BYTES)
        .filter_map(|bytes| {
            ImageReader::new(Cursor::new(bytes))
                .with_guessed_format()
                .ok()?
                .decode()
                .ok()
        })
        .collect();

    if decoded_tiles.len() == 1 {
        let scaled = decoded_tiles[0].resize_to_fill(edge, edge, FilterType::Lanczos3);
        overlay(&mut canvas, &scaled, 0, 0);
    } else if decoded_tiles.len() >= 2 {
        let scaled_quadrants: Vec<image::DynamicImage> = decoded_tiles
            .iter()
            .map(|img| img.resize_to_fill(half, half, FilterType::Lanczos3))
            .collect();

        let coords = [
            (0i64, 0i64),
            (i64::from(half), 0i64),
            (0i64, i64::from(half)),
            (i64::from(half), i64::from(half)),
        ];

        for (idx, (x, y)) in coords.into_iter().enumerate() {
            let tile = &scaled_quadrants[idx % scaled_quadrants.len()];
            overlay(&mut canvas, tile, x, y);
        }
    }

    let mut png_bytes = Vec::new();
    canvas
        .write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
        .map_err(|err| PlaylistError::Validation(format!("Failed to encode collage PNG: {err}")))?;

    let etag = compute_etag(&png_bytes);
    Ok(RenderedArtwork {
        body: png_bytes,
        content_type: String::from("image/png"),
        etag,
    })
}

/// Composes an SVG 2x2 collage from validated `data:<mime>;base64,...` tile strings,
/// preserving exact wire compatibility with `PlaylistArtworkService.buildCollage` in TypeScript.
#[must_use]
pub fn compose_svg_2x2_collage(data_url_tiles: &[String], size: u32) -> RenderedArtwork {
    let edge = resolve_artwork_size(Some(size));
    let half = edge / 2;
    let open = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{edge}" height="{edge}" viewBox="0 0 {edge} {edge}" role="img" aria-label="Playlist cover"><rect width="{edge}" height="{edge}" fill="#181818" />"##
    );

    let svg_text = if data_url_tiles.is_empty() {
        let font_size = edge / 3;
        format!(
            r##"{open}<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="{font_size}" fill="#b3b3b3">&#9834;</text></svg>"##
        )
    } else if data_url_tiles.len() == 1 {
        format!(
            r#"{open}<image x="0" y="0" width="{edge}" height="{edge}" preserveAspectRatio="xMidYMid slice" href="{}" /></svg>"#,
            data_url_tiles[0]
        )
    } else {
        let coords = [(0, 0), (half, 0), (0, half), (half, half)];
        let mut body = open;
        for (idx, (x, y)) in coords.into_iter().enumerate() {
            let href = &data_url_tiles[idx % data_url_tiles.len()];
            body.push_str(&format!(
                r#"<image x="{x}" y="{y}" width="{half}" height="{half}" preserveAspectRatio="xMidYMid slice" href="{href}" />"#
            ));
        }
        body.push_str("</svg>");
        body
    };

    let bytes = svg_text.into_bytes();
    let etag = compute_etag(&bytes);
    RenderedArtwork {
        body: bytes,
        content_type: String::from("image/svg+xml"),
        etag,
    }
}

/// Service managing custom playlist artwork BLOBs in SQLite and caching rendered 2x2 collages.
#[derive(Debug, Clone)]
pub struct PlaylistArtworkService {
    db: DbPool,
    collage_cache: Arc<Mutex<VecDeque<(String, RenderedArtwork)>>>,
}

impl PlaylistArtworkService {
    /// Creates a new [`PlaylistArtworkService`] backed by `db`.
    #[must_use]
    pub fn new(db: DbPool) -> Self {
        Self {
            db,
            collage_cache: Arc::new(Mutex::new(VecDeque::with_capacity(MAX_CACHED_COLLAGES))),
        }
    }

    /// Reads custom uploaded artwork for `playlist_id` from `playlist_artwork`.
    pub async fn get_custom(
        &self,
        playlist_id: &str,
    ) -> Result<Option<CustomPlaylistArtwork>, DbError> {
        let row = sqlx::query(
            "SELECT content_type, data, updated_at FROM playlist_artwork WHERE playlist_id = ?;",
        )
        .bind(playlist_id)
        .fetch_optional(self.db.inner())
        .await?;

        let Some(row) = row else {
            return Ok(None);
        };

        Ok(Some(CustomPlaylistArtwork {
            content_type: row.try_get("content_type")?,
            data: row.try_get("data")?,
            updated_at: row.try_get("updated_at")?,
        }))
    }

    /// Stores or replaces custom artwork for `playlist_id` in `playlist_artwork`.
    pub async fn set_custom(
        &self,
        playlist_id: &str,
        data: &[u8],
        content_type: &str,
    ) -> Result<(), DbError> {
        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query(
            r"
            INSERT INTO playlist_artwork (playlist_id, content_type, data, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(playlist_id) DO UPDATE SET
              content_type = excluded.content_type,
              data = excluded.data,
              updated_at = excluded.updated_at;
            ",
        )
        .bind(playlist_id)
        .bind(content_type)
        .bind(data)
        .bind(now_iso)
        .execute(self.db.inner())
        .await?;
        Ok(())
    }

    /// Deletes custom artwork for `playlist_id` so it reverts to the automatic 2x2 collage.
    pub async fn clear_custom(&self, playlist_id: &str) -> Result<bool, DbError> {
        let res = sqlx::query("DELETE FROM playlist_artwork WHERE playlist_id = ?;")
            .bind(playlist_id)
            .execute(self.db.inner())
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Computes the [`PlaylistArtworkDescriptor`] (`artworkId`, `artworkUrl`, `artworkMode`)
    /// for `playlist_id` given its leading track references.
    pub async fn describe(
        &self,
        playlist_id: &str,
        leading_track_refs: &[String],
    ) -> Result<PlaylistArtworkDescriptor, DbError> {
        if let Some(custom) = self.get_custom(playlist_id).await? {
            let sig = signature_of(&["custom", &custom.updated_at]);
            let artwork_id = build_playlist_artwork_id(playlist_id, &sig);
            return Ok(PlaylistArtworkDescriptor {
                artwork_url: Some(format!("/api/artwork/{}", urlencoding::encode(&artwork_id))),
                artwork_id: Some(artwork_id),
                artwork_mode: Some(PlaylistArtworkMode::Custom),
            });
        }

        let tiles: Vec<&str> = leading_track_refs
            .iter()
            .take(COLLAGE_TILE_COUNT)
            .map(String::as_str)
            .collect();
        if tiles.is_empty() {
            return Ok(PlaylistArtworkDescriptor::default());
        }

        let mut sig_parts = Vec::with_capacity(tiles.len() + 1);
        sig_parts.push("collage");
        sig_parts.extend(tiles);
        let sig = signature_of(&sig_parts);
        let artwork_id = build_playlist_artwork_id(playlist_id, &sig);

        Ok(PlaylistArtworkDescriptor {
            artwork_url: Some(format!("/api/artwork/{}", urlencoding::encode(&artwork_id))),
            artwork_id: Some(artwork_id),
            artwork_mode: Some(PlaylistArtworkMode::Collage),
        })
    }

    /// Retrieves a cached collage or stores a newly rendered collage in the bounded 64-slot cache.
    #[must_use]
    pub fn get_or_cache_svg_collage(
        &self,
        artwork_ids: &[String],
        data_url_tiles: &[String],
        size: Option<u32>,
    ) -> RenderedArtwork {
        let edge = resolve_artwork_size(size);
        let key = format!(
            "{edge}|{}",
            artwork_ids
                .iter()
                .take(COLLAGE_TILE_COUNT)
                .cloned()
                .collect::<Vec<_>>()
                .join("|")
        );

        if let Ok(guard) = self.collage_cache.lock()
            && let Some((_, cached)) = guard.iter().find(|(k, _)| k == &key)
        {
            return cached.clone();
        }

        let rendered = compose_svg_2x2_collage(data_url_tiles, edge);
        if let Ok(mut guard) = self.collage_cache.lock() {
            if guard.len() >= MAX_CACHED_COLLAGES {
                guard.pop_front();
            }
            guard.push_back((key, rendered.clone()));
        }
        rendered
    }
}
