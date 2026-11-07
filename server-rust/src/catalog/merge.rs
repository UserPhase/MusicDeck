//! # Multi-Source Catalog Federation & Deduplication (`catalog::merge`)
//!
//! Complete Rust port of `server/src/domain/catalog-merge.ts`.
//!
//! ## Deduplication & Merge Rules
//! 1. **Strong Identifier Priority (`ISRC` / `MusicBrainz`)**:
//!    - If both `local_track` and `catalog_track` carry matching `musicBrainzId` or `isrc`
//!      identifiers, [`recordings_match`] immediately returns `true`.
//!    - Conversely, if both carry the **same** identifier scheme (`isrc` or `musicbrainz`)
//!      with **different** values, [`recordings_match`] returns `false` even if their titles
//!      appear identical (preventing distinct recordings from colliding).
//! 2. **Normalized Title + Version Signature + Artist Credit + Duration Check**:
//!    - When strong IDs are absent, tracks match only when:
//!      - `title_key(local.title) == title_key(catalog.title)` (`normalize_music_text` + `version_signature`),
//!      - Primary artist or any credited artist matches after normalization, and
//!      - Duration difference is within $\pm 20\text{ seconds}$ (when both durations are non-zero).

use std::collections::HashSet;

use crate::catalog::identity::{
    CatalogEntityType, IdentityStrength, UnifiedCatalogItem, normalize_music_text,
    version_signature,
};

fn title_key(title: &str) -> String {
    format!(
        "{}|{}",
        normalize_music_text(Some(title)),
        version_signature(Some(title))
    )
}

fn strong_recording_ids(track: &UnifiedCatalogItem) -> HashSet<String> {
    let mut ids = HashSet::new();
    if let Some(ref hints) = track.identity_hints {
        if let Some(ref mbid) = hints.music_brainz_id {
            let norm = normalize_music_text(Some(mbid));
            if !norm.is_empty() {
                ids.insert(format!("musicbrainz:{norm}"));
            }
        }
        if let Some(ref isrc) = hints.isrc {
            let norm = normalize_music_text(Some(isrc));
            if !norm.is_empty() {
                ids.insert(format!("isrc:{norm}"));
            }
        }
    }
    if let Some(ref ident) = track.identity
        && matches!(
            ident.strength,
            IdentityStrength::Musicbrainz | IdentityStrength::Isrc
        )
    {
        ids.insert(format!("{}:{}", ident.strength.as_str(), ident.id));
    }
    ids
}

/// Determines whether `local_track` and `catalog_track` represent the same musical
/// recording, respecting strong IDs (`ISRC`/`MusicBrainz`), version signatures,
/// artist credits, and a 20-second duration tolerance.
#[must_use]
pub fn recordings_match(
    local_track: &UnifiedCatalogItem,
    catalog_track: &UnifiedCatalogItem,
) -> bool {
    if local_track.item_type != CatalogEntityType::Track
        || catalog_track.item_type != CatalogEntityType::Track
    {
        return false;
    }

    let local_strong = strong_recording_ids(local_track);
    let catalog_strong = strong_recording_ids(catalog_track);

    if local_strong.iter().any(|id| catalog_strong.contains(id)) {
        return true;
    }

    for scheme in ["isrc:", "musicbrainz:"] {
        let local_has = local_strong.iter().any(|id| id.starts_with(scheme));
        let catalog_has = catalog_strong.iter().any(|id| id.starts_with(scheme));
        if local_has && catalog_has {
            return false;
        }
    }

    if title_key(&local_track.title) != title_key(&catalog_track.title) {
        return false;
    }

    let local_artist = normalize_music_text(local_track.artist.as_deref());
    let catalog_artist = normalize_music_text(catalog_track.artist.as_deref());
    if local_artist.is_empty() || catalog_artist.is_empty() {
        return false;
    }

    let artist_matches = local_artist == catalog_artist
        || local_track.artist_credits.as_ref().is_some_and(|credits| {
            credits
                .iter()
                .any(|c| normalize_music_text(Some(&c.name)) == catalog_artist)
        })
        || catalog_track.artist_credits.as_ref().is_some_and(|credits| {
            credits
                .iter()
                .any(|c| normalize_music_text(Some(&c.name)) == local_artist)
        });

    if !artist_matches {
        return false;
    }

    match (local_track.duration_seconds, catalog_track.duration_seconds) {
        (Some(ld), Some(cd)) if ld > 0 && cd > 0 => ld.abs_diff(cd) <= 20,
        _ => true,
    }
}

