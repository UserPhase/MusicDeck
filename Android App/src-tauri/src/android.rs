use tauri::plugin::{Builder, PluginHandle};
use tauri::{Manager, State, Url, WebviewWindow, WebviewWindowBuilder, Wry};

use crate::server_url::{is_launcher, parse_server_url};

fn ensure_launcher(window: &WebviewWindow) -> Result<(), String> {
    if window.url().is_ok_and(|url| is_launcher(&url)) {
        Ok(())
    } else {
        Err("Open the MusicDeck connection screen to manage your server.".into())
    }
}

#[tauri::command]
async fn connect_musicdeck_server(
    window: WebviewWindow,
    android: State<'_, PluginHandle<Wry>>,
    server_url: String,
    local_network: bool,
    open: bool,
) -> Result<String, String> {
    ensure_launcher(&window)?;
    let server = parse_server_url(&server_url, cfg!(debug_assertions))?;
    if local_network || server.scheme() == "http" {
        let granted: bool = android
            .run_mobile_plugin_async("allowLocalNetwork", ())
            .await
            .map_err(|_| {
                "Could not request local network access. Check MusicDeck's Android permissions."
            })?;
        if !granted {
            return Err(
                "Allow Local network access in Android Settings for MusicDeck, then try again."
                    .into(),
            );
        }
    }
    android
        .run_mobile_plugin_async::<()>(
            "checkServer",
            serde_json::json!({ "url": server.as_str(), "open": open }),
        )
        .await
        .map_err(|err| err.to_string())?;
    Ok(server.into())
}

#[tauri::command]
async fn open_musicdeck_android_releases(
    window: WebviewWindow,
    android: State<'_, PluginHandle<Wry>>,
) -> Result<(), String> {
    ensure_launcher(&window)?;
    android
        .run_mobile_plugin_async("openReleases", ())
        .await
        .map_err(|err| err.to_string())
}

pub fn configure(builder: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    builder
        .plugin(
            Builder::<Wry, ()>::new("android-network")
                .setup(|app, api| {
                    app.manage(
                        api.register_android_plugin("app.musicdeck.android", "LocalNetworkPlugin")?,
                    );
                    Ok(())
                })
                .build(),
        )
        .setup(|app| {
            WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(|url: &Url| is_launcher(url))
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connect_musicdeck_server,
            open_musicdeck_android_releases
        ])
}
