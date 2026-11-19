#!/bin/sh
set -eu
umask 077

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
MUSIC_ROOT="${MUSICDECK_MUSIC_ROOT:-/music}"

# Standalone containers and other Compose services need a container-facing
# listener. Rust still honours an explicit bind address or host override.
if [ -z "${MUSICDECK_HOST:-}" ] && [ -z "${HOST:-}" ]; then
  export MUSICDECK_HOST=0.0.0.0
fi

case "$PUID" in
  ''|*[!0-9]*)
    echo "PUID and PGID must be positive numeric IDs (received PUID=$PUID PGID=$PGID)." >&2
    exit 1
    ;;
esac

case "$PGID" in
  ''|*[!0-9]*)
    echo "PUID and PGID must be positive numeric IDs (received PUID=$PUID PGID=$PGID)." >&2
    exit 1
    ;;
esac

if [ "$PUID" -eq 0 ] || [ "$PGID" -eq 0 ]; then
  echo "PUID and PGID must be non-zero so MusicDeck does not run as root." >&2
  exit 1
fi

groupmod --non-unique --gid "$PGID" musicdeck
usermod --non-unique --uid "$PUID" --gid "$PGID" musicdeck

mkdir -p /app/home /app/data /app/config /app/cache
chown -R "$PUID:$PGID" /app/home /app/data /app/config /app/cache
chmod 0700 /app/data

if [ -d /data ]; then
  chown -R "$PUID:$PGID" /data
  chmod 0700 /data
fi

# Refresh spotDL / yt-dlp / ytmusicapi at most once per 24h when SPOTDL_AUTO_UPDATE=1
if [ "${SPOTDL_AUTO_UPDATE:-0}" = "1" ]; then
  update_stamp=/app/cache/spotdl-last-update
  now="$(date +%s)"
  last_update=0
  if [ -r "$update_stamp" ]; then
    IFS= read -r last_update < "$update_stamp" || true
    case "$last_update" in
      ''|*[!0-9]*) last_update=0 ;;
    esac
  fi
  if [ "$now" -lt "$last_update" ] || [ "$((now - last_update))" -ge 86400 ]; then
    echo "Updating spotDL, yt-dlp and ytmusicapi (up to 60 seconds)..."
    if timeout -k 5s 60s "${SPOTDL_HOME:-/opt/venv}/bin/pip" install \
      --disable-pip-version-check --no-cache-dir --upgrade -r /app/requirements.txt; then
      echo "spotDL runtime update complete."
    else
      echo "spotDL update unavailable; checking the installed runtime before continuing." >&2
    fi
    if ! (printf '%s\n' "$now" > "$update_stamp" && chown "$PUID:$PGID" "$update_stamp"); then
      echo "Could not record the optional spotDL update check." >&2
    fi
  fi
fi

# Verify external media utilities under the target non-root identity
if ! timeout -k 1s 5s gosu musicdeck spotdl --version > /dev/null \
  || ! timeout -k 1s 5s gosu musicdeck python3 -c 'import yt_dlp, ytmusicapi, mutagen' \
  || ! timeout -k 1s 5s gosu musicdeck ffmpeg -version > /dev/null 2>&1; then
  echo "Degraded downloader capability: spotDL, yt-dlp, ytmusicapi, mutagen, or FFmpeg is unavailable." >&2
  export MUSICDECK_DOWNLOADER_HEALTH=degraded
elif ! timeout -k 1s 5s gosu musicdeck python3 -c 'from spotdl.utils.deno import is_deno_installed; raise SystemExit(0 if is_deno_installed() else 1)'; then
  echo "Deno is missing; restoring spotDL's local Deno runtime..."
  if ! timeout -k 5s 60s gosu musicdeck spotdl --download-deno; then
    echo "Degraded downloader capability: Deno could not be installed for YouTube downloads." >&2
    export MUSICDECK_DOWNLOADER_HEALTH=degraded
  fi
fi

if ! gosu musicdeck test -d "$MUSIC_ROOT" || ! gosu musicdeck test -w "$MUSIC_ROOT"; then
  export MUSICDECK_MUSIC_STORAGE_HEALTH=degraded
  owner="$(stat -c '%u:%g' "$MUSIC_ROOT" 2>/dev/null || echo unknown)"
  mode="$(stat -c '%a' "$MUSIC_ROOT" 2>/dev/null || echo unknown)"
  cat >&2 <<EOF
Degraded music storage capability: MusicDeck cannot write to $MUSIC_ROOT.
Container identity: $PUID:$PGID
Music directory:   owner=$owner mode=$mode

Set PUID and PGID in .env to the owner of MUSIC_ROOT, or update the host
directory permissions. See README.md section "Music folder permissions".
EOF
fi

# The server opens, migrates, and seeds SQLite itself before serving requests.
exec gosu musicdeck "$@"
