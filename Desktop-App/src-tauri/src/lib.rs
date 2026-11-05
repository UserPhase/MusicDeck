pub mod config;
pub mod updater;

use config::{load_config, normalize_server_url, save_config, DesktopConfig};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use updater::{
    check_for_updates, download_and_verify_installer, launch_installer, UpdateCheckResponse,
};

pub struct DesktopState {
    pub config: Mutex<DesktopConfig>,
    pub quitting: AtomicBool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfigUpdate {
    pub server_url: Option<String>,
    pub close_to_tray: Option<bool>,
    pub start_minimized: Option<bool>,
    pub auto_check_updates: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerHealthResponse {
    pub reachable: bool,
    pub server_url: String,
    pub app_name: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatusPayload {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub is_playing: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublicConfigPayload {
    app_name: Option<String>,
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn desktop_get_config(state: State<'_, DesktopState>) -> Result<DesktopConfig, String> {
    let guard = state
        .config
        .lock()
        .map_err(|_| "Desktop configuration lock poisoned".to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
fn desktop_set_config(
    app: AppHandle,
    state: State<'_, DesktopState>,
    update: DesktopConfigUpdate,
) -> Result<DesktopConfig, String> {
    let mut guard = state
        .config
        .lock()
        .map_err(|_| "Desktop configuration lock poisoned".to_string())?;

    let candidate = DesktopConfig {
        server_url: update
            .server_url
            .unwrap_or_else(|| guard.server_url.clone()),
        close_to_tray: update.close_to_tray.unwrap_or(guard.close_to_tray),
        start_minimized: update.start_minimized.unwrap_or(guard.start_minimized),
        auto_check_updates: update
            .auto_check_updates
            .unwrap_or(guard.auto_check_updates),
    };

    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("Unable to resolve app config directory: {err}"))?;
    let saved = save_config(&config_dir, &candidate)?;
    *guard = saved.clone();
    let _ = app.emit("desktop://config-changed", &saved);

    Ok(saved)
}

#[tauri::command]
async fn desktop_check_server(server_url: String) -> Result<ServerHealthResponse, String> {
    let normalized = normalize_server_url(&server_url)?;
    if normalized.is_empty() {
        return Err("Server URL is required".to_string());
    }

    let endpoint = format!("{normalized}/api/public/config");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|err| format!("Failed to initialize HTTP client: {err}"))?;

    match client.get(&endpoint).send().await {
        Ok(response) if response.status().is_success() => {
            let payload = response.json::<PublicConfigPayload>().await.ok();
            Ok(ServerHealthResponse {
                reachable: true,
                server_url: normalized,
                app_name: payload
                    .and_then(|p| p.app_name)
                    .or_else(|| Some("MusicDeck".to_string())),
                error: None,
            })
        }
        Ok(response) => Ok(ServerHealthResponse {
            reachable: false,
            server_url: normalized,
            app_name: None,
            error: Some(format!("Server responded with HTTP {}", response.status())),
        }),
        Err(err) => Ok(ServerHealthResponse {
            reachable: false,
            server_url: normalized,
            app_name: None,
            error: Some(format!("Could not connect to MusicDeck server: {err}")),
        }),
    }
}

#[tauri::command]
fn desktop_update_playback(app: AppHandle, status: PlaybackStatusPayload) -> Result<(), String> {
    let title = status
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let artist = status
        .artist
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let window_title = match (title, artist) {
        (Some(track), Some(artist_name)) => format!("{track} • {artist_name} — MusicDeck"),
        (Some(track), None) => format!("{track} — MusicDeck"),
        _ => "MusicDeck".to_string(),
    };

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&window_title);
    }

    if let Some(tray) = app.tray_by_id("main-tray") {
        let state_label = if status.is_playing { "Playing" } else { "Paused" };
        let tooltip = match (title, artist) {
            (Some(track), Some(artist_name)) => {
                format!("MusicDeck ({state_label})\n{track} — {artist_name}")
            }
            (Some(track), None) => format!("MusicDeck ({state_label})\n{track}"),
            _ => "MusicDeck".to_string(),
        };
        let _ = tray.set_tooltip(Some(&tooltip));
    }

    Ok(())
}

#[tauri::command]
fn desktop_window_action(app: AppHandle, action: String) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("Main window is unavailable".to_string());
    };

    match action.as_str() {
        "minimize" => window.minimize().map_err(|e| e.to_string()),
        "toggle-maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize().map_err(|e| e.to_string())
            } else {
                window.maximize().map_err(|e| e.to_string())
            }
        }
        "close" => window.close().map_err(|e| e.to_string()),
        "show" => {
            show_main_window(&app);
            Ok(())
        }
        other => Err(format!("Unsupported window action: {other}")),
    }
}

