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

`PlayerProvider.moveQueueItem(from, to)` moves only upcoming queue positions
using an immutable state update. Manual, context-generated and autoplay entries
share that same sequence, including when shuffle is enabled. A pending crossfade
is cancelled before reordering, retaining the outgoing track's position.
Asynchronous refills append new entries to the latest queue rather than replacing
manual moves. Queue snapshots preserve the active index for repeated song IDs.
Repeat remains the existing off/one toggle; this remediation does not add repeat-all.

`PlayerProvider` recovers the active deck from network stalls without touching
the queue, through the engine's `MediaStallRecovery`. A `waiting`/`stalled`
deck that makes no progress for 3.5 s, or a mid-playback network error, is
reloaded in place and seeked back to the saved position after metadata; the
browser then sends a byte `Range` request, which the stream route forwards to
Navidrome/Jellyfin. Retries back off exponentially (immediate, then 1/2/4/8 s,
five attempts, 10 s load timeout). After the last failure the deck is paused
with its source and position kept, so Play reconnects the same song from there.
Pausing during a reconnect still restores the position but does not resume
audio. Unseekable live transcodes restart from the beginning, and the player
says so. A track change, logout, or crossfade handoff abandons the recovery.

Audio stream inspection observes the bytes already passing through the library
stream proxy; it does not download a second copy or delay playback for metadata.
`services/AudioMetadataInspector.ts` keeps at most 500 observations (30-minute idle
expiry), a 64 KiB prefix per pipe and a bounded rolling transfer sample. Its
pull-based Web Stream wrapper preserves backpressure, errors and cancellation.
The authenticated `GET /api/v1/stream/inspect/:trackId?inspectionId=...` returns
sanitized source/output properties and server-to-MusicDeck delivery throughput,
with private/no-store caching. Random per-load correlation IDs are scoped by
account and track; selected-provider metadata follows source failover.

Header inspection supports native FLAC, PCM WAV, Ogg Opus/Vorbis, MP3, ADTS AAC
and bounded MP4/ALAC sample descriptions. MP4 is not assumed to mean AAC; a late
`moov` atom, oversized ID3 tag or initial mid-file Range may leave fields unknown.
An identical recovery pipe can reuse verified header properties. MP3 frame
bitrate is not presented as a track-average VBR bitrate. Raw/static provider
requests are direct evidence; observed codec/rate/depth/channel differences
establish conversion. A requested bitrate cap alone does not. Same-codec
re-encoding without observable differences remains unverified.

`useStreamQualityDetails` polls at two-second intervals while visible, aborting
stale track/account requests. Playback badges use output evidence, not catalog
quality or requested settings. Preview and separate server-normalized assets are
explicitly unverified. Engine diagnostics report the graph's actual sample rate
and current client track-gain stage, not source or hardware sample rate. Browser
device type is not guessed. The inspector's apply-now action saves the account
preference and reloads the current queue occurrence at its exact position and
playing intent. Direct bypasses server-normalized assets but retains client
ReplayGain; Original retains existing normalization policy. Other settings
callers still apply quality to subsequent stream loads.

`context/PlayerContext.tsx` is a thin React adapter over `services/audio/`:
`usePlaybackEngine` creates the engine, `useQueueStore` owns queue order and
playback status, and the provider keeps the long-standing `usePlayer()` API
(plus `playbackStatus`, `isBuffering`, `transitionMode` and
`changeTransitionMode`). Each queue entry becomes a `PlayableTrack` built from
the resolved stream URL, its normalization level and its silence-trim window.
The provider hosts the two `<audio>` decks in a hidden container and renders
time, duration and buffering from engine events. Around it the provider keeps:

- Normalization: the stream and level for an entry are fixed when the engine
  first receives it, so a normalized stream never also gets a measured gain.
  Measurements that arrive later glide the level with `updateTrack` (a ramp of
  at least 4 s). A normalized stream that becomes ready before an upcoming
  track starts replaces the prepared copy at unity gain.
- Auto-refill: when two or fewer upcoming tracks remain and autoplay is on,
  local recommendations seeded by the current track are appended once per
  queue position, deduplicated against the queue, without touching the current
  track. Hidden tracks and tracks played in the last four hours are excluded.
- Transition settings: `transitionMode` (`none`, `gapless`, `crossfade`;
  default gapless) and `crossfadeDuration` (1–10 s) are sent to the engine
  synchronously on change, saved to `playerTransitionMode` and
  `playerCrossfadeDuration`, and synced as `playback.transitionMode` and
  `playback.crossfadeDuration`. A saved positive duration without a mode
  migrates to crossfade. `components/PlayerSettings.tsx` renders these controls
  on the Settings page.

`services/audio/` holds the TypeScript playback engine. `PlaybackEngine` owns two
`HTMLAudioElement` decks plus an optional `AudioContext`, and delegates each
handover to exactly one handler chosen by the transition mode. A single
transition ticket makes them mutually exclusive, and a mode change mid-handover
waits until it commits or cancels:

- `GaplessTransition` fetches the next song at 90% (`resumableFetch.ts`
  resumes dropped downloads with `Range`/`If-Range`), decodes it, and schedules
  an `AudioBufferSourceNode` on the context clock at the outgoing track's end.
  Its only gain write is a hard cut at that instant. Without Web Audio, for
  songs over 20 minutes, or when decoding fails, it preloads the idle deck and
  switches on `ended`.
- `CrossfadeTransition` preloads the idle deck and ramps both deck gains
  (linear or equal-power, 1–10 s). It never decodes or schedules buffers.

`MediaStallRecovery` applies the stall policy above to the active deck. Engine
events carry the queue entry key (`trackEnd`, `transitionStart`,
`transitionCommit`, `bufferStall`, `streamRecovered`, `recoveryFailed`).

