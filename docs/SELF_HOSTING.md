# MusicDeck Self-Hosting Guide

This guide runs MusicDeck as a small self-hosted LAN stack:

```text
Browser (any LAN device)
  -> http://SERVER_IP:MUSICDECK_WEB_PORT
  -> MusicDeck Web container (nginx)
     -> /api proxy  -> MusicDeck Server container
     -> /ws proxy   -> MusicDeck Server container (reserved; no WebSockets in use yet)
  -> MusicDeck Server container
     -> selected backend container (internal only): Navidrome OR Jellyfin
```

Every device on your network talks to MusicDeck on **one origin**
(`MUSICDECK_PUBLIC_URL`). MusicDeck Server talks to the backend internally
over the Docker network; LAN clients never need to know those ports exist.

MusicDeck runs **exactly one** backend, chosen with `MUSIC_BACKEND`
(`navidrome` or `jellyfin`). The unused backend container is never created.

## Prerequisites

- Docker Engine (or Docker Desktop) with Compose
- A folder containing your music files
- A text editor

You do **not** need the MusicDeck source repository, and you do **not** need
Node.js, Python, FFmpeg, or spotDL installed on the host — the published
`musicdeck-server` image already contains them.

## Files

A complete production install is two files in one folder:

```text
/opt/musicdeck/
  docker-compose.yml   # pulls prebuilt images from GHCR
  .env                 # your settings
```

Images are published to GHCR by the repository's
`.github/workflows/publish-images.yml` workflow:

- `ghcr.io/userphase/musicdeck-server`
- `ghcr.io/userphase/musicdeck-web`

Developers who want to build from source instead use `docker-compose.dev.yml`
(see "Local development" below), which needs `server/Dockerfile`,
`webapp/Dockerfile`, and `webapp/nginx.conf` from a source checkout.

## First Startup

Create the install folder and fetch the two files:

```bash
mkdir -p /opt/musicdeck && cd /opt/musicdeck
curl -O https://raw.githubusercontent.com/UserPhase/MusicDeck/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/UserPhase/MusicDeck/main/.env.example
```

Set these values before starting (see `.env.example` for the full list and
explanations):

```text
MUSIC_BACKEND=navidrome
MUSICDECK_PUBLIC_URL=http://SERVER_IP:8080
MUSICDECK_SESSION_SECRET=replace-with-a-long-random-secret
MUSICDECK_ADMIN_USERNAME=admin
MUSICDECK_ADMIN_PASSWORD=change-this-admin-password
MUSIC_ROOT=/media/music

# Required only when MUSIC_BACKEND=navidrome
NAVIDROME_USERNAME=admin
NAVIDROME_PASSWORD=change-this-navidrome-password

# Required only when MUSIC_BACKEND=jellyfin
JELLYFIN_API_KEY=your-jellyfin-api-key
```

Replace `SERVER_IP` with your Docker host's actual LAN IP address (e.g.
`192.168.1.50`) or a resolvable hostname. `docker compose up` intentionally
fails fast with a clear error if `MUSICDECK_PUBLIC_URL`,
`MUSICDECK_SESSION_SECRET`, `MUSICDECK_ADMIN_PASSWORD`, or `MUSIC_ROOT` are
missing — there is no silent `localhost` fallback in production.
`MUSICDECK_CORS_ORIGIN` defaults to `MUSICDECK_PUBLIC_URL` if not set
separately. The server additionally validates, at startup, that the selected
backend's own credentials are present.

Leave `COMPOSE_PROFILES=${MUSIC_BACKEND}` in `.env` exactly as shipped — it is
what makes Compose start only the backend you selected.

`MUSIC_ROOT` must be an absolute path that already exists on the Docker host.
`NAVIDROME_DATA`, `JELLYFIN_CONFIG`, and `JELLYFIN_CACHE` are optional — they
default to `./navidrome-data`, `./jellyfin-config`, and `./jellyfin-cache`
(created next to `docker-compose.yml`) unless you override them with your own
absolute host paths.

`MUSICDECK_ADMIN_PASSWORD` is used only when the MusicDeck database has no
users. It is not used to reset an existing admin account.

Start the stack:

```bash
docker compose pull
docker compose up -d
```

