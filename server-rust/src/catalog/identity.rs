//! # Deterministic Music Identity & Container Filename Matching (`catalog::identity`)
//!
//! Complete Rust port of `server/src/domain/music-identity.ts`.
//!
//! ## Identity Hierarchy (`derive_canonical_identity`)
//! 1. **MusicBrainz UUID (`strength = "musicbrainz"`)**: `canonical_<base64url(sha256("<type>:musicbrainz:<mbid>"))[..24]>`
//! 2. **ISRC (`strength = "isrc"`, tracks only)**: `canonical_<base64url(sha256("track:isrc:<isrc>"))[..24]>`
//! 3. **UPC (`strength = "upc"`, albums only)**: `canonical_<base64url(sha256("album:upc:<upc>"))[..24]>`
//! 4. **Normalized Metadata + Version Signature (`strength = "normalized"`)**:
//!    - Preserves version distinctions (`live`, `remix`, `radio edit`, `deluxe`, `reissue`,
//!      `remaster(ed)`, `extended`, `acoustic`, `instrumental`, `demo`) via [`version_signature`]
//!      so a live or remastered recording is never collapsed into a studio version.
//! 5. **Provider-Scoped Fallback (`strength = "provider"`)**: Retains a unique per-provider
//!    identity when metadata is insufficient for a safe cross-provider merge.

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::providers::models::{IdentityHints, TrackArtistCredit};

static DISTINCT_VERSION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(live|remix|radio edit|deluxe|reissue|remaster(?:ed)?|extended|acoustic|instrumental|demo)\b",
    )
    .expect("valid version regex")
});

static FEATURING_SUFFIX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:\s*\((?:feat\.?|featuring|ft\.?)\s+[^)]*\)|\s*(?:[-,]\s*)?(?:feat\.?|featuring|ft\.?)\s+.+)$",
    )
    .expect("valid featuring suffix regex")
});

static TRACK_DISC_PREFIX_RE_1: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:(?:cd|disc|d)?\d+[-._ ]+)?\d+[\s._-]+").expect("valid prefix regex 1")
});

static TRACK_DISC_PREFIX_RE_2: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:[a-d]\d+|\d+)[\s._-]+").expect("valid prefix regex 2")
});

static FILE_EXT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\.[a-z0-9]+(?:$|\?)").expect("valid ext regex"));

/// Entity type for [`UnifiedCatalogItem`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogEntityType {
    /// Artist record.
    Artist,
    /// Album record.
    Album,
    /// Track record.
    Track,
    /// Playlist record.
    Playlist,
}

impl CatalogEntityType {
    /// Returns the lowercase wire label (`"artist"`, `"album"`, `"track"`, `"playlist"`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Artist => "artist",
            Self::Album => "album",
            Self::Track => "track",
            Self::Playlist => "playlist",
        }
    }
}

/// Confidence tier of a derived [`CanonicalIdentity`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IdentityStrength {
    /// Matched via MusicBrainz UUID.
    Musicbrainz,
    /// Matched via ISRC code.
    Isrc,
    /// Matched via UPC barcode.
    Upc,
    /// Matched via normalized title/artist/album + version signature.
    Normalized,
    /// Scoped to a single provider instance.
    Provider,
}

impl IdentityStrength {
    /// Returns the wire string (`"musicbrainz"`, `"isrc"`, `"upc"`, `"normalized"`, `"provider"`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Musicbrainz => "musicbrainz",
            Self::Isrc => "isrc",
            Self::Upc => "upc",
            Self::Normalized => "normalized",
            Self::Provider => "provider",
        }
    }
}

/// Deterministic canonical identity hash (`canonical_<24 chars>`) and its derivation strength.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalIdentity {
    /// Opaque hash identifier (`canonical_...`).
    pub id: String,
    /// Strength tier used to derive `id`.
    pub strength: IdentityStrength,
}

/// Unified catalog/search item representation used by [`derive_canonical_identity`]
/// and [`crate::catalog::merge`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedCatalogItem {
    /// Item ID (`md_...` or external ID).
    pub id: String,
    /// Entity kind (`artist`, `album`, `track`).
    #[serde(rename = "type")]
    pub item_type: CatalogEntityType,
    /// Provider identifier (`"library"`, `"deezer"`, `"itunes"`, `"spotify"`, etc.).
    pub provider: String,
    /// Primary title (track title, album name, or artist name).
    pub title: String,
    /// Primary artist name (for albums and tracks).
    pub artist: Option<String>,
    /// Multi-artist credits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist_credits: Option<Vec<TrackArtistCredit>>,
    /// Album title (for tracks).
    pub album: Option<String>,
    /// Track duration in seconds, if known.
    pub duration_seconds: Option<u32>,
    /// Cover artwork URL, if any.
    pub artwork: Option<String>,
    /// Optional cross-provider identity hints (`musicBrainzId`, `isrc`, `upc`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_hints: Option<IdentityHints>,
    /// Optional pre-computed canonical identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<CanonicalIdentity>,
}