Each `PlayableTrack` can carry a linear `gain` (ReplayGain or loudness
normalization, clamped to 0–4) and a silence-trim window (`trimStart`,
`trimEnd`). Values that resolve after loading are applied with
`engine.updateTrack(key, settings)`. With Web Audio, each output routes through
a level `GainNode` and then a separate transition-envelope `GainNode`, so fades
and gapless cuts never overwrite normalization. Without Web Audio, the level
multiplies `element.volume`, which caps boosts at unity. Both transition paths
measure the remaining time against the trimmed end, and a gapless voice starts
after the next song's leading silence. Decoded voices stop on the context clock.
Streamed decks end on the first `timeupdate` past the trimmed end. A resume
position or a listener's seek always beats the trimmed start. A trim change on
either side of a running transition cancels it so it is re-planned.

`hooks/useQueueStore.ts` is a pure reducer over
`PLAYING/PAUSED/BUFFERING/STALLED/TRANSITIONING` with an explicit transition
table. Queue entries have stable IDs, so repeated songs never collide, and
events for any entry other than the current one are ignored. Every load
request has its own sequence number, so rapid skips produce one engine load.
`hooks/usePlaybackEngine.ts` owns the engine's lifecycle.

Shuffle has two modes. Standard remains the default Fisher-Yates permutation.
`utils/shuffle.ts` implements Smart Shuffle locally, with seeded weighted
sampling without replacement: favorites have weight 1.5, artists in the rolling
five-track window multiply that by 0.2, and tracks heard less than two hours ago
are excluded. Artist-group Fenwick totals make selection and window updates
O(log N), for O(N log N) generation. The next artist penalty is updated after
every selection, not just once before generating the queue. Missing artist
metadata and compilation labels do not collapse unrelated songs into one artist.
No backend shuffle endpoint or additional dependency is needed.

`SMART_SHUFFLE_UPCOMING` and optional `SET_QUEUE.smartShuffle` are pure atomic
queue actions with explicit seed, clock, favorite IDs and listening history.
Only upcoming entries are filtered/reordered; the selected current entry and
queue prefix are preserved, even when that track was recently heard. Duplicate
upcoming track IDs are omitted. Excluded entries never reuse their stable IDs.
An exhausted candidate set does not fall back to recent songs. A player notice
explains exclusions. Next/Previous navigate the materialized order without
resampling; snapshots retain that order, index and uint32 seed on reload.
Manually injected/moved items remain explicit overrides. Autoplay/refill uses
Smart Shuffle on new candidates only, never replacing previously queued moves.

Actual engine `playing` and transition-commit events record local recency before
the scrobble threshold, without treating every queued position as listened.
Two-hour history is persisted per MusicDeck user and merged with account recent
plays; local records take precedence to avoid double-counting mirrored events.
History retains each track's latest timestamp and the last five actual events;
pause/reconnect of the same entry is not a new play. The mode is cached as
`playerShuffleMode`, synced as validated `playback.shuffleMode` account settings,
and exposed in the main player's shuffle menu and Settings. Sync writes are
serialized; errors retain the device choice with explicit feedback. Initial
settings responses cannot overwrite a newer selection. Portable settings backups
include the mode, never listening history.

Album-aware playback is an independent opt-in preference (`playerAlbumAware`
locally, validated boolean `playback.albumAware` in account settings). Explicit
album queue starts annotate local tracks with album membership and sequence
indices. Shuffle disables this policy; generic playlists, previews and autoplay
additions do not acquire album membership. The engine's `albumAware` option and
`setAlbumAware` command select the isolated gapless path only between consecutive
indices from the same album. Other boundaries still use the chosen transition
mode. Changing policy cancels prepared/in-flight transitions; original track
settings are retained so disabling it restores ordinary trim behavior.

`outputs.replayGainLevel` selects album gain and album peak for this context,
never track peak or track gain. Missing album gain leaves unity level rather
than flattening the record with independent measurements. The provider uses
original streams, bypasses per-track measured/normalized streams and prewarming,
and rejects late normalization updates for album entries. Album-tagged playback
ignores leading/trailing silence trimming, including late analysis results, so
gapless stitching retains recorded pauses. A policy change reloads an already
loaded entry at its current position and playing/paused state and reconfigures
the upcoming entry. Album membership, sequence and sanitized ReplayGain tags
survive queue snapshots. Disabling normalization still disables album gain.

`components/AlbumEditionPicker.tsx` queries the existing local artist/albums API.
It groups same-artist releases by normalized base title, removing recognized
edition suffixes (Deluxe, Remaster, Expanded, Anniversary) without merging live
or otherwise meaningfully qualified titles. It excludes external catalog items,
deduplicates IDs, and links editions through the existing album route without
changing playback. Missing artist IDs/single releases need no selector; failed
requests expose an inline retry and superseded requests are ignored.

Device downloads live in the `musicdeck-offline` IndexedDB store
(`utils/downloadManager.js`). A download is rejected rather than stored when
its body is shorter than `Content-Length`, when IndexedDB is unavailable (the
old metadata-only `localStorage` fallback is no longer written), or when the
quota is exceeded; each failure has a readable message. Rows never trust a
record directly: `services/storage/OfflineAuditor.ts` checks that the record
has a non-empty blob matching its stored and expected size and that its first
bytes can still be read. Audits are per track, deduplicated, limited to four at
a time and repeated after 60 s for verified files. A damaged record is deleted
and reported as `corrupt`; a previously stored track whose record has gone
(eviction, cleared site data) is `missing`. Both show "Re-download to Device"
instead of "Downloaded".

External (Deezer/iTunes) imports go through one handler,
`services/externalActions.ts` (`saveExternalAlbum`, `importExternalTrack`),
which drives `IDLE → QUEUED → IMPORTING → IN_LIBRARY` (or `FAILED`) per item
key from server acquisition job status. Repeat clicks join the in-flight
request, and on load the handler restores state from `GET /api/acquisitions`.
Status polling backs off on network errors and keeps the job; after repeated
failures it shows a Retry action. Retry is safe because
`AcquisitionService.createJob` reuses the same user's unfinished job for the
same requested track/album instead of inserting a duplicate. Explore renders
external albums with `components/ExternalAlbumCard.tsx`, and errors appear in
an inline `role="alert"`.

