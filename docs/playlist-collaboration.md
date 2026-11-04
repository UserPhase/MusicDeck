# Playlist collaboration

| Mode | Owner | Named viewer | Named collaborator | Other signed-in users |
| --- | --- | --- | --- | --- |
| PRIVATE | Read, track edits, management | No access | No access | No access |
| SHARED_READ | Read, track edits, management | Read/play | Viewer roles only | No access |
| COLLABORATIVE | Read, track edits, management | Read/play | Read/play, add/reorder/remove, party requests | No access |
| PUBLIC_SERVER | Read, track edits, management | Read/play | Read access only | Read/play |

Server administrators retain the existing maintenance override. Public server
visibility requires authentication and never grants public write access. Legacy
ownerless playlists migrate to PUBLIC_SERVER, with management reserved for admins.
New playlists are PRIVATE. Losing or deleting an owner does not publish a private
playlist automatically.

Migration 45 adds playlist sharing mode/revision, per-user permissions, item
`added_by_user_id`, authenticated invitation records, and durable party sessions
and requests. Existing items inherit a known owner as their contributor; unknown
historical contributors remain null. Deletes of user accounts clear attribution
rather than deleting tracks. Reorder/remove/undo preserve the original contributor.
Command history belongs to the actor and uses the existing playlist revision and
fingerprint checks, so another user's edit cannot be overwritten by stale undo.

`PlaylistCollaborationService` is the shared authorization authority. The playlist
service, all legacy mutation routes, command routes, folder tree, search,
recommendations, artwork, resume bookmarks, taste context, and exports use current
visibility and grants. Track edits require collaborator access; metadata, artwork,
Trash, sharing and invitations require ownership or administrator access. Exports
use the export subject's accessible playlists without implicitly exporting every
private playlist to administrators. Export pages recheck access while streaming.
The primary collaborative mutation endpoint is
`PUT /api/v1/playlists/:playlistId/tracks` with `ownerId`, current `revision`, and a
strict `edit` payload for add, remove, or reorder. The existing delta command
routes also support authorized collaborators. Unauthorized edits return 403;
private detail reads return 404; stale revisions return 409.

The owner-only sharing dialog uses a bounded local-account search, supports up to
100 distinct named members, and saves all grants in one transaction with a sharing
revision check. Roles are never inferred from request bodies. Its account identity
guard rejects requests from stale tabs. Live playlist pages poll a small revision
endpoint every five seconds and hydrate tracks only after changes. The server
rechecks authorization independently of that polling.

Invitation links contain 256 random bits, expire after seven days, and store only
SHA-256 hashes in SQLite. Named invitations are bound to an already-granted
recipient, with public-server invitations optionally usable by any signed-in
account. Resolving a link does not create or elevate a grant. Owners can revoke
links; saving sharing settings invalidates all previous invitations. Tokens travel
in a URL fragment and a POST body, never in server request URLs or query logs.
An unauthenticated recipient signs in on the invitation page before resolution.

Playlist responses and playlist artwork are no-store. Playlist covers bypass the
service worker's artwork cache so future cover requests recheck current access.
Permission revocation cannot erase media or information a user already downloaded
or copied while authorized.

Party requests are separate from remote playback transport controls. A collaborative
playlist owner opens a party queue on a player with playback loaded. The party is
bound to the authenticated login session and a random per-tab device identity,
renewed every 20 seconds by a bridge that stays mounted across views. Its lease
expires after 90 seconds without renewal. Logout, account disablement, a visibility
change, or loss of owner privileges stops new submissions. Only the exact hosting
session/device can review requests; other devices cannot take over its controls.
Requests are library-track IDs with actor attribution and an idempotency UUID.
Repeated deliveries with the same key return the same request; reusing a key for
another track returns 409. Pending requests are limited to 20 per member and 200
per party. Revoked/disabled contributors' pending requests are dismissed when the
party is read or reviewed.

The host explicitly adds a request to the existing local playback queue, then
acknowledges it. Session-storage request IDs prevent duplicate local additions
when an acknowledgement is retried. The server request inbox is durable; local
browser queue persistence remains subject to browser lifecycle behavior and does
not form a distributed atomic transaction with SQLite. No collaborator receives
pause, seek, volume, or arbitrary remote-command access through this feature.
Closed parties and expired/revoked invitations are retained for at most seven
additional days by the hourly cleanup.

API groups: `/api/v1/playlists/:id/sharing`, `/sharing/users`, `/sharing/links`,
`/api/v1/playlist-shares/resolve`, `/api/v1/playlists/:id/access-state`, `/party`,
`/party/requests`, and `/party/control`. All require a valid session. Mutations
include the authenticated actor's `ownerId` account guard; host controls additionally
require `deviceId`.

Validation includes the full permission matrix, all mutation aliases, attribution
and undo, stale revisions, recipient mismatch, hashed-token storage, expiration
and revocation, export/bookmark isolation, pending quotas, duplicate requests,
host-session/device isolation, disabled accounts, and browser Scenario 13 with
separate owner, viewer and collaborator contexts plus desktop/mobile dialog checks.
