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
  -> MusicDeck API (Rust/Axum + SQLite)
  -> Provider layer
     ├── Navidrome
     └── Jellyfin
```

MusicDeck owns users, sessions, settings, favorites, recently played, and
playlists. It maps every track/album/artist/artwork to a stable MusicDeck ID
and resolves playback to an available provider source automatically.

## Repository structure

- `webapp/` — React web client
- `server-rust/` — MusicDeck API server (Rust, Axum, SQLite)
- `docker-compose.yml` — self-hosted production stack
- `.env.example` — environment template for the Docker stack
- `docs/` — architecture, product, and self-hosting documentation

## Quick start (Docker Compose)

Install Docker Engine with the Compose plugin on the server first. If your
Docker setup needs administrator privileges, prefix the `docker` commands with
`sudo`. [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)

### Step 1: Create Project Directory

```bash
mkdir musicdeck && cd musicdeck
```

### Step 2: Download Configuration Files

Fetch the pre-configured docker-compose.yml and .env template:

```bash
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/UserPhase/MusicDeck/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/UserPhase/MusicDeck/main/.env.example
mkdir -p ./music
```

### Step 3: Configure Base Environment

Open .env to configure your initial deployment:

```bash
nano .env
```

Set `MUSIC_BACKEND` to `navidrome` or `jellyfin` and leave the template's
`COMPOSE_PROFILES` setting in place so Compose starts the selected backend.

- Set host path & IP:

  - `MUSIC_ROOT` defaults to `./music` beside `docker-compose.yml`. Add your
    music files there or set an absolute path for an existing library.
    Set `PUID` and `PGID` to the UID and GID of the account that owns the
    music folder. For the default folder created in step 2, use `id -u`
    and `id -g`.

    - MUSICDECK_PUBLIC_URL: Your server's LAN IP (e.g., http://192.168.1.50:8080).
      - Tip (Find your Server IP): Run  `ip -4  addr` in your server terminal. Look for your primary network interface (e.g., enp3s0 or eth0) and use the IP address listed after inet.

  - Set `MUSICDECK_WEB_BIND` to the host's LAN IP to bind the MusicDeck web
    port to that interface. The onboarding template uses `0.0.0.0`, which
    listens on all IPv4 interfaces. Restrict access to your trusted network.
    Navidrome and Jellyfin administration ports bind to `127.0.0.1` in
    production Compose. See
    [network restrictions](./docs/SELF_HOSTING.md#backend-bindings-and-network-restrictions).

  - The template enables HTTP on a trusted LAN with
    `MUSICDECK_SECURE_COOKIES=false`. Prefer HTTPS for long-term use; for a
    same-host TLS proxy, set `MUSICDECK_WEB_BIND=127.0.0.1`,
    `MUSICDECK_SECURE_COOKIES=true`, and an HTTPS public URL. HTTP exposes
    credentials/session traffic to observers on the network.

- Set MusicDeck credentials:

  - MUSICDECK_SESSION_SECRET: Set a long random string (e.g., run 'openssl rand -hex 32' in a terminal).

  - MUSICDECK_ADMIN_PASSWORD: Set your MusicDeck admin password.

### Step 4: Set Up Your Music Backend

#### Option A: Navidrome

Set `NAVIDROME_USERNAME` and `NAVIDROME_PASSWORD` in `.env`, then start the
Navidrome container.

```bash
docker compose up -d navidrome
```

On your PC, open an SSH tunnel using your server login. Leave it running while
you open `http://127.0.0.1:4533` on the PC and create the Navidrome account
matching the credentials in `.env`.

```bash
ssh -N -L 127.0.0.1:4533:127.0.0.1:4533 user@SERVER_IP
```

#### Option B: Jellyfin

```bash
docker compose up -d jellyfin
```

On your PC, open an SSH tunnel and visit `http://127.0.0.1:8096` in your
browser. Complete the setup wizard and add a Music library using `/music`.
In **Dashboard → API Keys**, create a key and set `JELLYFIN_API_KEY` in `.env`.

```bash
ssh -N -L 127.0.0.1:8096:127.0.0.1:8096 user@SERVER_IP
```

### Step 5: Start MusicDeck

```bash
docker compose pull
docker compose up -d --wait
```

Open `MUSICDECK_PUBLIC_URL` in your browser and sign in with
`MUSICDECK_ADMIN_USERNAME` and `MUSICDECK_ADMIN_PASSWORD`. To verify the
provider connection, open **Library** and play a track from the folder you
mounted at `/music`.

## Local development (for tweaking it yourself)

Build the Rust server and React client from a source checkout. The React dev
server listens on `http://localhost:3000` and forwards API requests to the
Rust server on port 4534. [Development setup](./docs/SELF_HOSTING.md#development-workflow)

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

Configured with a URL and an API key. MusicDeck sends the key in its
authorization header.

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
