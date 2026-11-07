//! # Avatar Validation, Image Resizing & BLOB Persistence Pipeline (`avatars`)
//!
//! Complete Rust port and hardening of `server/src/users/avatars.ts`.
//!
//! ## Security & Image Processing Pipeline
//! 1. **Strict Payload & Transport Size Limits**:
//!    - Raw image bytes are capped at [`MAX_AVATAR_BYTES`] (`5 MiB`).
//!    - Request bodies (base64 data URLs or `multipart/form-data` streams) are capped at
//!      [`MAX_AVATAR_REQUEST_BYTES`] (`8 MiB`) and aborted mid-stream if exceeded.
//! 2. **Magic-Byte Signature Verification**:
//!    - Only `image/jpeg` (`FF D8 FF`), `image/png` (`89 50 4E 47 0D 0A 1A 0A`), and
//!      `image/webp` (`RIFF....WEBP`) are accepted.
//!    - Declared MIME types are cross-checked against actual file header magic bytes so
//!      mislabeled HTML/SVG/GIF payloads (`data:image/png;base64,<html>...`) are rejected.
//! 3. **Decompression-Bomb Defense & EXIF Stripping ([`normalize_avatar_thumbnail`])**:
//!    - Configures `image::Limits` (`max_image_width = 4096`, `max_image_height = 4096`,
//!      `max_alloc = 64 MiB`) before decoding pixel buffers.
//!    - Resizes/crops decoded images to [`AVATAR_THUMBNAIL_DIMENSION`] (`256x256` px)
//!      using `FilterType::Lanczos3` and re-encodes into a fresh container buffer,
//!      automatically stripping embedded EXIF/GPS/XMP metadata.
//! 4. **Content-Addressed Caching (`ETag` & Versioned URLs)**:
//!    - [`avatar_url_for`] appends `?v=<timestamp_ms>` so browsers immediately fetch new
//!      uploads while caching unchanged avatars with `Cache-Control: private, max-age=31536000, immutable`
//!      and a strong SHA-256 `ETag`.

use std::io::Cursor;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use chrono::Utc;
use image::imageops::FilterType;
use image::{ImageFormat, ImageReader, Limits};
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Row};

use crate::db::DbPool;
use crate::users::UserError;

/// Maximum permitted decoded byte size (`5 MiB`) for a user avatar image.
pub const MAX_AVATAR_BYTES: usize = 5 * 1024 * 1024;

/// Maximum HTTP request body size (`8 MiB`) to accommodate base64 data URL overhead.
pub const MAX_AVATAR_REQUEST_BYTES: usize = 8 * 1024 * 1024;

/// Standardized square thumbnail dimension (`256x256` pixels) for resized avatars.
pub const AVATAR_THUMBNAIL_DIMENSION: u32 = 256;

/// Maximum input image width/height (`4096` pixels) to prevent decompression bombs.
pub const MAX_IMAGE_DIMENSION: u32 = 4096;

/// Maximum pixel buffer allocation (`64 MiB`) during image decoding.
pub const MAX_DECODE_ALLOC_BYTES: u64 = 64 * 1024 * 1024;

/// Supported avatar container formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AvatarFormat {
    /// `image/jpeg` (`FF D8 FF`).
    Jpeg,
    /// `image/png` (`89 50 4E 47 0D 0A 1A 0A`).
    Png,
    /// `image/webp` (`RIFF....WEBP`).
    Webp,
}

impl AvatarFormat {
    /// Parses a normalized MIME type string into an [`AvatarFormat`].
    #[must_use]
    pub fn from_mime(mime: &str) -> Option<Self> {
        match mime.trim().to_ascii_lowercase().as_str() {
            "image/jpeg" => Some(Self::Jpeg),
            "image/png" => Some(Self::Png),
            "image/webp" => Some(Self::Webp),
            _ => None,
        }
    }

    /// Detects the [`AvatarFormat`] strictly from leading magic bytes.
    #[must_use]
    pub fn sniff_magic_bytes(data: &[u8]) -> Option<Self> {
        if data.len() > 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
            return Some(Self::Jpeg);
        }
        if data.len() > 8 && data[0..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
            return Some(Self::Png);
        }
        if data.len() > 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
            return Some(Self::Webp);
        }
        None
    }

    /// Verifies that `data` starts with the exact magic byte signature for `self`.
    #[must_use]
    pub fn matches_magic_bytes(self, data: &[u8]) -> bool {
        Self::sniff_magic_bytes(data) == Some(self)
    }

    /// Returns the canonical HTTP `Content-Type` string.
    #[must_use]
    pub const fn mime_type(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Webp => "image/webp",
        }
    }

    const fn to_image_format(self) -> ImageFormat {
        match self {
            Self::Jpeg => ImageFormat::Jpeg,
            Self::Png => ImageFormat::Png,
            Self::Webp => ImageFormat::WebP,
        }
    }
}

