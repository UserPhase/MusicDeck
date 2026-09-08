# MusicDeck

One beautiful music app, any source. MusicDeck is a self-hosted music
application with a Spotify-inspired web UI and a provider layer that can read
your library from multiple backends.

> Provider-specific connection details and credentials stay on the server. The
> browser only ever talks to MusicDeck.

## Architecture

```text
Browser
  -> MusicDeck Web (React, nginx in production)
  -> MusicDeck API (Fastify + SQLite)
  -> Provider layer
     ├── Navidrome
     └── Jellyfin
```

MusicDeck owns users, sessions, settings, favorites, recently played, and
playlists. It maps every track/album/artist/artwork to a stable MusicDeck ID
and resolves playback to an available provider source automatically.

## Repository structure

- `webapp/` — React web client
- `server/` — MusicDeck API server (Fastify, TypeScript, SQLite)
- `docker-compose.yml` — self-hosted production stack
- `.env.example` — environment template for the Docker stack
- `server/.env.example` — environment template for local server development
- `docs/` — architecture, product, and self-hosting documentation

## Prerequisites

Development:

- Node.js 24+
- npm
- A running Navidrome or Jellyfin server (for real music data)

Self-hosted deployment:

- Docker Desktop (or Docker Engine) with Compose

## Local development

Run the server and the web client separately. The React dev server proxies
`/api/*` to the server on `http://localhost:4534` (see `webapp/package.json`).

### 1. Configure and start the server

From the workspace root:

```powershell
cd server
Copy-Item .env.example .env
notepad .env
```

Set at least:

```text
MUSICDECK_SESSION_SECRET=replace-with-a-local-random-string
MUSICDECK_DB_PATH=./data/musicdeck.sqlite
MUSICDECK_ADMIN_USERNAME=admin
MUSICDECK_ADMIN_PASSWORD=choose-a-development-password
NAVIDROME_URL=http://your-navidrome-host:4533
NAVIDROME_USERNAME=your-navidrome-service-user
NAVIDROME_PASSWORD=your-navidrome-service-password
```

Install dependencies and start the dev server (this also initializes the
SQLite database and applies migrations on startup):

```powershell
npm install
npm run dev
```

The server listens on `http://localhost:4534`.

To initialize the database without starting the server:

```powershell
npm run db:init
```

### 2. Start the web client

In a second terminal, from the workspace root:

```powershell
cd webapp
npm install
npm start
```

The client opens on `http://localhost:3000` and proxies API calls to the
server.

## First admin setup

The first administrator is created automatically from
`MUSICDECK_ADMIN_USERNAME` / `MUSICDECK_ADMIN_PASSWORD` **only when the users
table is empty** (on first database initialization). To change the admin
password later, sign in and use the profile/settings page, or reset it through
the admin dashboard. The env password is not used to reset an existing
account.

## Provider configuration

MusicDeck supports two providers. Both are optional independently; enable one
or both.

### Navidrome

Configured with a URL and a service-account username/password:

```text
NAVIDROME_URL=http://your-navidrome-host:4533
NAVIDROME_USERNAME=service-user
NAVIDROME_PASSWORD=service-password
```

### Jellyfin

Configured with a URL and an API key (sent via the `X-Emby-Token` header, never
in URLs):

```text
JELLYFIN_URL=http://your-jellyfin-host:8096
JELLYFIN_API_KEY=your-jellyfin-api-key
```

Jellyfin currently supports catalog browsing, search, artwork, and direct-play
streaming. Jellyfin favorites/playlist sync is not yet supported. Create a
Jellyfin API key under Jellyfin Dashboard → API Keys.

### External search providers

MusicDeck includes a disabled-by-default **External Catalog** search provider
backed by the public iTunes Search API. An administrator can enable it in
**Admin Dashboard → Search providers** and optionally set its two-letter
region. It returns metadata-only external search results; external playback
and artwork proxying are intentionally not supported for real external
catalogs yet. MusicDeck now has a server-side source-resolution layer (with a
disabled deterministic example source provider) that future external providers
will use without exposing provider URLs or credentials to the browser. Future
search providers use the same normalized result contract and are managed from
this section.

## Docker self-hosting (LAN server)

MusicDeck's production Docker stack is designed to be plug-and-play: change a
few host paths and credentials, then start it. Users on your network access
**one URL** — nginx in `musicdeck-web` reverse-proxies `/api/*` (and any future
WebSocket traffic under `/ws/*`) to `musicdeck-server` internally, so clients
never need to know about the internal server, Navidrome, or Jellyfin ports.

### 1. Create `.env`

From the workspace root:

```powershell
Copy-Item .env.example .env
notepad .env
```

### 2. Change host paths

Set these to real, existing absolute folders on your Docker host:

```text
MUSIC_ROOT=/media/music
NAVIDROME_DATA=/opt/navidrome/data
JELLYFIN_CONFIG=/opt/jellyfin/config
JELLYFIN_CACHE=/opt/jellyfin/cache
```

`MUSIC_ROOT` is mounted read-write into MusicDeck Server (so downloads land
there) and read-only into Navidrome/Jellyfin (so they can scan/serve it
without ever modifying it).