`useQueueReorder` implements Pointer Events for the shared `QueueSidebar`
without a drag-and-drop dependency. Mouse input uses the non-interactive row;
touch/pen input uses only the handle. Per-occurrence render keys preserve row
identity even when one song object appears multiple times. Preview transforms
never modify playback state; one `moveQueueItem` call commits the drop.
Queue/index changes, closing the panel, switching tabs, Escape, pointer
cancellation and window blur cancel the gesture and its edge-scroll frame.
Keyboard reordering uses the same action with focus and live announcements.

### Library health scan

`GET/POST /api/admin/library/health/scan` (`routes/admin/health.ts`) run the
admin health check in `LibraryHealthScanService` off the request path: POST
returns 202, only one check runs at a time, and clients poll the GET for
phase, progress and the report. The checks shared with `/api/library/health`
live in `domain/library-health.ts` and yield to the event loop every 500
items. The scan uses `CatalogService.auditSnapshot()` (uncached full
listings plus the connections that answered). It reports missing artwork,
metadata problems, duplicates, album sync mismatches (album count gaps, and
tracks whose album is not listed, but only when every provider supplies a
full album list) and orphaned track records. A record is orphaned only when
every connection that sources it listed successfully without it. Repairs:
`repair/artwork` triggers the scan scheduler's media-server rescan and marks
the report stale. `repair/prune-orphans` (409 without a report) re-lists the
library and, only if no provider is degraded, deletes the orphaned
`library_items` rows plus their favorites and ratings in one transaction.
Records still referenced by `playlist_items` are kept, and media files are
never touched. The admin UI is `components/admin/LibraryHealth.tsx`.

### Virtualized library browsing

Static playlist details also use `VirtualizedTrackList`. `useTrackSelection`
keeps occurrence IDs in a Set, with a stable range anchor independent of mounted
rows. `playlist_items.id` is exposed as `Track.playlistItemId`; full ordered
`Playlist.itemIds` also includes unavailable tracks omitted from hydration.
Native group dragging uses prefix offsets rather than mounted row positions,
pins the drag source while scrolling, and auto-scrolls the existing viewport.
Alt+Arrow keys and the batch toolbar provide keyboard/touch reorder alternatives.

`POST /api/v1/playlists/:playlistId/reorder` accepts `itemIds` and
`expectedItemIds`. The service verifies an exact occurrence permutation and the
expected order in one SQLite transaction; stale edits return 409
`PLAYLIST_CONFLICT`. Visible reordering preserves unavailable occurrence slots.
The client serializes edits, applies reorders optimistically and restores the
previous order on failure. Route-generation guards prevent late responses from
overwriting another playlist. `POST /api/v1/playlists/:playlistId/tracks/batch`
supports idempotent `{ action: "add", trackIds }` and exact-occurrence
`{ action: "remove", itemIds, expectedItemIds }` edits. Both routes retain normal
playlist ownership checks. Provider order synchronization is best-effort and
serialized per playlist; MusicDeck remains authoritative. Navidrome replacement
uses Subsonic `createPlaylist` with `playlistId` and the full ordered `songId`
array, not the append-only `updatePlaylist` operation.

The floating batch toolbar operates on the complete selection, not virtual
rows. Play Next inserts the group in one `INJECT_NEXT_MANY` queue action;
Queue All appends atomically. Both preserve selected occurrence order and
duplicates without changing current playback. Device downloads are sequential,
deduplicate song IDs, report partial failures and stop scheduling after navigation.

The Tracks and Albums library pages use `VirtualizedTrackList.tsx` and
`AlbumGrid.tsx` rather than mapping complete collections into the DOM.
`useVirtualWindow.ts` observes the existing page scroller, batches scroll work
with requestAnimationFrame, and binary-searches cached row offsets. Overscan is
two rows normally and three while moving quickly. Track lists support fixed
heights or ResizeObserver measurements; the library uses measured heights to
retain compact-density styling. Measurement changes above the visible row
adjust the scroll position to preserve its anchor. Album grids virtualize rows
of responsive 180px-minimum cards. Cover containers reserve a square aspect
ratio, and images use native lazy loading and asynchronous decoding.

`PlayerItemStateProvider` bridges the existing PlayerContext to a stable
external store. Track rows and favorite controls use useSyncExternalStore with
cached per-item selectors; unchanged selections retain their reference.
Playback timestamps do not publish item state. Switching playback updates
only the old/new current rows; liking a track updates only that track's
favorite control. Stable action wrappers always call the latest player
implementation without passing changing context objects through list props.
Other existing consumers can continue using `usePlayer()`.
Device-download promises and pending subscriptions are keyed by track in
`downloadManager.js`, so virtual-row unmounts neither lose the pending
indicator nor start duplicate downloads when the row reappears.

`usePagedLibrary.ts` requests only pages intersecting the virtual window
(200 items per page, two concurrent requests, eight cached pages). Uncached
slots retain their estimated height and render skeletons. Requests outside
the latest window or belonging to an unmounted/changed query are aborted;
page errors remain visible with Retry. New snapshot revisions invalidate old
cached pages instead of mixing collection orderings.
Deleted cached items are compacted out of the visible slot sequence, with
subsequent viewport offsets translated back to server offsets.

The authenticated tracks/albums endpoints accept optional `offset` and `limit`
(maximum 500) and return `total` and `revision` alongside their existing item
arrays. Omitting `offset` preserves the original response behavior. The track
filter endpoint also accepts `offset`. CatalogService shares 30-second track
and album snapshots across viewport requests. Recommendations and smart
playlists reuse the track snapshot for their background refreshes. A cold
snapshot still enumerates the provider collection. Navidrome and Jellyfin
enumerate albums in 500-item provider chunks. Third-party providers
can implement optional `listAllAlbums()` for complete album enumeration.
Filtered reads load user annotations once per request, not once per track.
Explicit track playback still loads the complete filtered collection into the
player queue, independently of the browsing cache.

