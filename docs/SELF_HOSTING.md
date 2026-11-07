# MusicDeck Self-Hosting Guide

## Portable user exports

Settings offers M3U8/XSPF playlists, history CSV, favorites JSON and a compressed
account ZIP bundle. These exports contain personal listening data: keep downloaded
files private. They are not full server backups or an automatic restore format,
and do not contain audio, sessions, provider credentials or server configuration.

`MUSICDECK_PUBLIC_URL` must be the real externally reachable MusicDeck origin:
it supplies credential-free fallback stream URLs in playlist exports. Those URLs
still require authentication. When a backend exposes a real track path inside
`MUSICDECK_MUSIC_ROOT`, the export uses a URI-encoded relative path instead.
Relocate exported playlist files to the matching music root before opening them
in another player. Paths outside that root are never disclosed; configure backend
path reporting and matching mounts for genuinely portable file locations.

Exports are streamed with at most 500 history rows queried per page. Reverse
proxies should permit long-lived streaming downloads without buffering the whole
response. Two exports per target account/four globally are allowed at once.
Disconnected clients release their export slots. For a consistent disaster
recovery image, continue using your existing database/configuration/media backup
workflow rather than relying on live paginated account exports.

## Acquisition resource limits

All values below are positive integer environment variables, available in both
Compose files and native server installations. Restart after changing them.
Administrators share these limits; admin retries count against the job owner's
pending capacity and the submitting administrator's rate budget.

| Variable (prefix `MUSICDECK_ACQUISITION_`) | Default | Meaning |
| --- | ---: | --- |
| `MAX_PENDING` | 50 | Global queued jobs plus requests undergoing admission |
| `MAX_PENDING_PER_USER` | 10 | Pending jobs/admissions per owner |
| `SUBMISSION_WINDOW_MS` | 60000 | Fixed submission-rate window |
| `SUBMISSIONS_PER_USER` | 20 | Submissions/retries per account per window |
| `SUBMISSIONS_GLOBAL` | 100 | Submissions/retries across accounts per window |
| `MAX_RATE_ENTRIES` | 10000 | Maximum account-rate buckets; fail closed when full |
| `RETENTION_MS` | 604800000 | Maximum terminal-job age: seven days |
| `MAX_RETAINED_JOBS` | 1000 | Maximum terminal-job count across all users |
| `CLEANUP_INTERVAL_MS` | 60000 | Periodic cleanup interval |
| `SSE_PER_USER` | 3 | Concurrent acquisition event streams per account |
| `SSE_GLOBAL` | 20 | Concurrent acquisition event streams in total |

HTTP 429 responses include `Retry-After` (seconds). Submission budgets include
admitted attempts that later fail or hit queue capacity, preventing rapid retry
loops. Pending includes short pre-download preparation; downloading jobs retain
the existing separate concurrency setting. Requests reserve capacity before
asynchronous lookups, so concurrent submissions cannot overfill the queue.
Acquisition bodies are limited to 64 KiB and validated with strict schemas.

Retention runs at startup, periodically, at submission, and when workers finish.
Only completed, failed, and cancelled jobs are eligible; running workers and
pending jobs are never removed. Expired history, retry inputs and container cache
references are deleted together. Downloaded music and library records are **not**
deleted. Old jobs can no longer be retried after retention; re-submit the track.
SQLite reuses freed database pages; cleanup does not shrink the physical database
file automatically. Back up the database before upgrading (a migration adds
bounded, persistent retry inputs).

These controls are designed for **one acquisition worker process per database**.
Rate buckets, in-progress admission reservations, and SSE capacity are local to
the process and reset on restart. Interrupted jobs are marked failed on restart.
Multiple instances need coordinated admission/rate/connection limits and job
scheduling; do not run independent workers against one database and assume these
limits provide cluster-wide protection. Stuck active jobs remain subject to the
downloader's existing timeouts and cancellation. Limits cover on-demand
acquisitions, not the separate Spotify playlist-import job scheduler.

SpotDL accepts HTTPS YouTube video/playlist URLs, SoundCloud track/set URLs, and
single artist-subdomain Bandcamp track/album URLs. YouTube hosts are matched
exactly, not by arbitrary suffix. Unsupported schemes, custom ports, userinfo,
option-like arguments, pipe-injected targets, and unrecognized URL fields are
rejected. Supported links are canonicalized before launch; arbitrary redirector
paths are not accepted. Separately registered HTTP acquisition providers retain
their own administrator-configured source policies; no private integration is
enabled merely by a client-supplied provider name.

