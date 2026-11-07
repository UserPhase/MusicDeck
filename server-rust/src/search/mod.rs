//! # Federated Search Models, Deduplication & Spotify Provider (`search`)
//!
//! Exports unified search models (`models`), canonical & fuzzy deduplication
//! (`deduplication`), and the Spotify client-credentials search provider (`spotify`).

pub mod deduplication;
pub mod models;
pub mod spotify;

pub use deduplication::{
    dedupe_keyless_search_results, deduplicate_unified_search_groups, fuzzy_track_match_score,
    levenshtein_distance, merge_availability, merge_metadata, merge_result, merge_sources,
    normalized_string_similarity, preferred_provider, search_identity,
};
pub use models::{
    SearchMode, SearchOptions, SearchProvider, SearchProviderKind, SearchProviderResult,
    SearchProviderTestResult, SearchResultMetadata, SearchResultSource, SearchResultType,
    UnifiedSearchGroups, UnifiedSearchResult, group_search_results, to_album_search_result,
    to_artist_search_result, to_legacy_search_response, to_playlist_search_result,
    to_track_search_result,
};
pub use spotify::{
    SPOTIFY_SEARCH_URL, SPOTIFY_TIMEOUT_MS, SPOTIFY_TOKEN_URL, SpotifyAuthClient, SpotifyAuthError,
    SpotifyAuthStage, SpotifyCredentials, SpotifySearchProvider, describe_spotify_error_body,
    resolve_spotify_credentials,
};
