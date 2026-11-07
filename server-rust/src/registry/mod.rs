//! # Search & Playable Source Registries (`registry`)
//!
//! Exports playable source models & comparators (`playable_sources`),
//! 3-stage source candidate discovery & resolution (`source_discovery`),
//! opaque token-minting playable source registry (`source_providers`),
//! and federated search provider registry (`search_providers`).

pub mod playable_sources;
pub mod search_providers;
pub mod source_discovery;
pub mod source_providers;

pub use playable_sources::{
    PlayableSource, PlayableSourceAvailability, PlayableSourceQuality, PlayableSourceType,
    SourcePreference, SourceProvider, SourceProviderCapabilities, SourceProviderTestResult,
    SourceResolution, SourceResolutionOptions, compare_source_quality,
};
pub use search_providers::{
    AdminSearchProvider, DeezerSearchProvider, FederatedSearchOutcome, LibrarySearchProvider,
    PlaylistSearchProvider, SearchProviderRegistry, SearchProviderStatus,
};
pub use source_discovery::{
    AcquisitionInputs, CandidateResolveOptions, CandidateResolver, PipelineProviderSummary,
    SourceCandidate, SourceCandidateContainer, SourceCandidateKind, SourceContainerProvider,
    SourceDetailProvider, SourceDiscoveryOptions, SourceDiscoveryProvider, SourcePipelineProvider,
    SourcePipelineRegistry, is_album_container, matches_candidate, score_candidate,
    validated_playable_url,
};
pub use source_providers::{
    AdminSourceProvider, DeezerPreviewSourceProvider, ItunesPreviewSourceProvider,
    LibrarySourceProvider, PLAYABLE_SOURCE_TOKEN_TTL_MS, SOURCE_PROVIDER_RESOLVE_TIMEOUT_MS,
    SourceProviderRegistry,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{CanonicalIdentity, IdentityStrength};
    use crate::search::{
        SearchProviderKind, SearchResultMetadata, SearchResultSource, SearchResultType,
        UnifiedSearchGroups, UnifiedSearchResult, deduplicate_unified_search_groups,
        fuzzy_track_match_score, levenshtein_distance,
    };

    fn sample_search_track(
        id: &str,
        provider: SearchProviderKind,
        title: &str,
        artist: &str,
        album: &str,
        duration_seconds: Option<u32>,
    ) -> UnifiedSearchResult {
        UnifiedSearchResult {
            item_type: SearchResultType::Track,
            id: id.to_owned(),
            title: title.to_owned(),
            subtitle: Some(artist.to_owned()),
            artist: Some(artist.to_owned()),
            artist_credits: None,
            album: Some(album.to_owned()),
            artwork: None,
            preview_url: None,
            provider,
            source: SearchResultSource {
                kind: match provider {
                    SearchProviderKind::Library => String::from("library"),
                    SearchProviderKind::Musicdeck => String::from("musicdeck"),
                    _ => String::from("external"),
                },
                count: 1,
                options: None,
                external_available: (provider == SearchProviderKind::External).then_some(true),
            },
            availability: None,
            identity: None,
            providers: None,
            in_library: Some(provider == SearchProviderKind::Library),
            local_track_id: (provider == SearchProviderKind::Library).then(|| id.to_owned()),
            local_album_id: None,
            metadata: SearchResultMetadata {
                duration_seconds,
                ..SearchResultMetadata::default()
            },
            identity_hints: None,
        }
    }

    #[test]
    fn deduplicates_unified_search_groups_preferring_library_over_external() {
        let ext = sample_search_track(
            "external_deezer_track_100",
            SearchProviderKind::External,
            "Digital Love",
            "Daft Punk",
            "Discovery",
            Some(301),
        );
        let lib = sample_search_track(
            "md_track_1",
            SearchProviderKind::Library,
            "Digital Love",
            "Daft Punk",
            "Discovery",
            Some(301),
        );

        let groups = UnifiedSearchGroups {
            track: vec![ext, lib],
            ..UnifiedSearchGroups::default()
        };

        let deduped = deduplicate_unified_search_groups(groups);
        assert_eq!(deduped.track.len(), 1);
        let merged = &deduped.track[0];
        assert_eq!(merged.id, "md_track_1");
        assert_eq!(merged.provider, SearchProviderKind::Library);
        assert_eq!(merged.in_library, Some(true));
        assert_eq!(merged.source.external_available, Some(true));
        assert_eq!(
            merged.providers.as_deref(),
            Some(
                &[
                    SearchProviderKind::External,
                    SearchProviderKind::Library
                ][..]
            )
        );
    }

    #[test]
    fn scores_and_matches_candidates_with_version_and_ssrf_protection() {
        assert_eq!(levenshtein_distance("rammstein", "ramstein"), 1);
        assert!(validated_playable_url("https://cdn.example.com/audio/track.flac").is_some());
        assert!(validated_playable_url("http://cdn.example.com/audio/track.flac").is_none());
        assert!(validated_playable_url("https://127.0.0.1/audio/track.flac").is_none());
        assert!(validated_playable_url("https://192.168.1.50/audio/track.flac").is_none());

        let mut target = sample_search_track(
            "md_track_1",
            SearchProviderKind::Library,
            "Everlong",
            "Foo Fighters",
            "The Colour and the Shape",
            Some(250),
        );
        target.identity = Some(CanonicalIdentity {
            id: String::from("id_everlong"),
            strength: IdentityStrength::Normalized,
        });

        let studio_candidate = SourceCandidate {
            id: String::from("cand_1"),
            provider: String::from("archive"),
            kind: Some(SourceCandidateKind::Track),
            title: Some(String::from("Everlong")),
            artist: Some(String::from("Foo Fighters")),
            album: Some(String::from("The Colour and the Shape")),
            container: None,
            detail_url: None,
            metadata: None,
            duration_seconds: Some(251),
            file_size: Some(30_000_000),
            quality: Some(PlayableSourceQuality {
                codec: Some(String::from("FLAC")),
                lossless: Some(true),
                bitrate: Some(1000),
                ..PlayableSourceQuality::default()
            }),
            identity: None,
        };

        let live_candidate = SourceCandidate {
            title: Some(String::from("Everlong (Live at Wembley)")),
            ..studio_candidate.clone()
        };

        assert!(matches_candidate(&target, &studio_candidate));
        assert!(!matches_candidate(&target, &live_candidate));
        assert!(score_candidate(&target, &studio_candidate) > score_candidate(&target, &live_candidate));

        let live_search = sample_search_track(
            "md_track_2",
            SearchProviderKind::External,
            "Everlong (Live)",
            "Foo Fighters",
            "The Colour and the Shape",
            Some(250),
        );
        assert!(
            fuzzy_track_match_score(&target, &target)
                > fuzzy_track_match_score(&target, &live_search)
        );
    }
}