**Downstream SSRF limitation:** MusicDeck validates input URLs, not every network
request made by SpotDL/yt-dlp. Provider redirects, DNS answers, CDN requests, and
artwork retrieval happen inside downstream tools and were not dynamically
certified as SSRF-safe. Keep these tools current and apply host/container egress
rules that deny loopback, link-local/cloud-metadata, and untrusted private-network
destinations for downloader traffic. Preserve explicit trusted connectivity to
configured Navidrome/Jellyfin services; do not globally break legitimate private
media integrations. Use a dedicated downloader network policy or network
namespace where distinct egress rules are necessary.

The current frontend polls acquisition status and does not open acquisition
EventSources, so SSE throttling does not add frontend reconnect loops. Custom SSE
clients should back off on 429 and reconnect only after capacity is available.
Streams also revalidate their original session before sending frames and every
five seconds while idle. In-process logout, password resets, account disabling,
and role changes trigger immediate rechecks. A stream opened as administrator
is closed on demotion rather than retaining cross-user visibility.

## Database and credential-file protections

Provider credentials remain in SQLite in their existing format. API redaction
is not encryption: treat the database, SQLite sidecars, backups, `.env`, and
Docker configuration volumes as secret-bearing files.

For native POSIX deployments, run MusicDeck under a dedicated non-root account.
New database directories request mode `0700`; new database files request `0600`
**before** SQLite opens them. At startup, existing service-owned database,
`-wal`, `-shm`, and `-journal` files with group/other permissions are tightened
to `0600` where supported. SQLite uses the database mode for new sidecars.
Database-file symbolic links are rejected; point `MUSICDECK_DB_PATH` at the
actual regular file instead. Existing directory permissions and file ownership
are not automatically changed by the application.

Warnings appear in **Admin > Logs** when an existing directory permits
group/other access, an unsafe file belongs to another account, or the filesystem
cannot enforce the requested file mode. Correct the specific host path after
checking its owner, ACLs, and whether other services legitimately use it.
Do not recursively chmod/chown a music library, shared host directory, or volume
root just to silence a warning. Put the MusicDeck database in its own directory.
POSIX extended/default ACLs can grant access beyond mode bits; review them too.

The Docker image seeds `/app/data` with mode `0700`, and the entrypoint uses
`umask 077` for newly created runtime files. Named volumes created from this image
inherit the seeded directory; **existing named volumes and bind mounts do not
necessarily inherit image permissions**. Keep the configured `PUID`/`PGID`
compatible with the existing service-owned files. The entrypoint's existing
ownership setup still applies to its managed runtime volumes; mount dedicated
MusicDeck directories, not shared or arbitrary host trees.

On Windows, Node's POSIX mode bits do **not** establish or verify NTFS ACL
isolation. A startup warning requests host ACL review: grant the service account
the required modify/read/write access and remove access for untrusted users.
Keep required administrator/SYSTEM access. Audit inherited ACLs with the Windows
Security UI or `icacls`, including the database directory and backup destination;
do not blindly copy ACL commands between hosts. Docker Desktop bind mounts,
SMB/NFS/CIFS, FAT/exFAT, NAS ACLs, and root-squashed mounts may not honor `0600`.
Use host ACLs or a private local Docker volume/filesystem when Unix modes are
ineffective. Application startup compatibility does not prove access isolation.

Administrator password resets and account disabling delete all existing
sessions atomically with the account change. Re-enabling requires a fresh login.
Self-service password changes retain the current session and revoke other
sessions. Stream authorization notifications are process-local; other processes
or direct database edits are detected before the next frame or within the
five-second idle check. No session expiration duration was changed.

MusicDeck supports direct access on a trusted LAN and the recommended HTTPS
reverse-proxy deployment. The downloaded `.env.example` explicitly enables
HTTP LAN onboarding for MusicDeck. The bundled backend setup pages are
published on the Docker host's loopback interface. HTTPS deployment:

```text
Browser
  -> https://music.example.com
  -> TLS reverse proxy
  -> MusicDeck Web container (nginx)
     -> /api proxy  -> MusicDeck Server container
     -> /api/v1/remote WebSocket -> MusicDeck Server container (device control)
  -> MusicDeck Server container
     -> selected backend container (internal API): Navidrome OR Jellyfin
```

