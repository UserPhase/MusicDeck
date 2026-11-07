//! # Search Deduplication, Fuzzy Similarity & Multi-Source Merging (`search::deduplication`)
//!
//! Ports `server/src/domain/search-deduplication.ts` and the keyless deduplication
//! helpers from `server/src/domain/search-provider-registry.ts`, plus bounded
//! Levenshtein edit-distance similarity scoring for fuzzy search ranking.

use std::collections::HashMap;

use unicode_normalization::UnicodeNormalization;

use crate::catalog::{
    Availability, AvailabilityState, derive_canonical_identity, normalize_music_text,
    version_signature,
};
use crate::search::models::{
    SearchProviderKind, SearchResultMetadata, SearchResultSource, UnifiedSearchGroups,
    UnifiedSearchResult,
};

/// Selects the higher-priority [`SearchProviderKind`] (`library < musicdeck < external < plugin`).
#[must_use]
pub const fn preferred_provider(
    current: SearchProviderKind,
    incoming: SearchProviderKind,
) -> SearchProviderKind {
    if incoming.rank() < current.rank() {
        incoming
    } else {
        current
    }
}

/// Merges two [`SearchResultSource`] descriptors, deduplicating `options` by ID
/// and preserving `"library"` > `"musicdeck"` > `"external"` priority.
#[must_use]
pub fn merge_sources(
    current: &SearchResultSource,
    incoming: &SearchResultSource,
) -> SearchResultSource {
    let mut options = Vec::new();
    for opt in current
        .options
        .iter()
        .flatten()
        .chain(incoming.options.iter().flatten())
    {
        if !options
            .iter()
            .any(|existing: &crate::catalog::SourceOption| existing.id == opt.id)
        {
            options.push(opt.clone());
        }
    }

    let has_external = current.kind == "external"
        || incoming.kind == "external"
        || current.external_available == Some(true)
        || incoming.external_available == Some(true);

    let kind = if current.kind == "library" || incoming.kind == "library" {
        String::from("library")
    } else if current.kind == "musicdeck" || incoming.kind == "musicdeck" {
        String::from("musicdeck")
    } else {
        String::from("external")
    };

    SearchResultSource {
        kind,
        count: current.count.max(incoming.count),
        options: (!options.is_empty()).then_some(options),
        external_available: has_external.then_some(true),
    }
}

/// Merges two [`Availability`] structs, promoting `Available > Degraded > Unavailable`.
#[must_use]
pub fn merge_availability(
    current: Option<&Availability>,
    incoming: Option<&Availability>,
) -> Option<Availability> {
    match (current, incoming) {
        (None, None) => None,
        (Some(c), None) => Some(c.clone()),
        (None, Some(i)) => Some(i.clone()),
        (Some(c), Some(i)) => {
            let state = if c.state == AvailabilityState::Available
                || i.state == AvailabilityState::Available
            {
                AvailabilityState::Available
            } else if c.state == AvailabilityState::Degraded
                || i.state == AvailabilityState::Degraded
            {
                AvailabilityState::Degraded
            } else {
                AvailabilityState::Unavailable
            };

            Some(Availability {
                state,
                connection_id: c.connection_id.clone(),
                source_count: c.source_count + i.source_count,
                available_source_count: c.available_source_count + i.available_source_count,
                library_available: c.library_available || i.library_available,
            })
        }
    }
}

