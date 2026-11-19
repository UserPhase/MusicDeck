"""Exercise the production gateway against an isolated Subsonic media fixture."""
import base64
import concurrent.futures
from contextlib import closing
import datetime
import hashlib
import http.client
import json
import os
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

MEDIA = bytes(range(256)) * 256
ETAG = '"fixture-v1"'
TRACK_IDS = ("normal", "stall", "truncated", "mismatch")


class Provider(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path != "/rest/stream.view":
            body = json.dumps({"subsonic-response": {"status": "ok", "version": "1.16.1"}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        track = parse_qs(url.query)["id"][0]
        if track == "stall":
            time.sleep(20)
            self.close_connection = True
            return

        size = len(MEDIA)
        requested = self.headers.get("Range")
        if_range = self.headers.get("If-Range")
        status, first, last = 200, 0, size - 1
        if requested and (if_range is None or if_range == ETAG):
            start, end = requested.removeprefix("bytes=").split("-", 1)
            first = int(start) if start else max(0, size - int(end))
            last = min(int(end), size - 1) if start and end else size - 1
            status = 206 if first <= last else 416

        if track == "mismatch":
            first += 1

        self.send_response(status)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", ETAG)
        if status == 416:
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if status == 206:
            self.send_header("Content-Range", f"bytes {first}-{last}/{size}")
        self.send_header("Content-Length", str(last - first + 1))
        self.end_headers()
        try:
            if track == "truncated":
                self.wfile.write(MEDIA[first:first + 1024])
                self.wfile.flush()
                time.sleep(0.25)
                self.close_connection = True
            else:
                self.wfile.write(MEDIA[first:last + 1])
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True


def seed(database):
    with closing(sqlite3.connect(database)) as db, db:
        (provider,) = db.execute(
            "SELECT id FROM backend_connections WHERE enabled = 1 AND type = 'navidrome'"
        ).fetchone()
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        for track in TRACK_IDS:
            db.execute(
                "INSERT INTO library_items (id, type, created_at, updated_at) VALUES (?, 'track', ?, ?)",
                (f"md_{track}", now, now),
            )
            db.execute(
                """INSERT INTO library_item_sources
                   (library_item_id, connection_id, provider_item_id, item_type, created_at)
                   VALUES (?, ?, ?, 'track', ?)""",
                (f"md_{track}", provider, track, now),
            )


def send_ws_frame(conn, opcode, payload):
    mask = os.urandom(4)
    size = len(payload)
    length = bytes((size | 0x80,)) if size < 126 else b"\xfe" + size.to_bytes(2, "big")
    conn.send(bytes((0x80 | opcode,)) + length + mask
              + bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload)))


def read_ws_message(conn, stream):
    while True:
        header = stream.read(2)
        assert len(header) == 2, "WebSocket closed while writes were in flight"
        first, second = header
        assert first & 0x80 and not second & 0x80, header
        size = second & 0x7F
        if size >= 126:
            size = int.from_bytes(stream.read(2 if size == 126 else 8), "big")
        payload = stream.read(size)
        assert len(payload) == size, "Truncated WebSocket frame"
        opcode = first & 0xF
        if opcode == 0x9:
            send_ws_frame(conn, 0xA, payload)
        else:
            assert opcode == 0x1, (opcode, payload[:120])
            return json.loads(payload)


def verify(connect_url, browser_origin=None):
    target = urlsplit(connect_url)
    origin = browser_origin or connect_url
    browser_host = urlsplit(origin).netloc
    cookie = None

    def request(method, path, *, payload=None, headers=None, expected=200):
        conn = http.client.HTTPConnection(target.hostname, target.port, timeout=11)
        request_headers = {"Origin": origin, "Host": browser_host, **(headers or {})}
        if cookie:
            request_headers["Cookie"] = cookie
        if payload is not None:
            request_headers["Content-Type"] = "application/json"
        try:
            conn.request(method, path, None if payload is None else json.dumps(payload), request_headers)
            response = conn.getresponse()
            body = response.read()
            assert response.status == expected, (method, path, response.status, body[:300])
            return response, body
        finally:
            conn.close()

    response, body = request("POST", "/api/auth/login", payload={
        "username": "admin", "password": "ci-only-admin-password",
    })
    cookie = response.getheader("Set-Cookie").split(";", 1)[0]
    user = json.loads(body)["user"]["id"]

    track = {"id": "md_normal", "title": "Smoke track", "artist": "Fixture", "album": "Fixture"}
    queue = "/api/v1/user/queue-session"
    _, body = request("POST", f"{queue}/content?{urlencode({'ownerId': user})}", payload={
        "version": 2, "entries": [{"entryId": "smoke-occurrence", "track": track}],
    })
    content_id = json.loads(body)["contentId"]
    started = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1)).isoformat()
    all_workers_ready = threading.Barrier(10, timeout=10)
    stream = "/api/tracks/md_normal/stream?inspectionId=ci-smoke"

    def remote_playback():
        with closing(http.client.HTTPConnection(target.hostname, target.port, timeout=10)) as conn:
            key = base64.b64encode(os.urandom(16)).decode()
            conn.request("GET", "/api/v1/remote", headers={
                "Origin": origin, "Host": browser_host, "Cookie": cookie, "Connection": "Upgrade",
                "Upgrade": "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key,
            })
            with closing(conn.getresponse()) as response:
                assert response.status == 101, (response.status, response.read())
                digest = hashlib.sha1(f"{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11".encode()).digest()
                assert response.getheader("Sec-WebSocket-Accept") == base64.b64encode(digest).decode()
                send_ws_frame(conn, 0x1, json.dumps({
                    "type": "REGISTER", "device_id": "ci-player", "queue_device_id": "ci-player",
                    "device_name": "CI player", "device_type": "web", "can_receive": True,
                    "live_sync": True, "playback_lease": True, "playbackLeaseProtocol": 1,
                    "state": {"current_track": track, "playing": True, "position_ms": 0,
                              "duration_ms": 180000, "volume": 1},
                }).encode())
                while (message := read_ws_message(conn, response.fp))["type"] != "INITIAL_STATE":
                    assert message["type"] == "DEVICES", message
                assert message["state"]["is_playing"] and message["state"]["device_id"] == "ci-player"
                all_workers_ready.wait()
                changes = 0
                while changes < 3 * 12:
                    message = read_ws_message(conn, response.fp)
                    changes += message["type"] == "QUEUE_CHANGED"
                send_ws_frame(conn, 0x8, b"\x03\xe8")

    def queue_writes(device):
        all_workers_ready.wait()
        for sequence in range(1, 13):
            _, body = request("PUT", queue, payload={
                "ownerId": user, "deviceId": f"ci-device-{device}", "deviceName": f"CI {device}",
                "contentId": content_id, "sequence": sequence,
                "checkpoint": {"index": 0, "position": sequence, "repeatOne": False,
                               "shuffle": False, "shuffleMode": "standard", "albumAware": False,
                               "volume": 1, "wasPlaying": True, "capturedAt": int(time.time() * 1000)},
            })
            assert json.loads(body) == {"saved": True, "sequence": sequence}

    def listening_writes(device):
        all_workers_ready.wait()
        for seconds in range(1, 13):
            _, body = request("POST", "/api/listening-events", payload={
                "ownerUserId": user, "playbackSessionId": f"ci-listen-{device}", "trackId": track["id"],
                "startedAt": started, "listenedSeconds": seconds, "durationSeconds": 180,
                "finished": False, "track": {key: track[key] for key in ("title", "artist", "album")},
            })
            assert json.loads(body)["listenedSeconds"] == seconds

    def media_sessions():
        all_workers_ready.wait()
        for position in range(1, 13):
            _, body = request("POST", "/api/v1/user/media-sessions", payload={
                "type": "album", "mediaId": "ci-album", "title": "Fixture", "trackId": track["id"],
                "trackIndex": 0, "trackCount": 1, "positionSeconds": position, "durationSeconds": 180,
                "capturedAt": int(time.time() * 1000) + position,
            })
            assert json.loads(body)["checkpoint"]["positionSeconds"] == position
            request("GET", f"/api/v1/stream/inspect/{track['id']}?inspectionId=ci-smoke")

    def ranges():
        all_workers_ready.wait()
        for _ in range(6):
            _, body = request("GET", stream)
            assert body == MEDIA
            response, body = request("GET", stream, headers={"Range": "bytes=17-4095"}, expected=206)
            assert response.getheader("Content-Range") == f"bytes 17-4095/{len(MEDIA)}"
            assert body == MEDIA[17:4096]
            response, _ = request("GET", stream, headers={"Range": "bytes=999999-"}, expected=416)
            assert response.getheader("Content-Range") == f"bytes */{len(MEDIA)}"

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as workers:
        jobs = [workers.submit(queue_writes, i) for i in range(3)]
        jobs += [workers.submit(listening_writes, i) for i in range(3)]
        jobs += [workers.submit(ranges) for _ in range(2)]
        jobs += [workers.submit(media_sessions), workers.submit(remote_playback)]
        for job in jobs:
            job.result()

    response, body = request("GET", stream, headers={"Range": "bytes=17-", "If-Range": '"stale"'})
    assert response.getheader("Content-Range") is None and body == MEDIA
    request("GET", "/api/tracks/md_mismatch/stream", headers={"Range": "bytes=0-2047"}, expected=502)

    started_at = time.monotonic()
    request("GET", "/api/tracks/md_stall/stream", expected=502)
    elapsed = time.monotonic() - started_at
    assert 2 <= elapsed < 9, f"stalled upstream headers took {elapsed:.2f}s"

    conn = http.client.HTTPConnection(target.hostname, target.port, timeout=5)
    try:
        conn.request("GET", "/api/tracks/md_truncated/stream", headers={
            "Host": browser_host, "Cookie": cookie, "Range": "bytes=0-8191",
        })
        response = conn.getresponse()
        assert response.status == 206, response.status
        assert response.getheader("Content-Range") == f"bytes 0-8191/{len(MEDIA)}"
        try:
            response.read()
        except http.client.IncompleteRead as error:
            assert error.partial == MEDIA[:1024], len(error.partial)
        else:
            raise AssertionError("truncated upstream returned a complete response")
    finally:
        conn.close()
    request("GET", "/api/health")
    print("Gateway, WebSocket, concurrent playback writes, ranges, and upstream failures passed")


if __name__ == "__main__":
    operation = sys.argv[1]
    if operation == "provider":
        ThreadingHTTPServer(("0.0.0.0", 8090), Provider).serve_forever()
    elif operation == "seed":
        seed(sys.argv[2])
    elif operation == "verify":
        verify(sys.argv[2], *sys.argv[3:])
    else:
        raise ValueError(operation)
