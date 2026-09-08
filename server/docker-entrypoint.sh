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

mkdir -p /app/data /app/config /app/cache
chown -R "$PUID:$PGID" /app/data /app/config /app/cache

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