### Admin server log viewer

`server/src/utils/logger.ts` keeps the last 1,000 server log entries in an
in-memory ring buffer that is also capped at about 2 MB. It evicts the oldest
entries first and truncates oversized messages, stacks and metadata.

The buffer is fed from five places:

- Fastify/pino output, through a capture stream passed as the logger `stream`.
  Lines still print to stdout.
- `console.*` calls, which are patched but still print.
- `unhandledRejection` events. The handler records them and keeps the process
  alive.
- `uncaughtExceptionMonitor` and process warnings. These are recorded only, so
  an uncaught exception still crashes the process.
- Partial catalog provider failures, pushed directly by `CatalogService`.

Every entry is redacted before it is stored. Redaction removes:

- Registered literal secrets: the session secret, Navidrome password, Jellyfin
  API key, first-admin password and Spotify client secret.
- Bearer/Basic tokens, cookie and authorization headers, and the
  `musicdeck_session` value.
- Subsonic `t`/`s`/`p` query parameters.
- Credential-looking keys, in both text and nested metadata.
- HTTP(S) URL userinfo credentials.

Catalog list, random and search fan-out reads share `CatalogService.runReads`.
The service accepts the existing log-buffer interface (the process-wide
`serverLogs` in production). If some providers fail and at least one succeeds,
it pushes one structured warning per failed connection and operation into the
same redacted, bounded buffer used by admin history and live SSE. Warnings
include connection ID, provider type, operation and a redacted error description;
provider URLs and search text are not logged. Total failures retain the existing
generic public error and aggregate causes, without duplicate partial warnings.

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

### Smart playlists

Smart playlists persist a private JSON AST, not track membership. Migration 33
adds `smart_playlists`, a narrow `smart_playlist_tracks` SQL read projection,
separate playable payloads, normalized genres, and per-user activity summaries.
Metadata refreshes at startup, every five minutes, and after coordinated library
index scans. Failed/partial providers retain the last indexed metadata with an
explicit warning; ordinary catalog reads do not rewrite this projection.

`types/smart-playlist.ts` validates non-empty nested `AND`/`OR` groups, limits
trees to 100 nodes and six nested levels, and enforces field/operator/value
compatibility. The SQL compiler only interpolates fixed, allowlisted column and
operator tokens; user values are bound parameters. `contains` treats `%`, `_`
and backslash literally. Genre equality matches any individual genre; substring
search uses a separator forbidden in genre rule values to prevent cross-tag
matches. Missing numeric metadata does not match comparisons. Never-played
tracks match `not_in_last_days`, but not absolute last-played comparisons.
Relative days are rolling 24-hour UTC intervals, inclusive at the recent cutoff.

SQLite triggers keep activity summaries current on listening-event and legacy
recent-history inserts, updates and deletes, including cumulative heartbeat
updates and user deletion. Play counts take the maximum of counted event history
and its legacy mirrors rather than adding both; skip counts include explicit
skips and finished unqualified listens. Favorites and activity remain scoped to
the authenticated MusicDeck user, never shared backend-account statistics.

`routes/smart-playlists.ts` exposes authenticated CRUD at
`/api/v1/smart-playlists`, POST `/preview`, and GET `/:id/tracks` with bounded
pagination and an exact count. All saved-definition reads/writes are owner-only,
including for administrators. `SmartPlaylistEvaluator` evaluates locally without
provider calls or cached result membership. Its regression benchmark checks a
compound genre/year/play-count/last-played rule against 20,000 tracks and 20,000
listening rows, requiring SQL count plus sample p95 below 25 ms.

The Library's Smart Playlists category mounts the recursive
`SmartPlaylistBuilder`. Live previews debounce 350 ms, abort obsolete requests,
and display counts, sample tracks, index freshness and errors. Saving stores
rules; playing evaluates current membership again and fills the existing player
queue. Deleting a smart playlist never deletes tracks or changes static playlists.

### Saved external discoveries

`saved_discoveries` stores metadata-only, user-owned Deezer/iTunes bookmarks.
Migration 32 adds a unique `(user_id, provider, type, external_id)` key and
cascading user deletion. Provider-prefixed IDs are normalized before storage;
saving the same item returns the original record without starting a download.

`routes/saved-discoveries.ts` registers authenticated
`GET /api/v1/discoveries/saved`, `POST /api/v1/discoveries/save`, and
`DELETE /api/v1/discoveries/saved/:id`. Every query is scoped to the session
user. GET cross-references the existing local library matcher and durable
acquisition state. Unavailable library sources produce an explicit warning
and unknown status rather than a false in-library badge.

`useSavedDiscoveries` shares a per-user external-store cache, coalesces repeated
mutations and rejects stale refresh results. Explore album/track bookmark
controls store metadata only. `SavedDiscoveriesView` is mounted at
`/saved-discoveries` and linked from the main sidebar and header navigation. Its selected imports
use the existing acquisition API and `SPOTDL_IMPORT` task runner, preserving
permissions, deduplication and progress tracking. The visible shelf polls every
five seconds and refreshes on reconnect/focus. Imported entries remain saved
unless the listener explicitly enables automatic removal; pruning removes only
bookmarks, never media files.

### Local recommendations and autoplay

`services/RecommendationEngine.ts` selects from an in-memory catalog snapshot,
refreshed at startup and every five minutes from the connected media servers.
Selection never calls recommendation plugins or external metadata services.
Genre/artist/mood indexes bound candidate pools to 2,048 tracks; up to 64 ranked
pools and user profiles are retained for 30 seconds. The under-15-ms latency
target applies to warm local selection, not initial provider catalog loading.