Every device on your network talks to MusicDeck on **one origin**
(`MUSICDECK_PUBLIC_URL`). MusicDeck Server talks to the backend internally
over the Docker network. Direct backend setup/admin pages use the separately
published loopback ports. Normal MusicDeck playback uses only the MusicDeck
origin.

MusicDeck runs **exactly one** backend, chosen with `MUSIC_BACKEND`
(`navidrome` or `jellyfin`). The unused backend container is never created.

## Prerequisites

- Docker Engine 28.0.0 or newer (or Docker Desktop with that engine) with Compose
- A folder containing your music files
- A text editor

You do **not** need the MusicDeck source repository, and you do **not** need
Node.js, Python, FFmpeg, Deno, or spotDL installed on the host — the published
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
(see "Local development" below), which needs `server-rust/Dockerfile`,
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
MUSICDECK_PUBLIC_URL=https://music.example.com
MUSICDECK_SESSION_SECRET=replace-with-a-long-random-secret
MUSICDECK_ADMIN_USERNAME=admin
MUSICDECK_ADMIN_PASSWORD=change-this-admin-password
PUID=1000
PGID=1000
MUSIC_ROOT=/media/music

# Required only when MUSIC_BACKEND=navidrome
NAVIDROME_USERNAME=admin
NAVIDROME_PASSWORD=change-this-navidrome-password

# Required only when MUSIC_BACKEND=jellyfin
JELLYFIN_API_KEY=your-jellyfin-api-key
```

Set `MUSICDECK_PUBLIC_URL` to the exact URL your LAN browser will use (for
example, `http://192.168.1.50:8080`). For HTTP on a trusted LAN, the template
sets `MUSICDECK_WEB_BIND=0.0.0.0` and `MUSICDECK_SECURE_COOKIES=false`;
prefer replacing bind addresses with the host's specific LAN IP and
restricting published ports to trusted source networks. HTTP is not encrypted.
For HTTPS through a same-host TLS proxy, use an HTTPS public URL,
`MUSICDECK_WEB_BIND=127.0.0.1`, and `MUSICDECK_SECURE_COOKIES=true`.
`docker compose up` intentionally
fails fast with a clear error if `MUSICDECK_PUBLIC_URL`,
`MUSICDECK_SESSION_SECRET`, `MUSICDECK_ADMIN_PASSWORD`, or `MUSIC_ROOT` are
missing — there is no silent `localhost` fallback in production.
`MUSICDECK_CORS_ORIGIN` defaults to `MUSICDECK_PUBLIC_URL` if not set
separately. The server additionally validates, at startup, that the selected
backend's own credentials are present.

Leave `COMPOSE_PROFILES=${MUSIC_BACKEND}` in `.env` exactly as shipped — it is
what makes Compose start only the backend you selected.

`MUSIC_ROOT` must be an absolute path that already exists on the Docker host
and is writable by `PUID:PGID`. On most Linux hosts, set these to the account
that owns the library (`id -u` and `id -g`). If needed, fix an existing
library's ownership before startup:

```bash
sudo chown -R "$(id -u):$(id -g)" /media/music
```

MusicDeck uses root only for container initialization, then immediately drops
to `PUID:PGID` before starting Node. It never runs the application or
downloader as root. Startup fails with an ownership/mode diagnostic when the
configured identity cannot write to the music root, rather than allowing a
later download to fail with `EACCES`.

After changing `PUID`, `PGID`, or host ownership, recreate the server:

```bash
docker compose up -d --force-recreate musicdeck-server
```

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

Open MusicDeck from your other LAN device using `MUSICDECK_PUBLIC_URL`:

```text
http://SERVER_IP:8080
```

If you selected `MUSIC_BACKEND=navidrome`, open Navidrome on the Docker host
for initial setup and service-account creation:

```text
http://127.0.0.1:4533
```

After Navidrome has a user matching `NAVIDROME_USERNAME` and
`NAVIDROME_PASSWORD`, MusicDeck Server can use it as the backend service
account.

If you selected `MUSIC_BACKEND=jellyfin`, open Jellyfin on the Docker host
to complete its first-run wizard:

```text
http://127.0.0.1:8096
```

Create an API key under **Dashboard → API Keys**, set `JELLYFIN_API_KEY` in
`.env`, then `docker compose up -d` again.

For Jellyfin, start just that backend first with
`docker compose up -d jellyfin`, complete the wizard, then set the API key
before starting the full stack.

## Backend bindings and network restrictions

