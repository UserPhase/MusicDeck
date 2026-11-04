# Private listening and taste controls

The player’s **Private** switch changes a per-account preference shared with other signed-in players. Settings → **Taste & feedback** (also `/settings/taste`) manages that preference, hidden artists/albums/tracks, song and playlist exclusions, and listening-influence resets.

Private listening keeps MusicDeck listening history and enabled scrobbling. It does not make playback anonymous or disable external scrobble integrations. Private listening sessions do not contribute to affinity, discovery seeds, smart-playlist listening counts, recent-play recommendation suppression or automatic queue extension. Manual favorites and explicit preference feedback remain deliberate taste signals.

## Persistent eligibility boundary

Migration 43 adds `TasteProfileManager`, per-account preferences/revisions, private-session policy periods, song exclusions, `playlists.exclude_from_taste`, and immutable eligibility/origin fields on listening events and recent-play mirrors. `taste_listening_events` and `taste_recently_played` are SQLite views over full history. They reject excluded events, sessions before a reset cutoff, and excluded recording identities.

The normal playback recorder still accumulates actual listening time, qualifies counted history, and writes the scrobble outbox in its original transaction. Taste eligibility is stamped before the event becomes visible. An existing event's excluded flag can only move from false to true. Mid-session privacy removes an already-counted session's taste contribution and updates its recent-play mirror. A delayed or out-of-order report cannot reverse that decision. Original playlist origin also remains fixed for the session.

The browser tracker snapshots playlist context, captures private/excluded status monotonically, and includes it in its durable report outbox. A response acknowledging an earlier public report cannot discard a pending privacy update with equal listening seconds. After private mode ends, historical report timestamps distinguish completed public listens from later private periods. While server privacy is active, reports are conservatively excluded regardless of client flags or backdating. Server decisions learned after offline delivery also retract local shuffle influence and remain attached to the active session.

Private mode starts immediately on the device, including offline. Ending it requires server acknowledgement. Pending intent is stored per account and retried on reconnect. Unknown or unreadable preferences default to private until checked. Account changes abort pending requests and clear rendered account state. The server polls no external services for these preferences.

## Recommendation integration

`RecommendationEngine`, `RecommendationService`, `SimilarMixEngine`, automatic playback extension and the smart-playlist activity projection read eligible activity. SQLite triggers keep the smart projection synchronized. Preference revisions invalidate cached profiles and ranked pools immediately. Full history/statistics views continue reading the original history tables.

Provider-wide play counts cannot distinguish private sessions or excluded playlist origins. Once an account uses an exclusion/private mode or resets its taste, recommendation fallback to those provider aggregate counters stays disabled. MusicDeck uses that account’s eligible local activity and explicit favorites instead. This prevents an upstream scrobble from silently reintroducing a private listen.

Queue entries retain their originating playlist through playback, filtered views and resume contexts. The server checks the playlist flag on each report and autoplay request. Local smart-shuffle history also removes a session that becomes private, and private/excluded playback cannot refill or extend its queue automatically. Existing queued songs continue playing normally.

## Song and playlist controls

A song's **Exclude from taste profile** menu option suppresses listening signals without hiding the song from recommendations or preventing explicit playback. Recordings can be matched across provider IDs using title/artist identities that preserve meaningful versions. Restoring a song exclusion can re-enable older eligible history; sessions actually recorded as private/excluded remain excluded.

A playlist's checkbox applies to listening started from that playlist, including tracks queued from it. Listening to the same song independently remains eligible. Enabling the checkbox also excludes that account's active session from the playlist. Previously completed listening is retained with its original eligibility. Playlist owners/admins and users of editable shared legacy playlists can change the flag; other users' private playlists remain protected. The flag survives Trash/restore.

## Shared feedback identities

Hidden rules retain recording, artist and album metadata alongside provider IDs. One shared filter applies them across local recommendations, playlist suggestions, Explore, similar-song mixes and external search results. Explicit library search/navigation remains available. External artist menus can hide an artist by name even when a provider supplies no artist ID. Missing metadata on older rules falls back to exact IDs until the library index can resolve it.

The dashboard groups equivalent hidden rules. **Restore** removes all negative aliases of the chosen recording/artist/album for the authenticated account, while preserving independent explicit feedback. Song/playlist taste exclusions are listed separately because they control learning rather than candidate visibility. Requests cannot restore or reset another account by supplying its ID.

## Reset semantics

**Reset listening influence** requires typing `RESET` and uses a revision check. It advances an account-specific cutoff and clears only the derived smart-listening summary. Full listening history, scrobble queues, playlists, favorites and explicit hidden choices remain saved. No historical rows or media files are deleted. Sessions started before the cutoff stay ineligible even if their final reports arrive after the reset. New sessions build taste normally.

## Validation

Service tests cover unchanged affinity during private qualified plays, scrobble callbacks, monotonic mid-session exclusions, delayed reports, context-specific playlist exclusions, canonical feedback restoration, reset preservation, account isolation and SQLite persistence. UI tests cover offline sync, account changes, restore failures and reset confirmation. The listening tracker has an in-flight privacy-acknowledgement regression test.

Acceptance Scenario 11 exercises actual browser playback, the global player switch, offline ending/synchronization, native-provider scrobbling, playlist checkbox, hidden rules, reset preservation and the 390 px mobile control. The existing migration fixture now constructs a genuine older schema before upgrading.

```sh
# Repository root
npm run test:acceptance:types
npm run test:acceptance -- --grep "Scenario 11"

# server/
npx vitest run test/taste-profile.test.ts test/listening-activity.test.ts --maxWorkers=1

# webapp/
npm test -- --watch=false --runInBand --runTestsByPath src/services/TasteProfileStore.test.ts src/views/settings/TasteProfileView.test.tsx src/utils/listeningTracker.test.js
```