The existing `recommendation_feedback` table stores per-user track/artist/album
weights and hard exclusions; no parallel feedback table is introduced.
Favorites plus local plays minus skips form affinity. Finished, unqualified
listening sessions count as early-abandon signals. Similarity combines shared
genres, artist identity/links, year proximity, optional BPM and mood.
Opposing more/less feedback replaces the previous direction. Listening,
favorite and feedback writes invalidate that user's pools. Indexed recent-play
queries are reapplied on cache hits and exclude the last four hours.

`POST /api/recommendations/autoplay` accepts a local seed, limit and queued
exclusions. Both proactive queue refill and end-of-queue continuation use it;
there is no random-song fallback that could bypass negative feedback.
Generated queue entries retain explanations and provenance across reloads.
Successful feedback removes matching upcoming generated entries and invalidates
pending refill responses, without deleting manual queue entries or stopping
the currently playing song. Navidrome/Jellyfin remain the catalog authorities;
their catalog refresh is separate from the local recommendation hot path.

### Listening activity

`listening_events` is the persistent, per-user source for Listening Activity
and the queue's Recently Played preview. Migration 25 extends the existing
recommendation events rather than introducing another tracking system.
Events are not pruned. Legacy completed events and unmatched recent rows are
preserved, with unknown durations left NULL (never inferred from track length).

- The global `PlayerProvider` owns one `listeningTracker` across navigation
  and layout changes. Media progress is bounded by elapsed wall time;
  pausing, buffering and seeking do not manufacture listening seconds.
  External previews are excluded.
- Each listen has a session ID and cumulative seconds. The server upserts
  `(user_id, playback_session_id)` transactionally and takes the maximum
  reported duration, so duplicate/out-of-order requests cannot add plays.
  Native repeat-one wraps, explicit previous-button restarts and new plays
  get new session IDs. Crossfade handoffs preserve incoming playback time.
  Logout ends the session; queued reports carry an expected owner that the
  server checks against authentication to prevent account-switch races.
- Reports are sent every 10 seconds, at the qualification threshold, on
  pause/finish and on page hide, using keepalive requests. A per-user,
  per-tab sessionStorage outbox retries failed reports (up to 100 sessions,
  logging explicitly if offline storage overflows). Refresh resumes the same
  unfinished session. Requests time out after 15 seconds and only one report
  per session is in flight. Closing a tab or a process crash can lose the final
  unreported interval; server-confirmed history remains persistent.
- The counted-listen threshold defaults to **30 seconds**, or the full track
  duration for shorter tracks. Admins may set `listening.thresholdSeconds`
  (a JSON number from 1 to 240) via `PATCH /api/admin/settings/server`.
  New player sessions load this setting; changing it takes effect in the
  server immediately. Listening time includes known short listens, whereas
  history, play counts and rankings require a qualified listen.
- Provider scrobbling is separate from counted listens: the first report that
  reaches **50% of the track or 20 seconds** of real listening, whichever
  comes first, triggers one Navidrome scrobble. The point is derived from the
  stored seconds, so retries and out-of-order reports scrobble only once.
- Metadata/artwork snapshots keep history readable after a track disappears.
  Playback resolves the current library track first and reports unavailable
  tracks without removing their history. Missing legacy metadata is explicitly
  excluded from distinct artist/album totals rather than guessed.

Authenticated endpoints:

- `POST /api/listening-events`: accepts cumulative session reports; the
  previous recommendation-event body remains compatible.
- `GET /api/listening-activity/config`: the counted-listen threshold.
- `GET /api/listening-activity/history`: `period=7|30|90|year|all`, literal
  `search`, `limit` (1-50), and an opaque keyset `cursor`. Date/ID indexes
  make repeated listens and concurrent inserts safe at page boundaries.
- `GET /api/listening-activity/statistics`: the same period choices, with
  real listening seconds, qualified plays, distinct identities, top 10 songs/
  artists/albums and daily/monthly/weekday/hourly aggregates. Trends are
  attributed to the playback start in UTC. The calendar-year period provides
  the basis for future annual recaps.
- `GET /api/recently-played`: the latest 50 qualified events from the same
  source; the queue renders 10 and links to full history. Shared provider-account
  history is not mixed into these user-specific events.

`ListeningActivity.jsx` uses the existing React Query cache, with user-scoped
keys, 30-second freshness, abortable reads and progressive cursor pagination.
Statistics are refreshed after qualified listens/finish, not each heartbeat.
Recent lists also refresh on focus and every minute for other-device activity.
The page reuses `TrackRow`, its context menu and playlist actions, and lives
inside the unchanged layout/player shell.

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
  persisted in `server_settings` as `library.lastScanRun`. A provider counts
  as failed when its scan trigger errors or times out. For example, Navidrome
  `startScan` returning non-2xx fails the provider instead of silently
  succeeding.
- Times use the server process time zone, which the status response reports.

### Portable account exports

`services/DataExportService.ts` owns serialization; `routes/user-export.ts`
registers cookie-authenticated GET endpoints under `/api/v1/user/export`:

- `/summary`: record counts and approximate byte sizes without provider requests.
- `/playlists/:playlistId?format=m3u8|xspf`: an individual UTF-8 playlist.
- `/playlists?format=m3u8|xspf`: all owned/shared playlists in a ZIP archive.
- `/history?format=csv`: all recorded listening events, including partial listens.
- `/favorites?format=json`: deduplicated track/album/artist favorites, recommendation
  feedback modifiers (including hidden flags), and media ratings.
- `/settings?format=json`: saved, allowlisted account preferences with decoded values.
- `/bundle?format=zip|json`: the unified, versioned account export. ZIP adds
  individual history, favorites, settings, M3U8/XSPF playlists and a README.

