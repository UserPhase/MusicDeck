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

## Quick start (Docker Compose)

Follow these steps to deploy MusicDeck using Docker Compose.

### Step 1: Create Project Directory

mkdir musicdeck && cd musicdeck

### Step 2: Download Configuration Files

Fetch the pre-configured docker-compose.yml and .env template:

```bash
curl -O https://raw.githubusercontent.com/UserPhase/MusicDeck/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/UserPhase/MusicDeck/main/.env.example
```

### Step 3: Configure Base Environment

Open .env to configure your initial deployment:
```bash
nano .env
```
    Select your backend: Set MUSIC_BACKEND=navidrome OR MUSIC_BACKEND=jellyfin. 

    Set host path & IP:

        MUSIC_ROOT: Absolute path to your music folder (e.g., /media/music).

        MUSICDECK_PUBLIC_URL: Your server's LAN IP (e.g., http://192.168.1.50:8080).
          Tip (Find your Server IP): Run  `ip -4  addr` in your server terminal. Look for your primary network interface (e.g., enp3s0 or eth0) and use the IP address listed after inet.

    Set MusicDeck credentials:

        MUSICDECK_SESSION_SECRET: Set a long random string (e.g., run `openssl rand -hex 32` in a terminal).

        MUSICDECK_ADMIN_PASSWORD: Set your MusicDeck admin password.

### Step 4: First-Run Setup (Choose Your Backend)
Option A: Navidrome Setup

    Set NAVIDROME_PASSWORD in .env.

    Start the stack:
```bash
    docker compose pull && docker compose up -d
```
    Open http://[YOUR_SERVER_IP]:4533 in your browser and create the admin account matching NAVIDROME_USERNAME and NAVIDROME_PASSWORD from your .env.

Option B: Jellyfin Setup

    Start Jellyfin first so you can configure it:
```bash
    docker compose pull && docker compose up -d jellyfin
```
    Open http://[YOUR_SERVER_IP]:8096 in your browser, complete the initial setup wizard, and log in.

    Go to Dashboard -> API Keys, create a new API key (e.g., named "MusicDeck"), and copy the key string.

    Open .env and set JELLYFIN_API_KEY=<your-copied-key>:

```bash
    nano .env
```
    Start the full MusicDeck stack:
```bash
    docker compose up -d
```
Step 5: Access MusicDeck

Open http://[YOUR_SERVER_IP]:8080 in your browser and log in using your MUSICDECK_ADMIN_USERNAME and MUSICDECK_ADMIN_PASSWORD.

## Local development (for tweaking it yourself)

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

