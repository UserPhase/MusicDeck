use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateEnvironment {
    current_version: String,
    windows: bool,
    blocked_reason: Option<&'static str>,
}

#[tauri::command]
pub(crate) fn desktop_update_environment(app: AppHandle) -> UpdateEnvironment {
    #[cfg(target_os = "windows")]
    let per_user = tauri::utils::platform::bundle_type()
        == Some(tauri::utils::config::BundleType::Nsis)
        && std::env::current_exe()
            .ok()
            .zip(std::env::var_os("LOCALAPPDATA"))
            .is_some_and(|(exe, local_app_data)| {
                exe.starts_with(std::path::PathBuf::from(local_app_data))
            });
    #[cfg(not(target_os = "windows"))]
    let per_user = true;

    let has_key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| !key.trim().is_empty());
    let blocked_reason = if !has_key {
        Some("Signed updates are unavailable in this build.")
    } else if !per_user {
        Some("Install MusicDeck for your Windows user with the current NSIS setup executable to enable unattended updates.")
    } else {
        None
    };
    UpdateEnvironment {
        current_version: app.package_info().version.to_string(),
        windows: cfg!(target_os = "windows"),
        blocked_reason,
    }
}
