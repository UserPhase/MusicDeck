pub mod config;
pub mod proxy;
mod updater;

use config::{candidate_server_urls, load_config, DesktopConfig, DesktopConnection};
use proxy::{send_upstream, start_local_api_proxy, upstream_redirect_policy};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{
    ipc::JavaScriptChannelId,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, Webview, WindowEvent,
};
use tokio::sync::oneshot;

pub struct DesktopState {
    connection: Arc<Mutex<DesktopConnection>>,
    config_dir: std::path::PathBuf,
    http_client: reqwest::Client,
    pending_requests: Mutex<HashMap<u32, Option<oneshot::Sender<()>>>>,
    pub proxy_url: Option<String>,
    pub quitting: AtomicBool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfigResponse {
    pub server_url: String,
    pub proxy_url: Option<String>,
    pub close_to_tray: bool,
    pub start_minimized: bool,
    pub auto_check_updates: bool,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopApiRequest {
    pub path: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
    cancel_channel: Option<JavaScriptChannelId>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopApiResponse {
    pub status: u16,
    pub ok: bool,
    pub headers: HashMap<String, String>,
    pub body: String,
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
fn desktop_get_config(state: State<'_, DesktopState>) -> Result<DesktopConfigResponse, String> {
    let guard = state
        .connection
        .lock()
        .map_err(|_| "Desktop configuration lock poisoned".to_string())?;
    let config = &guard.config;
    Ok(DesktopConfigResponse {
        server_url: config.server_url.clone(),
        proxy_url: state.proxy_url.clone(),
        close_to_tray: config.close_to_tray,
        start_minimized: config.start_minimized,
        auto_check_updates: config.auto_check_updates,
    })
}

#[tauri::command]
fn desktop_set_config(
    app: AppHandle,
    state: State<'_, DesktopState>,
    update: DesktopConfigUpdate,
) -> Result<DesktopConfigResponse, String> {
    let mut guard = state
        .connection
        .lock()
        .map_err(|_| "Desktop configuration lock poisoned".to_string())?;

    let config = &guard.config;
    let candidate = DesktopConfig {
        server_url: update
            .server_url
            .unwrap_or_else(|| config.server_url.clone()),
        close_to_tray: update.close_to_tray.unwrap_or(config.close_to_tray),
        start_minimized: update.start_minimized.unwrap_or(config.start_minimized),
        auto_check_updates: update
            .auto_check_updates
            .unwrap_or(config.auto_check_updates),
        session_cookie: None,
    };

    guard.save_settings(&state.config_dir, candidate)?;
    let saved = &guard.config;
    let response = DesktopConfigResponse {
        server_url: saved.server_url.clone(),
        proxy_url: state.proxy_url.clone(),
        close_to_tray: saved.close_to_tray,
        start_minimized: saved.start_minimized,
        auto_check_updates: saved.auto_check_updates,
    };
    let _ = app.emit("desktop://config-changed", &response);

    Ok(response)
}

#[tauri::command]
async fn desktop_check_server(
    state: State<'_, DesktopState>,
    server_url: String,
) -> Result<ServerHealthResponse, String> {
    let candidates = candidate_server_urls(&server_url)?;
    let primary = candidates
        .first()
        .cloned()
        .ok_or_else(|| "Server URL is required".to_string())?;

    let mut last_error = String::new();

    for candidate in &candidates {
        let endpoint = format!("{candidate}/api/public/config");
        match state
            .http_client
            .get(&endpoint)
            .timeout(Duration::from_secs(6))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                match response.json::<PublicConfigPayload>().await {
                    Ok(payload) => {
                        return Ok(ServerHealthResponse {
                            reachable: true,
                            server_url: candidate.clone(),
                            app_name: payload.app_name.or_else(|| Some("MusicDeck".to_string())),
                            error: None,
                        })
                    }
                    Err(err) => {
                        last_error = format!(
                            "{candidate} returned an unreadable MusicDeck configuration: {err}"
                        )
                    }
                }
            }
            Ok(response) => {
                last_error = format!("{candidate} responded with HTTP {}", response.status());
            }
            Err(err) => {
                last_error = format!("{err}");
            }
        }
    }

    let tried = candidates.join(", ");
    Ok(ServerHealthResponse {
        reachable: false,
        server_url: primary,
        app_name: None,
        error: Some(format!(
            "Could not reach MusicDeck (tried {tried}: {last_error}). For Docker Compose, use port 8080 (e.g. http://192.168.2.38:8080) and ensure MUSICDECK_WEB_BIND=0.0.0.0 in your server .env."
        )),
    })
}

struct PendingApiRequest<'a> {
    requests: &'a Mutex<HashMap<u32, Option<oneshot::Sender<()>>>>,
    id: u32,
}

impl Drop for PendingApiRequest<'_> {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(&self.id);
        }
    }
}

