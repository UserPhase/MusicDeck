# MusicDeck user-journey acceptance tests

Run from the repository root after installing the root, server and webapp dependencies:

```sh
npm install
npm run install:all
npx playwright install chromium
npm run test:acceptance:types
npm run test:acceptance
```

On Windows, installed Microsoft Edge is detected automatically; installing Chromium is optional. Set `PLAYWRIGHT_CHANNEL=chromium` to use Playwright's bundled Chromium explicitly. Linux CI can install browser system packages with `npx playwright install --with-deps chromium`. Run a single journey with `npm run test:acceptance -- --grep "Scenario 6"`. Open failures with `npx playwright show-report`.

The suite uses Playwright's isolated browser contexts and real loopback Fastify servers. Each journey owns a fresh SQLite database, library, staging directory, and two ephemeral REST provider servers. Current application source is bundled once per worker with esbuild; an old production build cannot make the suite pass. Tests run serially, without automatic retries.

`helpers/mockBackends.ts` implements authenticated Subsonic and Jellyfin catalog endpoints, paginated search, colliding native track IDs, and valid generated WAV audio. It forwards genuine byte ranges, can return 503s, hold incomplete responses, or disconnect active streams. Unsupported endpoints fail and are reported during teardown. Credentials and signed URL query strings are excluded from request attachments.

`helpers/appFixture.ts` assembles the real provider factory, catalog, playlist services, acquisition service, importer, task manager, authentication routes, diagnostics and persistence. All outbound server HTTP traffic is restricted to loopback. The partial-import journey substitutes the external spotDL process/Spotify metadata boundary; its filesystem operations, HTTP provider scans, playlist linking, job persistence and failed-track diagnostics use production code. The release-feed journey injects deterministic iTunes metadata without making external requests and checks explicit import API delegation; scenario 5 covers the import worker pipeline.

The acceptance-only browser probe observes the mounted PlayerProvider and PlaybackEngine and invokes their real public actions. It also benchmarks the exported queue reducer. It is injected while building the test bundle; production assets and source exports contain no test bridge. Normal login, setup, track playback, mobile selection and navigation are exercised through the DOM.

The background journey owns a separate headless browser/profile through `helpers/nativeBrowser.ts`, connecting with Playwright's public `connectOverCDP(..., { noDefaults: true })` option. This avoids installing Playwright's per-session forced-focus override, which another CDP session cannot remove. Mobile viewport and touch input use Chromium's device emulation. `PLAYWRIGHT_EXECUTABLE_PATH` can select a custom Chromium executable for that journey; otherwise it uses installed Windows Edge or Playwright's downloaded Chromium. The helper closes its owned browser process before the fixture removes its profile.

Fixture databases use file-backed WAL with `synchronous=NORMAL` after initialization so catalog population does not turn the queue benchmark into a host filesystem sync benchmark. Migration and foreign-key checks still execute against actual SQLite files. This suite does not test power-loss durability.

| Journey | Acceptance boundary |
| --- | --- |
| 1. Clean installation and setup | Empty database, UI login, actual provider credential check, required directories, completion survives database reopen. Optional missing download tools may warn. |
| 2. Legacy migration | Pre-39 inline smart-playlist payload shape, 1,000 payloads/playlist entries, multi-genre reconstruction, user preference/order preservation, integrity/foreign-key checks and idempotent reopen. |
| 3. Dual backends | Simultaneous track, artist and album catalogs and search, scoped IDs, real 206 WAV streams from both providers. Similar recordings remain distinct unless explicitly mapped by MusicDeck. |
| 4. Secondary failure | Upstream 503, degraded catalog, unaffected primary playback and track UI, recovery after reconnect. |
| 5. Partial import | Twenty manifest entries, three deterministic audio-provider failures, seventeen saved files and ordered playlist tracks, durable partial terminal state and per-track error logs. |
| 6. Offline recovery | Incomplete live stream, download becomes available, actual browser offline mode, recovery to verified IndexedDB audio, position preservation and offline app-shell reload/playback. |
| 7. Large queue | Real 5,000-item library and player queue, bounded mounted rows, logical reorder correctness, post-GC retained heap growth below 24 MiB, 100 warmed reducer reorders each below 15 ms. |
| 8. Mobile interactions | 390 px touch viewport, 550 ms native touch hold, batch selection/action, scroll-pan cancellation, inline-link isolation, route scroll restoration, continued audio and media-session metadata/state while the document is actually hidden (Playwright's forced-focus override is disabled). |
| 9. Playlist organization | Local track/genre search, duplicate-safe edit undo/redo, nested folder creation, real playlist drag/drop and restoration from Trash into the saved folder. |
| 10. Similar-song mixes | Cached graph generation, hybrid preview, lock/refresh/swap, idempotent saving with external metadata, queueing, live hidden-artist exclusion, account guard, external-occurrence undo and a 390 px layout check. |
| 11. Private listening and taste controls | Actual private playback, history/scrobble preservation, offline preference sync, excluded playlist origin, canonical unhide, reset cutoff/preservation, account guard and mobile toggle visibility. |
| 12. Followed artist releases | Explicit follow through the artist page, real scheduled scanner with deterministic iTunes metadata, six-hour cache reuse, previews, durable wishlist, explicit import API delegation, unfollow isolation, and desktop/390 px layouts. |
| 13. Household collaboration | Named viewer/collaborator sharing, authenticated recipient invitation/login, HTTP 403 viewer edits, contributor attribution, live edits, party requests and host approval, access/link revocation, and desktop/mobile sharing layouts. |
| 14. Persistent queues and handoff | Browser-process restart with 5,000 occurrences and fractional progress; named/static playlist saves; offline reload; bounded drawer rows; second-device restoration; 10,000 repeated/distinct-track hydration measurements. |

The timing threshold measures the queue reducer's synchronous reorder operation; it excludes React rendering, browser IPC and frame scheduling. The heap check measures retained JavaScript heap after garbage collection, not total browser RSS or a proof against every possible leak. Timing and heap samples are attached to the report. Slow shared CI machines can legitimately fail a strict 15 ms requirement; use a controlled performance runner to enforce that budget consistently.

Tab backgrounding and Media Session checks do not certify Android/iOS process suspension, device locking, audio focus, Bluetooth routing or every browser's background policy. Those require real-device acceptance testing. This suite also does not certify installed spotDL/FFmpeg binaries or compatibility with every live Navidrome/Jellyfin release.

Teardown closes Fastify/background services, SQLite handles, mock sockets, browser contexts and temporary directories. Failed journeys retain screenshots, traces, provider request logs and diagnostic attachments under `test-results/acceptance`; the HTML report is in `playwright-report`.
