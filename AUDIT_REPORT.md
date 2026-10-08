# MusicDeck System Audit Report

**Scope:** full-stack verification after the contrast fixes, dynamic branding, the four layout presets, live log streaming and the library scan scheduler.
**Original result:** 28 PASS · 3 WARN · 0 FAIL · 1 N/A. Every failure found during the original audit was either fixed in place or explained below.

**Remediation update (2026-10-08):** The three original warnings now pass the
automated checks described in the addendum below. The original tables retain
their historical evidence; this update does not claim fresh live-browser or
external-service verification of every earlier PASS.

## How it was verified

| Layer | Method |
|---|---|
| Server | Vitest, **75 files / 809 tests passing** (two consecutive full runs). The new [`server/test/system-audit.test.ts`](server/test/system-audit.test.ts) adds route-enumerated auth guards, persistence across restarts and error-pipeline checks. |
| Client | Jest, 389 tests passing, and the production build (`webapp/build`) compiles. |
| UI | Headless Microsoft Edge (`playwright-core`) driving the production build against a mock API that served real WAV audio with HTTP Range support. Viewports: 1440 px, 900 px and 375 px, in both themes. |
| Contrast | Computed WCAG 2.1 ratios from the rendered colours (`getComputedStyle`), not from the class names. |

> **Stack note.** The audit prompts name TypeScript, Tailwind, Zustand and a `system_settings` table. This repository actually uses React JSX with plain CSS and React context on the client, and Fastify + better-sqlite3 on the server. Settings live in the **`server_settings`** table. Each checklist item was verified against these real equivalents.

## Status breakdown

### 1. Core audio playback & media pipeline

| Check | Status | Evidence |
|---|---|---|
| Playback continuity across navigation | **PASS** | `currentTime` kept advancing on the same `<audio>` element across Home → Library → Album → Search. |
| Playback continuity across layout preset switches | **PASS** | Switching spotify → apple → ytmusic → soundcloud did not pause or reset the element or the queue. The player state lives in `PlayerContext` above the layout shell. |
| Queue: next / previous / rapid switching | **PASS** | 10 rapid "Next" clicks left exactly one playing element, on the correct track. |
| Shuffle & repeat (off / all / one) | **PASS** | Order and wrap-around behaviour verified in the browser and by `PlayerContext.test.jsx`. |
| Queue reordering | **WARN** | **Missing feature, not a regression.** The play queue has no drag or move-up/down reordering; only playlists support it (`PUT /api/playlists/:id/tracks/reorder`). *Remediation:* add a `moveQueueItem(from, to)` action to `PlayerContext` and drag handles in `QueuePanel`. |
| Recently Played populates | **PASS** | An entry appears after a qualifying listen (½ of the duration, capped at 240 s) and is persisted per user via `POST /api/recently-played` with retention (`domain.test.ts`). |
| Metadata lookups survive timeouts and missing data | **PASS** *(fixed during audit)* | Navidrome and Jellyfin calls now time out after 15 s; Spotify auth, track resolution and the search-provider registry after 10 s. Failures resolve to empty or normalized results with no unhandled rejections. |
| Navidrome scan trigger failure | **PASS** *(fixed during audit)* | `scanLibrary` used to report success when the trigger request failed. It now throws, the scheduler records a failed run, and Spotify import tolerates the error. |

### 2. UI, accessibility & contrast

| Check | Status | Evidence |
|---|---|---|
| "Remove photo" contrast | **PASS** | 11.74:1 dark / 14.33:1 light (minimum 4.5:1). |
| Queue / Recently Played segmented control | **PASS** | Active tab 11.74:1 dark / 14.33:1 light; inactive ≈ 6.9:1. |
| "Re-analyze current track" button | **PASS** *(fixed during audit)* | `.account-secondary` had no CSS and rendered as an unstyled browser button. It is now styled (11.74:1 / 14.33:1) with tactile press states. |
| Preset `spotify` | **PASS** | Left sidebar, centre content, right queue panel, bottom player. |
| Preset `apple` | **PASS** | Sidebar, sticky top header player with search, centre content, right panel. |
| Preset `ytmusic` | **PASS** | Full-width top navigation with drawer, full-bleed content, expandable bottom drawer player. |
| Preset `soundcloud` | **PASS** | Top header, feed column with an inline right widget sidebar, full-width bottom player. |
| Responsive breakpoints | **PASS** *(fixed during audit)* | 1440 px and 900 px render each archetype; under 768 px all four fall back to the shared mobile shell. At ≤ 700 px the topbar profile name squeezed the search box to about 80 px. It is now visually hidden but still read by screen readers, and the search box is 211 px wide. |

### 3. Admin panel & system management