/// Validated avatar binary payload ready for database storage or HTTP delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvatarImage {
    /// Raw or normalized image bytes.
    pub data: Vec<u8>,
    /// Verified MIME type (`"image/jpeg"`, `"image/png"`, or `"image/webp"`).
    pub content_type: String,
    /// Strong HTTP `ETag` header value (`"\"sha256-...\""`) computed over `data`.
    pub etag: String,
}

/// Computes a strong HTTP `ETag` (`"\"sha256-<hex>\""`) from avatar bytes.
#[must_use]
pub fn compute_avatar_etag(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    format!("\"sha256-{hex}\"")
}

/// Constructs a cache-busted avatar URL (`/api/users/<id>/avatar?v=<epoch_ms_or_iso>`),
/// matching `avatarUrlFor` in `server/src/users/avatars.ts`.
#[must_use]
pub fn avatar_url_for(user_id: &str, updated_at: Option<&str>) -> Option<String> {
    let raw_ts = updated_at?.trim();
    if raw_ts.is_empty() {
        return None;
    }

    let version_token = chrono::DateTime::parse_from_rfc3339(raw_ts)
        .map_or_else(|_| raw_ts.to_owned(), |dt| dt.timestamp_millis().to_string());

    Some(format!(
        "/api/users/{}/avatar?v={}",
        urlencoding::encode(user_id),
        urlencoding::encode(&version_token)
    ))
}

/// Parses and validates a `data:<mime>;base64,<payload>` avatar string, verifying
/// MIME whitelist (`image/jpeg`, `image/png`, `image/webp`), byte size (`<= 5 MiB`),
/// and header magic bytes.
pub fn parse_avatar_data_url(raw_data_url: &str) -> Result<AvatarImage, UserError> {
    let trimmed = raw_data_url.trim();
    let Some(rest) = trimmed.strip_prefix("data:") else {
        return Err(UserError::InvalidAvatar(String::from(
            "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
        )));
    };

    let Some((meta, encoded)) = rest.split_once(',') else {
        return Err(UserError::InvalidAvatar(String::from(
            "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
        )));
    };

    let Some(mime_part) = meta.strip_suffix(";base64") else {
        return Err(UserError::InvalidAvatar(String::from(
            "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
        )));
    };

    let Some(format) = AvatarFormat::from_mime(mime_part) else {
        return Err(UserError::InvalidAvatar(String::from(
            "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
        )));
    };

    let clean_b64: String = encoded.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    if clean_b64.is_empty() {
        return Err(UserError::InvalidAvatar(String::from(
            "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
        )));
    }

    let decoded = BASE64_STANDARD.decode(clean_b64).map_err(|_| {
        UserError::InvalidAvatar(String::from(
            "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
        ))
    })?;

    validate_raw_avatar_bytes(&decoded, Some(format.mime_type()))
}

/// Validates raw uploaded bytes against [`MAX_AVATAR_BYTES`] (`5 MiB`) and magic-byte
/// signatures (`image/jpeg`, `image/png`, `image/webp`).
pub fn validate_raw_avatar_bytes(
    bytes: &[u8],
    declared_mime: Option<&str>,
) -> Result<AvatarImage, UserError> {
    if bytes.is_empty() || bytes.len() > MAX_AVATAR_BYTES {
        return Err(UserError::InvalidAvatar(String::from(
            "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
        )));
    }

    let format = if let Some(mime) = declared_mime {
        let declared = AvatarFormat::from_mime(mime).ok_or_else(|| {
            UserError::InvalidAvatar(String::from(
                "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
            ))
        })?;
        if !declared.matches_magic_bytes(bytes) {
            return Err(UserError::InvalidAvatar(String::from(
                "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
            )));
        }
        declared
    } else {
        AvatarFormat::sniff_magic_bytes(bytes).ok_or_else(|| {
            UserError::InvalidAvatar(String::from(
                "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less",
            ))
        })?
    };

    Ok(AvatarImage {
        data: bytes.to_vec(),
        content_type: format.mime_type().to_owned(),
        etag: compute_avatar_etag(bytes),
    })
}

