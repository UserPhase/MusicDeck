# MusicDeck Self-Hosting Guide

This guide runs MusicDeck as a small self-hosted LAN stack:

```text
Browser (any LAN device)
  -> http://SERVER_IP:MUSICDECK_WEB_PORT
  -> MusicDeck Web container (nginx)
     -> /api proxy  -> MusicDeck Server container
     -> /ws proxy   -> MusicDeck Server container (reserved; no WebSockets in use yet)
  -> MusicDeck Server container
     -> Navidrome container (internal only)
     -> Jellyfin container (internal only, optional)
```

Every device on your network talks to MusicDeck on **one origin**
(`MUSICDECK_PUBLIC_URL`). MusicDeck Server talks to Navidrome and Jellyfin
internally over the Docker network; LAN clients never need to know those
ports exist.

## Prerequisites

- Docker Desktop or Docker Engine with Compose
- A folder containing your music files
- A text editor

## Files

Important deployment files:

- `docker-compose.yml`
- `.env.example`
- `server/Dockerfile`
- `webapp/Dockerfile`
- `webapp/nginx.conf`

## First Startup

From the workspace root:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set these values before starting (see `.env.example` for the full list and
explanations):

```text
MUSICDECK_PUBLIC_URL=http://SERVER_IP:8080
MUSICDECK_CORS_ORIGIN=http://SERVER_IP:8080
MUSICDECK_SESSION_SECRET=replace-with-a-long-random-secret
MUSICDECK_ADMIN_USERNAME=admin
MUSICDECK_ADMIN_PASSWORD=change-this-admin-password
NAVIDROME_USERNAME=admin
NAVIDROME_PASSWORD=change-this-navidrome-password
MUSIC_ROOT=/media/music
NAVIDROME_DATA=/opt/navidrome/data
JELLYFIN_CONFIG=/opt/jellyfin/config
JELLYFIN_CACHE=/opt/jellyfin/cache
```

Replace `SERVER_IP` with your Docker host's actual LAN IP address (e.g.
`192.168.1.50`) or a resolvable hostname. `docker compose up` intentionally
fails fast with a clear error if `MUSICDECK_PUBLIC_URL`, `MUSICDECK_CORS_ORIGIN`,
`MUSICDECK_SESSION_SECRET`, `MUSICDECK_ADMIN_PASSWORD`, `NAVIDROME_USERNAME`,
`NAVIDROME_PASSWORD`, `MUSIC_ROOT`, `NAVIDROME_DATA`, `JELLYFIN_CONFIG`, or
`JELLYFIN_CACHE` are missing — there is no silent `localhost` fallback in
production.

All host paths (`MUSIC_ROOT`, `NAVIDROME_DATA`, `JELLYFIN_CONFIG`,
`JELLYFIN_CACHE`) must be absolute paths that already exist on the Docker
host.

`MUSICDECK_ADMIN_PASSWORD` is used only when the MusicDeck database has no
users. It is not used to reset an existing admin account.

Start the stack:

```powershell
docker compose up -d
```

Open MusicDeck (the only URL LAN clients need):

```text
http://SERVER_IP:8080
```

Open Navidrome directly for initial Navidrome setup if needed (optional —
see "Required vs. optional ports" below):

```text
http://SERVER_IP:4533
```

After Navidrome has a user matching `NAVIDROME_USERNAME` and
`NAVIDROME_PASSWORD`, MusicDeck Server can use it as the backend service
account.

Jellyfin is optional. If you want it, open it directly (also optional):

```text
http://SERVER_IP:8096
```

Create an API key under **Dashboard → API Keys**, set `JELLYFIN_API_KEY` in
`.env`, then `docker compose up -d` again. Enable/configure the Jellyfin
connection from MusicDeck's Admin dashboard.

## LAN Access (other devices on your network)

The Docker Compose stack already binds `musicdeck-server` to `0.0.0.0`
internally and publishes only `musicdeck-web` on
`${MUSICDECK_WEB_PORT:-8080}` on all host interfaces — no extra container
configuration is required for LAN access itself. To reach MusicDeck from a
phone, tablet, or another computer on the same network:

1. Find the host machine's LAN IP address (e.g. `192.168.1.50`).
2. Set `MUSICDECK_PUBLIC_URL` and `MUSICDECK_CORS_ORIGIN` in `.env` to that
   address, for example:
   ```text
   MUSICDECK_PUBLIC_URL=http://192.168.1.50:8080
   MUSICDECK_CORS_ORIGIN=http://192.168.1.50:8080
   ```
   These must match the exact origin browsers on other devices will use,
   including port. Both are required — there is no `localhost` default.
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

Builds the React app and serves it with nginx. This is the only container
LAN clients connect to.

- Public port: `${MUSICDECK_WEB_PORT:-8080}` — **required**
- Proxies `/api/*` and `/ws/*` to `musicdeck-server:4534`
- Serves the React client without running the React development server

### musicdeck-server

Runs the compiled TypeScript MusicDeck API server.

- Internal port: `4534` — never published to the host; only reachable from
  `musicdeck-web` over the internal Docker network
- Uses SQLite at `/app/data/musicdeck.sqlite`
- Stores sessions, users, settings, favorites, recently played, and
  playlist ownership — all isolated per user (see "Multi-User Accounts")
- Reads Navidrome/Jellyfin credentials from environment variables

### navidrome

Runs the Navidrome music backend.

- Internal URL used by MusicDeck Server: `http://navidrome:4533`
- Optional host port: `${NAVIDROME_PORT:-4533}` — only for direct
  Navidrome setup/admin access; not required for normal MusicDeck use
