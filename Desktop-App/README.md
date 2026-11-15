# MusicDeck Desktop App (Tauri v2)

Native desktop shell for **MusicDeck** built with [Tauri v2](https://v2.tauri.app/) that reuses the shared React client in [`../webapp`](../webapp).

## Architecture

- **Shared UI (`../webapp`)**: Uses the existing MusicDeck React application (`devUrl: http://localhost:3000` in development and `frontendDist: ../../webapp/build` in production builds).
- **Desktop Runtime Bridge (`../webapp/src/services/desktop/desktopRuntime.js`)**:
  - Detects when `webapp` is running inside the Tauri desktop runtime (`window.__TAURI__` / `window.__TAURI_INTERNALS__`).
  - Resolves relative `/api/*` requests, audio streams, and artwork proxy URLs to the user-configured MusicDeck server URL.
  - Exposes a **Desktop Server Connection** dialog on the sign-in screen and from the system tray so users can connect to a local (`http://localhost:4534`) or LAN/remote MusicDeck server (`http://192.168.x.x:8080`).
  - Syncs active track playback state (`title`, `artist`, `isPlaying`) with the native window title and system tray tooltip.
  - Handles native system tray media controls (`Play / Pause`, `Next Track`, `Previous Track`) through `PlayerContext`.
- **Rust Core (`src-tauri/`)**:
  - Persists desktop configuration (`desktop-config.json` in the OS app config directory).
  - Performs server reachability checks against `/api/public/config`.
  - Manages the system tray icon, menu actions, and close-to-tray background playback behavior.

## Prerequisites

1. **Node.js** (v20+) and **npm**
2. **Rust toolchain** (current stable via `rustup`)
3. **Platform WebView runtime**:
   - **Windows**: Microsoft Edge WebView2 (pre-installed on Windows 10/11) and Visual Studio C++ Build Tools
   - **macOS**: Xcode Command Line Tools
   - **Linux**: `webkit2gtk-4.1`, `libayatana-appindicator3-dev`, `librsvg2-dev`

## Development

1. Start your MusicDeck server (defaults to `http://localhost:4534`).
2. From `Desktop-App/`:

```powershell
npm install
npm run dev
```

`npm run dev` automatically starts the shared `webapp` dev server (`http://localhost:3000`) and launches the Tauri desktop window.

## Production Build

```powershell
npm run build
```

This builds the webapp and puts the per-user NSIS setup executable in `src-tauri/target/release/bundle/nsis/`. Local builds use an empty updater public key and can run without signing credentials.

## Building & Downloading the `.exe` via GitHub (with Auto-Updates)

Configure the updater signing key once before running [the desktop release workflow](../.github/workflows/desktop-app.yml). Generate the key pair outside the repository from `Desktop-App/`.

```powershell
npx tauri signer generate -w "$env:USERPROFILE\musicdeck-updater.key"
```
- In GitHub Actions variables, set `TAURI_UPDATER_PUBLIC_KEY` to the contents of `musicdeck-updater.key.pub`.
- In GitHub Actions secrets, set `TAURI_SIGNING_PRIVATE_KEY` to the contents of `musicdeck-updater.key` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to its password if one was set. Keep the private key backed up securely. Existing installations continue to trust the public key they shipped with.
- Increase the version in `Desktop-App/package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` when publishing an update, and regenerate both lockfiles. Tauri offers versions newer than the installed app.

The workflow publishes the signed NSIS setup executable and `latest.json` to GitHub Releases. On Windows, **Update & Restart** displays download progress in MusicDeck, verifies the package signature, and hands off to the silent installer. NSIS reopens MusicDeck after updating the installation in `%LOCALAPPDATA%`. If MusicDeck was installed with the older machine-wide MSI, remove that installation and run the current per-user NSIS setup once.

## Validation & Tests

Validate the Tauri configuration, capabilities, icons, and Rust command bindings:

```powershell
npm test
npm run validate
```
