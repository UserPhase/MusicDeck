//! # Plugin Registry, Manifest Parser & Extension Runtime Bridge (`plugins`)
//!
//! Exports [`PluginManifest`], [`PluginPermission`], [`PluginCapability`],
//! [`parse_custom_manifest`], [`PluginRegistry`], [`ExtensionManifest`],
//! [`ExtensionContext`], [`HookRegistry`], [`ExtensionManager`], and
//! [`unpack_extension_tar_gz`].

pub mod extensions;
pub mod manifest;
pub mod registry;

pub use extensions::{
    ExtensionContext, ExtensionError, ExtensionErrorCode, ExtensionInfo, ExtensionManager,
    ExtensionManifest, ExtensionRouteHandler, ExtensionRuntimeHooks, ExtensionStatus,
    HookRegistry, MAX_EXTENSION_ARCHIVE_BYTES, MAX_EXTENSION_MANIFEST_BYTES,
    MAX_ROUTES_PER_EXTENSION, compute_extension_fingerprint, unpack_extension_tar_gz,
};
pub use manifest::{
    CURRENT_MANIFEST_VERSION, ManifestValidationError, PLUGIN_CAPABILITIES, PLUGIN_EVENTS,
    PLUGIN_PERMISSIONS, PluginCapability, PluginConfigField, PluginConfigOption, PluginConfigSpec,
    PluginErrorClassification, PluginErrorStatus, PluginManifest, PluginPermission, UIExtension,
    classify_plugin_error, http_status_for_plugin_error, parse_custom_manifest,
    validate_manifest,
};
pub use registry::{
    ExternalArtworkPlugin, LastFmPlugin, ListenBrainzPlugin, MusicBrainzPlugin, MusicDeckPlugin,
    PluginLog, PluginOrigin, PluginRegistry, SpotDLDownloaderPlugin,
};

#[cfg(test)]
mod tests {
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use serde_json::json;
    use tar::{Builder, Header};

    use super::*;
    use crate::db::{DbPool, run_migrations};

    fn create_sample_extension_tar_gz(id: &str) -> Vec<u8> {
        let mut tar_bytes = Vec::new();
        {
            let enc = GzEncoder::new(&mut tar_bytes, Compression::default());
            let mut ar = Builder::new(enc);

            let manifest_str = json!({
                "apiVersion": 1,
                "id": id,
                "name": "Sample Extension",
                "version": "1.0.0",
                "description": "Test extension package",
                "entry": "index.mjs"
            })
            .to_string();
            let mut h1 = Header::new_gnu();
            h1.set_size(manifest_str.len() as u64);
            h1.set_mode(0o644);
            h1.set_cksum();
            ar.append_data(&mut h1, "extension.json", manifest_str.as_bytes())
                .unwrap();

            let entry_code = r#"
export default function createExtension() {
    return {
        registerRoutes(register) {
            register("GET", "/status", async () => ({ healthy: true }));
        }
    };
}
"#;
            let mut h2 = Header::new_gnu();
            h2.set_size(entry_code.len() as u64);
            h2.set_mode(0o644);
            h2.set_cksum();
            ar.append_data(&mut h2, "index.mjs", entry_code.as_bytes())
                .unwrap();

            ar.finish().unwrap();
        }
        tar_bytes
    }

    #[test]
    fn parses_custom_plugin_manifest_and_rejects_unknown_permissions() {
        let valid = json!({
            "manifestVersion": 1,
            "id": "custom.lyrics.provider",
            "name": "Custom Lyrics",
            "version": "0.2.0",
            "capabilities": ["lyrics"],
            "permissions": ["network.request"],
            "configuration": {
                "apiKey": { "type": "secret", "label": "API Key", "required": true }
            }
        });
        let parsed = parse_custom_manifest(&valid).expect("valid custom manifest");
        assert_eq!(parsed.id, "custom.lyrics.provider");
        assert!(parsed.config.unwrap().fields[0].secret);

        let invalid_perm = json!({
            "manifestVersion": 1,
            "id": "bad.plugin",
            "name": "Bad",
            "version": "1.0.0",
            "capabilities": ["lyrics"],
            "permissions": ["filesystem.root"]
        });
        assert!(parse_custom_manifest(&invalid_perm).is_err());
    }

    #[tokio::test]
    async fn unpacks_extension_tar_gz_discovers_enables_and_dispatches_routes() {
        let pool = DbPool::connect_memory().await.expect("open memory db");
        run_migrations(&pool, None).await.expect("run migrations");

        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let archive_bytes = create_sample_extension_tar_gz("sample-ext");

        let unpacked = unpack_extension_tar_gz(&archive_bytes, temp_dir.path())
            .expect("unpack extension tar.gz");
        assert_eq!(unpacked.id, "sample-ext");

        let manager = ExtensionManager::new(Some(pool.clone()), temp_dir.path());
        let (discovered, issues) = manager.discover().await.expect("discover extensions");
        assert!(issues.is_empty());
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].id, "sample-ext");
        assert_eq!(discovered[0].status, ExtensionStatus::Disabled);

        let enabled_info = manager
            .set_enabled("sample-ext", true)
            .await
            .expect("enable sample-ext");
        assert!(enabled_info.enabled);
        assert_eq!(enabled_info.status, ExtensionStatus::Enabled);

        let resp = manager
            .dispatch("sample-ext", "GET", "/status", json!({ "ping": 1 }))
            .await
            .expect("dispatch route");
        assert_eq!(resp["ok"], true);

        pool.close().await;
    }
}