### 3. Set secrets, passwords, and your server's LAN address

```text
MUSICDECK_PUBLIC_URL=http://SERVER_IP:8080
MUSICDECK_CORS_ORIGIN=http://SERVER_IP:8080
MUSICDECK_SESSION_SECRET=replace-with-a-long-random-secret
MUSICDECK_ADMIN_USERNAME=admin
MUSICDECK_ADMIN_PASSWORD=choose-a-strong-password
NAVIDROME_USERNAME=your-navidrome-service-user
NAVIDROME_PASSWORD=your-navidrome-service-password
```

Replace `SERVER_IP` with your Docker host's actual LAN IP address (e.g.
`192.168.1.50`) or a resolvable hostname — this is the address every device on
your network will type into its browser. Do not leave these as `localhost` in
a real deployment.

### 4. Start the stack

```powershell
docker compose up -d
```

### 5. Open MusicDeck

```text
http://SERVER_IP:8080
```

This is the only address any device on your LAN needs — phones, tablets, and
other computers all use the same URL and port.

### 6. Connect Navidrome/Jellyfin accounts

- Navidrome needs a user matching `NAVIDROME_USERNAME`/`NAVIDROME_PASSWORD`
  before MusicDeck can read from it. Create it once via Navidrome's own UI —
  optionally reachable directly at `http://SERVER_IP:4533` (see "Required vs.
  optional ports" below).
- Jellyfin is optional. If you want it, log in to Jellyfin directly at
  `http://SERVER_IP:8096`, create an API key under **Dashboard → API Keys**,
  set `JELLYFIN_API_KEY` in `.env`, then restart: `docker compose up -d`.
  Enable/configure the Jellyfin connection from MusicDeck's Admin dashboard.

### Required vs. optional ports

| Port | Service | Required for LAN clients? |
| --- | --- | --- |
| `MUSICDECK_WEB_PORT` (default `8080`) | musicdeck-web | **Required** — the only address end users need |
| `NAVIDROME_PORT` (default `4533`) | navidrome | Optional — only for direct Navidrome setup/admin access |
| `JELLYFIN_PORT` (default `8096`) | jellyfin | Optional — only for direct Jellyfin setup/admin access |

MusicDeck Server itself (`4534`) is never published to the host; it is only
reachable from `musicdeck-web` over the internal Docker network.

### Persistent data

Docker named volumes: `musicdeck-data` (SQLite database — users, sessions,
settings, favorites, recently played, playlists), `musicdeck-config`, and
`musicdeck-cache`. Host-path volumes: `MUSIC_ROOT` (your music, read-write for
MusicDeck / read-only for Navidrome and Jellyfin), `NAVIDROME_DATA`,
`JELLYFIN_CONFIG`, and `JELLYFIN_CACHE`.

### Multi-user access

Every device connects to the same `MUSICDECK_WEB_PORT`/`MUSICDECK_PUBLIC_URL`.
Each signed-in user gets an independent session cookie and fully isolated
settings/favorites/recently-played/playlists — multiple LAN clients (or
multiple accounts on the same device) can use the server simultaneously
without seeing each other's data. See
`server/test/multi-user-isolation.test.ts` for regression coverage.

### Updating

```powershell
docker compose pull
docker compose up -d --build
```

For more detail (HTTPS/reverse proxy, secret files, backups, health checks),
see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Development vs production

- **Local development**: `server` runs via `tsx watch` on `:4534`; `webapp`
  runs via `react-scripts start` on `:3000` and proxies `/api` to the server.
- **Docker/self-hosted**: nginx serves the built React app on the web port and
  proxies `/api/*` to the server container internally — one origin, no CORS
  setup required.

## API overview

The MusicDeck API is same-origin under `/api`:

- `/api/auth/*` — login, logout, session, change password
- `/api/albums`, `/api/artists`, `/api/tracks` — catalog
- `/api/search` — search
- `/api/library/random-*` — random albums/tracks
- `/api/playlists*` — playlists and items
- `/api/favorites/*`, `/api/recently-played` — user data
- `/api/tracks/:id/stream`, `/api/artwork/:id` — media (provider-resolved)
- `/api/admin/*` — admin health, users, backend connections, server settings

All catalog and media responses use stable MusicDeck IDs; provider IDs never
reach the client.

## Testing

Server (from `server/`):

```powershell
npm test            # vitest suite
npm run typecheck   # tsc --noEmit
npm run build       # production build
```

Web client (from `webapp/`):

```powershell
npm test            # react-scripts test (CI: set CI=true to run once)
npm run build       # production build
```

> Run React tests via `npm test` (which invokes `react-scripts test`), not
> `npx jest`. Calling `jest` directly bypasses Create React App's Babel/JSX
> transform and fails with `Cannot use import statement outside a module`.
> In non-interactive environments, set `CI=true` so the suite runs once
> instead of entering watch mode.

## Keeping this README current

When a change modifies setup, startup, environment variables, Docker
deployment, configuration, or required tooling, update this README in the same
change. This file is the authoritative startup guide; do not create a second,
conflicting guide. Provider-specific deployment detail lives in
`docs/SELF_HOSTING.md` and `docs/architecture.md`.