/// Merges two [`SearchResultMetadata`] records, preferring fields from `primary`
/// and filling missing fields from `secondary`.
#[must_use]
pub fn merge_metadata(
    primary: &SearchResultMetadata,
    secondary: &SearchResultMetadata,
) -> SearchResultMetadata {
    SearchResultMetadata {
        source_server: primary
            .source_server
            .clone()
            .or_else(|| secondary.source_server.clone()),
        audio_metadata: primary
            .audio_metadata
            .clone()
            .or_else(|| secondary.audio_metadata.clone()),
        genres: primary.genres.clone().or_else(|| secondary.genres.clone()),
        normalization_gain_db: primary
            .normalization_gain_db
            .or(secondary.normalization_gain_db),
        loudness: primary.loudness.or(secondary.loudness),
        duration_seconds: primary.duration_seconds.or(secondary.duration_seconds),
        year: primary.year.or(secondary.year),
        song_count: primary.song_count.or(secondary.song_count),
        artist_id: primary
            .artist_id
            .clone()
            .or_else(|| secondary.artist_id.clone()),
        album_id: primary
            .album_id
            .clone()
            .or_else(|| secondary.album_id.clone()),
        recommendation_reason: primary
            .recommendation_reason
            .clone()
            .or_else(|| secondary.recommendation_reason.clone()),
        spotify_track_url: primary
            .spotify_track_url
            .clone()
            .or_else(|| secondary.spotify_track_url.clone()),
        spotify_url: primary
            .spotify_url
            .clone()
            .or_else(|| secondary.spotify_url.clone()),
        spotify_track_id: primary
            .spotify_track_id
            .clone()
            .or_else(|| secondary.spotify_track_id.clone()),
        spotify_id: primary
            .spotify_id
            .clone()
            .or_else(|| secondary.spotify_id.clone()),
        deezer_track_id: primary.deezer_track_id.or(secondary.deezer_track_id),
        deezer_track_url: primary
            .deezer_track_url
            .clone()
            .or_else(|| secondary.deezer_track_url.clone()),
        itunes_track_id: primary.itunes_track_id.or(secondary.itunes_track_id),
        isrc: primary.isrc.clone().or_else(|| secondary.isrc.clone()),
    }
}

/// Merges two [`UnifiedSearchResult`] records sharing the same canonical identity.
#[must_use]
pub fn merge_result(
    current: &UnifiedSearchResult,
    incoming: &UnifiedSearchResult,
) -> UnifiedSearchResult {
    let winner = preferred_provider(current.provider, incoming.provider);
    let use_incoming = winner == incoming.provider && current.provider != incoming.provider;
    let (primary, secondary) = if use_incoming {
        (incoming, current)
    } else {
        (current, incoming)
    };

    let mut providers = Vec::new();
    for p in current
        .providers
        .clone()
        .unwrap_or_else(|| vec![current.provider])
        .into_iter()
        .chain(
            incoming
                .providers
                .clone()
                .unwrap_or_else(|| vec![incoming.provider]),
        )
    {
        if !providers.contains(&p) {
            providers.push(p);
        }
    }

    let in_library = primary.in_library.unwrap_or(false) || secondary.in_library.unwrap_or(false);
    let identity = derive_canonical_identity(&current.to_catalog_item());

    UnifiedSearchResult {
        item_type: primary.item_type,
        id: primary.id.clone(),
        title: primary.title.clone(),
        subtitle: primary
            .subtitle
            .clone()
            .or_else(|| secondary.subtitle.clone()),
        artist: primary.artist.clone().or_else(|| secondary.artist.clone()),
        artist_credits: primary
            .artist_credits
            .clone()
            .or_else(|| secondary.artist_credits.clone()),
        album: primary.album.clone().or_else(|| secondary.album.clone()),
        artwork: primary
            .artwork
            .clone()
            .or_else(|| secondary.artwork.clone()),
        preview_url: primary
            .preview_url
            .clone()
            .or_else(|| secondary.preview_url.clone()),
        provider: winner,
        source: merge_sources(&current.source, &incoming.source),
        availability: merge_availability(
            current.availability.as_ref(),
            incoming.availability.as_ref(),
        ),
        identity: Some(identity),
        providers: Some(providers),
        in_library: Some(in_library),
        local_track_id: primary
            .local_track_id
            .clone()
            .or_else(|| secondary.local_track_id.clone()),
        local_album_id: primary
            .local_album_id
            .clone()
            .or_else(|| secondary.local_album_id.clone()),
        metadata: merge_metadata(&primary.metadata, &secondary.metadata),
        identity_hints: None,
    }
}

