# Scrobbling connections

MusicDeck submits qualified listening sessions to Last.fm and ListenBrainz through a per-user SQLite outbox. Enabling a server plugin permits users to connect an account; it does not send everyone's history to the administrator's account.

## Configure and connect

1. In Admin → Plugins, enable the integration and approve `history.read` and `network.request`. Last.fm also requires an application API key and its **shared secret** (`apiSecret`), both from the same Last.fm API application. The old API-key/session-key configuration alone cannot sign requests. On upgrade, an enabled Last.fm plugin without a shared secret is disabled while preserving its configuration, allowing the server to start. Add the shared secret and enable it again.
2. Set `MUSICDECK_PUBLIC_URL` to the externally accessible MusicDeck origin, including HTTPS when used. Register the MusicDeck callback with your Last.fm application: `/api/v1/scrobble/lastfm/callback`. MusicDeck supplies a session-bound `state` query parameter through Last.fm's supported `cb` parameter. Authorization must return to the same MusicDeck session; each state expires after ten minutes and is consumed once. Last.fm uses its web authorization/session-key protocol, not OAuth 2.
3. In Settings → Listening connections, authorize Last.fm or enter a session key issued to that same application. For ListenBrainz, enter your user token from its Settings page. MusicDeck validates the remote account before saving it. Test Connection only validates credentials; it does not publish a test listen.

Legacy administrator session keys and ListenBrainz test tokens are never automatically assigned to users. Each user must explicitly connect. Users' credentials are kept in the private SQLite database, never returned by settings/status APIs or stored in browser storage, and included in protected system backups. Disconnect erases the stored user credential and cancels pending submissions. Remote accounts may also require revoking the session/token at the provider.

## Qualification and original listening times

Third-party submissions require half the track duration or four minutes of actual listening, whichever comes first. Last.fm additionally requires a known duration greater than 30 seconds. For unknown-duration ListenBrainz tracks, MusicDeck waits four minutes. Missing artist/title metadata is not replaced with invented metadata. These rules are separate from the existing MusicDeck/Navidrome scrobble point.

The client sends cumulative playback-session reports. The local event and qualifying outbox entries commit in the same SQLite transaction. Retries preserve the original session start, artist, title, album, and duration. Repeated reports cannot enqueue that session twice; matching artist/title/original-second listens are also deduplicated per user/provider. New accounts receive future listens only: MusicDeck does not import history saved before connection. Legacy `complete` events without a session timestamp and measured listening duration remain local/provider events.

## Recovery and delivery semantics

The worker wakes on committed playback, connection changes, and every 15 seconds. It uses a 60-second SQLite lease and a 15-second request timeout. Expired leases are recoverable after process termination; a stale worker cannot acknowledge another worker's lease. The HTTP server stops/aborts this worker before closing SQLite during shutdown or backup restoration.

Network errors, HTTP 408/429/5xx, and documented transient Last.fm errors use exponential backoff starting at 30 seconds with up to 25% jitter, capped at six hours. Provider `Retry-After`/ListenBrainz reset-in headers can extend that delay (bounded at seven days against malformed upstream values). Authentication/configuration failures block that account until a successful connection test or reconnect. Permanent failures and Last.fm ignored listens are inspectable separately from successful submissions. After 12 failed attempts, a listen needs manual retry. Retry does not bypass a provider waiting period.

Pending jobs for an account are submitted oldest first; another user's account can continue while one account waits. A changed remote account cancels old pending jobs. Replacing credentials for the same account retains queued listens and the original consent boundary. Disconnect cancels unsent jobs and removes stored credentials. Deleting local listening history cascades to its queue entries. Sent deduplication records are retained with their listening events; include this data in database capacity planning.

Delivery is **at least once**, with durable local deduplication. If a provider accepts a listen but its acknowledgment is lost, retry can submit it again. These APIs do not expose an application idempotency key, so MusicDeck cannot guarantee exactly-once delivery across that boundary.

Local Only Mode or disabled external privacy permissions pause delivery and abort active external requests. Plays reported while sharing is disabled are not added to the external outbox. Following a privacy-policy save, only newly started sessions can enter the outbox, so delayed reports cannot backfill listening from before the policy change. Previously consented queued plays remain available for delivery if sharing is re-enabled. A provider may already have accepted a request when it is cancelled; cancellation cannot recall remote history.

Settings polls live connection status every 15 seconds while visible, showing last confirmed delivery, its original listening time, queue counts, next retry, and the latest 20 non-success diagnostics. Upstream response text and secrets are not included in diagnostics.

## Protocol references and validation

- [Last.fm signing specification](https://www.last.fm/api/authspec): concatenate alphabetically sorted raw parameter names and values, append the shared secret, encode as UTF-8 and MD5 hash. Exclude `format`, `callback`, and `api_sig`. Form encoding happens after signing.
- [Last.fm web authorization](https://www.last.fm/api/webauth) and [track.scrobble](https://www.last.fm/api/show/track.scrobble): signed requests, API errors inside HTTP 200, and ignored-message handling.
- [Last.fm scrobbling rules](https://www.last.fm/api/scrobbling).
- [ListenBrainz core endpoints](https://listenbrainz.readthedocs.io/en/latest/users/api/core.html) and [listen JSON schema](https://listenbrainz.readthedocs.io/en/latest/users/json.html): `artist_name`, `track_name`, optional `release_name`, and the immutable `listened_at` timestamp. Token validation checks `valid`, not just HTTP 200.

The protocol tests hash the official Last.fm example preimages against independently computed .NET MD5 digests. The documentation provides example preimages rather than published expected digest test vectors. Tests also cover malformed/ignored/API-level failures, strict ListenBrainz payloads, SQLite restart recovery, transaction rollback, ordering, multiple workers, account changes, privacy cancellation, authorization state replay, real playback-route integration, and Settings controls. All external transports in tests are simulated; no real listens or account connections are created.