Administrators have the same endpoint suffixes at
`/api/v1/admin/users/:userId/export`. The regular user prefix always means the
signed-in account, even for administrators; private playlists belonging to
other accounts are not included. Shared legacy playlists remain exportable.
Every download is an attachment with `private, no-store` caching. Two active
exports per target account and four globally are allowed; excess requests get
429 and `Retry-After`. Disconnects and server shutdown abort stream production.

Database enumeration uses keyset pages of at most 500 rows, with event-loop
yields between pages. History reads include a rowid high-water mark so newly
inserted events cannot extend an active export indefinitely. No SQLite iterator
or transaction remains open while waiting on HTTP backpressure. Exports are live
paginated reads, not transactionally consistent snapshots; avoid editing during
generation. `Readable.from` streams incremental CSV/JSON/XML text, and Archiver
streams one lazily appended entry at a time with DEFLATE and ZIP64 support.
History and ZIP generation never collect the complete output into a Buffer.

M3U8 includes `#EXTM3U`, sanitized single-line metadata and `#EXTINF` integer
seconds (`-1` for unknown duration). XSPF uses its version-1 XML namespace,
escaped XML text, URI-encoded locations and integer millisecond durations.
Provider paths inside the configured music root become root-relative URI paths;
outside-root or unavailable paths fall back to credential-free public MusicDeck
stream URLs. The README explains how to relocate playlist files to the music
root and that fallback URLs need a signed-in MusicDeck session. Media files,
absolute server paths, provider credentials, signed media URLs and login data
are not exported. Missing items and duplicate playlist occurrences are retained.
History uses stored snapshots or locally indexed metadata, not per-row provider
requests. CSV uses CRLF and RFC 4180 quoting, with an apostrophe prefix protecting
formula-like textual values for spreadsheet use. Unknown legacy durations/client
names remain empty rather than being invented.

Migration 34 adds nullable `listening_events.client_name`; the existing session
report accepts an optional bounded `clientName`, and new web sessions report
`MusicDeck Web`. Unified JSON (`musicdeck-user-export`, version 1) also preserves
smart playlist rules and saved discoveries' identities and allowlisted descriptive
metadata, excluding arbitrary provider payloads. Favorites retain available local
metadata and provider identity references for migration.

`components/settings/DataExportPanel.tsx` shows counts, approximate sizes, format
selectors, loading/empty/error states and retry. It verifies connectivity/session
before invoking the browser's native attachment download manager; large files
are never accumulated into a frontend Blob. Transfer progress/errors belong to
the browser download manager, not a fabricated completion indicator. These exports
include saved account settings; the existing local preference backup remains the
path for unsaved/device-only preferences. ZIP size estimates are heuristic, not
exact precomputed archive lengths.

### Navigation state and resumable collections

`useViewStateStore.ts` keeps up to 100 route snapshots per signed-in account in
versioned localStorage, with selective `useSyncExternalStore` subscriptions and
cross-tab updates. Search queries/source filters, library filters, visible page
indices and scroll offsets survive navigation/reloads. The store also exposes
sort fields without introducing new sorting controls. Explicit search URL
parameters take precedence over the saved query. Browsing state is device-local,
not an account setting.

`AppLayout` owns the existing `<main>` scroller. Destination pages expose
`data-view-loading` until their asynchronous content has settled. Returning to a
saved offset hides the destination until layout is ready, then restores the
offset and synchronously notifies `useVirtualWindow` before revealing content.
Virtual spacers preserve the total collection height without fetching preceding
pages; the restored visible range requests just its own pages. Outgoing positions
are captured by scroll events, not by reading a potentially clamped scroller
after React has replaced its contents. Route snapshots flush on navigation and
pagehide; corrupt/unavailable browser storage is logged without breaking browsing.

`ResumableMediaService.ts` stores user-scoped album/playlist checkpoints in
SQLite (`media_sessions`, migration 35), independently of scrobbles/statistics.
Authenticated GET/POST/DELETE `/api/v1/user/media-sessions` routes derive ownership
from the session, validate bounded finite positions and timestamps, and reject
inaccessible playlists. GET returns the newest 100 items for shelves; an optional
validated `type`/`mediaId` pair retrieves a specific header checkpoint regardless
of shelf limits. Completed checkpoints disappear immediately; stale ones
expire after 30 days, on access and by hourly cleanup. Short-lived completion
ordering tombstones prevent delayed progress requests from resurrecting finished
collections. Newer capture timestamps win over out-of-order device reports;
clients should have reasonably synchronized clocks (more than five seconds in
the future is rejected).

PlayerProvider tags queue tracks with their original collection/index/count and
playlist occurrence ID, preserving them through truncation, shuffle and device
queue restoration. An engine-event subscriber saves at most every five seconds,
with additional exact-position flushes on pause, navigation, visibility loss and
pagehide (small keepalive requests). Account changes abort pending requests.
Home and collection headers load checkpoints on mount/focus and every 30 seconds
while visible; successful local writes update them immediately. Sync failures
remain explicit and never stop audio.

`ContinueListeningRow.tsx` shows a track-relative progress ring: completed track
indices plus the fraction of the current track, divided by the collection track
count (not a measure of total historical listening time). Resume resolves stable
playlist occurrence IDs before indices, so duplicate tracks/reorders are safe;
a removed occurrence reports an error instead of substituting a different copy.
Explicit resume disables shuffle and loads the ordered collection using the
engine's `startAt`, including metadata-delayed seeks and fractional seconds.
Streams must support seeking to resume accurately. Normal Play still starts at
the beginning; navigation alone never stops playback.

### Background task coordination

Administrators can monitor coordinated work at `/admin/activity`. The Activity
Center uses `useTaskStream.ts`: one cookie-authenticated EventSource per mounted
center, a fresh snapshot on reconnect, exponential backoff (500 ms to 30 s with
jitter), and a 45 s liveness timeout. Independent external-store subscriptions
separate task rows, list membership, connection status and resource metrics.
Progress notifications are coalesced to at most one per task per 100 ms; an
unchanged queue/history snapshot does not notify the surrounding sections.
Connections, retries, watchdogs and pending updates are released on unmount or
account changes.

