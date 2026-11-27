"""Read a single public Spotify playlist page using spotDL's installed client stack."""

import hashlib
import json
import math
import re
import sys
from pathlib import Path


def mapping(value):
    return value if isinstance(value, dict) else {}


def playlist_item(item):
    from spotdl.types.song import Song

    item = mapping(item)
    v2 = mapping(mapping(item.get("itemV2")).get("data"))
    v3 = mapping(mapping(item.get("itemV3")).get("data"))
    identity = mapping(v3.get("identityTrait"))
    uri = v2.get("uri") or v3.get("uri") or ""
    key_data = [item.get("uid"), uri, item.get("addedAt")]
    key = hashlib.sha256(json.dumps(key_data, sort_keys=True).encode()).hexdigest()
    if not isinstance(uri, str) or not re.fullmatch(r"spotify:track:[A-Za-z0-9]{1,64}", uri):
        return {"key": key, "song": None}

    contributors = mapping(identity.get("contributors")).get("items") or []
    artists = [entry["name"] for entry in map(mapping, contributors)
               if isinstance(entry.get("name"), str) and entry["name"].strip()]
    duration = mapping(v2.get("trackDuration")).get("totalMilliseconds")
    title = identity.get("name") or v2.get("name")
    if (not isinstance(title, str) or not title.strip() or not artists
            or type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0):
        return {"key": key, "song": None}

    album = mapping(v2.get("albumOfTrack"))
    album_uri = album.get("uri") or ""
    isrc = mapping(v2.get("externalIds")).get("isrc")
    song_id = uri.removeprefix("spotify:track:")
    song = Song.from_missing_data(
        name=title, artist=artists[0], artists=artists, duration=duration / 1000,
        song_id=song_id, url=f"https://open.spotify.com/track/{song_id}",
        album_id=album_uri.removeprefix("spotify:album:") or None,
        album_name=album.get("name"), disc_number=v2.get("discNumber"),
        track_number=v2.get("trackNumber"), isrc=isrc or None,
        explicit=mapping(v2.get("contentRating")).get("label") == "EXPLICIT",
    )
    return {"key": key, "song": song.json}


def normalize_page(payload, offset):
    playlist = payload["data"]["playlistV2"]
    content = playlist["content"]
    items = content["items"]
    if not isinstance(items, list):
        raise ValueError("Invalid Spotify playlist items")
    revision = playlist.get("revisionId") or playlist.get("revision")
    reported_offset = mapping(content.get("pagingInfo")).get("offset")
    return {
        "offset": reported_offset if type(reported_offset) is int else offset,
        "total": content["totalCount"],
        "name": playlist.get("name"),
        "revision": revision if isinstance(revision, str) and revision else None,
        "items": [playlist_item(item) for item in items],
    }


def fetch_page(playlist_id, offset, limit):
    # Loading the same Spotify wrapper as spotDL initializes its public client configuration.
    from spotdl.utils.spotify import SpotifyClient  # noqa: F401
    from spotapi import PublicPlaylist
    from spotapi.exceptions import BaseClientError, PlaylistError, RequestError
    from spotapi.http.request import TLSClient

    class PageClient(TLSClient):
        failure = None

        def parse_response(self, response, method, danger):
            self.failure = None
            if response.status_code >= 400:
                self.failure = (response.status_code, response.headers.get("Retry-After", ""))
            return super().parse_response(response, method, danger)

    client = PageClient("chrome120", "", auto_retries=0)
    try:
        payload = PublicPlaylist(playlist_id, client=client).get_playlist_info(limit, offset=offset)
        return {"page": normalize_page(payload, offset)}
    except (BaseClientError, PlaylistError, RequestError, KeyError, TypeError, ValueError) as error:
        status, retry_after = client.failure or (0, "")
        if status == 429:
            seconds = None
            if retry_after.isascii() and retry_after.isdecimal() and len(retry_after) <= 8:
                seconds = int(retry_after)
            return {"error": "rate-limited", "retry_after": seconds}
        if status >= 500 or status == 408 or isinstance(error, RequestError):
            return {"error": "provider-network"}
        if status in (401, 403, 404):
            return {"error": "playlist-unavailable"}
        return {"error": "invalid-page"}
    finally:
        client.close()


if __name__ == "__main__":
    command, playlist_id, offset, limit, output = sys.argv[1:]
    if command != "spotify-playlist-page" or not re.fullmatch(r"[A-Za-z0-9]{1,64}", playlist_id):
        raise SystemExit("Invalid playlist page request")
    result = fetch_page(playlist_id, int(offset), int(limit))
    Path(output).write_text(json.dumps(result, allow_nan=False), encoding="utf-8")
