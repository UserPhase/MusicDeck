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
2. **Rust toolchain** (`rustup`, `cargo`, `rustc` 1.77.2+)
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

This runs `npm --prefix ../webapp run build` and packages the native desktop bundle in `src-tauri/target/release/bundle/`:
- **NSIS Setup `.exe`**: `src-tauri/target/release/bundle/nsis/MusicDeck_0.1.0_x64-setup.exe`
- **MSI Installer `.msi`**: `src-tauri/target/release/bundle/msi/MusicDeck_0.1.0_x64_en-US.msi`

## Building & Downloading the `.exe` via GitHub (with Auto-Updates)

The repository includes [`.github/workflows/desktop-app.yml`](../.github/workflows/desktop-app.yml), which builds the Windows `.exe` and `.msi` installers automatically on GitHub's `windows-latest` runners (no local Rust or C++ toolchain needed on your PC) and publishes `latest.json` for in-app auto-updates:

1. Commit and push `Desktop-App`, `webapp`, and `.github/workflows/desktop-app.yml` to `main`.
2. GitHub Actions runs **Build Desktop App (Windows .exe)** automatically (or you can trigger it manually under **Actions → Build Desktop App (Windows .exe) → Run workflow**).
3. Once finished, download `MusicDeck_0.1.0_x64-setup.exe` from either:
   - **GitHub Releases**: under the `desktop-latest` release on your repository's **Releases** page, or
   - **GitHub Actions**: under the workflow run's **Artifacts** (`MusicDeck-Windows-x64-Installer`).
4. **Automatic Updates**:
   - Every build generates a `latest.json` manifest containing the version, commit build ID, download URL, and SHA-256 checksum of the `.exe` installer.
   - Installed desktop clients automatically check `latest.json` on startup (and via **Check for Updates...** in the system tray or **Desktop Server Connection** dialog).
   - Clicking **Update & Restart** downloads the new `.exe` over HTTPS from GitHub Releases, verifies its SHA-256 integrity, launches the installer, and upgrades the app in place.

## Validation & Tests

Validate the Tauri configuration, capabilities, icons, and Rust command bindings:

```powershell
npm test
npm run validate
```