`/api/v1/admin/tasks/stream` aliases the existing `/events` endpoint. Both send
`ready`, `task.state`, `task.progress`, `metrics`, `history.cleared` and heartbeat
events. Ready snapshots merge up to 500 active/pending tasks and the newest 500
tasks including terminal history. Metrics refresh every 2.5 seconds and distinguish
host free/total RAM, Node process RSS, one-minute load per core (not CPU usage),
worker slots and media-stream leases. Priority changes are also broadcast.
`DELETE /api/v1/admin/tasks/history` removes only terminal tasks and their
diagnostics, notifying other open centers. Active and queued work is preserved.
All monitoring, diagnostic and control routes require administrator access.

TaskManager retains the last 200 diagnostic entries per task, each limited to
2,000 characters, in a cascading SQLite table. State/progress messages and
credential-redacted spotDL stdout/stderr are available from
`GET /api/v1/admin/tasks/:taskId/logs`. The downloader uses its existing
credential redaction before forwarding process lines, and TaskManager applies
the shared logger redactor again before persistence. Older tasks may have no
trace. Expanded diagnostic panels poll every two seconds while work is active;
terminal diagnostics load once and support manual refresh. UI history is bounded
to 500 entries. Speed uses reported download bytes/s when available; ETA is
explicitly approximate and based on observed progress, never fabricated.
Smart playlist previews/evaluation are synchronous indexed queries, not
TaskManager jobs, so the center does not invent entries or pause controls for them.

`server/src/services/TaskManager.ts` provides a persistent coordinator for
cooperative `SPOTDL_IMPORT` (`SPOTDL_DOWNLOAD` compatibility alias),
`LIBRARY_SCAN` and `AUDIO_ANALYSIS` runners.
Tasks and five-field cron schedules are stored in SQLite; after a process
restart, unfinished `PROCESSING` rows are marked failed rather than being
reported as if they continued. Queued work survives and is resumed when its
runner registers. Settled history is bounded to 1,000 tasks.

- The default worker limit is two concurrent tasks and one audio-analysis
  worker. The priority queue orders downloads above library scans above audio
  analysis; admins can adjust active or queued priority through the task API.
- The monitor uses `os.freemem()`, system load per CPU core and active media
  stream leases. New work waits under resource pressure; scans and audio analysis yield
  at its next checkpoint while a stream is active. Task runners must call
  `checkpoint()` between bounded units of work and observe `signal` for
  cancellation. JavaScript cannot safely suspend a non-cooperative runner.
- Admin-only `/api/v1/admin/tasks` endpoints expose lifecycle controls and
  cron schedules. `/api/v1/admin/tasks/events` broadcasts state and progress
  over authenticated, connection-limited SSE. The SSE representation omits
  task payloads; progress includes process RSS, processed item counts and
  percentage.
- `buildServer` registers acquisition/Spotify playlist import and library-scan
  runners before binding services. Existing import progress, metadata parsing,
  durable playlist checkpoints and scan-status endpoints remain in use.
  Playlist imports yield between tracks and provider retries; the same abort
  signal reaches each spotDL process. Cancellation sends SIGTERM, escalates
  after three seconds, and waits for process close before temporary-file cleanup.
  Acquisition restart recovery retains its explicit failed/retry behavior;
  playlist imports resume from their persisted manifests after registration.
- Library scans trigger Navidrome/Jellyfin scans sequentially and refresh
  MusicDeck's stable track-ID index in batches of 50, yielding between batches.
  Providers own filesystem traversal; an already accepted remote scan cannot
  be cancelled by MusicDeck. Follow-up scans during imports share the parent
  task slot rather than waiting on a nested task and risking deadlock.
- `buildServer` accepts `taskDefinitions` overrides so worker adapters can provide
  validated payloads and cooperative run functions. Attempting to enqueue or
  schedule a type without a registered worker returns a conflict rather than
  creating work that can never run.

### Trusted server extension lifecycle

`ExtensionManager` adds an opt-in executable-module lifecycle beside the existing
catalog/provider plugin registry. It discovers strict `extension.json` manifests
under `MUSICDECK_EXTENSIONS_DIR` without importing disabled code, persists enabled
intent in SQLite and serializes live activation/disable. A fixed admin-only
Fastify gateway dispatches exact module routes, so hot toggles never mutate a
started router. Optional audio-analysis runners/interceptors use TaskManager;
core download and scan runners bypass extension middleware.

Disable closes admission, aborts and cancels work, drains handlers/tasks and
awaits resource cleanup. Failed cleanup remains unavailable and retryable;
server shutdown uses `preClose` to abort work before waiting for HTTP requests.
Local module imports are trusted in-process code, not a security sandbox.
Replacement code requires restart; newly installed folders can be scanned live.
See [server extensions](server-extensions.md) for the complete hook contract,
installation, lifecycle guarantees and isolation limitations.

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
artwork, and static direct streaming or requested MP3 bitrate caps. Actual
transcoding is verified separately by the stream inspector. Both Navidrome
and Jellyfin connections may be enabled simultaneously; the catalog service
fans reads out across them and the source resolver picks a playable source.

### Outbound privacy policy

`server/src/services/PrivacyManager.ts` owns a global SQLite-backed policy,
installed before providers, plugins and background services start. Requests use
an AsyncLocalStorage scope; background work uses the same runtime policy.
Managed HTTP transports (including injected catalog/plugin bridges) are checked
before transport or DNS, with each redirect checked separately. Only exact
configured library origins and base paths are trusted, not arbitrary LAN hosts.
Cross-origin redirects drop authentication headers. Enabling a restriction
aborts affected streams and awaits termination of managed spotDL workers.

