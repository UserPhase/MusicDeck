import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from spotapi import PublicPlaylist
from spotapi.exceptions import PlaylistError
from spotdl.types.song import Song


BRIDGE_PATH = Path(__file__).resolve().parents[1] / "src" / "acquisition" / "spotify_playlist.py"
SPEC = importlib.util.spec_from_file_location("spotify_playlist", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


def track(uid):
    uri = "spotify:track:FixtureTrack"
    return {
        "uid": uid,
        "itemV2": {"data": {"uri": uri, "trackDuration": {"totalMilliseconds": 181750}}},
        "itemV3": {"data": {"uri": uri, "identityTrait": {
            "name": "Fixture Song", "contributors": {"items": [{"name": "Fixture Artist"}]},
        }}},
    }


class SpotifyPlaylistTests(unittest.TestCase):
    def test_reads_one_requested_page_and_keeps_every_position(self):
        payload = {"data": {"playlistV2": {"name": "Fixture", "revisionId": "revision-1", "content": {
            "totalCount": 760, "pagingInfo": {"offset": 399}, "items": [track("a"), None, track("b")],
        }}}}
        with patch.object(PublicPlaylist, "get_playlist_info", return_value=payload) as fetch:
            page = bridge.fetch_page("FixturePlaylist", 399, 101)["page"]
        fetch.assert_called_once_with(101, offset=399)
        self.assertEqual((page["offset"], page["total"], page["revision"]), (399, 760, "revision-1"))
        first, unavailable, repeated = page["items"]
        self.assertNotEqual(first["key"], repeated["key"])
        self.assertEqual(first["song"], repeated["song"])
        self.assertIsNone(unavailable["song"])
        song = Song.from_dict(first["song"])
        self.assertEqual(song.url, "https://open.spotify.com/track/FixtureTrack")
        self.assertEqual(song.duration, 181.75)
        self.assertIsNone(song.album_name)

    def test_preserves_retry_after_for_the_rust_worker(self):
        def throttled(playlist, _limit, *, offset):
            self.assertEqual(offset, 399)
            response = SimpleNamespace(status_code=429, headers={"Retry-After": "12"}, text="")
            playlist.base.client.parse_response(response, "POST", False)
            raise PlaylistError("Fixture throttle")

        with patch.object(PublicPlaylist, "get_playlist_info", throttled):
            self.assertEqual(bridge.fetch_page("FixturePlaylist", 399, 101),
                             {"error": "rate-limited", "retry_after": 12})