/// Decodes, center-crops, and resizes an avatar image to `256x256` pixels while enforcing
/// decompression-bomb memory limits (`4096x4096` max dimensions, `64 MiB` max allocation)
/// and stripping EXIF metadata by re-encoding into a fresh container buffer.
pub fn normalize_avatar_thumbnail(
    bytes: &[u8],
    declared_mime: Option<&str>,
) -> Result<AvatarImage, UserError> {
    let validated = validate_raw_avatar_bytes(bytes, declared_mime)?;
    let format = AvatarFormat::from_mime(&validated.content_type).ok_or_else(|| {
        UserError::InvalidAvatar(String::from("Unsupported avatar image format"))
    })?;

    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOC_BYTES);

    let mut reader = ImageReader::with_format(Cursor::new(&validated.data), format.to_image_format());
    reader.limits(limits);

    let decoded = reader.decode().map_err(|err| {
        UserError::InvalidAvatar(format!(
            "Avatar image could not be decoded safely: {err}"
        ))
    })?;

    let thumbnail = decoded.resize_to_fill(
        AVATAR_THUMBNAIL_DIMENSION,
        AVATAR_THUMBNAIL_DIMENSION,
        FilterType::Lanczos3,
    );

    let mut output_buf = Vec::new();
    let out_format = match format {
        AvatarFormat::Jpeg => ImageFormat::Jpeg,
        AvatarFormat::Png => ImageFormat::Png,
        AvatarFormat::Webp => ImageFormat::WebP,
    };
    thumbnail
        .write_to(&mut Cursor::new(&mut output_buf), out_format)
        .map_err(|err| UserError::InvalidAvatar(format!("Failed to encode avatar thumbnail: {err}")))?;

    let etag = compute_avatar_etag(&output_buf);
    Ok(AvatarImage {
        data: output_buf,
        content_type: validated.content_type,
        etag,
    })
}

/// Stores or replaces the avatar BLOB for `user_id` inside an atomic SQLite transaction,
/// updating `users.avatar_updated_at` and `users.updated_at`.
///
/// Returns `Ok(true)` if the user existed and was updated, or `Ok(false)` if `user_id` was not found.
pub async fn set_user_avatar(
    pool: &DbPool,
    user_id: &str,
    data: &[u8],
    content_type: &str,
) -> Result<bool, UserError> {
    let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut conn = pool.inner().acquire().await?;
    let mut tx = conn.begin().await?;

    let update_res = sqlx::query(
        "UPDATE users SET avatar_updated_at = ?, updated_at = ? WHERE id = ?;",
    )
    .bind(&now_iso)
    .bind(&now_iso)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    if update_res.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(false);
    }

    sqlx::query(
        r"
        INSERT INTO user_avatars (user_id, content_type, data, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          content_type = excluded.content_type,
          data = excluded.data,
          updated_at = excluded.updated_at;
        ",
    )
    .bind(user_id)
    .bind(content_type)
    .bind(data)
    .bind(&now_iso)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(true)
}

/// Removes the custom avatar for `user_id` inside an atomic SQLite transaction.
pub async fn clear_user_avatar(pool: &DbPool, user_id: &str) -> Result<bool, UserError> {
    let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut conn = pool.inner().acquire().await?;
    let mut tx = conn.begin().await?;

    let update_res = sqlx::query(
        "UPDATE users SET avatar_updated_at = NULL, updated_at = ? WHERE id = ?;",
    )
    .bind(&now_iso)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM user_avatars WHERE user_id = ?;")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(update_res.rows_affected() > 0)
}

/// Fetches the stored avatar BLOB, MIME type, and computed `ETag` for `user_id`.
pub async fn get_user_avatar(pool: &DbPool, user_id: &str) -> Result<Option<AvatarImage>, UserError> {
    let row = sqlx::query("SELECT content_type, data FROM user_avatars WHERE user_id = ?;")
        .bind(user_id)
        .fetch_optional(pool.inner())
        .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    let content_type: String = row.try_get("content_type")?;
    let data: Vec<u8> = row.try_get("data")?;
    let etag = compute_avatar_etag(&data);

    Ok(Some(AvatarImage {
        data,
        content_type,
        etag,
    }))
}