Open MusicDeck (the only URL LAN clients need):

```text
http://SERVER_IP:8080
```

If you selected `MUSIC_BACKEND=navidrome`, open Navidrome directly for its
initial setup (optional — see "Required vs. optional ports" below):

```text
http://SERVER_IP:4533
```

After Navidrome has a user matching `NAVIDROME_USERNAME` and
`NAVIDROME_PASSWORD`, MusicDeck Server can use it as the backend service
account.

If you selected `MUSIC_BACKEND=jellyfin`, open Jellyfin directly to complete
its first-run wizard:

```text
http://SERVER_IP:8096
```

Create an API key under **Dashboard → API Keys**, set `JELLYFIN_API_KEY` in
`.env`, then `docker compose up -d` again.

## LAN Access (other devices on your network)

The Docker Compose stack already binds `musicdeck-server` to `0.0.0.0`
internally and publishes only `musicdeck-web` on
`${MUSICDECK_WEB_PORT:-8080}` on all host interfaces — no extra container
configuration is required for LAN access itself. To reach MusicDeck from a
phone, tablet, or another computer on the same network:

1. Find the host machine's LAN IP address (e.g. `192.168.1.50`).
2. Set `MUSICDECK_PUBLIC_URL` in `.env` to that address, for example:
   ```text
   MUSICDECK_PUBLIC_URL=http://192.168.1.50:8080
   ```
   This must match the exact origin browsers on other devices will use,
   including port — there is no `localhost` default. `MUSICDECK_CORS_ORIGIN`
   defaults to this value automatically.
3. Start/restart the stack (`docker compose up -d`) so the server picks up
   the new environment values.
4. Browse to `http://192.168.1.50:8080` from any device on the same network.

Because the React client only ever calls same-origin relative `/api/...`
paths (proxied by nginx), there is no separate frontend build step or extra
environment variable needed for the API URL — whatever host/IP the browser
uses to load the page is the host/IP it will use for API calls
automatically. MusicDeck does not currently use WebSockets; `webapp/nginx.conf`
still proxies a reserved `/ws/` path with correct `Upgrade`/`Connection`
header forwarding so a future real-time feature works through the same
single origin without any client-side reconfiguration.

If you plan to expose MusicDeck beyond your LAN (e.g. over the public
internet), put it behind a reverse proxy with HTTPS — see "HTTPS / Reverse
Proxy" below — and set `MUSICDECK_SECURE_COOKIES=true`.

## Services

### musicdeck-web

Serves the prebuilt React app with nginx. This is the only container LAN
clients connect to.

- Image: `ghcr.io/userphase/musicdeck-web`
- Public port: `${MUSICDECK_WEB_PORT:-8080}` — **required**
- Proxies `/api/*` and `/ws/*` to `musicdeck-server:4534`
- Serves the React client without running the React development server

### musicdeck-server

Runs the compiled TypeScript MusicDeck API server.

- Image: `ghcr.io/userphase/musicdeck-server`
- Internal port: `4534` — never published to the host; only reachable from
  `musicdeck-web` over the internal Docker network
- Uses SQLite at `/app/data/musicdeck.sqlite`
- Stores sessions, users, settings, favorites, recently played, and
  playlist ownership — all isolated per user (see "Multi-User Accounts")
- Reads the selected backend's credentials from environment variables
- Bundles the full acquisition runtime so the host needs nothing installed:
  Node.js 24, Python 3, FFmpeg/ffprobe, and spotDL (in a dedicated
  virtualenv at `/opt/spotdl`)

### navidrome

Runs the Navidrome music backend. Started **only** when
`MUSIC_BACKEND=navidrome`.

- Internal URL used by MusicDeck Server: `http://navidrome:4533`
- Optional host port: `${NAVIDROME_PORT:-4533}` — only for direct
  Navidrome setup/admin access; not required for normal MusicDeck use
- Reads music from `MUSIC_ROOT` on the host, mounted read-only
- Stores its own database/config/cache in `NAVIDROME_DATA` on the host
  (optional; defaults to `./navidrome-data`)

### jellyfin

Runs the Jellyfin backend. Started **only** when `MUSIC_BACKEND=jellyfin`.