| Check | Status | Evidence |
|---|---|---|
| Dynamic branding | **PASS** | Saving an Application Name immediately updates the sidebar logo, the admin header and `document.title` without a reload. Empty or whitespace names fall back to "MusicDeck". |
| Log history `GET /api/admin/logs` | **PASS** | Level, limit and `after` filters are verified in `admin-logs.test.ts`. |
| Live SSE `GET /api/admin/logs/stream` | **PASS** | Entries arrive live in the UI; listeners are removed when the client disconnects. |
| Level filters, search, auto-scroll, stack expansion | **PASS** | Verified in the browser. |
| Ring buffer memory cap | **PASS** | Hard caps of 1,000 entries and ~2 MB, with per-message truncation (`LogBuffer` tests). Secrets, cookies and authorization headers are redacted. |
| Scheduler cron serialization | **PASS** | Daily → `0 3 * * *`, Weekly (Sunday) → `0 3 * * 0`, Disabled → `""`. Invalid or legacy strings are flagged in the UI and can be reset. |
| Scheduler live reschedule & "Scan library now" | **PASS** | Saving reschedules the in-memory `node-cron` job without a restart. A manual scan returns `202` and the UI polls the status endpoint. |

### 4. API, security & database integrity

| Check | Status | Evidence |
|---|---|---|
| Admin auth guards | **PASS** | `system-audit.test.ts` enumerates **every registered route** under `/api/admin/*` and `/api/v1/admin/*` (30 method/path pairs), plus the admin-only `/api/users` mutations. Each returns **401** without a session and **403** for a `user`-role session (68 assertions, 0 failures). New admin routes are covered automatically. |
| Config persistence across restart | **PASS** | Against a file-backed SQLite DB, the test sets `appName` and `library.scanSchedule = "0 3 * * 0"`, shuts the server down, then builds a new server on the same file. `GET /api/public/config` still returns the custom name, and the scheduler re-arms from `server_settings` (`enabled: true`, `nextRunAt` set). |
| Route errors produce `[ERROR]` logs without crashing | **PASS** *(fixed during audit, see F-1)* | When the backend throws, the client receives a normalized `502 PROVIDER_UNAVAILABLE` body with no stack, and an error-level ring-buffer entry is recorded with the root cause. `/api/health` keeps answering afterwards. |
| Unhandled promise rejections | **PASS** | Logged at `error` level, source `process`, with the stack; the process stays alive. Truly uncaught exceptions are recorded, then still terminate the process by design so Docker can restart it. |
| Partial provider outage visibility | **WARN** | When only *some* catalog providers fail, results are still served, but the failing provider's error is not logged; it shows only in each item's availability metadata. *Remediation:* pass a logger into `CatalogService` and `warn` once per failed connection in `readAll`. |

### 5. Regression check

| Subsystem | Status | Evidence |
|---|---|---|
| Navidrome API connection | **PASS** | `navidrome-backend.test.ts` and `multi-provider.test.ts` pass, including the new timeout and scan-failure cases. |
| Jellyfin API connection | **PASS** | `jellyfin-backend.test.ts` passes. |
| spotDL downloads & tag repair | **PASS** | `downloader-adapter.test.ts`, `audio-tagger-service.test.ts` (real ffmpeg and mutagen MP3/FLAC/M4A fixtures) and the Spotify import suites all pass. |
| Test-suite stability | **WARN** *(mitigated)* | The full suite timed out intermittently: scrypt hashing and Python tagging subprocesses on all 12 cores starved each other, hitting the 5 s default, per-test 10 s overrides and a 15 s polling deadline. No product code was at fault; each failing file passed alone. Added [`server/vitest.config.ts`](server/vitest.config.ts) (`maxWorkers: "50%"`, 20 s timeouts) and widened the 14-track import deadline. Two consecutive full runs then passed 809/809. |
| Phemex trading bot integration | **N/A** | No Phemex code, dependency or configuration exists anywhere in this repository. That integration presumably lives in a separate project and could not be regression-tested here. |

## Findings fixed during this audit

| ID | Severity | Location | Issue | Fix |
|---|---|---|---|---|
| F-1 | Medium | `server/src/domain/catalog.ts:65-79, 289, 308, 357, 366` | `readAll` and `search` used a bare `catch {}`, so when every provider failed, the real error (e.g. an auth failure or `ECONNREFUSED`) was dropped and operators saw only "All catalog providers are unavailable". | Failures are kept as `error`. The thrown error carries an `AggregateError` `cause`, and its server-side stack lists `Caused by [connectionId]: …` for each provider. The client-facing message is unchanged and leaks no provider internals. |
| F-2 | Medium | `server/src/backends/navidrome/navidrome-backend.ts`, `jellyfin-backend.ts`, `spotify-auth.ts`, `spotify-track-resolver.ts`, `search-provider-registry.ts` | Outbound HTTP calls had no timeout; a hung media server or API could stall requests indefinitely. | 15 s (media servers) and 10 s (Spotify and search providers) `AbortSignal` timeouts. Audio stream fetches are intentionally excluded. |
| F-3 | Medium | `navidrome-backend.ts` (`scanLibrary`) | A failed scan trigger was reported as success. | Now throws, so the scheduler records a failed run. |
| F-4 | Low | `webapp/src/styles/detail-pages.css`, `tactile.css` | `.account-secondary` was unstyled. | High-contrast styles plus press states. |
| F-5 | Low | `webapp/src/styles/topbar.css` | Mobile topbar crushed the search input. | Profile name visually hidden at ≤ 700 px but still read by screen readers. |
| F-6 | Low | `server/vitest.config.ts`, `server/test/audio-tagger-service.test.ts` | Load-dependent test flakiness. | Worker cap and timeout headroom. |
| F-7 | Low | 4 client test suites | Tests had drifted from current UI copy and behaviour. | Updated assertions. |

