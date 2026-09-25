import { describe, expect, test } from "vitest";
import { createLibraryMatchIndex, matchLocalAlbum, matchLocalTrack } from "../src/utils/libraryMatcher.js";

describe("local library matching", () => {
  const tracks = [
    { id: "track-1", title: "Lost", artist: "Linkin Park", isrc: "US-WB1-23-001" },
    { id: "track-2", title: "Medusa (Deluxe)", artist: "GEMS" },
    { id: "track-3", title: "Medusa", artist: "GEMS" },
  ];

  test("uses exact ISRC before title/artist", () => {
    expect(matchLocalTrack({ id: "external", title: "Different title", artist: "Someone", isrc: "uswb123001" }, tracks))
      .toEqual({ inLibrary: true, localTrackId: "track-1" });
  });

  test("falls back to normalized names without merging distinct editions", () => {
    expect(matchLocalTrack({ id: "external", title: "Médusa [Deluxe]", artist: "gems" }, tracks))
      .toEqual({ inLibrary: true, localTrackId: "track-2" });
    expect(matchLocalTrack({ id: "external", title: "Medusa (Live)", artist: "GEMS" }, tracks))
      .toEqual({ inLibrary: false });
  });

  test("does not match an empty title or a different artist", () => {
    expect(matchLocalTrack({ id: "external", title: "", artist: "GEMS" }, tracks).inLibrary).toBe(false);
    expect(matchLocalTrack({ id: "external", title: "Lost", artist: "Lostprophets" }, tracks).inLibrary).toBe(false);
  });

  test("matches album title and artist while preserving deluxe editions", () => {
    const albums = [
      { id: "album-1", title: "Medusa", artist: "GEMS" },
      { id: "album-2", title: "Medusa (Deluxe)", artist: "GEMS" },
    ];
    expect(matchLocalAlbum({ id: "external", title: "Medusa [Deluxe]", artist: "GEMS" }, albums))
      .toEqual({ inLibrary: true, localAlbumId: "album-2" });
    const index = createLibraryMatchIndex(tracks, albums);
    expect(index.matchTrack({ id: "external", title: "Lost", artist: "Other", isrc: "USWB123001" }))
      .toEqual({ inLibrary: true, localTrackId: "track-1" });
    expect(index.matchAlbum({ id: "external", title: "Medusa [Deluxe]", artist: "GEMS" }))
      .toEqual({ inLibrary: true, localAlbumId: "album-2" });
  });
});
