# Queue persistence and device handoff

1. `useQueueStore` owns stable occurrence IDs, order and playback state. Asynchronous hydration adopts decoded entries directly. A delayed read cannot overwrite a new user selection or a different account's state.
2. IndexedDB `musicdeck-queues` has account-scoped `contents` and `heads`. Content changes commit both records atomically; progress writes touch only the small head. Format 3 stores identical metadata once with separate occurrence references; format 2 remains readable. Encoding yields between batches. Legacy local-storage queues migrate once, removing the old copy only after commit. There is no local track-count cap; browser quota failures are displayed in the drawer.
3. SQLite migration 46 adds content-addressed, gzip-compressed snapshots, per-device checkpoints, named snapshots and idempotent playlist-save records. Content reads verify size, SHA-256 checksum, schema and occurrence count. Account ownership, sequence numbers and capture timestamps guard writes.

Open **Queue → Save & restore queues** to save every occurrence as a private static playlist, save/load/delete named queues, sync immediately or manage other-device snapshots. Playlist saves preserve duplicates and attribution in one transaction. Missing library entries abort the entire save; external discoveries remain metadata-only and never trigger downloads.

The second-device resume prompt requires an explicit restore. It restores the queue, index, fractional position, shuffle seed/mode, repeat/album options, volume and context **paused**. Preparing a local queue does not interrupt the active remote player. Explicit playback transfer remains in Devices.

Local restart recovery also works with the remembered offline collection when authentication is unavailable. This permits local reads only; server synchronization still requires authentication. Explicit sign-out clears the remembered selector.

## Endpoints

All endpoints below `/api/v1/user/queue-session` require an authenticated account; mutations also validate `ownerId`.

| Method / suffix | Operation |
| --- | --- |
| GET `/` | Device and named summaries without full arrays |
| POST `/content?ownerId=…` | Upload immutable content, including every occurrence |
| GET `/content/:contentId` | Read this account's verified content |
| PUT `/` | Save a checkpoint referencing uploaded content |
| DELETE `/` | Remove a device snapshot |
| POST `/named` | Idempotent named snapshot save |
| DELETE `/named/:queueId` | Revision-checked deletion |
| POST `/playlist` | Atomic, idempotent static playlist save |

Content uploads start shortly after edits. Pause flushes local persistence and syncs a checkpoint. Transient failures retry with bounded exponential backoff; reconnect retries immediately. Expired server contents are uploaded again from IndexedDB. Permanent validation/quota errors remain visible.

Exit/page-hide sends only a small `keepalive` checkpoint for already-uploaded content and flushes local persistence. Large arrays never enter the limited keepalive request budget. Browser termination or network loss can interrupt unfinished operations; the last committed snapshot remains available.

Explicit server limits: 32 MiB raw content per upload, 128 MiB compressed per account, 12 recent devices, 50 named queues. Device snapshots expire after 30 days; unreferenced content is eligible for cleanup after one day. Named queues persist until removed. The existing static playlist limit is 20,000 entries; larger queues can remain local or use named snapshots within the byte budget. Nothing silently truncates.

## Verification

Queue tests cover IndexedDB reopening, legacy migration, 10,000 entries, checkpoint separation, account/startup races, stale requests, retry identity, expired content, corruption, duplicate-safe playlist saves and rollback.

Acceptance scenario 14 restarts an actual browser process with 5,000 occurrences, saves a named snapshot and playlist, reloads offline, verifies bounded drawer rows and restores on another device. `queue-hydration-10000.json` records I/O, decoding, reducer application and total hydration for repeated and distinct tracks.

The 10 ms target is a performance budget, not a browser storage guarantee. Acceptance bounds synchronous reducer application below 10 ms and retains all full read/decode/apply samples. Cold storage, disk contention, metadata size, garbage collection and hardware can increase total time. Initial rendering does not wait for hydration.