## Original open items (superseded by remediation below)

1. **Queue reordering** (WARN): add drag-to-reorder in the play queue.
2. **Partial outage logging** (WARN): log a warning for each failing provider even when other providers succeed.
3. **Phemex** (N/A): run its regression checks in the repository that contains that integration.

## Remediation verification - 2026-10-08

| Original warning | Updated status | Verified evidence |
|---|---|---|
| Queue reordering | **PASS (automated)** | `PlayerProvider.moveQueueItem` immutably moves upcoming positions. `QueueSidebar` provides native dragging, keyboard arrows, Move Up/Down buttons and full-queue expansion. Tests cover both directions, boundaries, invalid moves, duplicate occurrences, progress/source continuity, Next/Previous, shuffle, repeat-one, persistence, consumer replacement/navigation, stale drags, asynchronous refills and crossfade cancellation. Focus follows keyboard moves and a live region announces positions. |
| Partial provider outage logging | **PASS** | Shared `runReads` covers list, random and search operations. One redacted warning per failed connection enters the existing bounded admin log buffer while healthy results remain available. Tests verify success, one/multiple partial failures, total failure aggregate causes, timeout errors, sensitive text, authenticated history and real HTTP live SSE delivery. |
| Test-suite stability | **PASS for this environment** | Two consecutive final full server runs passed **840/840 tests in 76 files**, in 118.02 s and 119.77 s. The existing 50% worker cap and 20 s test/hook timeouts remain unchanged. No reproducible runtime-test flake was observed. |
| Phemex integration | **N/A** | No implementation was added or tested. |

### Changes and checks

- Playback: [PlayerContext](webapp/src/context/PlayerContext.jsx),
  [QueueSidebar](webapp/src/components/QueueSidebar.jsx),
  [queue persistence](webapp/src/utils/queuePersistence.js), associated tests,
  and [queue styles](webapp/src/styles/layout.css).
- Logging: [CatalogService](server/src/domain/catalog.ts),
  [logger redaction](server/src/utils/logger.ts),
  [production wiring](server/src/main.ts),
  [test-server wiring](server/test/helpers.ts),
  [catalog tests](server/test/catalog-service.test.ts), and
  [admin history/SSE tests](server/test/admin-logs.test.ts).
- Focused client verification: **74/74** tests across playback, queue UI,
  persistence and layout suites.
- Focused server verification: **57/57** catalog/log tests.
- Final full client verification: **423/423** tests in **68 suites**.
- Server production build (`tsc -p tsconfig.build.json`): **PASS**.
- Frontend production build with `CI=true`: **PASS**, compiled successfully.
- ESLint for changed production client files, queue UI tests and persistence
  tests: **PASS**.

### Limitations and follow-ups

- Broad server typecheck still reports **11 existing errors** in untouched
  `admin-user-guards.test.ts`, `playlist-service.test.ts` and
  `spotify-folder-artwork.test.ts`. Changed server files have no reported
  errors; production typechecking/build passes.
- Including the existing playback test file in standalone ESLint reports
  **67 pre-existing Testing Library violations**. New tests use a scoped
  audio-query helper because audio elements have no implicit ARIA role;
  existing unrelated tests were not rewritten or globally suppressed.
- No browser automation tools or Playwright packages were available in this
  session. Dragging, keyboard behavior, focus and announcements were tested
  in Jest's DOM environment, not a live browser. Visual checks across themes,
  mobile devices and all four live layouts remain a recommended follow-up.
- External connectivity/downloads were not tested against live Navidrome,
  Jellyfin, Spotify or spotDL services. The full existing integration and
  audio-tagging suites passed; their fixtures/mocks do not prove live service
  availability.
- Current playback supports the existing **Repeat Off/One** toggle, not
  Repeat All. The original audit's Off/All/One claim does not match the
  current implementation. Reordering preserves existing repeat behavior;
  a new repeat mode is outside this remediation.
- The audit's widened 14-track polling deadline could not be confirmed as
  described: the current playlist-import helper polls 200 times at 10 ms.
  Its import cases passed in the repeated full suites, so no timeout changes
  were made.
