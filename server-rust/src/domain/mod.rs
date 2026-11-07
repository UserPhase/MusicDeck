//! # Core Domain Logic (`domain`)
//!
//! Exports hierarchical settings management (`settings`) and upcoming catalog,
//! library, playlist, search, and acquisition modules.

pub mod settings;

pub use settings::{
    ALLOWED_SERVER_SETTINGS, ALLOWED_USER_SETTINGS, APP_NAME_MAX_LENGTH, APP_NAME_SETTING_KEY,
    DEFAULT_APP_NAME, LAYOUT_PRESETS, NORMALIZATION_TARGETS, PublicAppConfig,
    SCAN_SCHEDULE_SETTING_KEY, SettingRecord, SettingsError, get_normalization_target,
    get_public_app_config, list_server_settings, list_user_settings, update_public_app_config,
    update_server_settings, update_user_settings, validate_admin_user_settings_patch,
    validate_scan_schedule, validate_user_settings_patch,
};
