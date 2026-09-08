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

MusicDeck's production stack runs from **prebuilt images on GHCR** — you do not
need this source repository, and you do not install Node.js, Python, FFmpeg, or
spotDL on the host (they are already inside the server image).

> **Do not clone or build this repository for production.** There is no
> `git clone`, no `npm install`, and no `docker compose build` step. The
> production `docker-compose.yml` contains **no build contexts** and never
> references `./server` or `./webapp`. If you see an error like
> `unable to prepare context: path "./server" not found`, you are using the
> developer file `docker-compose.dev.yml` instead of the production one.

The published images are:

```text
ghcr.io/userphase/musicdeck-server
ghcr.io/userphase/musicdeck-web
```

Both are multi-architecture (`linux/amd64` and `linux/arm64`, so Raspberry Pi
and other ARM servers work), and both publish a `latest` tag plus version tags
(`1.2.3`, `1.2`) for release tags. Pin a version with `MUSICDECK_VERSION` in
`.env` if you don't want to track `latest`.

A complete installation is just two files:

```text
/opt/musicdeck/
  docker-compose.yml
  .env
```

Users on your network access **one URL** — nginx in `musicdeck-web`
reverse-proxies `/api/*` (and WebSocket traffic under `/ws/*`) to
`musicdeck-server` internally, so clients never need to know about the internal
server, Navidrome, or Jellyfin ports.

### 1. Create the install folder and fetch the two files

```bash
mkdir -p /opt/musicdeck && cd /opt/musicdeck
curl -O https://raw.githubusercontent.com/UserPhase/MusicDeck/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/UserPhase/MusicDeck/main/.env.example
```

### 2. Choose your backend

MusicDeck runs **exactly one** music backend. Set it in `.env`:

```text
MUSIC_BACKEND=navidrome    # or: jellyfin
```

Only the selected backend's container is started — the other one is never
created — and only that backend's credentials are required.

### 3. Change your music folder path

Set this to a real, existing absolute folder on your Docker host:

```text
MUSIC_ROOT=/media/music
PUID=1000
PGID=1000
```

`MUSIC_ROOT` is mounted read-write into MusicDeck Server (so downloads land
there) and read-only into the backend (so it can scan/serve it without ever
modifying it). The backend's own data/config/cache folders already have working
defaults created next to `docker-compose.yml`.

#### Music folder permissions

MusicDeck runs as a non-root user. `PUID` and `PGID` must identify a host
account that can write to `MUSIC_ROOT`; on most Linux systems, use the IDs of
the account that owns the music folder:

```bash
id -u
id -g
sudo chown -R "$(id -u):$(id -g)" /media/music
```

Replace `/media/music` with your actual `MUSIC_ROOT`. If another service or
account must retain ownership, grant the configured group write access instead
of changing ownership. MusicDeck checks this permission during startup and
prints the container identity plus the directory's owner/mode when they do not
match. This prevents downloads from failing later with errors such as:

```text
EACCES: permission denied, mkdir '/music/Artist/Album'
```

### 4. Set secrets, passwords, and your server's LAN address

```text
MUSICDECK_PUBLIC_URL=http://SERVER_IP:8080
MUSICDECK_SESSION_SECRET=replace-with-a-long-random-secret
MUSICDECK_ADMIN_USERNAME=admin
MUSICDECK_ADMIN_PASSWORD=choose-a-strong-password

# Only when MUSIC_BACKEND=navidrome:
NAVIDROME_USERNAME=your-navidrome-service-user
NAVIDROME_PASSWORD=your-navidrome-service-password

# Only when MUSIC_BACKEND=jellyfin:
JELLYFIN_API_KEY=your-jellyfin-api-key
```

Replace `SERVER_IP` with your Docker host's actual LAN IP address (e.g.
`192.168.1.50`) or a resolvable hostname — this is the address every device on
your network will type into its browser. Do not leave this as `localhost` in
a real deployment. `MUSICDECK_CORS_ORIGIN` defaults to `MUSICDECK_PUBLIC_URL`
automatically, so you only need to set one URL.

### 5. Start the stack

```bash
docker compose pull
docker compose up -d
```

### 6. Open MusicDeck

```text
http://SERVER_IP:8080
```

This is the only address any device on your LAN needs — phones, tablets, and
other computers all use the same URL and port.

### 7. Connect your backend account

- **Navidrome** needs a user matching `NAVIDROME_USERNAME`/`NAVIDROME_PASSWORD`
  before MusicDeck can read from it. Create it once via Navidrome's own UI at
  `http://SERVER_IP:4533` (see "Required vs. optional ports" below).