- Reads music from `MUSIC_ROOT` on the host, mounted read-only
- Stores its own database/config/cache in `NAVIDROME_DATA` on the host

### jellyfin

Runs the optional Jellyfin backend.

- Internal URL used by MusicDeck Server: `http://jellyfin:8096`
- Optional host port: `${JELLYFIN_PORT:-8096}` — only for direct Jellyfin
  setup/admin access; not required for normal MusicDeck use
- Reads music from `MUSIC_ROOT` on the host, mounted read-only
- Stores its own config in `JELLYFIN_CONFIG` and transcode/image cache in
  `JELLYFIN_CACHE` on the host, both persistent across restarts

## Persistent Volumes

Docker named volumes:

- `musicdeck-data`: SQLite database and persistent MusicDeck data
- `musicdeck-config`: reserved for future config files
- `musicdeck-cache`: reserved for future cache/artwork/transcode data

Docker host bind mounts (all configurable via `.env`):

- `MUSIC_ROOT`: your music library folder
- `NAVIDROME_DATA`: Navidrome database/config/cache
- `JELLYFIN_CONFIG`: Jellyfin configuration (persistent across restarts)
- `JELLYFIN_CACHE`: Jellyfin transcode/image cache (persistent across restarts)

Music folder mapping:

```text
$MUSIC_ROOT:/music:ro   (navidrome, jellyfin)
$MUSIC_ROOT:/music      (musicdeck-server)
```

All three containers mount the same host folder (`$MUSIC_ROOT`) so that
music downloaded through MusicDeck's acquisition pipeline (e.g. the spotDL
downloader) lands in the exact folder Navidrome/Jellyfin scan. MusicDeck
Server mounts it read-write (to save downloaded files); Navidrome and
Jellyfin mount it read-only (they only need to scan/serve).

If your host music folder or Navidrome/Jellyfin data folders need to
change, edit the corresponding variable in `.env` and restart the stack —
`docker-compose.yml` itself has no hard-coded host paths.

### Local (non-Compose) development

When running `npm run dev` directly instead of Docker Compose, MusicDeck Server and Navidrome may live on different machines or filesystems with no shared folder by default. In that case, downloaded tracks will report as "completed"/"imported" in MusicDeck but never appear in your library, because Navidrome scans a folder your local MusicDeck process never wrote to.

Set `MUSICDECK_MUSIC_ROOT` in `.env` (or the server's environment) to a path that Navidrome's music folder also resolves to — for example a shared network path, or by running Navidrome locally against the same folder. See `.env.example` for details.

## Environment Variables

MusicDeck:

- `MUSICDECK_WEB_PORT`
- `MUSICDECK_PUBLIC_URL` — required, no `localhost` default in production
- `MUSICDECK_CORS_ORIGIN` — required, must match `MUSICDECK_PUBLIC_URL`
- `MUSICDECK_SESSION_SECRET` — required
- `MUSICDECK_ADMIN_USERNAME`
- `MUSICDECK_ADMIN_PASSWORD` — required

MusicDeck Server container also uses:

- `MUSICDECK_HOST=0.0.0.0`
- `MUSICDECK_PORT=4534`
- `MUSICDECK_DB_PATH=/app/data/musicdeck.sqlite`
- `MUSICDECK_MUSIC_ROOT`: folder where acquired/downloaded music is written. Must match Navidrome's/Jellyfin's scanned music folder (see "Persistent Volumes" above).

Navidrome backend connection:

- `NAVIDROME_URL=http://navidrome:4533` (internal, fixed)
- `NAVIDROME_USERNAME` — required
- `NAVIDROME_PASSWORD` — required
- `NAVIDROME_PORT` — optional host port for direct access
- `NAVIDROME_DATA` — required host path

Jellyfin backend connection (optional):

- `JELLYFIN_URL=http://jellyfin:8096` (internal, fixed)
- `JELLYFIN_API_KEY` — optional; leave blank to not use Jellyfin
- `JELLYFIN_PORT` — optional host port for direct access
- `JELLYFIN_CONFIG`, `JELLYFIN_CACHE` — required host paths

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
- `NAVIDROME_DATA` (Navidrome database/config/cache)
- `JELLYFIN_CONFIG` (Jellyfin configuration)
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

```powershell
docker compose pull
docker compose up -d --build
```

For local source builds, `--build` is enough to rebuild the server and web images.

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

```powershell
docker compose logs musicdeck-server
docker compose logs musicdeck-web
docker compose logs navidrome
```

Common startup issues:

- `MUSICDECK_SESSION_SECRET must be set`: set a non-default secret in `.env`.
- `NAVIDROME_URL must be a valid URL`: check the URL format.
- `NAVIDROME_USERNAME is required`: set the backend service username.
- `NAVIDROME_PASSWORD is required`: set the backend service password.
- `Set MUSIC_ROOT/NAVIDROME_DATA/JELLYFIN_CONFIG/JELLYFIN_CACHE in .env` (Compose variable errors): one or more required host paths are missing from `.env` — these have no default and must point at real, existing absolute folders.
- Cannot find music: check the `MUSIC_ROOT` host path in `.env` and host file/folder permissions.
- Downloads via On-Demand Library/spotDL complete successfully but tracks never appear in the library or play: MusicDeck Server and Navidrome/Jellyfin are not sharing the same music folder. In Docker Compose all three containers already mount `$MUSIC_ROOT`; for local/manual development, set `MUSICDECK_MUSIC_ROOT` to a path Navidrome's music folder also resolves to.

MusicDeck does not log Navidrome passwords, session secrets, tokens, or authenticated URLs.
