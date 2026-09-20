import {
  normalizeTrackData,
} from "./normalizeTrackData";

test("normalizes a library track and derives its downloaded state", () => {
  expect(normalizeTrackData({
    id: "md_track-1",
    title: "Library song",
    artistName: "Artist",
    albumName: "Album",
    durationSeconds: 180,
    availability: { libraryAvailable: true },
  }, "library")).toMatchObject({
    id: "md_track-1",
    title: "Library song",
    artist: "Artist",
    album: "Album",
    duration: 180,
    isDownloaded: true,
    origin: "library",
  });
});

test("preserves ReplayGain metadata for the playback engine", () => {
  expect(normalizeTrackData({
    id: "gain-track",
    title: "Balanced song",
    replayGain: { trackGainDb: -7.25, trackPeak: 0.91 },
  })).toMatchObject({
    replayGain: { trackGainDb: -7.25, trackPeak: 0.91 },
  });
});

test("elevates a nested playlist song ID over the playlist-item ID", () => {
  expect(normalizeTrackData({
    id: "playlist-item-9",
    track: {
      id: "song-42",
      title: "Nested song",
      spotdl: { status: "completed" },
    },
  }, "playlist")).toMatchObject({
    id: "song-42",
    title: "Nested song",
    isDownloaded: true,
    origin: "playlist",
  });
});

test("normalizes Jellyfin field names and runtime ticks", () => {
  expect(normalizeTrackData({
    Id: "jellyfin-7",
    Name: "Jellyfin song",
    Artists: ["Jelly Artist"],
    Album: "Jelly Album",
    RunTimeTicks: 2000000000,
    IndexNumber: 3,
  }, "liked")).toMatchObject({
    id: "jellyfin-7",
    title: "Jellyfin song",
    artist: "Jelly Artist",
    album: "Jelly Album",
    duration: 200,
    track: 3,
  });
});

test("normalizes raw iTunes Search fields", () => {
  expect(normalizeTrackData({
    trackId: 123,
    trackName: "iTunes song",
    artistName: "iTunes artist",
    collectionName: "iTunes album",
    trackTimeMillis: 215000,
    previewUrl: "https://audio-ssl.itunes.apple.com/preview.m4a",
  }, "search")).toMatchObject({
    id: "123",
    title: "iTunes song",
    artist: "iTunes artist",
    album: "iTunes album",
    duration: 215,
    previewUrl: "https://audio-ssl.itunes.apple.com/preview.m4a",
    origin: "search",
  });
});

test("flattens raw Deezer artist, album, artwork, and preview fields", () => {
  expect(normalizeTrackData({
    id: 42,
    title: "Deezer song",
    artist: { name: "Artist" },
    album: {
      title: "Deezer album",
      cover_xl: "https://cdn.example.test/deezer-xl.jpg",
      cover_medium: "https://cdn.example.test/deezer-medium.jpg",
    },
    preview: "https://cdns-preview-a.dzcdn.net/stream.mp3",
  }, "search")).toMatchObject({
    id: "42",
    artist: "Artist",
    album: "Deezer album",
    coverUrl: "https://cdn.example.test/deezer-xl.jpg",
    previewUrl: "https://cdns-preview-a.dzcdn.net/stream.mp3",
  });
});
