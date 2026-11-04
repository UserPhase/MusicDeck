# Followed artist releases

Artist follows are explicit, account-owned preferences. Library ownership, favorites,
and playback never create follows or imports. The artist page offers **Follow artist**
for local artists and stable Deezer/iTunes artist identities. Spotify-only discovery
identities must first be resolved to one of those supported providers.

Migration 44 adds `followed_artists`, shared `followed_artist_catalog` identity/scan
state, `new_release_cache`, and a durable provider request throttle. Foreign keys
remove a deleted user's follows. Unfollowing removes the artist from that user's
feed immediately; wishlist entries remain saved. Cached metadata is shared, never
other users' follow lists.

`NEW_RELEASES_SCAN` runs hourly at minute 17, catches up on server startup when
there are follows, and is queued after a follow. The task has priority 50 and
cooperatively pauses during media streams and resource pressure. Duplicate queued
jobs are joined. A scan checks up to 100 due artists, oldest due first. Each artist
has a renewable five-minute lease, preventing simultaneous scans by different
workers. A successful lookup is fresh for six hours. Checking manually honors that
freshness window rather than bypassing provider budgets.

iTunes uses ID-based lookup (up to 200 results); Deezer uses bounded artist-album
pagination (up to 300 entries). Local names require one exact normalized artist
match; ambiguous names remain unresolved with a diagnostic prompting a specific
provider follow. These public endpoints have bounded coverage and cannot guarantee
a complete worldwide discography. iTunes lookups currently use the US storefront.
Release types use explicit Deezer types or iTunes `- EP` / `- Single` title suffixes;
unclassified collections display Album.

The ID lookup and cache design follows Apple's [Search API documentation](https://performance-partners.apple.com/search-api).

Requests are sequential, timeout after eight seconds, reject redirects, and cap
decompressed JSON at 2 MiB. SQLite reservations pace scanner requests at least
3.5 seconds apart per provider. HTTP 429/503 Retry-After and Deezer's API-level quota
error set persistent provider cooldowns. Other failures back off from 15 minutes
to 24 hours. Cached feed entries remain readable during outages. Local Only Mode
and metadata permissions apply to background requests as well as UI actions.

The feed includes the last 30 calendar days through today, omits future releases,
deduplicates store entries by artist/title/edition/date before pagination, and
purges cache entries older than 45 days. It is available from Home and `/new-releases`.
Artist scan diagnostics and unfollow actions are under **Following**. Browser feed
refreshes read SQLite; they never perform provider lookups themselves.

Preview expands tracks through the existing external album catalog, with store
attribution alongside samples. Covers use the existing validated artwork proxy.
**Save to wishlist** uses Saved Discoveries, whose entries also appear on that page.
**Import via spotDL** uses the existing permission-checked acquisition queue and
shared progress/status tracking. Nothing downloads audio without that action.

Routes require a session: GET/POST `/api/v1/artist-follows`, DELETE
`/api/v1/artist-follows/:key`, GET `/api/v1/new-releases?offset=0&limit=30`, and POST
`/api/v1/new-releases/scan`. Follow mutations include `ownerId` to reject stale
account state. Follow creation and scans require external discovery permission;
unfollow and cached preference review remain available when metadata is disabled.

Validation covers cache reuse across accounts/restarts, provider identity checks,
date bounds, failure recovery, cancellation, quota cooldowns, scheduler yielding,
legacy task/log preservation, account switches, wishlist/preview/import actions,
and browser acceptance Scenario 12 at desktop and 390px mobile widths.