#[tauri::command]
async fn desktop_check_for_updates(
    manifest_url: Option<String>,
) -> Result<UpdateCheckResponse, String> {
    Ok(check_for_updates(manifest_url.as_deref()).await)
}

#[tauri::command]
async fn desktop_install_update(
    app: AppHandle,
    state: State<'_, DesktopState>,
    installer_url: String,
    sha256: Option<String>,
) -> Result<(), String> {
    let _ = app.emit(
        "desktop://update-status",
        serde_json::json!({ "stage": "downloading" }),
    );

    let installer_path = download_and_verify_installer(&installer_url, sha256.as_deref())
        .await
        .map_err(|err| {
            let _ = app.emit(
                "desktop://update-status",
                serde_json::json!({ "stage": "error", "error": err }),
            );
            err
        })?;

    let _ = app.emit(
        "desktop://update-status",
        serde_json::json!({ "stage": "installing" }),
    );

    launch_installer(&installer_path).map_err(|err| {
        let _ = app.emit(
            "desktop://update-status",
            serde_json::json!({ "stage": "error", "error": err }),
        );
        err
    })?;

    state.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

fn setup_system_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Open MusicDeck", true, None::<&str>)?;
    let separator_top = PredefinedMenuItem::separator(app)?;
    let play_pause_item =
        MenuItem::with_id(app, "toggle-play", "Play / Pause", true, None::<&str>)?;
    let next_item = MenuItem::with_id(app, "next", "Next Track", true, None::<&str>)?;
    let previous_item =
        MenuItem::with_id(app, "previous", "Previous Track", true, None::<&str>)?;
    let separator_mid = PredefinedMenuItem::separator(app)?;
    let server_item = MenuItem::with_id(
        app,
        "server-settings",
        "Server Connection...",
        true,
        None::<&str>,
    )?;
    let updates_item = MenuItem::with_id(
        app,
        "check-updates",
        "Check for Updates...",
        true,
        None::<&str>,
    )?;
    let separator_bottom = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit MusicDeck", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &separator_top,
            &play_pause_item,
            &next_item,
            &previous_item,
            &separator_mid,
            &server_item,
            &updates_item,
            &separator_bottom,
            &quit_item,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("MusicDeck")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                show_main_window(app);
            }
            "toggle-play" | "next" | "previous" => {
                let _ = app.emit(
                    "desktop://media-control",
                    serde_json::json!({ "action": event.id().as_ref() }),
                );
            }
            "server-settings" => {
                show_main_window(app);
                let _ = app.emit("desktop://open-server-settings", serde_json::json!({}));
            }
            "check-updates" => {
                show_main_window(app);
                let _ = app.emit("desktop://check-for-updates", serde_json::json!({}));
            }
            "quit" => {
                if let Some(state) = app.try_state::<DesktopState>() {
                    state.quitting.store(true, Ordering::SeqCst);
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("musicdeck-desktop"));
            let initial_config = load_config(&config_dir);
            let start_minimized = initial_config.start_minimized;

            app.manage(DesktopState {
                config: Mutex::new(initial_config),
                quitting: AtomicBool::new(false),
            });

            setup_system_tray(app.handle())?;

            if start_minimized {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if let Some(state) = app.try_state::<DesktopState>() {
                    let is_quitting = state.quitting.load(Ordering::SeqCst);
                    let close_to_tray = state
                        .config
                        .lock()
                        .map(|cfg| cfg.close_to_tray)
                        .unwrap_or(true);
                    if !is_quitting && close_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_get_config,
            desktop_set_config,
            desktop_check_server,
            desktop_update_playback,
            desktop_window_action,
            desktop_check_for_updates,
            desktop_install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running MusicDeck Tauri application");
}