#[tauri::command]
fn desktop_cancel_api_fetch(state: State<'_, DesktopState>, id: u32) {
    if let Ok(mut requests) = state.pending_requests.lock() {
        if let Some(cancel) = requests.get_mut(&id).and_then(Option::take) {
            let _ = cancel.send(());
        }
    }
}

#[tauri::command]
async fn desktop_api_fetch(
    state: State<'_, DesktopState>,
    webview: Webview,
    mut request: DesktopApiRequest,
) -> Result<DesktopApiResponse, String> {
    let Some(channel_id) = request.cancel_channel.take() else {
        return fetch_desktop_api(&state, request).await;
    };
    let ready = channel_id.channel_on::<_, bool>(webview);
    let id = ready.id();
    let (cancel, cancelled) = oneshot::channel();
    {
        let mut requests = state
            .pending_requests
            .lock()
            .map_err(|_| "Could not register the request".to_string())?;
        let std::collections::hash_map::Entry::Vacant(entry) = requests.entry(id) else {
            return Err("This desktop request is already registered".into());
        };
        entry.insert(Some(cancel));
    }
    let _pending = PendingApiRequest {
        requests: &state.pending_requests,
        id,
    };
    ready.send(true).map_err(|err| err.to_string())?;

    tokio::select! {
        biased;
        _ = cancelled => Err("Desktop API request cancelled".into()),
        response = fetch_desktop_api(&state, request) => response,
    }
}

async fn fetch_desktop_api(
    state: &DesktopState,
    request: DesktopApiRequest,
) -> Result<DesktopApiResponse, String> {
    let raw_path = request.path.trim();
    let relative_path = if raw_path.starts_with('/') {
        raw_path.to_string()
    } else if let Some(idx) = raw_path.find("/api/") {
        raw_path[idx..].to_string()
    } else if raw_path.ends_with("/api") {
        "/api".to_string()
    } else {
        format!("/{raw_path}")
    };

    let upstream = state
        .connection
        .lock()
        .map_err(|_| "Desktop configuration lock poisoned".to_string())?
        .begin_request();
    let method_str = request.method.as_deref().unwrap_or("GET").to_uppercase();
    let method = reqwest::Method::from_bytes(method_str.as_bytes())
        .map_err(|err| format!("Invalid HTTP method: {err}"))?;

    let candidates = upstream.candidate_urls()?;

    let mut upstream_response = None;
    let mut active_base_url = upstream.server_url.clone();
    let mut last_failure = None;

    for candidate_base in &candidates {
        let target_url = reqwest::Url::parse(&format!("{candidate_base}{relative_path}"))
            .map_err(|err| format!("Invalid MusicDeck request URL: {err}"))?;
        let origin = target_url.origin().ascii_serialization();
        let mut req_builder = state
            .http_client
            .request(method.clone(), target_url)
            .timeout(Duration::from_secs(30))
            .header("Origin", origin.as_str())
            .header("Referer", format!("{candidate_base}/"));

        if let Some(ref headers) = request.headers {
            for (k, v) in headers {
                if ["cookie", "host", "origin", "referer"]
                    .iter()
                    .any(|name| k.eq_ignore_ascii_case(name))
                {
                    continue;
                }
                req_builder = req_builder.header(k, v);
            }
        }

        if let Some(ref token) = upstream.cookie {
            if !token.is_empty() {
                req_builder = req_builder.header("Cookie", format!("musicdeck_session={token}"));
            }
        }

        if let Some(ref body) = request.body {
            req_builder = req_builder.body(body.clone());
        }

        match send_upstream(req_builder, &method, &origin, Duration::from_secs(30)).await {
            Ok(resp) => {
                active_base_url = candidate_base.clone();
                upstream_response = Some(resp);
                break;
            }
            Err(failure) => {
                let can_try_alternate = failure.can_try_alternate();
                last_failure = Some(failure);
                if !can_try_alternate {
                    break;
                }
            }
        }
    }

    let Some(resp) = upstream_response else {
        let failure = last_failure.ok_or("No MusicDeck server URL was available")?;
        let (code, message) = failure.details();
        return Ok(DesktopApiResponse {
            status: failure.status().as_u16(),
            ok: false,
            headers: HashMap::from([("content-type".into(), "application/json".into())]),
            body: serde_json::json!({ "error": { "code": code, "message": message } }).to_string(),
        });
    };

    let status = resp.status().as_u16();
    let ok = resp.status().is_success();
    let upstream_headers = resp.headers().clone();
    let mut headers = HashMap::new();
    for (k, v) in upstream_headers.iter() {
        if k == reqwest::header::SET_COOKIE {
            continue;
        }
        if let Ok(val_str) = v.to_str() {
            headers.insert(k.as_str().to_string(), val_str.to_string());
        }
    }

    let body = resp
        .text()
        .await
        .map_err(|err| format!("Could not read the MusicDeck response: {err}"))?;
    state
        .connection
        .lock()
        .map_err(|_| "Desktop configuration lock poisoned".to_string())?
        .accept_response(
            &state.config_dir,
            &upstream,
            &active_base_url,
            &upstream_headers,
        )?;

    Ok(DesktopApiResponse {
        status,
        ok,
        headers,
        body,
    })
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
        let state_label = if status.is_playing {
            "Playing"
        } else {
            "Paused"
        };
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
        "start-dragging" => window.start_dragging().map_err(|e| e.to_string()),
        "minimize" => window.minimize().map_err(|e| e.to_string()),
        "toggle-maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize().map_err(|e| e.to_string())
            } else {
                window.maximize().map_err(|e| e.to_string())
            }
        }
        "close" => {
            let close_to_tray = app
                .try_state::<DesktopState>()
                .and_then(|s| s.connection.lock().ok().map(|c| c.config.close_to_tray))
                .unwrap_or(true);
            if close_to_tray {
                window.hide().map_err(|e| e.to_string())
            } else {
                window.close().map_err(|e| e.to_string())
            }
        }
        "show" => {
            show_main_window(&app);
            Ok(())
        }
        other => Err(format!("Unsupported window action: {other}")),
    }
}

