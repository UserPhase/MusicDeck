# MusicDeck Server

MusicDeck Server is the API boundary between the React web client, future Android clients, and the music providers (Navidrome, Jellyfin).

For setup, startup, environment, and deployment, see the authoritative root [README](../README.md). For Docker/self-hosting detail, see [Self-Hosting Guide](../docs/SELF_HOSTING.md).

```text
React / Android
  -> MusicDeck API
  -> Provider layer
     ├── Navidrome
     └── Jellyfin
```

The browser authenticates with MusicDeck Server only. Provider credentials stay on the server.

## Requirements

- Node.js 24+
- npm
- A running Navidrome or Jellyfin server for real music data

## Spotify playlist import

The sidebar import action first asks spotDL for the Spotify track list without
downloading audio. MusicDeck creates its own playlist, checks each song against
the connected library by ISRC or artist and title, and links existing songs
directly. Only missing songs are downloaded, scanned, and linked. Audio uses
the shared `{artist}/{album}/{artist} - {title}.mp3` layout under
`MUSICDECK_MUSIC_ROOT`, so spotDL also skips a file already present at that
path. Repeated songs are linked once in their first Spotify position.

The Spotify source metadata stays under `MUSICDECK_SPOTIFY_IMPORT_SUBDIR`
(default `Spotify Imports`) inside the music library. The playlist name and
cover come from Spotify metadata. With Spotify app credentials, MusicDeck also
imports the original playlist description; otherwise the description links to
the Spotify source. The import requires spotDL, Deno, and FFmpeg in the
MusicDeck server (included in the Docker image). Navidrome M3U auto-import is
not required for this flow.

## Shrink older spotDL FLAC downloads

New spotDL downloads explicitly use MP3 at 320 kbps. To inspect older FLACs
recorded as spotDL acquisitions or stored in a legacy Spotify import job
folder, run `npm run library:shrink` from `server/`. Add `-- --apply` to convert
the eligible files. In a Compose installation, use
`docker compose exec --user musicdeck musicdeck-server node dist/scripts/shrink-library.js`
and add `--apply` to perform the conversion. The script uses the configured
music root and database, preserves audio tags and attached cover art, updates
M3U references, removes each original only after a smaller MP3 is ready, and
requests a Navidrome/Jellyfin rescan after successful conversions.

Other FLACs are excluded because their origin is unverified. Use `--all-flac`
only when you intend to convert every FLAC in the music root. An existing MP3
is never overwritten.

## Admin file deletion

Track and album deletion uses the file path reported by the catalog provider.
Navidrome normally reports a virtual path assembled from tags; that path may
not exist on disk. The bundled Compose files set
`ND_SUBSONIC_DEFAULTREPORTREALPATH=true`, and MusicDeck requests deletion
paths as the separate `MusicDeck File Management` Navidrome player. If using an
external Navidrome instance, enable **Report Real Path** for that player in
Navidrome **Settings > Players**. Changing the default does not update players
that Navidrome already created. MusicDeck refuses a virtual path and leaves
the file untouched.

The MusicDeck server and Navidrome/Jellyfin must mount the same library at the
configured `MUSICDECK_MUSIC_ROOT` path (the bundled Compose files use `/music`).

## Local development

See the root [README](../README.md#local-development) for exact commands. The server runs on `http://localhost:4534` via `npm run dev`, initializes SQLite and applies migrations on startup, and `npm run db:init` initializes the database without starting the server.

## Health

Public startup health check: `GET /api/health`. Admin health check: `GET /api/admin/health` (requires an authenticated MusicDeck admin).

## Authentication Model

- `POST /api/auth/login` creates a server-side session.
- The browser receives an HTTP-only `musicdeck_session` cookie.
- `GET /api/auth/session` returns the current MusicDeck user.
- `POST /api/auth/logout` invalidates the session.
- `POST /api/auth/change-password` updates the MusicDeck user's password.

Navidrome credentials, tokens, salts, and authenticated URLs are never returned to the browser.

MusicDeck users are separate from Navidrome users. Navidrome credentials are service/backend configuration owned by the server, not user credentials used by the React or Android clients.

## Authorization

- `admin` users can access `/api/admin/*` and user-management endpoints.
- `user` users can access their own library-facing API, profile, settings, playlists, favorites, and recently played data.
- The React UI may hide admin links, but the server is always the security boundary.

## API Error Format

Errors use a consistent envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request"
  }
}
```

Common codes include `AUTHENTICATION_REQUIRED`, `FORBIDDEN`, `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `BACKEND_ERROR`, and `INTERNAL_ERROR`.

## MusicDeck-Owned Data

The server now owns these user-facing concepts even while Navidrome remains the first music backend:

