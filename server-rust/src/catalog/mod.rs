//! # Catalog Federation, Identity & Source Resolution (`catalog`)
//!
//! Exports deterministic music identity derivation (`identity`), multi-source
//! catalog merging (`merge`), SQLite library identity mapping (`library`),
//! ordered stream/artwork source resolution (`resolver`), and multi-provider
//! catalog fan-out (`service`).

pub mod identity;
pub mod library;
pub mod merge;
pub mod resolver;
pub mod service;

pub use identity::{
    CanonicalIdentity, CatalogEntityType, ContainerFileMetadata, IdentityStrength,
    UnifiedCatalogItem, derive_canonical_identity, extract_track_title_from_path,
    match_container_file, normalize_music_text, version_signature,
};
pub use library::{LibraryItemType, LibraryService, SourceRef, TrackContentHint};
pub use merge::{
    find_matching_external_album, find_matching_external_artist, merge_album_tracks,
    merge_artist_albums, recordings_match,
};
pub use resolver::{CandidateSource, SourceResolver, SourceUnavailableError};
pub use service::{
    Availability, AvailabilityState, Available, CatalogListResult, CatalogSearchResult,
    CatalogService, SourceOption,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::IdentityHints;

    fn sample_track(
        id: &str,
        provider: &str,
        title: &str,
        artist: &str,
        album: &str,
        duration_seconds: Option<u32>,
        isrc: Option<&str>,
    ) -> UnifiedCatalogItem {
        UnifiedCatalogItem {
            id: id.to_owned(),
            item_type: CatalogEntityType::Track,
            provider: provider.to_owned(),
            title: title.to_owned(),
            artist: Some(artist.to_owned()),
            artist_credits: None,
            album: Some(album.to_owned()),
            duration_seconds,
            artwork: None,
            identity_hints: isrc.map(|code| IdentityHints {
                music_brainz_id: None,
                isrc: Some(code.to_owned()),
                upc: None,
            }),
            identity: None,
        }
    }

    #[test]
    fn normalizes_music_text_and_preserves_version_signatures() {
        assert_eq!(
            normalize_music_text(Some("  Björk & Thom Yorke — I've Seen It All (feat. Yorke) ")),
            "bjork and thom yorke i ve seen it all"
        );
        assert_eq!(
            version_signature(Some("Hotel California (Live Acoustic Remastered)")),
            "acoustic+live+remastered"
        );
        assert_eq!(
            extract_track_title_from_path("californication/CD1-03 - Scar Tissue.flac", None),
            "Scar Tissue"
        );
    }

    #[test]
    fn merges_local_and_catalog_tracks_without_collapsing_distinct_versions_or_isrcs() {
        let local_studio = sample_track(
            "md_local_1",
            "library",
            "Everlong",
            "Foo Fighters",
            "The Colour and the Shape",
            Some(250),
            Some("USRW29700011"),
        );
        let catalog_studio = sample_track(
            "ext_spot_1",
            "spotify",
            "Everlong",
            "Foo Fighters",
            "The Colour and the Shape",
            Some(251),
            Some("USRW29700011"),
        );
        let catalog_acoustic = sample_track(
            "ext_spot_2",
            "spotify",
            "Everlong (Acoustic)",
            "Foo Fighters",
            "The Colour and the Shape",
            Some(250),
            None,
        );
        let catalog_different_isrc = sample_track(
            "ext_spot_3",
            "spotify",
            "Everlong",
            "Foo Fighters",
            "The Colour and the Shape",
            Some(250),
            Some("USRW29999999"),
        );

        assert!(recordings_match(&local_studio, &catalog_studio));
        assert!(!recordings_match(&local_studio, &catalog_acoustic));
        assert!(!recordings_match(&local_studio, &catalog_different_isrc));

        let merged = merge_album_tracks(
            &[local_studio],
            &[catalog_studio, catalog_acoustic],
            true,
        );
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].id, "md_local_1");
        assert_eq!(merged[0].provider, "library");
        assert_eq!(merged[1].id, "ext_spot_2");
    }
}
