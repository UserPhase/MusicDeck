# MusicDeck Architecture

## 1. Purpose

MusicDeck is a self-hosted music application with:

- Spotify-inspired UX
- Navidrome as the primary music backend
- Jellyfin-inspired server/library concepts
- Web and Android clients
- A planned extensible plugin system
- A unified model for music from different providers

Core principle:

> One beautiful music app, any source.

This document describes the current architecture and established
architectural decisions.

It is not a feature roadmap.

---

## 2. Repository Structure

```text
MusicDeck/
├── webapp/
│   └── React web client
├── android/
│   └── Android client
├── server/
│   └── MusicDeck API/server
├── docs/
│   └── Architecture and project documentation
└── .github/
    └── Copilot agents and repository configuration
```

---

## 3. Providers

### Admin library statistics

Admin library overview and dashboard counts use the `collection` fields from
`/api/library/statistics`. The overview also shows total duration; genre counts
are not supplied by this endpoint. Admin data loading preserves successful
partial results while displaying and logging failed requests.

### User avatars

Users upload their own avatar via `POST /api/users/profile/avatar` as a JSON
`{ image }` base64 data URL (JPEG/PNG/WebP, ≤ 5 MB, bytes must match the
declared type) and remove it via `DELETE` on the same path. The image is
stored in the `user_avatars` SQLite table and served by the authenticated
`GET /api/users/:userId/avatar`. User payloads expose a versioned `avatarUrl`
(changes on every upload), so updating the auth session refreshes the top-bar
avatar immediately. The legacy free-form `avatarRef` is never rendered.

### Master administrator and admin user management

The bootstrap admin (the seeded first admin, or the oldest admin on upgraded
databases) carries `users.is_master` and is exposed as `isMasterAdmin`. The
API rejects with `403 MASTER_ADMIN_PROTECTED` any change to the master's role,
disabled state, or permissions, password resets by other admins, and deletion.
Any admin is also blocked from disabling, demoting, or deleting themselves
(`403 SELF_LOCKOUT`). User payloads include `lastLoginAt` (recorded on login)
and `lastPlaybackAt` (latest `recently_played` row). Admins override a user's
theme, stream quality, and download quality through
`GET`/`PATCH /api/admin/users/:userId/settings` (validated enum values). When
admins edit their own account, the client dispatches
`musicdeck:user-settings-changed` so the theme and player apply it live.

Theme is stored only as the `ui.theme` user setting (`"dark" | "light"`, validated
on both settings endpoints). Theme controls are available only in
Settings → Interface & Layout and the admin panel. Changes to your own theme go
through `webapp/src/utils/theme.js`. It applies the theme right away by
broadcasting the change event, which `App.js` turns into `<html data-theme>`,
then saves it, and switches back to the previous theme if the save fails.

Theme colours are CSS custom properties in `webapp/src/styles/tokens.css`:
dark values in `:root`, light overrides in `:root[data-theme="light"]`.
Component styles use tokens instead of literal colours:

- `--tint-rgb` for translucent hover and border overlays.
- `--accent-text` for accent-coloured text. It is darkened in light mode for
  contrast; accent fills still use `--accent`.
- `--panel-chrome`, `--player-bg` and similar tokens for surfaces.
- `--sidebar-surface`, `--aside-surface`, `--main-surface` and `--panel-border`
  for desktop panel depth. In light mode the canvas is darkest, then the left
  sidebar (`#f3f4f6`), then the right panel (`#f8f9fa`), then the white main
  content. In dark mode they resolve to the original panel colours.
- Light text tokens (`--text-secondary`, `--text-muted`, `--text-subtle`) are
  chosen to stay at or above 4.5:1 on every light surface, including sidebar
  hover fills.
- Sidebar navigation uses dedicated `--nav-*` tokens. Light mode strengthens
  section labels and inactive item contrast and adds a slate hover fill and a
  purple active pill. Dark-mode section labels and inactive links use
  `#9ca3af`; navigation icons and playlist fallback notes inherit the link
  color. The existing dark active pill and hover styling remain unchanged.
- `--glass-menu-*` for the glass dropdowns.

Overlays drawn on top of artwork stay white in both themes.
`styles/theme.css` holds the few light-only exceptions, plus the
`html.theme-transitioning` colour cross-fade. `App.js` adds that class for
about 350 ms only when the theme actually switches, so it never touches the
tactile hover and press transitions.

### Branding and layout presets

The application name is a global setting stored in the `server_settings`
table under the `branding.appName` key. It is exposed by two endpoints in
`server/src/routes/config-routes.ts`:

- `GET /api/public/config` needs no login (the login page is branded too) and
  returns `{ appName }`, falling back to `"MusicDeck"`.
