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