- Internal URL used by MusicDeck Server: `http://jellyfin:8096`
- Optional host port: `${JELLYFIN_PORT:-8096}` — needed at least once to
  create the API key MusicDeck authenticates with
- Reads music from `MUSIC_ROOT` on the host, mounted read-only
- Stores its own config in `JELLYFIN_CONFIG` and transcode/image cache in
  `JELLYFIN_CACHE` on the host (optional; default to `./jellyfin-config` and
  `./jellyfin-cache`), both persistent across restarts
- Jellyfin does not implement provider-side user-data sync, so favorites and
  playlists are kept in MusicDeck's own database instead of being mirrored
  to the backend

## Persistent Volumes

Docker named volumes:

- `musicdeck-data`: SQLite database and persistent MusicDeck data
- `musicdeck-config`: reserved for future config files
- `musicdeck-cache`: reserved for future cache/artwork/transcode data

Docker host bind mounts (all configurable via `.env`):

- `MUSIC_ROOT`: your music library folder (required)
- `NAVIDROME_DATA`: Navidrome database/config/cache (optional, defaults to
  `./navidrome-data`)
- `JELLYFIN_CONFIG`: Jellyfin configuration (optional, defaults to
  `./jellyfin-config`)
- `JELLYFIN_CACHE`: Jellyfin transcode/image cache (optional, defaults to
  `./jellyfin-cache`)

Music folder mapping:

```text
$MUSIC_ROOT:/music:ro   (navidrome, jellyfin)
$MUSIC_ROOT:/music      (musicdeck-server)
```

MusicDeck Server and the selected backend mount the same host folder
(`$MUSIC_ROOT`) so that music downloaded through MusicDeck's acquisition
pipeline (e.g. the spotDL downloader) lands in the exact folder the backend
scans. MusicDeck Server mounts it read-write (to save downloaded files); the
backend mounts it read-only (it only needs to scan/serve).

If your host music folder or the backend's data folders need to change, edit
the corresponding variable in `.env` and restart the stack —
`docker-compose.yml` itself has no hard-coded host paths.

### Local (non-Compose) development

When running `npm run dev` directly instead of Docker Compose, MusicDeck Server and Navidrome may live on different machines or filesystems with no shared folder by default. In that case, downloaded tracks will report as "completed"/"imported" in MusicDeck but never appear in your library, because Navidrome scans a folder your local MusicDeck process never wrote to.

