# MusicDeck Android

This Tauri v2 shell uses package ID `app.musicdeck.android` and supports Android 7.0 (API 24) and later. Its bundled React launcher tests and selects a server. A regular Android WebView loads the gateway without desktop IPC, so the UI, API, media, cookies, and device-control socket share the selected origin. **Android APK releases** in the launcher opens GitHub for sideloadable updates. Update the MusicDeck web gateway to get the current mobile UI.

## Windows setup

Install [Android Studio](https://developer.android.com/studio). In **Tools → SDK Manager**, install Android SDK Platforms 36 and 37.0 and **Android SDK Command-line Tools (latest)**. Substitute your actual installation paths if they differ from the defaults below.

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$sdkManager = "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat"
& $sdkManager --licenses
& $sdkManager 'platforms;android-36' 'platforms;android-37.0' 'platform-tools' 'build-tools;36.0.0' 'ndk;29.0.13846066'
$env:NDK_HOME = "$env:ANDROID_HOME\ndk\29.0.13846066"
foreach ($name in 'JAVA_HOME', 'ANDROID_HOME', 'NDK_HOME') {
    [Environment]::SetEnvironmentVariable($name, (Get-Item "Env:$name").Value, 'User')
}
rustup target add aarch64-linux-android x86_64-linux-android
```

The ARM64 target is for a modern Android phone. The x86-64 target is for a typical Windows Android emulator. Gradle 9.6.1 comes through the checked-in wrapper. Android Gradle Plugin 9.3 requires JDK 17 or newer. The project pins Tauri CLI 2.12.4 through npm, so a global Cargo CLI is optional. See the [Tauri Android prerequisites](https://v2.tauri.app/start/prerequisites/#android) and [Android Gradle Plugin compatibility](https://developer.android.com/build/releases/agp-9-3-0-release-notes).

## Debug APK and development check

From PowerShell, install both npm packages and build an ARM64 debug APK.

```powershell
Set-Location 'D:\spotify_alternative\Android App'
npm ci --prefix ../webapp
npm ci
npm run android:build -- --debug --apk --target aarch64 --split-per-abi
Get-Item .\src-tauri\gen\android\app\build\outputs\apk\arm64\debug\app-arm64-debug.apk
```

Connect an ARM64 phone with USB debugging enabled. Install the debug APK directly from PowerShell.

```powershell
$apk = Get-Item .\src-tauri\gen\android\app\build\outputs\apk\arm64\debug\app-arm64-debug.apk -ErrorAction Stop
& "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" verify $apk.FullName
& "$env:ANDROID_HOME\platform-tools\adb.exe" install -r $apk.FullName
```

If the Tauri command compiles the Rust library and then fails to create a symbolic link, stage that library and the Tauri configuration before running the debug assembly with Gradle.

```powershell
$androidProject = 'src-tauri/gen/android'
$jni = "$androidProject/app/src/main/jniLibs/arm64-v8a"
New-Item -ItemType Directory -Force -Path $jni, "$androidProject/app/src/main/assets" | Out-Null
Copy-Item -LiteralPath 'src-tauri/target/aarch64-linux-android/debug/libmusicdeck_android_lib.so' -Destination $jni
node -e 'const fs = require("node:fs"); const config = require("./src-tauri/tauri.conf.json"); config.plugins ??= {}; fs.writeFileSync("src-tauri/gen/android/app/src/main/assets/tauri.conf.json", JSON.stringify(config));'
& "$androidProject/gradlew.bat" -p $androidProject ':app:assembleArm64Debug' -x ':app:rustBuildArm64Debug' '-PabiList=arm64-v8a' '-ParchList=arm64' '-PtargetList=aarch64'
```

To run the shell directly, start an Android emulator or connect a phone, then run the following from `Android App`. This uses the bundled launcher in development as well.

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" devices
npm run android:dev
```

## Connect and verify playback

1. Launch the app and enter your MusicDeck **web gateway URL**, such as `https://music.example.com`. Use the gateway that serves the UI and forwards `/api`, including WebSocket upgrades for `/api/v1/remote`. For an HTTPS reverse proxy, set `MUSICDECK_PUBLIC_URL` to that exact external URL, keep `MUSICDECK_SECURE_COOKIES=true`, and forward WebSocket `Upgrade` and the original `Host`. Use the final HTTPS URL if a proxy redirects HTTP to HTTPS.
2. For plain HTTP on a private LAN, install the debug APK. For the production Compose gateway on a test network, set `MUSICDECK_WEB_BIND` to the server's LAN IP and `MUSICDECK_PUBLIC_URL` to its HTTP gateway URL, for example `http://192.168.1.50:8080`. Set `MUSICDECK_SECURE_COOKIES=false` for that HTTP-only test deployment and recreate the Compose services. Keep the port limited to the test LAN. On a Windows-hosted emulator, `10.0.2.2` can reach the host's web port. Use the host's LAN IP on a physical phone.
3. Select **This server is on my local network** for a LAN gateway, including a private HTTPS server. Tap **Test connection** and allow Local network access if Android asks. The test checks the MusicDeck API and web page at the entered URL and port. After it succeeds, tap **Connect**. Android 17 requires this permission for LAN traffic. Debug HTTP automatically requests it. Release APKs require HTTPS and use Android's normal certificate checks.
4. Sign in, play a local track, and open the mini-player. Check the cover, scrubber, transport, Queue, and scroll down to Lyrics. Browse Home, Discover, and Library in portrait mode. Use **Change server** under the profile menu or on the sign-in screen to reopen the launcher. Android Back also returns through the connection history if a gateway fails to load.
5. Sign into the same gateway and account from a second client. Open **Devices** and enable playback on each device. Confirm both appear, then transfer playback and test pause, next, and seek. The app uses `ws://<gateway>/api/v1/remote` for HTTP and `wss://<gateway>/api/v1/remote` for HTTPS. The same-origin session cookie authenticates the socket. A plain GET to that route returns `426` by design. A failed socket handshake with `401` points to a missing or expired session. For `403`, check the external scheme, host, port, and `MUSICDECK_PUBLIC_URL` on the gateway.

## Background playback check

- Sign in to a gateway running the current web build. Start an album, seek into the track, skip to the next track, then send the app to the background and lock the phone long enough to cross a track boundary. Try play, pause, and skip on the lock screen if Android exposes media controls. Repeat with the screen unlocked and another app in front.
- While playing, disconnect the network long enough to exhaust the stream buffer. Reconnect and reopen the app. Check **Devices** on both clients for a single phone entry and try a remote seek. If the stream exhausted its retry budget, tap **Play** to retry from the saved position. Repeat when paused to check that unlocking or reconnecting does not start playback.
- Android's `ACCESS_NETWORK_STATE` permission lets the app tell the WebView when a default network becomes available. The remote client retries a pending socket connection on network return and replaces stale connections on foreground return.
- Playback and lock-screen actions depend on the Android WebView's HTML media and Media Session support. MusicDeck's `mediaSessions` flag controls server resume checkpoints. `audioEffects` uses Web Audio when available. `silenceTrimming` relies on media timing events, and `serverNormalization` can fall back to the original stream. Android may freeze or terminate the WebView. Sustained playback independent of the Activity requires a native player in a media playback foreground service.

## Native project

`src-tauri/gen/android` was initialized using Tauri CLI 2.12.4 with `android init --ci --skip-targets-install`. Build the included Android project directly. To generate a fresh Android target from the Tauri configuration, use `npm run android:init -- --ci --skip-targets-install` from this directory. The supplied Gradle Rust task resolves the project-local CLI from `node_modules` and passes paths as separate arguments so the directory name can contain a space.