Authenticated clients read `GET /api/v1/privacy`; administrators update the
complete four-boolean policy through `PATCH /api/v1/privacy`. Disabled
integrations return HTTP 403 with `LOCAL_ONLY_MODE_ACTIVE` or
`EXTERNAL_INTEGRATION_DISABLED`. The policy is stored at `privacy.policy` in
`server_settings`; malformed persisted data refuses startup. `LOCAL_ONLY_MODE`
is an environment lock and cannot be overridden by the API.

Metadata, artwork and imports have separate permissions. Since spotDL owns its
nested provider requests, imports conservatively require metadata and artwork
permission as well. Unknown-purpose plugin diagnostics require all permissions.
The browser loads policy before mounting authenticated content, synchronizes
every five seconds and on focus, proxies iTunes lookups through the server and
filters cached external artwork. A later sync failure blocks external features
without unmounting the player or local library. This is application enforcement,
not a firewall or a restriction on the configured media server's own integrations.

### Installable web shell and offline storage

The CRA production build injects its revisioned asset list into
`webapp/src/service-worker.ts`; registration lives in the existing `src/index.js`
entry point. No parallel build pipeline or new runtime dependency is needed.
Registration requires a secure, same-origin context and is disabled in development.
An installed update waits for existing tabs to close rather than interrupting
playback. Navigation is network-first with the installed HTML shell as the offline
fallback; bundled JS, CSS and fonts use StaleWhileRevalidate. Current build assets
are retained while obsolete versions/asset URLs are removed on activation.

Artwork from the same-origin authenticated proxy uses CacheFirst with a 30-day
freshness limit and at most 1,000 entries. Cache names are account-scoped; logout
or account changes clear artwork, and privacy changes bypass/remove external
artwork. Native artwork remains usable during privacy synchronization outages.
The worker requests current policy again if its in-memory state was restarted.
Native catalog list/detail responses use the same bounded CacheFirst policy in
account- and privacy-mode-scoped metadata caches, respecting `Cache-Control:
no-store`. Account/policy changes and API mutations invalidate cached catalog
data. Search, external-entity, settings, privacy and session APIs remain
network-only; cached metadata never substitutes for session authentication.
The public PWA manifest also uses CacheFirst.

Audio/video destinations, media URLs, Range requests, mutations and third-party
URLs are never intercepted or automatically cached. Explicit track downloads
continue through `downloadManager` into the existing `musicdeck-offline/tracks`
IndexedDB store, verified by `OfflineAuditor`. The storage manager uses
`navigator.storage.estimate()` for origin usage/quota and a cursor for audio
inventory without loading all audio blobs into memory. Artwork cleanup and stale
web-cache cleanup are independent of audio deletion. Audio purge aborts pending
downloads, prevents new admissions, clears records in a transaction and
invalidates audited downloaded badges; preferences, sessions and the current
offline shell are preserved.

### Google Cast output

`CastManager` lazily wraps the Google Web Sender SDK after user consent.
`useCastSession` binds its lifecycle to the authenticated PlayerProvider, and
PlaybackEngine switches to a mutually exclusive `RemoteAudioOutput` instead of
creating a parallel queue. Receiver time/state/completion become the engine's
existing occurrence-keyed events; local decks and gapless/crossfade preparation
are released while casting. Stopping returns to a paused local deck.

Authenticated Cast ticket issuance resolves source MIME and creates a bounded,
session-bound track capability. Receivers fetch its cookie-free, no-store Range
endpoint; no browser session or provider credentials cross to Google. Privacy
changes and session revocation invalidate capabilities. Cast and WebSocket
handoffs cannot compete for the same engine. See
[Google Cast](google-cast.md) for security, deployment and verification limits.

### Remote playback sessions

`RemoteControlHub` attaches to the existing HTTP server at `/api/v1/remote`.
Upgrades require the normal session cookie and an exact configured public/CORS
Origin. Sessions are revalidated on messages, revocation notifications and
15-second ping/pong heartbeats. Registries, commands and transfers are isolated
by user; presence is ephemeral, with at most 16 connections per account. The hub
does not relay audio or expose backend credentials.

`useRemoteSession` publishes device state every 500 ms when it changes,
reconnects with bounded exponential backoff, correlates command acknowledgements
and coalesces continuous seek/volume updates into 80 ms windows. Transport
commands execute through the same PlayerProvider/PlaybackEngine used locally;
remote-aware public controls do not echo incoming commands back to the hub.

Handoff is an acknowledged prepare/commit protocol:

```text
Controller -> Hub -> Source: REQUEST_SNAPSHOT
Source -> Hub -> Target: INITIALIZE_PLAYER (ordered queue + fractional position)
Target: hydrate current library track; load paused; await real decoded/seeked data
Target -> Hub: READY
Hub -> Source: PAUSE_FOR_TRANSFER
Source: capture fresh position, then pause
Source -> Hub -> Target: START_TRANSFER (fresh snapshot)
Target -> Hub: STARTED
Hub -> devices: active-player registry + TRANSFER_COMPLETE
```

The source continues while the target prepares. A queue mutation aborts commit;
unique occurrence IDs preserve repeated tracks, and repeat/shuffle seed,
album membership and collection checkpoint metadata travel with the queue.
Transfers are capped at 5,000 entries and 1 MiB, use only portable library IDs
and safe metadata, and never carry stream URLs. Nonportable selected sources,
previews and streams without finite, seekable media readiness are rejected.
Targets require an explicit user gesture to enable playback. Preparation is
silent; final autoplay failures are acknowledged only after pausing the target,
allowing a safe source resume. An ambiguous post-pause disconnect/timeout does
not auto-resume the source and risk two audible players.

The controller shows the target's track, fractional position, play state and
volume. Queue editing, shuffle/repeat editing and audio inspection belong to
the active device; stale local queues/quality diagnostics are not presented as
remote state. This is single-player continuity, not clock-synchronized multi-room
audio. Browser suspension, OS background limits and network latency still apply.
