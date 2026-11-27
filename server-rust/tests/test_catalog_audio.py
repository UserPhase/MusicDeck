import io
import json
import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from mutagen.mp4 import MP4


BRIDGE = Path(__file__).resolve().parents[1] / "src" / "acquisition" / "catalog_audio.py"


class CatalogAudioTests(unittest.TestCase):
    def test_album_candidates_keep_the_rust_bridge_fields(self):
        output = io.StringIO()
        with patch("ytmusicapi.YTMusic", autospec=True) as client:
            yt = client.return_value
            yt.search.return_value = [{
                "browseId": "MPREfixture",
                "title": "Test Album",
                "artists": [{"name": "Test Artist"}],
            }]
            yt.get_album.return_value = {
                "title": "Test Album",
                "year": 2026,
                "tracks": [
                    {
                        "videoId": "abcdefghijk",
                        "title": "Test Track",
                        "artists": [{"name": "Test Artist"}],
                        "duration": "3:35",
                        "isExplicit": False,
                    },
                    {"videoId": "unavailable", "isAvailable": False},
                ],
            }
            with patch.object(sys, "argv", [str(BRIDGE), "album", "Test Artist", "Test Album", ""]):
                with redirect_stdout(output):
                    runpy.run_path(str(BRIDGE), run_name="__main__")
            yt.search.assert_called_once_with("Test Artist Test Album", filter="albums", limit=8)
            yt.get_album.assert_called_once_with("MPREfixture")

        self.assertEqual(json.loads(output.getvalue()), {"tracks": [{
            "video_id": "abcdefghijk", "title": "Test Track", "artists": ["Test Artist"],
            "album": "Test Album", "year": "2026", "duration": 215, "explicit": False,
        }]})

    def test_tagged_m4a_preserves_duration_and_recording_identity(self):
        metadata = {
            "url": "https://www.deezer.com/track/123",
            "title": "Test Track", "isrc": "USAAA2600001", "track_number": 2,
        }
        ffmpeg = os.getenv("FFMPEG_PATH", "ffmpeg")
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "audio.m4a"
            subprocess.run([
                ffmpeg, "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                "-t", "1", "-c:a", "aac", str(audio),
            ], check=True, timeout=15)
            duration = MP4(audio).info.length
            self.assertGreater(duration, 0)
            subprocess.run([
                sys.executable, str(BRIDGE), "tag", str(audio), json.dumps(metadata), "",
            ], check=True, timeout=15)
            tagged = MP4(audio)
            self.assertEqual(tagged.info.length, duration)
            self.assertEqual(tagged.tags["\xa9nam"], [metadata["title"]])
            self.assertEqual(tagged.tags["----:spotdl:WOAS"], [metadata["url"].encode("utf-8")])
            self.assertEqual(tagged.tags["----:spotdl:ISRC"], [metadata["isrc"].encode("utf-8")])
            self.assertEqual(tagged.tags["trkn"], [(2, 0)])