/// Deterministically merges search results sharing the same canonical identity
/// within each group (`track`, `album`, `artist`, `playlist`), preserving first-seen
/// order while promoting `library` entries as the primary client-facing representative.
#[must_use]
pub fn deduplicate_unified_search_groups(groups: UnifiedSearchGroups) -> UnifiedSearchGroups {
    fn dedupe_vec(items: Vec<UnifiedSearchResult>) -> Vec<UnifiedSearchResult> {
        let mut order: Vec<String> = Vec::with_capacity(items.len());
        let mut by_identity: HashMap<String, UnifiedSearchResult> =
            HashMap::with_capacity(items.len());

        for mut item in items {
            let identity = derive_canonical_identity(&item.to_catalog_item());
            let key = identity.id.clone();
            item.identity = Some(identity);
            if item.providers.is_none() {
                item.providers = Some(vec![item.provider]);
            }

            if let Some(existing) = by_identity.get(&key) {
                let merged = merge_result(existing, &item);
                by_identity.insert(key, merged);
            } else {
                order.push(key.clone());
                item.identity_hints = None;
                by_identity.insert(key, item);
            }
        }

        order
            .into_iter()
            .filter_map(|key| by_identity.remove(&key))
            .collect()
    }

    UnifiedSearchGroups {
        track: dedupe_vec(groups.track),
        album: dedupe_vec(groups.album),
        artist: dedupe_vec(groups.artist),
        playlist: dedupe_vec(groups.playlist),
    }
}

