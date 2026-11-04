# Offline downloads

MusicDeck's web client can play verified, explicitly downloaded audio without a live server session. Open `/downloads` to use the local collection. This does not authenticate the user to the server or grant admin access. Sign-out clears the local account selector and stops pending downloads; saved audio remains scoped to its original account.

## Storage manifest

1. `musicdeck-downloads` contains separate `media` (binary Blobs), `manifest` (track metadata, size, requested bitrate, timestamp, SHA-256 and integrity status), `queue`, `collections`, `policies`, and `settings` object stores. Each record has an account-scoped key and an indexed owner field. Manifest enumeration never reads all audio bytes.
2. Completed media, its verified manifest and removal of its queue entry commit in one IndexedDB transaction. Incomplete audio stays inside the persistent queue and never earns an offline badge. Cancellation removes the job; completion must still match the job's unique lease token. Tabs and service workers claim jobs in read/write transactions with expiring leases.
3. Playback checks file size, readability and SHA-256 before making a local Blob URL. Integrity diagnostics retain missing/corrupt manifests so the UI can offer repair. Blob URLs are revoked on account changes, replacement and purge. Durable collection membership preserves order, duplicate playlist entries and partial availability across restarts.

IndexedDB transactions must stay short: fetching and hashing finish outside the transaction. Publication and reads resolve on transaction completion, rather than individual request success. See [IndexedDB transaction lifetime](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB).

## Downloads and recovery

`OfflineDownloadEngine.enqueueDownload()` persists work before processing it. `enqueueCollection()` persists an entire album/playlist queue and collection membership together. The processor uses one transfer per instance, with cross-context leases to prevent duplicate transfers. Transfers checkpoint their partial Blob at 4 MiB or five-second intervals, bounded by a 512 MiB per-track browser limit. A crashed context's lease expires after 90 seconds.

Resumption sends `Range` and `If-Range` only when a strong ETag or Last-Modified validator was saved. Unvalidated partial bytes are discarded. A full `200` response replaces partial bytes; `206` requires a matching, valid range. HTML/login responses, invalid ranges, empty/truncated bodies, oversized files and authentication failures cannot publish audio. Transient failures retry with bounded backoff, then remain visibly failed until retried. A stalled transfer is aborted after 45 seconds without progress. Quota failures retain an actionable failed job rather than a false download.

Legacy `musicdeck-offline` records are retained. The Downloads view offers an explicit import because older records have no account ownership information. Import verifies the original bytes and assigns the copy to the selected local account. Originals remain intact because a move across databases cannot be atomic; they count toward browser origin usage until separately removed.

## Automatic rules

The Downloads view persists Favorites and per-playlist rules. Reconciliation runs every five minutes while the authenticated app is open, after favorites/playlist changes, on reconnect, focus, visibility changes and connection changes. It updates collection snapshots and enqueues eligible full library tracks; external previews are excluded. Queue and manifest checks deduplicate existing work. Removing a track from a collection or disabling a rule does not delete saved audio or cancel already queued work. Explicit removal remains a separate operation. A retained automatic rule can download removed audio again on its next reconciliation.

`effectiveType` measures connection speed; it does not identify Wi-Fi or billing. Automatic transfers require known Wi-Fi/Ethernet or an explicit unmetered signal. Cellular, metered and data-saver connections pause automatic transfers. Unknown cost also pauses unless the user explicitly opts in. The gate is checked throughout a transfer, not just when it starts.

Where supported, the existing service worker handles the `musicdeck-auto-downloads` Background Sync tag. It obtains the current server session before choosing an owner, applies the same network gate, then reconciles and drains the queue. Incomplete queued work rejects the sync event so the browser may retry it. No audio is added to CacheStorage. Background Sync is browser-controlled and one-shot; periodic foreground reconciliation remains the portable fallback. See [Background Synchronization API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API).

## Web and native boundary

Installing the PWA does not change storage ownership or guarantees. `navigator.storage.estimate()` reports approximate usage and quota for the entire origin, including app caches, partial transfers, retained legacy files and other accounts. `persist()` is requested only from the user's button; a grant reduces eviction risk but cannot prevent explicit site-data removal. Downloads, policy settings and the local account hint are isolated from generic cache cleanup. See [browser storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

Native clients need a dedicated filesystem store and operating-system background transfer implementation. This browser engine always reports `mode: "web"`; it never infers native persistence from standalone PWA display mode. Native operating-system permissions, user deletion and available disk space still apply.

The offline app shell requires an earlier successful production service-worker installation on HTTPS or localhost. Local Downloads mode restores no server credentials. Browser codec support and autoplay rules still determine whether a saved file can start playing.