/// Merges local playable tracks with external catalog tracks for the same album.
///
/// Matched catalog tracks adopt the local track's `id`, `provider`, and `artwork`
/// so they play directly from the local library, while unmatched catalog tracks
/// remain visible as undownloaded album entries.
#[must_use]
pub fn merge_album_tracks(
    local_tracks: &[UnifiedCatalogItem],
    catalog_tracks: &[UnifiedCatalogItem],
    append_unmatched_local: bool,
) -> Vec<UnifiedCatalogItem> {
    let mut matched_local_ids = HashSet::new();
    let mut merged = Vec::with_capacity(catalog_tracks.len() + local_tracks.len());

    for catalog_track in catalog_tracks {
        if catalog_track.item_type != CatalogEntityType::Track {
            continue;
        }
        if let Some(local_track) = local_tracks
            .iter()
            .find(|candidate| recordings_match(candidate, catalog_track))
        {
            matched_local_ids.insert(local_track.id.clone());
            let mut combined = catalog_track.clone();
            combined.id.clone_from(&local_track.id);
            combined.provider.clone_from(&local_track.provider);
            if local_track.artwork.is_some() {
                combined.artwork.clone_from(&local_track.artwork);
            }
            merged.push(combined);
        } else {
            merged.push(catalog_track.clone());
        }
    }

    if append_unmatched_local {
        for local_track in local_tracks {
            if !matched_local_ids.contains(&local_track.id) {
                merged.push(local_track.clone());
            }
        }
    }

    merged
}

/// Merges local artist albums with external catalog albums, appending undownloaded
/// releases whose `title_key` is not already present locally.
#[must_use]
pub fn merge_artist_albums(
    local_albums: &[UnifiedCatalogItem],
    catalog_albums: &[UnifiedCatalogItem],
) -> Vec<UnifiedCatalogItem> {
    let local_keys: HashSet<String> = local_albums
        .iter()
        .map(|album| title_key(&album.title))
        .collect();

    let mut merged = local_albums.to_vec();
    for album in catalog_albums {
        if album.item_type == CatalogEntityType::Album && !local_keys.contains(&title_key(&album.title))
        {
            merged.push(album.clone());
        }
    }
    merged
}

/// Finds the first external album matching `album_name` and optional `artist_name`.
#[must_use]
pub fn find_matching_external_album<'a>(
    results: &'a [UnifiedCatalogItem],
    album_name: &str,
    artist_name: Option<&str>,
) -> Option<&'a UnifiedCatalogItem> {
    let target_title = normalize_music_text(Some(album_name));
    let target_artist = normalize_music_text(artist_name);

    results.iter().find(|item| {
        item.item_type == CatalogEntityType::Album
            && normalize_music_text(Some(&item.title)) == target_title
            && (target_artist.is_empty()
                || normalize_music_text(item.artist.as_deref()) == target_artist)
    })
}

/// Finds the first external artist matching `artist_name`.
#[must_use]
pub fn find_matching_external_artist<'a>(
    results: &'a [UnifiedCatalogItem],
    artist_name: &str,
) -> Option<&'a UnifiedCatalogItem> {
    let target_title = normalize_music_text(Some(artist_name));
    results.iter().find(|item| {
        item.item_type == CatalogEntityType::Artist
            && normalize_music_text(Some(&item.title)) == target_title
    })
}
