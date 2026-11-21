fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "connect_musicdeck_server",
                "open_musicdeck_android_releases",
            ])),
    )
    .expect("failed to configure the MusicDeck Tauri app");
}
