import { describe, expect, test } from "vitest";

import { toSearchGroups } from "../src/domain/search.js";

const availability = {
  state: "available" as const,
  connectionId: "internal-connection-id",
  sourceCount: 2,
  availableSourceCount: 2,
  libraryAvailable: true,
};

describe("unified search result model", () => {
  test("maps provider catalog results to neutral metadata without exposing connection IDs", () => {
    const groups = toSearchGroups({
      artists: [],
      albums: [],
      tracks: [{
        id: "md_track-1",
        providerId: "provider-track-1",
        title: "Digital Love",
        artistId: "md_artist-1",
        artistName: "Daft Punk",
        albumId: "md_album-1",
        albumName: "Discovery",
        durationSeconds: 300,
        trackNumber: 3,
        artworkId: "mdart_1",
        artworkUrl: "/api/artwork/mdart_1",
        streamUrl: "/api/tracks/md_track-1/stream",
        availability,
        sources: [{ id: "internal-connection-id", name: "Home Library" }],
      }],
      degraded: false,
    }, []);

    expect(groups.track[0]).toMatchObject({
      type: "track",
      id: "md_track-1",
      title: "Digital Love",
      provider: "library",
      source: { kind: "library", count: 1, options: [{ id: "internal-connection-id", name: "Home Library" }] },
      availability,
      metadata: { artistId: "md_artist-1", albumId: "md_album-1", durationSeconds: 300 },
    });
    expect(groups.track[0]).not.toHaveProperty("providerId");
  });

  test("maps MusicDeck playlists and preserves explicit empty groups", () => {
    const groups = toSearchGroups({
      artists: [],
      albums: [],
      tracks: [],
      degraded: false,
    }, [{
      id: "mdpl_1",
      providerId: "mdpl_1",
      name: "Night Drive",
      description: null,
      artworkId: null,
      artworkUrl: null,
      songCount: 8,
    }]);

    expect(groups.track).toEqual([]);
    expect(groups.album).toEqual([]);
    expect(groups.artist).toEqual([]);
    expect(groups.playlist).toEqual([
      expect.objectContaining({ type: "playlist", provider: "musicdeck", title: "Night Drive" }),
    ]);
  });
});