Set `MUSICDECK_MUSIC_ROOT` in `.env` (or the server's environment) to a path that Navidrome's music folder also resolves to — for example a shared network path, or by running Navidrome locally against the same folder. See `.env.example` for details.

## Environment Variables

Backend selection:

- `MUSIC_BACKEND` — `navidrome` (default) or `jellyfin`. Selects the single
  backend MusicDeck runs against; anything else fails startup rather than
  silently falling back.
- `COMPOSE_PROFILES=${MUSIC_BACKEND}` — leave as shipped; this is what stops
  Compose from creating the unused backend container.

MusicDeck:

- `MUSICDECK_WEB_PORT`
- `MUSICDECK_PUBLIC_URL` — required, no `localhost` default in production
- `MUSICDECK_CORS_ORIGIN` — optional, defaults to `MUSICDECK_PUBLIC_URL`
- `MUSICDECK_SESSION_SECRET` — required
- `MUSICDECK_ADMIN_USERNAME`
- `MUSICDECK_ADMIN_PASSWORD` — required

Image selection:

- `MUSICDECK_VERSION` — image tag to run; defaults to `latest`. Pin to a
  release tag for reproducible deployments.
- `MUSICDECK_IMAGE_SERVER`, `MUSICDECK_IMAGE_WEB` — override only if you
  publish your own image builds.

MusicDeck Server container also uses:

- `MUSICDECK_HOST=0.0.0.0`
- `MUSICDECK_PORT=4534`
- `MUSICDECK_DB_PATH=/app/data/musicdeck.sqlite`
- `MUSICDECK_MUSIC_ROOT`: folder where acquired/downloaded music is written. Must match the backend's scanned music folder (see "Persistent Volumes" above).

Navidrome backend connection (required when `MUSIC_BACKEND=navidrome`):

- `NAVIDROME_URL=http://navidrome:4533` (internal, fixed)
- `NAVIDROME_USERNAME` — required for this backend
- `NAVIDROME_PASSWORD` — required for this backend
- `NAVIDROME_PORT` — optional host port for direct access
- `NAVIDROME_DATA` — optional host path, defaults to `./navidrome-data`

Jellyfin backend connection (required when `MUSIC_BACKEND=jellyfin`):

- `JELLYFIN_URL=http://jellyfin:8096` (internal, fixed)
- `JELLYFIN_API_KEY` — required for this backend
- `JELLYFIN_PORT` — optional host port for direct access
- `JELLYFIN_CONFIG`, `JELLYFIN_CACHE` — optional host paths, default to
  `./jellyfin-config` and `./jellyfin-cache`

Music library:

- `MUSIC_ROOT` — required host path, mounted read-write into MusicDeck
  Server and read-only into Navidrome/Jellyfin

Secret file support exists for:

- `MUSICDECK_SESSION_SECRET_FILE`
- `NAVIDROME_PASSWORD_FILE`

Use secret files or your platform's secret manager for production where possible. Do not commit `.env`.

## Credential Storage

MusicDeck no longer stores fresh Navidrome username/password values in SQLite when environment credentials are supplied. Existing database-stored credentials are scrubbed when startup credentials are provided through environment/config.

Database-stored backend credentials remain a development fallback for older databases that do not yet provide deployment credentials.

## Multi-User Accounts

MusicDeck supports multiple independent user accounts on one server:

- The first account is created automatically from `MUSICDECK_ADMIN_USERNAME`/`MUSICDECK_ADMIN_PASSWORD` the first time the database has zero users (see `seedInitialData` in `server/src/db/migrations.ts`). This only runs once — it does not reset an existing admin's password.
- Additional accounts (admin or standard `user` role) are created by an admin from the Admin > Users page, or via `POST /api/users`.
- Each user has their own session, settings (`/api/settings/user`), favorites, recently played history, and playlists — all scoped by `user_id` in SQLite. Non-admin users cannot read or modify another user's data or admin-only server settings (`403 Forbidden`).
- See `server/test/multi-user-isolation.test.ts` for regression coverage confirming two accounts on the same server never see each other's settings, favorites, or history, and that logging out one account does not affect another's session.

## Health Checks

MusicDeck Server container health check:

```text
GET /api/health
```

This endpoint returns non-sensitive service liveness only.

Navidrome container health check:

```text
GET /app/
```

Admin health data remains protected behind MusicDeck admin authorization:

```text
GET /api/admin/health
```

## Same-Origin Production Shape

In Compose, the browser talks to `musicdeck-web` only:

```text
http://SERVER_IP:8080/
http://SERVER_IP:8080/api/*
```

nginx proxies `/api/*` (and reserved `/ws/*`) to the server internally. This avoids requiring users to configure browser CORS for normal production deployments.

Local development is different: React's development server uses the `proxy` setting in `webapp/package.json` to reach `http://localhost:4534`.

## HTTPS / Reverse Proxy

For real production use, put MusicDeck behind a reverse proxy such as Caddy, Nginx, Traefik, or your hosting provider's proxy.

Recommended external shape:

```text
https://musicdeck.example.com
  -> musicdeck-web:80
  -> /api proxy to musicdeck-server:4534
```

Use HTTPS so cookies can be marked secure and credentials are protected in transit.

## Backup Basics

Back up these volumes/paths:

- `musicdeck-data`
- `NAVIDROME_DATA` (Navidrome database/config/cache; defaults to `./navidrome-data`)
- `JELLYFIN_CONFIG` (Jellyfin configuration; defaults to `./jellyfin-config`)
- `MUSIC_ROOT` (your music library folder)
- your `.env` or secret-management configuration

For SQLite, stop the containers before copying the database for the simplest safe backup:

```powershell
docker compose down
# copy the MusicDeck data volume using your preferred Docker volume backup method
docker compose up -d
```

A full backup/restore command is intentionally deferred.

## Updating

Production (prebuilt GHCR images):

```bash
docker compose pull
docker compose up -d
```

Pin `MUSICDECK_VERSION` in `.env` to a release tag instead of `latest` if you
want updates to be explicit rather than automatic on the next pull.

Developer source builds:

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

## Development Workflow

Run services directly while developing:

```powershell
cd server
npm install
npm run dev
```

```powershell
cd webapp
npm install
npm start
```

React development uses `http://localhost:3000` and proxies `/api/*` to `http://localhost:4534`.

Note: the Docker image bundles Python, FFmpeg, and spotDL, but a bare
`npm run dev` on the host does not. To exercise the acquisition/downloader
pipeline locally you must install `python3`, `ffmpeg`, and `spotdl` yourself,
or develop against the containerized stack
(`docker compose -f docker-compose.dev.yml up -d --build`).

### Developing locally against a remote/production Navidrome

If `NAVIDROME_URL` points at a Navidrome instance running on another machine (e.g. a production server), MusicDeck Server running locally (`npm run dev`) has no shared filesystem with that remote Navidrome by default. In this setup:

- Acquisitions (e.g. spotDL downloads via On-Demand Library) will download and report `completed`/`imported` successfully, because MusicDeck only knows about its own local `MUSICDECK_MUSIC_ROOT` folder.
- The downloaded file will **not** appear in your library or be playable, because the remote Navidrome server scans its own separate music folder and never sees files written to your local machine.

This is expected — it's not a bug in the download pipeline. To actually make downloaded tracks playable while developing against a remote Navidrome, you need a real shared location between the two machines, for example:
- Mount/share the remote Navidrome server's music folder over the network (e.g. SMB/NFS) and point `MUSICDECK_MUSIC_ROOT` at that mounted path, or
- Run Navidrome locally too (matching the Docker Compose model) so both share one filesystem, or
- Deploy MusicDeck Server itself alongside Navidrome (e.g. via `docker-compose.yml`, where both containers already mount the same music volume) instead of running it locally.

## Troubleshooting

Check container status:

```powershell
docker compose ps
```

View logs:

```bash
docker compose logs musicdeck-server
docker compose logs musicdeck-web
docker compose logs "$MUSIC_BACKEND"
```

Common startup issues:

- `unable to prepare context: path ".../server" not found`: you are using a
  build-based compose file without a source checkout. Production installs must
  use `docker-compose.yml` (prebuilt GHCR images); `docker-compose.dev.yml` is
  the only file that builds from `./server` and `./webapp`.
- `MUSICDECK_SESSION_SECRET must be set`: set a non-default secret in `.env`.
- `MUSIC_BACKEND must be "navidrome" or "jellyfin"`: fix the typo in `.env`.
- Both Navidrome and Jellyfin containers start, or the wrong one does: make
  sure `COMPOSE_PROFILES=${MUSIC_BACKEND}` is still present in `.env`.
- `NAVIDROME_URL must be a valid URL`: check the URL format.
- `NAVIDROME_USERNAME is required` / `NAVIDROME_PASSWORD is required`: set the
  backend service credentials (only needed when `MUSIC_BACKEND=navidrome`).
- `JELLYFIN_API_KEY is required when MUSIC_BACKEND=jellyfin`: create an API key
  in Jellyfin's dashboard and set it in `.env`.
- `Set MUSIC_ROOT in .env` (Compose variable error): `MUSIC_ROOT` has no default and must point at a real, existing absolute folder. `NAVIDROME_DATA`/`JELLYFIN_CONFIG`/`JELLYFIN_CACHE` are optional and default to folders created next to `docker-compose.yml` if omitted.
- Cannot find music: check the `MUSIC_ROOT` host path in `.env` and host file/folder permissions.
- Downloads via On-Demand Library/spotDL complete successfully but tracks never appear in the library or play: MusicDeck Server and the backend are not sharing the same music folder. In Docker Compose both containers already mount `$MUSIC_ROOT`; for local/manual development, set `MUSICDECK_MUSIC_ROOT` to a path the backend's music folder also resolves to.
- `spotdl: not found` or FFmpeg errors during acquisition: expected only for
  local `npm run dev` runs. The Docker image bundles both; verify inside the
  container with `docker exec musicdeck-server spotdl --version` and
  `docker exec musicdeck-server ffmpeg -version`.

MusicDeck does not log Navidrome passwords, session secrets, tokens, or authenticated URLs.