/// Candidate container file metadata matched against a target track via [`match_container_file`].
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerFileMetadata {
    /// Relative or full path inside the container/archive.
    pub path: Option<String>,
    /// File name.
    pub name: Option<String>,
    /// Embedded tag title, if inspected.
    pub title: Option<String>,
    /// Embedded tag artist, if inspected.
    pub artist: Option<String>,
    /// Embedded tag album, if inspected.
    pub album: Option<String>,
    /// File duration in seconds, if inspected.
    pub duration_seconds: Option<u32>,
}

/// Normalizes music metadata text for deterministic comparison, matching
/// `normalizeMusicText()` in `server/src/domain/music-identity.ts`:
/// 1. NFKD Unicode decomposition and removal of combining diacritical marks (`\u{0300}..=\u{036f}`).
/// 2. Replaces `&` with `" and "`.
/// 3. Strips trailing `(feat. ...)` / `- featuring ...` suffixes.
/// 4. Replaces non-alphanumeric runs with a single space, trims, and lowercases.
#[must_use]
pub fn normalize_music_text(value: Option<&str>) -> String {
    let Some(raw) = value else {
        return String::new();
    };
    if raw.is_empty() {
        return String::new();
    }

    let decomposed: String = raw
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect();

    let ampersand_expanded = decomposed.replace('&', " and ");
    let without_feat = FEATURING_SUFFIX_RE.replace(&ampersand_expanded, "");

    let mut normalized = String::with_capacity(without_feat.len());
    let mut prev_space = true;
    for ch in without_feat.chars() {
        if ch.is_alphanumeric() {
            for lower in ch.to_lowercase() {
                normalized.push(lower);
            }
            prev_space = false;
        } else if !prev_space {
            normalized.push(' ');
            prev_space = true;
        }
    }

    normalized.trim().to_owned()
}

/// Extracts and sorts distinct release/recording version markers (`live`, `remix`,
/// `remastered`, `acoustic`, etc.) so distinct versions never collide on normalized title keys.
#[must_use]
pub fn version_signature(value: Option<&str>) -> String {
    let Some(raw) = value else {
        return String::new();
    };
    let mut tokens: Vec<String> = DISTINCT_VERSION_RE
        .find_iter(raw)
        .map(|m| normalize_music_text(Some(m.as_str())))
        .filter(|s| !s.is_empty())
        .collect();
    tokens.sort();
    tokens.join("+")
}

fn opaque_identity(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    let encoded = URL_SAFE_NO_PAD.encode(digest);
    let prefix: String = encoded.chars().take(24).collect();
    format!("canonical_{prefix}")
}

/// Derives a deterministic [`CanonicalIdentity`] for `item` following the priority order:
/// `musicBrainzId` -> `isrc` (tracks) -> `upc` (albums) -> normalized metadata -> provider fallback.
#[must_use]
pub fn derive_canonical_identity(item: &UnifiedCatalogItem) -> CanonicalIdentity {
    if let Some(ref hints) = item.identity_hints {
        if let Some(ref mbid) = hints.music_brainz_id
            && !mbid.trim().is_empty()
        {
            let key = format!(
                "{}:musicbrainz:{}",
                item.item_type.as_str(),
                normalize_music_text(Some(mbid))
            );
            return CanonicalIdentity {
                id: opaque_identity(&key),
                strength: IdentityStrength::Musicbrainz,
            };
        }
        if item.item_type == CatalogEntityType::Track
            && let Some(ref isrc) = hints.isrc
            && !isrc.trim().is_empty()
        {
            let key = format!("track:isrc:{}", normalize_music_text(Some(isrc)));
            return CanonicalIdentity {
                id: opaque_identity(&key),
                strength: IdentityStrength::Isrc,
            };
        }
        if item.item_type == CatalogEntityType::Album
            && let Some(ref upc) = hints.upc
            && !upc.trim().is_empty()
        {
            let key = format!("album:upc:{}", normalize_music_text(Some(upc)));
            return CanonicalIdentity {
                id: opaque_identity(&key),
                strength: IdentityStrength::Upc,
            };
        }
    }

    let title = normalize_music_text(Some(&item.title));
    let artist = normalize_music_text(item.artist.as_deref());
    let album = normalize_music_text(item.album.as_deref());
    let combined_for_version = format!("{} {}", item.title, item.album.as_deref().unwrap_or(""));
    let version = version_signature(Some(&combined_for_version));

    let normalized_key = match item.item_type {
        CatalogEntityType::Artist if !title.is_empty() => Some(format!("artist:{title}")),
        CatalogEntityType::Album if !title.is_empty() && !artist.is_empty() => {
            Some(format!("album:{artist}:{title}:{version}"))
        }
        CatalogEntityType::Track
            if !title.is_empty() && !artist.is_empty() && !album.is_empty() =>
        {
            Some(format!("track:{artist}:{album}:{title}:{version}"))
        }
        _ => None,
    };

    if let Some(key) = normalized_key {
        return CanonicalIdentity {
            id: opaque_identity(&key),
            strength: IdentityStrength::Normalized,
        };
    }

    let fallback_key = format!(
        "provider:{}:{}:{}",
        item.item_type.as_str(),
        item.provider,
        item.id
    );
    CanonicalIdentity {
        id: opaque_identity(&fallback_key),
        strength: IdentityStrength::Provider,
    }
}