- Favorites: `/api/favorites/tracks`
- Recently played: `/api/recently-played`
- Playlist ownership metadata
- User profile fields such as `displayName` and `avatarRef`
- User settings and server settings

Recently played is stored per authenticated MusicDeck user and trimmed to prevent unbounded growth.

Favorites are stored per authenticated MusicDeck user and synchronized to the current backend.

Playlist ownership is tracked in MusicDeck. Legacy/unowned playlists remain accessible for compatibility, while owned playlists can only be modified by their owner or an admin.

## Profile and Settings Foundation

Current profile endpoints:

```text
GET /api/users/me
PATCH /api/users/me
```

Users can update safe profile fields only. Normal users cannot change their role or disabled state.

User settings:

```text
GET /api/settings/user
PATCH /api/settings/user
```

Server settings are admin-only:

```text
GET /api/admin/settings/server
PATCH /api/admin/settings/server
```

The future topbar account menu should contain Profile, Settings, Admin Dashboard for admins only, and Log out. That UI is intentionally not implemented in this server phase.

## Backend Abstraction

The server exposes MusicDeck-owned JSON models from `/api/*`. It currently uses `NavidromeBackend` as the first `MusicBackend` implementation.

The public API should remain stable when a native MusicDeck music engine is added later.

## Tests and Validation

### Spotify import recovery and metadata tools

Spotify imports keep a SQLite `import_jobs` checkpoint with every source position,
published file path, provider track ID, and failure reason. Startup resumes unfinished
jobs. Duplicate source positions share one playlist entry while remaining visible
in the job accounting. Partial jobs retain their complete failure manifest.

Per-track downloads use a complete cached spotDL song manifest instead of fetching
the Spotify identity again. When audio matching fails, recovery looks up the
recording on Deezer by ISRC, then artist/title, checking version qualifiers and
duration (within four seconds). It uses the matched title for an explicit audio
search, using a placeholder-bearing template so spotDL does not prepend a second
artist/title query. Recovery tries SoundCloud, YouTube and YouTube Music in
separate processes: finding a protected/unavailable URL in one provider does not
prevent the next source being tried. Each recovery process gets fresh staging and
a two-minute timeout; at most three recovery attempts run after the initial
download. Deezer provides
metadata; its preview URL is never used as the downloaded full song. Spotify's
canonical title, artists, album and output path remain authoritative. If Deezer
is unavailable or has no safe match, the retry uses the original cached metadata.

The durable per-track `downloadAttempts` retain up to four attempts, provider, search strategy,
and bounded credential-redacted downloader output, including partial output on
timeouts. These diagnostics survive staging cleanup and server restarts. Existing
library tracks are reused without additional external lookups or downloads.
Optional lyric-provider errors (including Genius 429 responses) do not classify
the audio failure or suppress its retry. Matched-video/CDN 403 and yt-dlp audio
errors receive the independent per-track retry used by the earlier importer;
actual sign-in/bot errors remain explicit authentication failures. All downloads
use spotDL's five-retry setting and print its terminal error summary. Rich source
frames are removed before bounding diagnostics so they cannot crowd out the
underlying exception, and each attempt retains its classified error code. Missing
ISRC values are serialized as empty strings rather than null, avoiding spotDL's
Mutagen ID3 exception without inventing a recording identifier.

Audio downloads remain in staging until metadata has been verified. Repairs use
Mutagen from spotDL's Python environment to merge MP3, FLAC, and M4A tags without
remuxing audio or replacing existing cover art and unrelated metadata. `ffprobe`
independently verifies the repaired file before atomic publication when available;
if ffprobe is not installed, inspection uses Mutagen in spotDL's Python environment.
The Docker
image installs these tools from `requirements.txt`; rebuild it for this update.

For a native installation, install the updated Python requirements in the spotDL
environment. `MUSICDECK_TAGGER_PYTHON` and `FFPROBE_PATH` override auto-detection.
The tagger reads the current spotDL plugin media-tool paths on every operation.
Durable imported playlists are created in MusicDeck's own SQLite library; their
creation does not issue a non-idempotent upstream playlist request.

Native audio integration tests need Python with Mutagen, FFmpeg, and ffprobe.
Set `MUSICDECK_MEDIA_TEST_PYTHON`, `MUSICDECK_MEDIA_TEST_FFMPEG`, and
`MUSICDECK_MEDIA_TEST_FFPROBE` to enable these tests in CI. They check preservation
of audio, embedded artwork, track/disc numbers, genre, ReplayGain, and custom tags
in all three containers. The media tests skip when the tools are unavailable.

```powershell
npm test
npm run typecheck
npm run build
```

From `webapp`:

```powershell
npm test -- --watchAll=false --runInBand
npm run build
npx eslint src
```
