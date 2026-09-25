#!/bin/sh
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
MUSIC_ROOT="${MUSICDECK_MUSIC_ROOT:-/music}"

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

# YouTube extractors change frequently. Refresh at most once per day on
# container startup; keep the image's working packages if the update service
# is offline or slow. Set SPOTDL_AUTO_UPDATE=0 for fully fixed deployments.
if [ "${SPOTDL_AUTO_UPDATE:-1}" = "1" ]; then
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
    if timeout -k 5s 60s "${SPOTDL_HOME}/bin/pip" install \
      --disable-pip-version-check --no-cache-dir --upgrade -r /app/requirements.txt; then
      echo "spotDL runtime update complete."
    else
      echo "spotDL update unavailable; checking the installed runtime before continuing." >&2
    fi
    printf '%s\n' "$now" > "$update_stamp"
  fi
fi

if ! gosu musicdeck spotdl --version > /dev/null \
  || ! gosu musicdeck python -c 'import yt_dlp, ytmusicapi' \
  || ! gosu musicdeck ffmpeg -version > /dev/null 2>&1; then
  echo "spotDL, yt-dlp, ytmusicapi, or FFmpeg is unavailable in the server container." >&2
  exit 1
fi

if ! gosu musicdeck python -c 'from spotdl.utils.deno import is_deno_installed; raise SystemExit(0 if is_deno_installed() else 1)'; then
  echo "Deno is missing; restoring spotDL's local Deno runtime..."
  if ! timeout -k 5s 60s gosu musicdeck spotdl --download-deno; then
    echo "Deno could not be installed; YouTube downloads would fail." >&2
    exit 1
  fi
fi

if [ -d "$MUSIC_ROOT" ] && ! gosu musicdeck test -w "$MUSIC_ROOT"; then
  owner="$(stat -c '%u:%g' "$MUSIC_ROOT" 2>/dev/null || echo unknown)"
  mode="$(stat -c '%a' "$MUSIC_ROOT" 2>/dev/null || echo unknown)"
  cat >&2 <<EOF
MusicDeck cannot write to $MUSIC_ROOT.
Container identity: $PUID:$PGID
Music directory:   owner=$owner mode=$mode

Set PUID and PGID in .env to the owner of MUSIC_ROOT, or update the host
directory permissions. See README.md section "Music folder permissions".
EOF
  exit 1
fi

exec gosu musicdeck "$@"
