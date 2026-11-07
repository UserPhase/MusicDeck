//! # Core Background & Governance Services (`services`)
//!
//! Exports [`PrivacyManager`] and related runtime service managers.

pub mod favorites;
pub mod listening_activity;
pub mod privacy;
pub mod recently_played;

pub use favorites::{
    MediaFavoriteRecord, list_favorite_albums, list_favorite_track_ids, set_media_favorite,
    set_track_favorite,
};
pub use listening_activity::{
    ActivityPeriod, DEFAULT_LISTENING_THRESHOLD_SECONDS, HistoryCursor, ListeningActivityError,
    ListeningHistoryItem, ListeningHistoryResponse, PlaybackEventInput, PlaybackTrackSnapshot,
    RecordPlaybackOutcome, SCROBBLE_MAX_SECONDS, listening_history, listening_statistics,
    listening_threshold, record_playback, scrobble_point_seconds,
};
pub use privacy::{
    EffectivePrivacyPermissions, PRIVACY_POLICY_SETTING_KEY, PrivacyBlockCode, PrivacyCategory,
    PrivacyError, PrivacyManager, PrivacySettings, PrivacySnapshot, classify_outbound_url,
};
pub use recently_played::{
    LISTENING_WINDOW_DAYS, RECENTLY_PLAYED_LIMIT, RECENTLY_PLAYED_RETENTION, RecentlyPlayedEntry,
    add_recently_played, can_use_provider_history, list_recently_played_entries,
    listening_window_start_iso,
};
