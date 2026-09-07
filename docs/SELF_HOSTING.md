# MusicDeck Self-Hosting Guide

This guide runs MusicDeck as a small self-hosted stack:

```text
Browser
  -> MusicDeck Web container
  -> /api proxy
  -> MusicDeck Server container
  -> Navidrome container
```

The browser talks to MusicDeck on one origin. MusicDeck Server talks to Navidrome internally.

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

Set these values before starting:

```text
MUSICDECK_SESSION_SECRET=replace-with-a-long-random-secret
MUSICDECK_ADMIN_USERNAME=admin
MUSICDECK_ADMIN_PASSWORD=change-this-admin-password
NAVIDROME_USERNAME=admin
NAVIDROME_PASSWORD=change-this-navidrome-password
```

Music library and Navidrome data paths are fixed host paths in `docker-compose.yml` (`/media/music` and `/opt/navidrome/data`). Edit `docker-compose.yml` directly if your host paths differ.

`MUSICDECK_ADMIN_PASSWORD` is used only when the MusicDeck database has no users. It is not used to reset an existing admin account.

Start the stack:

```powershell
docker compose up --build
```

Open MusicDeck:

```text
http://localhost:8080
```

Open Navidrome directly for initial Navidrome setup if needed:

```text
http://localhost:4533
```

After Navidrome has a user matching `NAVIDROME_USERNAME` and `NAVIDROME_PASSWORD`, MusicDeck Server can use it as the backend service account.

## Services

### musicdeck-web

Builds the React app and serves it with nginx.

- Public port: `${MUSICDECK_WEB_PORT:-8080}`
- Proxies `/api/*` to `musicdeck-server:4534`
- Serves the React client without running the React development server

### musicdeck-server

Runs the compiled TypeScript MusicDeck API server.

- Internal port: `4534`
- Uses SQLite at `/app/data/musicdeck.sqlite`
- Stores sessions, users, settings, favorites, recently played, and playlist ownership
- Reads Navidrome credentials from environment variables

### navidrome

Runs the initial music backend.

- Internal port: `4533`
- Optional host port: `${NAVIDROME_PORT:-4533}`
- Reads music from `/media/music` on the host, mounted read-only
- Stores its own database/config/cache in `/opt/navidrome/data` on the host

## Persistent Volumes

Docker named volumes:

- `musicdeck-data`: SQLite database and persistent MusicDeck data
- `musicdeck-config`: reserved for future config files
- `musicdeck-cache`: reserved for future cache/artwork/transcode data

Docker host bind mounts:

- `/opt/navidrome/data`: Navidrome database/config/cache
- `/media/music`: your music library folder

Music folder mapping:

```text
/media/music:/music:ro   (navidrome)
/media/music:/music      (musicdeck-server)
```

Both containers mount the same host folder (`/media/music`) so that music downloaded through MusicDeck's acquisition pipeline (e.g. the spotDL downloader) lands in the exact folder Navidrome scans. MusicDeck Server mounts it read-write (to save downloaded files); Navidrome mounts it read-only (it only needs to scan/serve).

If your host music folder or Navidrome data folder live somewhere else, edit the bind mount paths directly in `docker-compose.yml`.

### Local (non-Compose) development

When running `npm run dev` directly instead of Docker Compose, MusicDeck Server and Navidrome may live on different machines or filesystems with no shared folder by default. In that case, downloaded tracks will report as "completed"/"imported" in MusicDeck but never appear in your library, because Navidrome scans a folder your local MusicDeck process never wrote to.

Set `MUSICDECK_MUSIC_ROOT` in `.env` (or the server's environment) to a path that Navidrome's music folder also resolves to — for example a shared network path, or by running Navidrome locally against the same folder. See `.env.example` for details.

## Environment Variables

MusicDeck:

- `MUSICDECK_WEB_PORT`
- `MUSICDECK_PUBLIC_URL`
- `MUSICDECK_CORS_ORIGIN`
- `MUSICDECK_SESSION_SECRET`
- `MUSICDECK_ADMIN_USERNAME`
- `MUSICDECK_ADMIN_PASSWORD`

MusicDeck Server container also uses:

- `MUSICDECK_HOST=0.0.0.0`
- `MUSICDECK_PORT=4534`
- `MUSICDECK_DB_PATH=/app/data/musicdeck.sqlite`
- `MUSICDECK_MUSIC_ROOT`: folder where acquired/downloaded music is written. Must match Navidrome's scanned music folder (see "Persistent Volumes" above).

Navidrome backend connection:

- `NAVIDROME_URL=http://navidrome:4533`
- `NAVIDROME_USERNAME`
- `NAVIDROME_PASSWORD`

Secret file support exists for:

- `MUSICDECK_SESSION_SECRET_FILE`
- `NAVIDROME_PASSWORD_FILE`

Use secret files or your platform's secret manager for production where possible. Do not commit `.env`.

## Credential Storage

MusicDeck no longer stores fresh Navidrome username/password values in SQLite when environment credentials are supplied. Existing database-stored credentials are scrubbed when startup credentials are provided through environment/config.

Database-stored backend credentials remain a development fallback for older databases that do not yet provide deployment credentials.

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
http://localhost:8080/
http://localhost:8080/api/*
```

nginx proxies `/api/*` to the server internally. This avoids requiring users to configure browser CORS for normal production deployments.

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
- `/opt/navidrome/data` (Navidrome database/config/cache)
- `/media/music` (your music library folder)
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
docker compose up --build -d
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
- Cannot find music: check the `/media/music` host path in `docker-compose.yml` and host file permissions.
- Downloads via On-Demand Library/spotDL complete successfully but tracks never appear in the library or play: MusicDeck Server and Navidrome are not sharing the same music folder. In Docker Compose both containers already mount `/media/music`; for local/manual development, set `MUSICDECK_MUSIC_ROOT` to a path Navidrome's music folder also resolves to.

MusicDeck does not log Navidrome passwords, session secrets, tokens, or authenticated URLs.