- `PATCH /api/admin/config` is admin-only. The name is trimmed and must be
  1–40 characters with no control characters.

On the client, `webapp/src/context/BrandingContext.jsx` loads the config and
sets `document.title`. It caches the name in localStorage so the next load
doesn't flash the default. `<BrandWordmark/>` renders the header logo. When
an admin saves a new name under Admin → Appearance → Branding, the context
updates right away, so no reload is needed. The Appearance sections are
Overview, Branding and Custom CSS.

The layout preset is a per-user setting, `ui.layoutPreset`
(`"spotify" | "apple" | "ytmusic" | "soundcloud"`, default `"spotify"`,
validated on both settings endpoints). A stored legacy `"tidal"` value is
read as `"spotify"`. The preset is chosen in Settings → Interface & Layout →
Layout Style and saved through `webapp/src/utils/layoutPreset.js`, which also
holds each preset's metadata and shell rules. The value is applied first and
switches back if the save fails.

`components/Layout/AppLayout.jsx` is the shell engine for every non-admin
route. It composes four structural archetypes, and Tidal, Deezer, Qobuz and
Amazon Music map onto them:

- **Spotify** (`spotify`): library sidebar, content, docked right panel and a
  bottom player bar.
- **Apple Music** (`apple`): library sidebar plus a header that holds the
  transport controls and search (`HeaderPlayers/AppleHeaderPlayer.jsx`). The
  lyrics and queue panels are full height, and there is no bottom bar.
- **YouTube Music** (`ytmusic`): the header navigation and hamburger come
  from `Headers/TopNavHeader.jsx`, and the sidebar becomes an off-canvas
  drawer. Content is full bleed, the player floats and expands, and the
  panels open as bottom sheets (`PlayerBars/DrawerPlayerBar.jsx`).
- **SoundCloud** (`soundcloud`): header navigation, a feed with an inline
  widget column (`WidgetSidebar.jsx`: now playing, next up, recently played,
  playlists) and a full-width bottom player.

Below 768px every preset uses one mobile shell: a drawer menu, a mini player
and a bottom tab bar (`MobileNavBar.jsx`).

AppLayout sets `<html data-layout-shell>`, and `styles/layout-presets.css`
styles each shell from it. Every slot is keyed, so switching presets swaps
only the chrome. `<main>`, the routed page and the library sidebar keep
their identity. All audio and queue state lives in `PlayerProvider`, so
playback continues while you switch. Now Playing auto-opens on a new track
only in the shells where it docks (Spotify and Apple). Every preset keeps the
same routes.

### Admin server log viewer

`server/src/utils/logger.ts` keeps the last 1,000 server log entries in an
in-memory ring buffer that is also capped at about 2 MB. It evicts the oldest
entries first and truncates oversized messages, stacks and metadata.

The buffer is fed from four places:

- Fastify/pino output, through a capture stream passed as the logger `stream`.
  Lines still print to stdout.
- `console.*` calls, which are patched but still print.
- `unhandledRejection` events. The handler records them and keeps the process
  alive.
- `uncaughtExceptionMonitor` and process warnings. These are recorded only, so
  an uncaught exception still crashes the process.

Every entry is redacted before it is stored. Redaction removes:

- Registered literal secrets: the session secret, Navidrome password, Jellyfin
  API key, first-admin password and Spotify client secret.
- Bearer/Basic tokens, cookie and authorization headers, and the
  `musicdeck_session` value.
- Subsonic `t`/`s`/`p` query parameters.
- Credential-looking keys, in both text and nested metadata.

Admin-only endpoints (`routes/admin-logs-routes.ts`):

- `GET /api/admin/logs?level=&limit=`: history plus buffer stats.
- `GET /api/admin/logs/stream`: SSE stream.
  - Batches new entries every 100 ms into `logs` events.
  - Each batch carries an `id:`, so `Last-Event-ID` or `?after=` replays
    anything missed.
  - Also sends `cleared` and a 25 s heartbeat.
  - At most 10 concurrent streams.
- `DELETE /api/admin/logs`: clears the buffer.

The UI lives at Admin → Server → Logs (`webapp/src/pages/admin/AdminLogs.jsx`).

### Library scan scheduler

`server/src/services/scannerScheduler.ts` owns one in-memory `node-cron` job
that triggers `CatalogService.scanLibrary()` on every connected provider.

- The schedule is the `library.scanSchedule` server setting: a standard
  5-field cron expression (`0 3 * * *` daily, `0 3 * * 0` weekly), or `""`
  for no automatic scans. `buildServer` reads it on startup and stops the job
  on close.
- `PATCH /api/admin/settings/server` validates the value (5 fields only;
  legacy aliases such as `disabled` normalize to `""`), saves it, and re-arms
  the job in place. No restart is needed.
