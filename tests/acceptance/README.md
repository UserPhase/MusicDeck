# MusicDeck user-journey acceptance tests

Run from the repository root after installing the root and webapp dependencies:

```sh
npm install
npm run install:all
npx playwright install chromium
npm run test:acceptance:types
npm run test:acceptance
```

On Windows, installed Microsoft Edge is detected automatically; installing Chromium is optional. Set `PLAYWRIGHT_CHANNEL=chromium` to use Playwright's bundled Chromium explicitly. Linux CI can install browser system packages with `npx playwright install --with-deps chromium`. Run a single journey with `npm run test:acceptance -- --grep "Scenario 6"`. Open failures with `npx playwright show-report`.

The suite starts the Rust MusicDeck binaries with Playwright and serves current React source through a loopback test gateway. Use Node.js 24 for the fixture's SQLite access and a Rust toolchain to build the server and database initializer. Each journey owns its SQLite database, library, staging directory and mock REST providers. The browser bundle is generated once per worker.

The mock Navidrome and Jellyfin providers serve authenticated catalog data and real byte ranges from generated WAV fixtures. The gateway forwards HTTP and WebSocket requests to the Rust server. Fixture preferences, credentials and files are isolated from the developer's installation.

Partial spotDL imports and followed-artist release service behavior are covered by the Rust tests in [spotDL tasks](../../server-rust/src/tasks/tests/spotdl.rs) and [artist follows](../../server-rust/src/social/artist_follows.rs). The old browser scenarios for those features used dependency injection specific to the TypeScript server.

The acceptance-only browser probe observes the mounted PlayerProvider and PlaybackEngine and invokes their real public actions. It also benchmarks the exported queue reducer. It is injected while building the test bundle; production assets and source exports contain no test bridge. Normal login, setup, track playback, mobile selection and navigation are exercised through the DOM.

The background journey owns a separate headless browser/profile through `helpers/nativeBrowser.ts`, connecting with Playwright's public `connectOverCDP(..., { noDefaults: true })` option. This avoids installing Playwright's per-session forced-focus override, which another CDP session cannot remove. Mobile viewport and touch input use Chromium's device emulation. `PLAYWRIGHT_EXECUTABLE_PATH` can select a custom Chromium executable for the suite; otherwise it uses installed Windows Edge or Playwright's downloaded Chromium. The helper closes its owned browser process before the fixture removes its profile.

Migration and foreign-key checks execute against file-backed SQLite fixture databases.

| Journey | Acceptance boundary |
| --- | --- |
| 1. Clean installation and setup | Empty database, UI login, actual provider credential check, required directories, completion survives database reopen. Optional missing download tools may warn. |
| 2. Legacy migration | Pre-39 inline smart-playlist payload shape, 1,000 payloads/playlist entries, multi-genre reconstruction, user preference/order preservation, integrity/foreign-key checks and idempotent reopen. |
| 3. Dual backends | Simultaneous track, artist and album catalogs and search, scoped IDs, real 206 WAV streams from both providers. Distinct recordings remain separate and matching MusicBrainz recording IDs share a library entry. |
| 4. Secondary failure | Upstream 503, degraded catalog, unaffected primary playback and track UI, recovery after reconnect. |
| 6. Offline recovery | Incomplete live stream, download becomes available, actual browser offline mode, recovery to verified IndexedDB audio, position preservation and offline app-shell reload/playback. |
| 7. Large queue | Real 5,000-item library and player queue, bounded mounted rows, logical reorder correctness, post-GC retained heap growth below 24 MiB, 100 warmed reducer reorders each below 15 ms. |
| 8. Mobile interactions | 390 px touch viewport, 550 ms native touch hold, batch selection/action, scroll-pan cancellation, artist actions that leave playback untouched, route scroll restoration, continued audio and media-session metadata/state while the document is actually hidden (Playwright's forced-focus override is disabled). |
| 9. Playlist organization | Local track/genre search, duplicate-safe edit undo/redo, nested folder creation, real playlist drag/drop and restoration from Trash into the saved folder. |
| 10. Similar-song mixes | Cached graph generation, hybrid preview, lock/refresh/swap, idempotent saving with external metadata, queueing, live hidden-artist exclusion, account guard, external-occurrence undo and a 390 px layout check. |
| 11. Private listening and taste controls | Actual private playback, history/scrobble preservation, offline preference sync, excluded playlist origin, canonical unhide, reset cutoff/preservation, account guard and mobile toggle visibility. |
| 13. Household collaboration | Named viewer/collaborator sharing, authenticated recipient invitation/login, HTTP 403 viewer edits, contributor attribution, live edits, party requests and host approval, access/link revocation, and desktop/mobile sharing layouts. |
| 14. Persistent queues and handoff | Browser-process restart with 5,000 occurrences and fractional progress; named/static playlist saves; offline reload; bounded drawer rows; second-device restoration; 10,000 repeated/distinct-track hydration measurements. |

The timing threshold measures the queue reducer's synchronous reorder operation; it excludes React rendering, browser IPC and frame scheduling. The heap check measures retained JavaScript heap after garbage collection, not total browser RSS or a proof against every possible leak. Timing and heap samples are attached to the report. Slow shared CI machines can legitimately fail a strict 15 ms requirement; use a controlled performance runner to enforce that budget consistently.

Tab backgrounding and Media Session checks do not certify Android/iOS process suspension, device locking, audio focus, Bluetooth routing or every browser's background policy. Those require real-device acceptance testing. This suite also does not certify installed spotDL/FFmpeg binaries or compatibility with every live Navidrome/Jellyfin release.

Teardown stops the Rust child process and closes the gateway, SQLite handles, mock sockets, browser contexts and temporary directories. Failed journeys retain screenshots, traces, provider request logs and diagnostic attachments under `test-results/acceptance`; the HTML report is in `playwright-report`.
