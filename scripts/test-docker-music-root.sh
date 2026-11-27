#!/usr/bin/env bash
set -euo pipefail

IMAGE="${MUSICDECK_TEST_IMAGE:-musicdeck-server:music-root-test}"
SERVER_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../server-rust" && pwd)"
PUID="${TEST_PUID:-$(id -u)}"
PGID="${TEST_PGID:-$(id -g)}"
WORK_DIR="$(mktemp -d)"
VOLUME_PREFIX="musicdeck-permissions-$RANDOM-$$"

cleanup() {
  docker volume rm \
    "${VOLUME_PREFIX}-data" \
    "${VOLUME_PREFIX}-config" \
    "${VOLUME_PREFIX}-cache" \
    >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

if [[ "$PUID" == "0" || "$PGID" == "0" ]]; then
  echo "Run this test as a non-root host user, or set non-zero TEST_PUID/TEST_PGID." >&2
  exit 1
fi

MUSIC_ROOT="$WORK_DIR/music"
ALBUM_DIR="$MUSIC_ROOT/Lana Del Rey/Born to Die_ The Paradise Edition"
TRACK_PATH="$ALBUM_DIR/Imported Track.mp3"

mkdir -p "$MUSIC_ROOT"
chmod 0755 "$MUSIC_ROOT"

docker volume create "${VOLUME_PREFIX}-data" >/dev/null
docker volume create "${VOLUME_PREFIX}-config" >/dev/null
docker volume create "${VOLUME_PREFIX}-cache" >/dev/null

docker run --rm \
  -e "PUID=$PUID" \
  -e "PGID=$PGID" \
  -e MUSICDECK_MUSIC_ROOT=/music \
  --mount "type=bind,src=$MUSIC_ROOT,dst=/music" \
  --mount "type=volume,src=${VOLUME_PREFIX}-data,dst=/app/data" \
  --mount "type=volume,src=${VOLUME_PREFIX}-config,dst=/app/config" \
  --mount "type=volume,src=${VOLUME_PREFIX}-cache,dst=/app/cache" \
  --mount "type=bind,src=$SERVER_DIR/tests,dst=/bridge/tests,readonly" \
  --mount "type=bind,src=$SERVER_DIR/src/acquisition,dst=/bridge/src/acquisition,readonly" \
  "$IMAGE" \
  sh -ec '
    test "$(id -u)" = "$PUID"
    test "$(id -g)" = "$PGID"
    test -w "$HOME"
    mkdir -p "$HOME/.cache"
    python3 --version
    spotdl --version
    yt-dlp --version
    python3 -m pip check
    ffmpeg -version
    ffprobe -version
    deno_version=$(deno --version)
    printf "%s\n" "$deno_version"
    dpkg --compare-versions "$(printf "%s\n" "$deno_version" | awk "NR == 1 {print \$2}")" ge 2.3.0
    deno eval "if (2 + 2 !== 4) Deno.exit(1)"
    python3 -B -m unittest discover -s /bridge/tests -p "test_*.py" -v
    mkdir -p "/music/Lana Del Rey/Born to Die_ The Paradise Edition"
    ffmpeg -loglevel error -f lavfi -i anullsrc=r=44100:cl=stereo -t 0.2 \
      -codec:a libmp3lame \
      "/music/Lana Del Rey/Born to Die_ The Paradise Edition/Imported Track.mp3"
    ffprobe -v error \
      "/music/Lana Del Rey/Born to Die_ The Paradise Edition/Imported Track.mp3"
    ffmpeg -v error -f lavfi -i anullsrc=r=44100:cl=stereo -t 1 -c:a aac \
      -movflags +empty_moov+frag_keyframe /tmp/fragmented.m4a
    duration=$(ffprobe -v error -select_streams a:0 -show_entries stream=duration \
      -of default=nw=1:nk=1 /tmp/fragmented.m4a)
    python3 -c "import sys; assert float(sys.argv[1]) > 0" "$duration"
    printf data > /app/data/write-test
    printf config > /app/config/write-test
    printf cache > /app/cache/write-test
  '

test -s "$TRACK_PATH"
test "$(stat -c '%u' "$TRACK_PATH")" = "$PUID"
test "$(stat -c '%g' "$TRACK_PATH")" = "$PGID"

# Model the selected Navidrome/Jellyfin mount: the backend can read the same
# imported file but cannot modify the shared library.
docker run --rm \
  --mount "type=bind,src=$MUSIC_ROOT,dst=/music,readonly" \
  alpine:3.20 \
  sh -c '
    test -r "/music/Lana Del Rey/Born to Die_ The Paradise Edition/Imported Track.mp3"
    if touch /music/backend-must-not-write 2>/dev/null; then
      echo "Read-only backend mount unexpectedly accepted a write." >&2
      exit 1
    fi
  '

echo "Music-root deployment test passed for runtime UID:GID $PUID:$PGID."