fn setup_system_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Open MusicDeck", true, None::<&str>)?;
    let separator_top = PredefinedMenuItem::separator(app)?;
    let play_pause_item =
        MenuItem::with_id(app, "toggle-play", "Play / Pause", true, None::<&str>)?;
    let next_item = MenuItem::with_id(app, "next", "Next Track", true, None::<&str>)?;
    let previous_item = MenuItem::with_id(app, "previous", "Previous Track", true, None::<&str>)?;
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("musicdeck-desktop"));
            let initial_config = load_config(&config_dir);
            let start_minimized = initial_config.start_minimized;
            let connection = Arc::new(Mutex::new(DesktopConnection::new(initial_config)));
            let http_client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(6))
                .redirect(upstream_redirect_policy())
                .build()?;
            let proxy_url = start_local_api_proxy(
                Arc::clone(&connection),
                config_dir.clone(),
                http_client.clone(),
            );

            app.manage(DesktopState {
                connection,
                config_dir,
                http_client,
                pending_requests: Mutex::new(HashMap::new()),
                proxy_url,
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
                        .connection
                        .lock()
                        .map(|connection| connection.config.close_to_tray)
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
            desktop_api_fetch,
            desktop_cancel_api_fetch,
            desktop_update_playback,
            desktop_window_action,
            updater::desktop_update_environment
        ])
        .run(tauri::generate_context!())
        .expect("error while running MusicDeck Tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[tokio::test]
    async fn desktop_fetch_rejects_an_incomplete_upstream_body() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let config = DesktopConfig {
                server_url: format!("http://{}", listener.local_addr().unwrap()),
                ..DesktopConfig::default()
            };
            let upstream = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    headers.push(stream.read_u8().await.unwrap());
                }
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 99\r\nConnection: close\r\n\r\nshort",
                    )
                    .await
                    .unwrap();
                stream.shutdown().await.unwrap();
            });
            let dir = tempfile::tempdir().unwrap();
            let state = DesktopState {
                connection: Arc::new(Mutex::new(DesktopConnection::new(config))),
                config_dir: dir.path().to_owned(),
                http_client: reqwest::Client::new(),
                pending_requests: Mutex::default(),
                proxy_url: None,
                quitting: AtomicBool::new(false),
            };
            let request = DesktopApiRequest {
                path: "/api/test".into(),
                method: None,
                headers: None,
                body: None,
                cancel_channel: None,
            };
            let error = fetch_desktop_api(&state, request).await.unwrap_err();
            assert!(error.starts_with("Could not read the MusicDeck response"));
            upstream.await.unwrap();
        })
        .await
        .unwrap();
    }
}