- **Jellyfin** needs an API key. Complete Jellyfin's first-run wizard at
  `http://SERVER_IP:8096`, create a key under **Dashboard → API Keys**, set
  `JELLYFIN_API_KEY` in `.env`, then re-run `docker compose up -d`.

### Required vs. optional ports

| Port | Service | Required for LAN clients? |
| --- | --- | --- |
| `MUSICDECK_WEB_PORT` (default `8080`) | musicdeck-web | **Required** — the only address end users need |
| `NAVIDROME_PORT` (default `4533`) | navidrome | Optional — only for direct Navidrome setup/admin access |
| `JELLYFIN_PORT` (default `8096`) | jellyfin | Optional — only for direct Jellyfin setup/admin access |

MusicDeck Server itself (`4534`) is never published to the host; it is only
reachable from `musicdeck-web` over the internal Docker network.

### Bundled runtime dependencies

The `musicdeck-server` image ships everything the acquisition/downloader system
needs, so the host stays clean:

| Dependency | Purpose |
| --- | --- |
| Node.js 24 | MusicDeck Server runtime |
| Python 3 | spotDL runtime |
| spotDL | On-Demand Library / track acquisition |
| FFmpeg + ffprobe | audio conversion and tagging for downloads |

Downloads are written straight into `MUSIC_ROOT`, which is the same folder your
selected backend scans, so acquired tracks appear in the library automatically.

### Persistent data

Docker named volumes: `musicdeck-data` (SQLite database — users, sessions,
settings, favorites, recently played, playlists), `musicdeck-config`, and
`musicdeck-cache`. Host-path volumes: `MUSIC_ROOT` (your music, read-write for
MusicDeck / read-only for the backend), plus `NAVIDROME_DATA`,
`JELLYFIN_CONFIG`, and `JELLYFIN_CACHE` — these default to `./navidrome-data`,
`./jellyfin-config`, and `./jellyfin-cache` (created next to
`docker-compose.yml`) unless overridden in `.env`.

### Multi-user access

Every device connects to the same `MUSICDECK_WEB_PORT`/`MUSICDECK_PUBLIC_URL`.
Each signed-in user gets an independent session cookie and fully isolated
settings/favorites/recently-played/playlists — multiple LAN clients (or
multiple accounts on the same device) can use the server simultaneously
without seeing each other's data. See
`server/test/multi-user-isolation.test.ts` for regression coverage.

### Updating

```bash
docker compose pull
docker compose up -d
```

Pin `MUSICDECK_VERSION` in `.env` to a release tag instead of `latest` for
reproducible deployments.

For more detail (HTTPS/reverse proxy, secret files, backups, health checks),
see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Development vs production

- **Local development**: `server` runs via `tsx watch` on `:4534`; `webapp`
  runs via `react-scripts start` on `:3000` and proxies `/api` to the server.
- **Docker (developers, builds from source)**: `docker-compose.dev.yml` builds
  the images from `./server` and `./webapp` and therefore needs a full source
  checkout:
  ```bash
  docker compose -f docker-compose.dev.yml up -d --build
  ```
- **Docker (self-hosted/production)**: `docker-compose.yml` pulls prebuilt GHCR
  images and needs no source tree. nginx serves the built React app on the web
  port and proxies `/api/*` to the server container internally — one origin, no
  CORS setup required.

### Publishing the images (maintainers only)

Self-hosters never need this section. The
[`Publish Docker images`](.github/workflows/publish-images.yml) workflow builds
and pushes both images to GHCR on every push to `main`, on `v*` tags, and via
manual `workflow_dispatch`. It lowercases the repository owner (`UserPhase` →
`userphase`) because GHCR image paths must be lowercase and must match the
references in `docker-compose.yml` exactly.

**GHCR packages are private on first publish.** Until they are made public,
`docker compose pull` fails for users with `error from registry: denied`. Make
each package public once, after the first successful run:

1. Open `https://github.com/users/UserPhase/packages/container/musicdeck-server/settings`
2. **Danger Zone → Change visibility → Public**
3. Repeat for `musicdeck-web`

To automate this instead, create a PAT with the `write:packages` and
`delete:packages` scopes and save it as the repository secret
`GHCR_VISIBILITY_TOKEN`; the workflow will then set visibility on each run. If
the secret is absent the workflow still succeeds and just prints the manual
steps above.

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
