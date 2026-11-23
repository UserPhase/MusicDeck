"""YouTube Music and audio tagging bindings for the Rust acquisition worker."""

import base64
import json
import sys
import unicodedata
from pathlib import Path


def key(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text).lower() if c.isalnum())


def artists(item):
    return [a["name"] for a in (item.get("artists") or []) if a.get("name")]


def seconds(song):
    duration = song.get("duration_seconds")
    if duration is not None:
        return duration
    parts = (song.get("duration") or "").split(":")
    if len(parts) in (2, 3) and all(part.isdecimal() for part in parts):
        return sum(int(part) * 60 ** index for index, part in enumerate(reversed(parts)))
    return None


def candidates(mode, artist, album, title):
    from ytmusicapi import YTMusic

    yt = YTMusic()
    if mode == "album":
        releases = yt.search(f"{artist} {album}", filter="albums", limit=8)
        matching = {
            r["browseId"] for r in releases
            if r.get("browseId", "").startswith("MPRE")
            and key(r.get("title", "")) == key(album)
            and any(key(name) == key(artist) for name in artists(r))
        }
        if len(matching) > 3:
            return {"ambiguous": True}
        rows = []
        for browse_id in sorted(matching):
            release = yt.get_album(browse_id)
            if len(release.get("tracks") or []) > 100:
                continue
            rows.extend(
                (song, release.get("title"), release.get("year"))
                for song in release.get("tracks") or []
            )
    else:
        query = " ".join(value for value in (artist, title, album) if value)
        matches = yt.search(query, filter="songs", limit=8)
        rows = [(item, (item.get("album") or {}).get("name"), None) for item in matches[:8]]
    return {"tracks": [
        {
            "video_id": song.get("videoId"),
            "title": song.get("title"),
            "artists": artists(song),
            "album": name,
            "year": str(year) if year else None,
            "duration": seconds(song),
            "explicit": song.get("isExplicit"),
        }
        for song, name, year in rows if song.get("isAvailable", True)
    ]}


def tag_id3(tags, metadata, artwork):
    from mutagen.id3 import APIC, TALB, TDRC, TIT2, TPE1, TPE2, TPOS, TRCK, TSRC, WOAS

    tags.add(WOAS(url=metadata["url"]))
    for field, frame in (
        ("title", TIT2), ("artist", TPE1), ("album", TALB), ("album_artist", TPE2),
        ("year", TDRC), ("isrc", TSRC), ("track_number", TRCK), ("disc_number", TPOS),
    ):
        if metadata.get(field):
            tags.add(frame(encoding=3, text=str(metadata[field])))
    if artwork:
        tags.setall("APIC", [APIC(encoding=3, mime="image/jpeg", type=3,
                                 desc="Front cover", data=artwork)])


def tag_mp4(tags, metadata, artwork):
    from mutagen.mp4 import MP4Cover

    for field, key in (
        ("title", "\xa9nam"), ("artist", "\xa9ART"), ("album", "\xa9alb"),
        ("album_artist", "aART"), ("year", "\xa9day"),
    ):
        if metadata.get(field):
            tags[key] = [str(metadata[field])]
    tags["----:spotdl:WOAS"] = [metadata["url"].encode("utf-8")]
    if metadata.get("isrc"):
        tags["----:spotdl:ISRC"] = [metadata["isrc"].encode("utf-8")]
    for field, key in (("track_number", "trkn"), ("disc_number", "disk")):
        if metadata.get(field):
            tags[key] = [(metadata[field], 0)]
    if artwork:
        tags["covr"] = [MP4Cover(artwork, MP4Cover.FORMAT_JPEG)]


def tag_vorbis(audio, metadata, artwork):
    from mutagen.flac import FLAC, Picture

    audio.tags["woas"] = [metadata["url"]]
    for field, key in (
        ("title", "title"), ("artist", "artist"), ("album", "album"),
        ("album_artist", "albumartist"), ("year", "date"), ("isrc", "isrc"),
        ("track_number", "tracknumber"), ("disc_number", "discnumber"),
    ):
        if metadata.get(field):
            audio.tags[key] = [str(metadata[field])]
    if artwork:
        picture = Picture()
        picture.type = 3
        picture.mime = "image/jpeg"
        picture.desc = "Front cover"
        picture.data = artwork
        if isinstance(audio, FLAC):
            audio.clear_pictures()
            audio.add_picture(picture)
        else:
            audio.tags["metadata_block_picture"] = [base64.b64encode(picture.write()).decode("ascii")]


def tag(filename, metadata, cover):
    from mutagen import File
    from mutagen.flac import FLAC
    from mutagen.mp3 import MP3
    from mutagen.mp4 import MP4
    from mutagen.oggopus import OggOpus
    from mutagen.oggvorbis import OggVorbis
    from mutagen.wave import WAVE

    # Check the actual container before writing tags to the downloaded file.
    expected = {".mp3": MP3, ".wav": WAVE, ".m4a": MP4, ".flac": FLAC,
                ".ogg": OggVorbis, ".opus": OggOpus}
    audio = File(filename)
    if not isinstance(audio, expected[Path(filename).suffix]):
        raise ValueError("Audio does not match the requested container")
    if audio.tags is None:
        audio.add_tags()
    artwork = Path(cover).read_bytes() if cover else None
    if isinstance(audio, (MP3, WAVE)):
        tag_id3(audio.tags, metadata, artwork)
        audio.save(v2_version=3)
    else:
        if isinstance(audio, MP4):
            tag_mp4(audio.tags, metadata, artwork)
        else:
            tag_vorbis(audio, metadata, artwork)
        audio.save()


if sys.argv[1] == "tag":
    tag(sys.argv[2], json.loads(sys.argv[3]), sys.argv[4])
else:
    print(json.dumps(candidates(*sys.argv[1:])))