/// Extracts a clean track title from a file path by stripping directory components,
/// file extensions, leading disc/track numbers (`"CD1-03 "`, `"03 - "`, `"1-03. "`),
/// and an optional leading `"<artist> - "` prefix.
#[must_use]
pub fn extract_track_title_from_path(file_path: &str, artist: Option<&str>) -> String {
    if file_path.is_empty() {
        return String::new();
    }
    let file_name = file_path.rsplit('/').next().unwrap_or(file_path);
    let base_name = FILE_EXT_RE.replace(file_name, "").trim().to_owned();

    let step1 = TRACK_DISC_PREFIX_RE_1.replace(&base_name, "");
    let mut without_prefix = TRACK_DISC_PREFIX_RE_2.replace(&step1, "").into_owned();

    if let Some(artist_name) = artist
        && !artist_name.trim().is_empty()
    {
        let pattern = format!(r"(?i)^{}\s*-\s*", regex::escape(artist_name.trim()));
        if let Ok(re) = Regex::new(&pattern) {
            without_prefix = re.replace(&without_prefix, "").into_owned();
        }
    }

    let trimmed = without_prefix.trim();
    if trimmed.is_empty() {
        base_name
    } else {
        trimmed.to_owned()
    }
}

/// Matches a container file entry against a target track using normalized title,
/// version signature protection, artist overlap, and a $\pm 20\text{ s}$ duration tolerance.
#[must_use]
pub fn match_container_file(target: &UnifiedCatalogItem, file: &ContainerFileMetadata) -> bool {
    let file_path = file
        .path
        .as_deref()
        .or(file.name.as_deref())
        .unwrap_or_default();
    let extracted_title = extract_track_title_from_path(file_path, None);
    let file_title = file.title.as_deref().unwrap_or(&extracted_title);

    let requested_title = normalize_music_text(Some(&target.title));
    if requested_title.is_empty() {
        return false;
    }

    let normalized_file_title = normalize_music_text(Some(file_title));
    let normalized_extracted = normalize_music_text(Some(&extracted_title));
    let raw_file_name = file_path.rsplit('/').next().unwrap_or(file_path);
    let raw_base = FILE_EXT_RE.replace(raw_file_name, "");
    let normalized_raw = normalize_music_text(Some(&raw_base));

    let requested_version = version_signature(Some(&target.title));
    let candidate_version_source = file
        .title
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(if !raw_base.is_empty() {
            &raw_base
        } else {
            file_path
        });
    if requested_version != version_signature(Some(candidate_version_source)) {
        return false;
    }

    let requested_artist = normalize_music_text(target.artist.as_deref());
    let file_artist = normalize_music_text(file.artist.as_deref());
    if !requested_artist.is_empty() && !file_artist.is_empty() {
        let artist_matches = file_artist == requested_artist
            || file_artist.contains(&requested_artist)
            || requested_artist.contains(&file_artist)
            || normalized_raw.contains(&requested_artist);
        if !artist_matches {
            return false;
        }
    }

    let exact_title_match = normalized_file_title == requested_title
        || normalized_extracted == requested_title;
    let combined_artist_title = format!("{requested_artist} {requested_title}");
    let artist_title_match = !requested_artist.is_empty()
        && (normalized_extracted == combined_artist_title
            || normalized_raw == combined_artist_title
            || normalized_file_title == combined_artist_title);

    let prefix_with_space = format!("{requested_title} ");
    let suffix_with_space = format!(" {requested_title}");
    let boundary_match = normalized_extracted.starts_with(&prefix_with_space)
        || normalized_extracted.ends_with(&suffix_with_space)
        || (!normalized_file_title.is_empty()
            && (normalized_file_title.starts_with(&prefix_with_space)
                || normalized_file_title.ends_with(&suffix_with_space)));

    if !(exact_title_match || artist_title_match || boundary_match) {
        return false;
    }

    if let (Some(req_dur), Some(file_dur)) = (target.duration_seconds, file.duration_seconds)
        && req_dur > 0
        && file_dur > 0
        && req_dur.abs_diff(file_dur) > 20
    {
        return false;
    }

    true
}