/// Normalizes a search string using NFD decomposition, stripping diacritics (`\p{M}`)
/// and collapsing alphanumeric tokens (`[\p{L}\p{N}]+`).
///
/// Mirrors `searchIdentity(value)` in `server/src/domain/search-provider-registry.ts`.
#[must_use]
pub fn search_identity(value: Option<&str>) -> String {
    let fallback = value.unwrap_or("").trim().to_lowercase();
    if fallback.is_empty() {
        return String::from("unknown");
    }

    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in fallback.nfd() {
        if unicode_normalization::char::is_combining_mark(ch) {
            continue;
        }
        if ch.is_alphanumeric() {
            current.push(ch);
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }

    let joined = tokens.join(" ");
    if !joined.is_empty() {
        joined
    } else {
        fallback
    }
}

/// Deduplicates keyless external search results (Deezer primary + iTunes supplementary).
///
/// When an iTunes track collides with a Deezer track on `<search_identity(title)>::<search_identity(artist)>`,
/// Deezer remains the canonical result and inherits `preview_url` from iTunes if Deezer's preview was absent.
#[must_use]
pub fn dedupe_keyless_search_results(items: Vec<UnifiedSearchResult>) -> Vec<UnifiedSearchResult> {
    let mut result: Vec<UnifiedSearchResult> = Vec::with_capacity(items.len());
    let mut track_indexes: HashMap<String, usize> = HashMap::new();

    for item in items {
        if item.item_type != crate::search::models::SearchResultType::Track {
            result.push(item);
            continue;
        }

        let key = format!(
            "{}::{}",
            search_identity(Some(&item.title)),
            search_identity(item.artist.as_deref())
        );

        if let Some(&existing_index) = track_indexes.get(&key) {
            if result[existing_index].preview_url.is_none() && item.preview_url.is_some() {
                result[existing_index].preview_url = item.preview_url;
            }
        } else {
            track_indexes.insert(key, result.len());
            result.push(item);
        }
    }

    result
}

/// Computes the Wagner-Fischer Levenshtein edit distance between two normalized UTF-8 strings
/// in $O(\min(N, M))$ memory using a single rolling row buffer.
#[must_use]
pub fn levenshtein_distance(left: &str, right: &str) -> usize {
    if left == right {
        return 0;
    }
    let left_chars: Vec<char> = left.chars().collect();
    let right_chars: Vec<char> = right.chars().collect();
    if left_chars.is_empty() {
        return right_chars.len();
    }
    if right_chars.is_empty() {
        return left_chars.len();
    }

    let (short, long) = if left_chars.len() <= right_chars.len() {
        (&left_chars, &right_chars)
    } else {
        (&right_chars, &left_chars)
    };

    let mut prev_row: Vec<usize> = (0..=short.len()).collect();
    let mut curr_row: Vec<usize> = vec![0; short.len() + 1];

    for (i, &l_ch) in long.iter().enumerate() {
        curr_row[0] = i + 1;
        for (j, &s_ch) in short.iter().enumerate() {
            let cost = usize::from(l_ch != s_ch);
            curr_row[j + 1] = (curr_row[j] + 1)
                .min(prev_row[j + 1] + 1)
                .min(prev_row[j] + cost);
        }
        std::mem::swap(&mut prev_row, &mut curr_row);
    }

    prev_row[short.len()]
}

/// Normalized similarity ratio in `[0.0, 1.0]` derived from [`levenshtein_distance`].
#[must_use]
pub fn normalized_string_similarity(left: Option<&str>, right: Option<&str>) -> f64 {
    let norm_left = normalize_music_text(left);
    let norm_right = normalize_music_text(right);
    if norm_left.is_empty() && norm_right.is_empty() {
        return 1.0;
    }
    if norm_left.is_empty() || norm_right.is_empty() {
        return 0.0;
    }
    if norm_left == norm_right {
        return 1.0;
    }
    let max_len = norm_left.chars().count().max(norm_right.chars().count());
    let dist = levenshtein_distance(&norm_left, &norm_right);
    (1.0 - (dist as f64 / max_len as f64)).clamp(0.0, 1.0)
}

/// Computes a multi-factor fuzzy relevance & similarity score between two [`UnifiedSearchResult`] tracks,
/// enforcing version-signature protection (`live`, `remix`, `acoustic`, `instrumental`, `remastered`)
/// and duration tolerance windows (`<= 3s` exact bonus, `<= 8s` tolerance, `> 20s` penalty).
#[must_use]
pub fn fuzzy_track_match_score(
    reference: &UnifiedSearchResult,
    candidate: &UnifiedSearchResult,
) -> i32 {
    let mut score = 0_i32;

    if let (Some(id_a), Some(id_b)) = (&reference.identity, &candidate.identity) {
        if id_a.id == id_b.id {
            score += 100;
        }
    }

    let title_sim = normalized_string_similarity(Some(&reference.title), Some(&candidate.title));
    if (title_sim - 1.0).abs() < f64::EPSILON {
        score += 40;
    } else if title_sim >= 0.85 {
        score += 25;
    } else if title_sim >= 0.70 {
        score += 10;
    }

    let artist_sim =
        normalized_string_similarity(reference.artist.as_deref(), candidate.artist.as_deref());
    if (artist_sim - 1.0).abs() < f64::EPSILON {
        score += 30;
    } else if artist_sim >= 0.85 {
        score += 15;
    } else if candidate.artist.is_none() {
        score -= 15;
    }

    let album_sim =
        normalized_string_similarity(reference.album.as_deref(), candidate.album.as_deref());
    if (album_sim - 1.0).abs() < f64::EPSILON {
        score += 25;
    }

    if let (Some(d1), Some(d2)) = (
        reference.metadata.duration_seconds.filter(|&d| d > 0),
        candidate.metadata.duration_seconds.filter(|&d| d > 0),
    ) {
        let diff = d1.abs_diff(d2);
        if diff <= 3 {
            score += 20;
        } else if diff <= 8 {
            score += 10;
        } else if diff > 20 {
            score -= 30;
        }
    }

    if version_signature(Some(&reference.title)) != version_signature(Some(&candidate.title)) {
        score -= 50;
    }

    score
}
