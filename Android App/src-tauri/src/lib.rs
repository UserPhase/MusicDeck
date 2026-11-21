#[cfg(target_os = "android")]
mod android;

#[cfg(any(target_os = "android", test))]
mod server_url;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = android::configure(builder);
    builder
        .run(tauri::generate_context!())
        .expect("failed to run the MusicDeck Android app");
}