Production Compose fixes both backend host bindings to `127.0.0.1`.
Docker Engine releases older than 28.0.0 can allow hosts on the same network
segment to reach loopback-published ports. See the [Docker port publishing
documentation](https://docs.docker.com/engine/network/port-publishing/).

For remote setup, forward the selected backend port through SSH, then open
the corresponding `127.0.0.1` URL above in your local browser. Replace
`user@SERVER_IP` with your SSH login and run the command for your backend.

```bash
# Navidrome
ssh -N -L 127.0.0.1:4533:127.0.0.1:4533 user@SERVER_IP
# Jellyfin
ssh -N -L 127.0.0.1:8096:127.0.0.1:8096 user@SERVER_IP
```

Existing `NAVIDROME_PORT` and `JELLYFIN_PORT` remain numeric host-port
overrides. Use the configured host port in the browser and SSH command if
you change it. Recreate the selected backend after changes with
`docker compose up -d navidrome` or `docker compose up -d jellyfin`.

Internal Docker URLs/ports are unchanged; MusicDeck does not use published
host ports to contact its backend. For an externally hosted backend, set
`NAVIDROME_URL` or `JELLYFIN_URL` and the corresponding credentials, keep
`MUSIC_BACKEND` selected, and remove/comment the `COMPOSE_PROFILES` assignment
so no bundled backend starts. Use a restricted private route or HTTPS where
appropriate; do not expose backend administration merely for MusicDeck access.

## HTTPS access

Without the onboarding template's explicit HTTP overrides, production
cookies are secure by default and the web port binds to loopback. For HTTPS,
do not expose MusicDeck's cleartext container port to browsers: set
`MUSICDECK_WEB_BIND=127.0.0.1` so a TLS-terminating
reverse proxy on the same host can reach it without publishing cleartext
access to the LAN. If the TLS proxy runs in another container or host, set
`MUSICDECK_WEB_BIND` to an address reachable by that proxy and restrict the
port with firewall rules or a private container network.

Configure the reverse proxy to terminate TLS, forward the original
`X-Forwarded-Proto: https` header to MusicDeck Web, and send HSTS to clients.
`webapp/nginx.conf` forwards the HTTPS scheme to MusicDeck Server and adds
browser hardening headers (CSP, `X-Content-Type-Options`, referrer policy,
and clickjacking protection). HSTS should be emitted by the external TLS
proxy, not this internal HTTP container. `MUSICDECK_PUBLIC_URL` must be the exact HTTPS origin
that browsers use; `MUSICDECK_CORS_ORIGIN` defaults to it.

Because the React client only ever calls same-origin relative `/api/...`
paths (proxied by nginx), there is no separate frontend build step or extra
environment variable needed for the API URL — whatever host/IP the browser
uses to load the page is the host/IP it will use for API calls
automatically. Remote device control uses a same-origin WebSocket at
`/api/v1/remote`. `webapp/nginx.conf` forwards HTTP/1.1 `Upgrade` and
`Connection: upgrade` headers for that exact path with a one-hour read timeout.
Any outer reverse proxy must forward these upgrades too. Use `wss:` behind
HTTPS and preserve the browser's `Origin`; the hub accepts only the exact
configured `MUSICDECK_PUBLIC_URL` / `MUSICDECK_CORS_ORIGIN` origins and the
normal session cookie. No token belongs in the WebSocket URL.

The development Compose stack is intended for local development only and
defaults secure cookies off for its HTTP URL. Never expose it to an untrusted
network.

Google Cast receivers need direct access to the configured
`MUSICDECK_PUBLIC_URL`, normally HTTPS with a receiver-trusted certificate.
Browser-only SSO/VPN access is not sufficient. The supplied nginx disables
access logging for the track-capability stream path; outer proxies must also
redact its `token` query parameter and disable caching. Cast loads Google's SDK
only after user consent and is blocked by Local-Only mode. See
[Google Cast deployment and capability security](google-cast.md).

## Services

### musicdeck-web

Serves the prebuilt React app with nginx. HTTPS reverse-proxy access is
recommended; explicit HTTP LAN mode is supported only on trusted networks.

- Image: `ghcr.io/userphase/musicdeck-web`
- Host binding: `127.0.0.1:${MUSICDECK_WEB_PORT:-8080}` by default; use
  `MUSICDECK_WEB_BIND` for the intended LAN/proxy address. The onboarding
  template explicitly uses `0.0.0.0`.
- Proxies `/api/*` and `/ws/*` to `musicdeck-server:4534`
- Serves the React client without running the React development server

### musicdeck-server

Runs the compiled Rust MusicDeck API server (`musicdeck-server`).

- Image: `ghcr.io/userphase/musicdeck-server`
- Internal port: `4534` — never published to the host; only reachable from
  `musicdeck-web` over the internal Docker network
- Uses SQLite at `/app/data/musicdeck.sqlite`. The server applies pending SQL
  migrations to the mounted database before it starts serving requests. This
  runs automatically at container startup without an interactive migration step.
- File-backed databases use WAL with a five-second busy timeout. Keep the
  database on a writable local volume and run one MusicDeck server per database.
- Stores sessions, users, settings, favorites, recently played, and
  playlist ownership — all isolated per user (see "Multi-User Accounts")
- Reads the selected backend's credentials from environment variables
- Bundles the full acquisition runtime so the host needs nothing installed:
  Rust release binaries (`musicdeck-server`, `init_db`, `shrink_library`),
  Python 3, FFmpeg/ffprobe, Deno, and spotDL (in a dedicated virtualenv at
  `/opt/venv` aliased at `/opt/spotdl`). Automatic spotDL/yt-dlp/ytmusicapi updates are
  opt-in (`SPOTDL_AUTO_UPDATE=1`). The default (`0`) keeps startup reproducible
  by using the image-pinned versions unless you explicitly request a refresh.

### navidrome

Runs the Navidrome music backend. Started **only** when
`MUSIC_BACKEND=navidrome`.

- Internal URL used by MusicDeck Server: `http://navidrome:4533`
- Host port: `${NAVIDROME_PORT:-4533}`, bound to `127.0.0.1` for direct setup
  and administration
- Reads music from `MUSIC_ROOT` on the host, mounted read-only
- Stores its own database/config/cache in `NAVIDROME_DATA` on the host
  (optional; defaults to `./navidrome-data`)

### jellyfin

Runs the Jellyfin backend. Started **only** when `MUSIC_BACKEND=jellyfin`.

- Internal URL used by MusicDeck Server: `http://jellyfin:8096`
- Host port: `${JELLYFIN_PORT:-8096}`, bound to `127.0.0.1` for direct setup
  and administration, including API-key creation
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
Spotify playlist imports write `cover.jpg` and `folder.jpg` alongside each
album's downloaded audio before triggering the library rescan. MusicDeck must
have write access to those album directories, and Navidrome/Jellyfin must have
read and directory-traversal access. Artwork files are created with mode 0644;
existing covers are never overwritten. Folder-art failures appear as import
warnings and do not prevent importing the audio. Spotify cover metadata is
also retained in MusicDeck's SQLite data volume for missing-cover API fallback.
Imports completed before this feature need to be re-imported to populate
folder art and the new cache; existing audio is reused rather than replaced.

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
- `MUSICDECK_WEB_BIND` — production web port bind address; defaults to
  `127.0.0.1` for a same-host TLS proxy; the LAN onboarding template sets
  `0.0.0.0`. Prefer a specific host LAN IP for direct LAN access.
- `MUSICDECK_SECURE_COOKIES` — defaults to `true` in production Compose;
  the trusted-LAN HTTP template explicitly sets `false`. Set `true` for HTTPS.
- `MUSICDECK_PUBLIC_URL` — required, no `localhost` default in production
- `MUSICDECK_CORS_ORIGIN` — optional, defaults to `MUSICDECK_PUBLIC_URL`
- `MUSICDECK_SESSION_SECRET` — required
- `MUSICDECK_ADMIN_USERNAME`
- `MUSICDECK_ADMIN_PASSWORD` — required

Image selection:

- `MUSICDECK_VERSION` — image tag to run; defaults to the published commit tag
  `sha-752688b` in the provided compose file. Use a tag published for both the web
  and server images; the package version does not imply a published image release.
  Keep this pinned to an explicit release or commit tag for controlled rollback.
- `MUSICDECK_IMAGE_SERVER`, `MUSICDECK_IMAGE_WEB` — override only if you
  publish your own image builds.
- `NAVIDROME_IMAGE`, `JELLYFIN_IMAGE` — optional backend image references;
  keep explicit version tags (or digests) instead of mutable `latest`.

MusicDeck Server container also uses:

- `MUSICDECK_HOST=0.0.0.0`
- `MUSICDECK_PORT=4534`
- `MUSICDECK_DB_PATH=/app/data/musicdeck.sqlite`
- `MUSICDECK_MUSIC_ROOT`: folder where acquired/downloaded music is written. Must match the backend's scanned music folder (see "Persistent Volumes" above).

Navidrome backend connection (required when `MUSIC_BACKEND=navidrome`):

- `NAVIDROME_URL` — defaults to `http://navidrome:4533`; override for an external backend
- `NAVIDROME_USERNAME` — required for this backend
- `NAVIDROME_PASSWORD` — required for this backend
- `NAVIDROME_PORT` — optional host port for direct access
- `NAVIDROME_BIND` — development Compose only; production uses `127.0.0.1`
- `NAVIDROME_DATA` — optional host path, defaults to `./navidrome-data`

Jellyfin backend connection (required when `MUSIC_BACKEND=jellyfin`):

- `JELLYFIN_URL` — defaults to `http://jellyfin:8096`; override for an external backend
- `JELLYFIN_API_KEY` — required for this backend
- `JELLYFIN_PORT` — optional host port for direct access
- `JELLYFIN_BIND` — development Compose only; production uses `127.0.0.1`
- `JELLYFIN_CONFIG`, `JELLYFIN_CACHE` — optional host paths, default to
  `./jellyfin-config` and `./jellyfin-cache`

Music library:

- `MUSIC_ROOT` — required host path, mounted read-write into MusicDeck
  Server and read-only into Navidrome/Jellyfin

Secret file support exists for:

- `MUSICDECK_SESSION_SECRET_FILE`
- `NAVIDROME_PASSWORD_FILE`

Use secret files or your platform's secret manager for production where possible. Do not commit `.env`.

## Login limits and trusted proxies

| Variable | Default | Meaning |
|---|---:|---|
| `MUSICDECK_LOGIN_WINDOW_MS` | 900000 | Fixed window length (15 minutes) |
| `MUSICDECK_LOGIN_IP_MAX` | 20 | Admitted attempts per client IP/window |
| `MUSICDECK_LOGIN_ACCOUNT_MAX` | 10 | Admitted attempts per normalized username/window, across IPs |
| `MUSICDECK_LOGIN_MAX_CONCURRENT` | 4 | Global concurrent login work |
| `MUSICDECK_LOGIN_MAX_ENTRIES` | 10000 | Total retained IP + username buckets (minimum 2) |
| `MUSICDECK_TRUSTED_PROXIES` | empty | Comma-separated trusted proxy IP addresses/CIDRs |

All limits must be positive safe integers. Login returns generic `429` errors
with `Retry-After` when either budget, concurrency, or storage capacity is
exhausted. All admitted attempts count, including successes; successfully
logging in does not clear account/IP budgets. Username limiter keys are
trimmed, Unicode-normalized, lowercased, and hashed; actual case-sensitive
username lookup is unchanged. Thus distinct usernames differing only in
case/normalization intentionally share a budget. Restrictions expire without
permanent account lockouts. Idle entries are cleaned at least once per minute
(or once per shorter configured window); saturated storage rejects new
identifiers rather than evicting live limits.

Forwarding headers are **not trusted by default**. The immediate socket peer
is then the IP key, so users behind nginx or a shared NAT share that IP budget.
To use original client addresses behind a proxy, configure only the actual
trusted proxy IPs or narrowly scoped CIDRs. Do not use a proxy hop count,
`true`, or a blanket network. In Docker, use a controlled proxy address/network
and ensure untrusted containers cannot join it. If an outer TLS proxy is also
in the forwarding chain, trust only its actual address as needed. Proxies must
overwrite untrusted client headers or append the actual sender correctly;
test the resulting `request.ip` with your exact proxy chain. Never enable
forwarding trust on a directly accessible API without a restricted proxy path.

Limiter state is in memory **per server instance**. It resets on restart and
is not shared across replicas. These defaults target the single-instance
SQLite deployment. Multi-instance deployments need coordinated gateway or
shared rate limiting; also apply coarse network/edge limits for volumetric
traffic. Account budgets can temporarily deny a legitimate login during a
targeted attack; operators should tune for expected users behind shared IPs,
not disable protections. Global login concurrency bounds bcrypt work but does
not bound all Fastify sockets or traffic.

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
https://music.example.com/
https://music.example.com/api/*
```

nginx proxies `/api/*` (including WebSocket upgrades at `/api/v1/remote`) and
additional `/ws/*` integrations to the server internally. This avoids requiring
users to configure browser CORS for normal production deployments.

Local development is different: React's development server uses the `proxy` setting in `webapp/package.json` to reach `http://localhost:4534`.

## HTTPS / Reverse Proxy

HTTPS deployment uses a reverse proxy such as Caddy, Nginx, Traefik, or your
hosting provider's proxy. Without explicit LAN overrides, production Compose
defaults to `MUSICDECK_SECURE_COOKIES=true` and a loopback web binding. When
switching from the HTTP onboarding template, explicitly set
`MUSICDECK_SECURE_COOKIES=true` and `MUSICDECK_WEB_BIND=127.0.0.1`.

Recommended external shape:

```text
https://musicdeck.example.com (TLS termination + HSTS)
  -> http://127.0.0.1:8080 (musicdeck-web)
  -> /api proxy to musicdeck-server:4534
```

Set `MUSICDECK_PUBLIC_URL=https://musicdeck.example.com` and configure the TLS
proxy to forward `X-Forwarded-Proto: https`. Keep the web container's port
private and use a valid certificate; secure cookies do not protect
credentials sent over a publicly reachable HTTP endpoint.

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

Backups contain recoverable provider credentials and must have the **same access
restrictions as the live database**. On POSIX, create a dedicated service-owned
backup directory with `0700`, use `umask 077` before producing backups, and verify
backup files are `0600` (including archives and temporary snapshots). On Windows,
use a private destination with reviewed NTFS ACLs; on NAS/cloud storage, verify
the destination's ACLs and encryption separately. Never put database snapshots
under the web root, a publicly shared folder, or source control.

Do not copy only the main database from a running WAL database: committed data
may still be in `-wal`. Stop MusicDeck cleanly and copy the dedicated data
directory, including any remaining `-wal`/`-shm`/`-journal` files, or use SQLite's
consistent online backup API/tool under a restricted account. Keep backup ACLs
private during transfer and restoration, not only afterward. Apply an explicit
backup retention policy; protect and remove obsolete snapshots through the
backup system. Restore into a dedicated directory with the intended service
account's ownership and private permissions before starting MusicDeck, and test
that the restored database can be read/written.

## Updating

Production (prebuilt GHCR images):

```bash
docker compose pull
docker compose up -d
```

Update `MUSICDECK_VERSION`, `NAVIDROME_IMAGE`, and `JELLYFIN_IMAGE` explicitly
when you want new images. This keeps upgrades and rollbacks reviewable instead
of silently tracking mutable tags.

Developer source builds:

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

## Development Workflow

Run services directly while developing:

```powershell
cd server-rust
cargo run --bin musicdeck-server
```

```powershell
cd webapp
npm install
npm start
```

React development uses `http://localhost:3000` and proxies `/api/*` to `http://localhost:4534`.

Note: the Docker image bundles Python, FFmpeg, Deno, and spotDL, but a bare
`cargo run` on the host does not. To exercise the acquisition/downloader
pipeline locally you must install `python3`, `ffmpeg`, `deno`, and `spotdl` yourself,
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

Admins can read the most recent 1,000 server log lines live under
**Admin → Server → Logs**. The viewer has level filters, search, pause,
copy and export, and secrets are redacted. The buffer is held in memory and
resets on restart. For full history, use the container output:

```bash
docker compose logs musicdeck-server
docker compose logs musicdeck-web
docker compose logs "$MUSIC_BACKEND"
```

Library scans:

Under **Admin → Server → General** you can schedule automatic library scans
(Disabled, Daily or Weekly at a chosen time) or run one immediately with
**Scan library now**. Changes apply without a restart. Scheduled times use the
MusicDeck server's time zone, which is shown next to the schedule. In Docker
this is UTC unless you set `TZ` (for example `TZ=Europe/Amsterdam`) on the
`musicdeck-server` service.

Common startup issues:

- `unable to prepare context: path ".../server-rust" not found`: you are using a
  build-based compose file without a source checkout. Production installs must
  use `docker-compose.yml` (prebuilt GHCR images); `docker-compose.dev.yml` is
  the only file that builds from `./server-rust` and `./webapp`.
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
- `spotdl: not found`, missing Deno, or FFmpeg errors during acquisition:
  expected only for local `npm run dev` runs. The Docker image bundles all
  three; verify inside the container with `docker exec musicdeck-server
  spotdl --version`, `docker exec musicdeck-server ffmpeg -version`, and
  `docker exec musicdeck-server python -c "from spotdl.utils.deno import
  is_deno_installed; print(is_deno_installed())"`.

MusicDeck does not log Navidrome passwords, session secrets, tokens, or authenticated URLs.

## Playback loudness

In **Settings → Audio & Playback**, enable **Volume Normalization** and choose
**−18 LUFS**, **−16 LUFS** (default), or **−14 LUFS**, then save your settings.
The target belongs to each user's account. Measurements are shared, while gain
is applied during that user's playback; original music files stay unchanged.
Peak protection may keep very dynamic tracks below the selected target.

**Scan all tracks** prepares an existing library in the background, prioritising
the requesting user's listening history, then their playlists, then other tracks.
It shows progress, reuses valid measurements, and resumes after a server restart.
Run it again to retry failed tracks or pick up a reconnected library source.
New downloads are analysed automatically, so this button is optional for those.
Analysis uses the configured FFmpeg executable and does not block playback.

For **Automatic Silence Trimming**, **Analyze all tracks** sits beside
**Re-analyze current track**. It runs its own background scan with the same
listening-history and playlist priorities, progress tracking and restart recovery.
Enable silence trimming to use it. The scan uses the threshold and minimum silence
duration currently shown in Settings; those settings stay fixed for that scan.
Matching saved results are reused. Change the settings and run another scan to
prepare a different trimming profile. Original audio files stay unchanged.

### Local-only operation

In Settings, **Privacy & External Integrations** lets administrators disable
external discovery, spotDL imports and external artwork globally. Other accounts
can view the policy but cannot change it. Changes are enforced immediately by
the server; clients synchronize within five seconds or when their window gains
focus. Active affected transfers are aborted and managed downloader workers
are stopped before the settings update completes. Stored granular permissions
are preserved while the master switch is enabled.

For an environment-enforced restriction, set `LOCAL_ONLY_MODE=true` (or `1`)
before starting MusicDeck. Both Compose configurations pass this variable to
the server. `false`/`0` leave the persisted policy in control; invalid values
refuse startup. The environment lock cannot be disabled from Settings.

Configured Navidrome/Jellyfin origins and base paths remain reachable, including
native artwork and streaming. Other private-network endpoints are not implicitly
trusted. Redirects to nonconfigured origins are blocked in Local-Only Mode.
Imports are unavailable if either metadata or artwork permission is disabled:
spotDL performs its own nested requests, which cannot be filtered individually.

This gate covers MusicDeck-managed transports and downloader processes. It is
not an OS-level air-gap guarantee: independent processes, operator-supplied
browser resources, arbitrary third-party code and the configured media server's
own outbound integrations are outside its control. For a strict no-WAN
deployment, also enforce host/container egress firewall rules and disable
external integrations on Navidrome/Jellyfin. Allow only your required library
destinations and keep DNS/network access restricted at the infrastructure layer.

### PWA installation and offline shell

Production web builds emit `service-worker.js` and a MusicDeck manifest with
192px/512px installation icons. Serve the app and worker from the same HTTPS
origin (localhost is also a secure context); registration is disabled in the
development server. Do not rewrite `service-worker.js` to SPA HTML, and serve it
with a JavaScript content type and revalidation/no-cache rather than an immutable
long-lived cache. Hashed static assets may use immutable caching. Keep the worker
and app within the same deployment scope; cross-origin `PUBLIC_URL` cannot
register a worker.

Open the production app online once and allow the worker's asset installation
to finish before testing an offline deep-link reload. Cached shell loading is
not offline authentication: sign-in and library API requests still require the
server. The offline banner states this limitation explicitly. Existing tabs keep
their current worker until closed, preserving active playback during updates.

The browser owns storage quota and may evict even explicit audio downloads.
Settings → Offline Storage distinguishes origin usage/quota, audio records,
artwork cleanup and catalog/obsolete web-cache cleanup. Cache cleanup never deletes the
current shell or explicit downloads; confirmed audio removal clears IndexedDB
records rather than deleting an open database. No server library files,
preferences or authentication cookies are removed by these controls.

### Optional trusted server extensions

The server image discovers reviewed extension folders under `/extensions`
(`./extensions` for direct Node deployments); `MUSICDECK_EXTENSIONS_DIR` overrides
the path. Mount this directory read-only and keep it readable by the MusicDeck
runtime user. Admin > Plugins > Server extensions can scan new installations and
hot-toggle lifecycle hooks without a container restart. Updating code already
discovered requires a restart.

Extensions are executable server code, not sandboxed catalog manifests.
Only enable audited code; use separate services for heavy compute and container
egress policy for strict privacy enforcement. See
[the installation guide and complete hook contract](server-extensions.md).
