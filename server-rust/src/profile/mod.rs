//! # User Taste Profile & Library Insights (`profile`)
//!
//! Exports [`TasteProfileManager`], [`TasteState`], [`TasteTarget`],
//! [`TasteProfileOverview`], [`TasteFeedbackFilter`], [`LibraryInsightsService`],
//! and catalog health auditing ([`audit_catalog`], [`count_issues`]).

pub mod insights;
pub mod taste;

pub use insights::{
    LibraryFilter, LibraryHealthCounts, LibraryHealthIssue, LibraryHealthIssueType, LibraryInsight,
    LibraryInsightsService, SavedLibraryFilter, audit_catalog, count_issues,
};
pub use taste::{
    TasteExcludedPlaylist, TasteExcludedTrack, TasteExclusionDecision, TasteFeedbackFilter,
    TasteHiddenItem, TasteProfileError, TasteProfileManager, TasteProfileOverview, TasteState,
    TasteTarget, taste_artist_id, taste_recording_key,
};
