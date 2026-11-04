# Similar-song mixes

Open **Build a similar-song mix** from Explore or Library → Playlists. Choose 1–5 library songs, or enter a title and artist for an external seed. A preview contains up to 25 distinct related recordings. The builder reports shortages rather than padding the mix with unrelated songs. Lock candidates to keep their slots during refresh; swapping replaces only the selected row. Changing settings marks the preview stale until it is regenerated.

## Scoring and selection

For candidate `c` and seed `i`, `s_i` is the maximum direct Last.fm match, or the strongest cached two-hop path (`0.65 × first edge × second edge`). A same-artist library fallback contributes `0.15` when metadata lookups are unavailable. Missing seed edges contribute zero.

```
similarity = 0.65 × max(s_i) + 0.35 × mean(s_i)
listeningFamiliarity = clamp(0.75 × log(1 + userPlays) / log(21) + 0.25 × favorite)
F = local ? 0.25 + 0.75 × listeningFamiliarity : 0
score = 0.70 × similarity^(1.8 - 1.2 × adventurousness)
      + 0.30 × (1 - adventurousness) × F
      + 0.30 × adventurousness × (1 - F)
```

Per-user plays use the larger of recent-play counts and distinct listening sessions, avoiding double counting the same events across those tables. Provider-wide aggregate play counts are not treated as personal history. A small reproducible Gumbel perturbation lets refresh explore alternatives. Hybrid selection targets `round(25 × adventurousness)` external recordings, prioritizes artist diversity, then fills any shortage from eligible candidates. Library-only and discovery-only boundaries remain strict. Locked songs count toward the quotas.

Title/artist identity normalization preserves meaningful recording versions. Seeds and duplicate recordings are excluded. Hidden tracks, hidden recording aliases, blocked artists and blocked albums are applied before selection on every request. Current feedback is rechecked before queueing or saving, including after asynchronous preview resolution. New feedback also stores title/artist identity so a different provider ID cannot bypass a hide.

## Cache and network behavior

Migration 42 adds SQLite public similarity vectors, an external recording directory, account-owned preview tokens, and external metadata on playlist occurrences. Last.fm `track.getSimilar` uses HTTPS GET, URL-encoded artist/title, `autocorrect=1`, `format=json`, a server-only API key and an identifiable User-Agent. This read method needs no user session or signature. Configure the existing Last.fm plugin API key and grant its network permission in Admin → Plugins. API JSON errors are checked even when HTTP status is 200.

Nonempty vectors cache for seven days; valid empty results cache for six hours. Transient failures can use vectors up to 30 days beyond expiry. Lookup failures back off in SQLite; rate limits respect Retry-After (bounded to one minute–one hour) and share a service cooldown. Invalid/suspended application keys trigger a ten-minute cooldown. Requests for the same recording coalesce. Outbound calls are serialized with 650 ms minimum start spacing, capped at 32 queued recording lookups, and bounded by a six-second request timeout and one MiB response limit. Malformed cache payloads are repaired. Memory retains 256 vectors; disk retains 2,000 vectors. Two-hop traversal uses already-cached edges and never fans out into additional network calls.

The library identity index is rebuilt only when the smart-playlist catalog revision changes. Warm ranking uses the in-memory index and indexed SQLite user signals, without provider enumeration or audio processing. The performance test measures 20 warmed five-seed generations against 10,000 library tracks, requiring each generation to take less than 20 ms. That budget excludes initial library indexing, uncached API calls, HTTP transport, UI rendering and save-time audio-preview lookup. It is a measured test requirement, not a real-time guarantee on every host.

Local-only privacy mode allows library-only mixes using cached vectors and same-artist local candidates, without sending seed metadata out. External scopes require metadata permission and a complete library snapshot so an unreachable library is not mistaken for an empty collection. No audio is downloaded by mix generation.

## Preview, save and playback

Preview tokens belong to the signed-in account and expire after 30 minutes. Their candidate IDs are authoritative: clients cannot inject arbitrary save/queue tracks. Up to 30 recent previews are retained per account. Save commits all local and discovery occurrences plus its idempotency mapping in one SQLite transaction. Retrying a save against the same preview returns the same playlist. Removed external occurrences retain their metadata through undo/redo and Trash restoration.

Discovery entries contain recording metadata and a vetted Deezer preview when one can be resolved. They never claim to be downloaded full-length audio. A missing preview remains visible and is reported when queueing; importing the recording is required for full playback. Previews are resolved only when used or saved, through the existing bounded preview resolver, outside the playlist write transaction. The builder provides one preview player, pauses existing playback when auditioning and stops its preview on close. External artwork URLs and Last.fm website URLs are not used as audio sources.

The modal traps focus, restores focus/scroll on close, supports 390 px layouts and resets private state immediately on account changes. Save and queue errors remain visible and retryable. Recipe changes disable stale save/queue actions. Accounts cannot reuse one another's preview tokens.

## Validation

```
# Repository root
npm run test:acceptance:types
npm run test:acceptance -- --grep "Scenario 10"

# server/
npx vitest run test/similar-mix-engine.test.ts --maxWorkers=1

# webapp/
npm test -- --watch=false --runInBand --runTestsByPath src/components/discovery/MixBuilderModal.test.tsx
```

Last.fm protocol references: https://www.last.fm/api/show/track.getSimilar and https://www.last.fm/api/intro.