- An invalid stored value leaves scans off and is reported in the status
  response, so a bad row cannot crash startup.
- Manual and scheduled runs share one in-flight guard, so scans never
  overlap. A scheduled tick that hits a running scan is skipped and logged.
- Each run is recorded as `succeeded`, `partial` (some providers failed),
  `failed`, or `skipped` (no provider supports scanning). The last run is
  persisted in `server_settings` as `library.lastScanRun`.
- Times use the server process time zone, which the status response reports.

Admin-only endpoints:

- `GET /api/admin/library/scan/status`: schedule, next run, whether a scan is
  running, and the last run.
- `POST /api/admin/library/scan`: starts a scan and returns `202` right away
  with `{ started, alreadyRunning, status }`. The client polls status while a
  scan runs.

The UI lives at Admin → Server → General. `ScanSchedulePicker.jsx` maps
Disabled / Daily / Weekly plus a time and weekday onto cron through
`webapp/src/utils/cronUtils.js`. Expressions the picker cannot represent are
shown read-only and kept until the admin edits the picker or resets it to
Daily at 03:00.

MusicDeck treats music sources as providers behind the registry:

- **Navidrome** — primary provider; catalog, streaming, artwork, and
  favorites/playlist sync.
- **Jellyfin** — built-in provider (catalog + direct audio streaming +
  artwork). Favorites/playlist sync is not yet supported.

### Jellyfin connection

A Jellyfin connection is configured in `backend_connections` with
`type = "jellyfin"` and provider config `config_json`:

```json
{ "url": "http://jellyfin:8096", "apiKey": "<jellyfin-api-key>" }
```

Credentials may instead come from `JELLYFIN_URL` / `JELLYFIN_API_KEY`
environment variables. The API key authenticates via the `X-Emby-Token`
header and is never placed in URLs or logs.

Album detail responses expose `coverUrl` and `artworkUrl` using authenticated
MusicDeck artwork identities. Local artwork candidates are validated before
the response is returned, with coalesced checks, a 128-entry cache, and at most
five concurrent validations. Missing/default root covers inherit the first
genuine child cover (including external tracks), then exact-match iTunes/Deezer
metadata if no child artwork is available. Failed local artwork IDs accompany
the response so child candidates cannot reintroduce a rejected cover.
Validation/metadata network failures are logged and exposed as
`artworkResolutionFailed` without preventing the album itself from loading;
failed checks are not cached as authoritative missing-artwork results.
Spotify playlist imports persist canonical album covers in
`imported_album_artwork`, indexed by normalized album artist and album name
(case/accent/punctuation-insensitive, apostrophes removed). A Spotify album ID
is retained when supplied. The album API checks this durable cache before
network metadata searches after rejecting missing/default native artwork.
Matched and legacy imports publish `cover.jpg` and `folder.jpg` in the actual
audio destination directory before their batch library rescan. JPEG downloads
are restricted to HTTPS `i.scdn.co/image/...`, with no redirects, an eight-second
timeout and a 5 MB limit. Each file is flushed and atomically linked without
overwriting existing folder artwork; files use mode 0644 for backend readability.
Artwork failures are logged and retained as bounded import warnings without
failing downloaded tracks; persistence does not depend on CDN download success.
Navidrome HTTP 200 default images are detected by SHA-256 equality with that
connection's `al-0` image at the same requested size. Reads are limited to 5 MB
and five seconds; only fingerprints are cached, for five minutes and at most
eight sizes per connection. Servers without an `al-0` image retain normal
artwork behavior; unknown default images cannot be inferred from URLs alone.
The shared client resolver rejects known placeholder paths/IDs before rendering
and preserves supplied
HTTP(S) and application-relative URLs, proxies raw IDs, and tries root artwork,
nested album artwork, then all distinct child-track covers. Image error handlers
remain as a second line of defense for genuine covers that later fail to load.
Failures are scoped to the current media item and candidate list.
Local album covers remain preferred. Missing or failed covers can resolve
through the authenticated `/api/metadata/album-artwork` proxy using exact
normalized artist and album matches from iTunes or Deezer. Lookups are
bounded and cached; CDN hosts, redirects, content types, and image sizes are
validated. This display-only fallback never rewrites embedded tags.
Wikipedia artist biographies use `/api/metadata/artist-biography` rather
than browser cross-origin requests, with cached musical-article validation
and source attribution. Native biographies retain priority.

Current Jellyfin support: catalog browsing, search, random albums/tracks,
artwork, and **direct-play streaming only** (no transcoding). Both Navidrome
and Jellyfin connections may be enabled simultaneously; the catalog service
fans reads out across them and the source resolver picks a playable source.