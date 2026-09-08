import { describe, expect, it } from "vitest";
import {
  findMatchingExternalAlbum,
  findMatchingExternalArtist,
  mergeAlbumTracks,
  mergeArtistAlbums,
} from "../src/domain/catalog-merge.js";
import type { UnifiedSearchResult } from "../src/domain/search.js";

function localTrack(title: string, artist = "Queen"): UnifiedSearchResult {
  return {
    type: "track",
    id: `local-${title}`,
    title,
    subtitle: artist,
    artist,
    album: "A Night at the Opera",
    artwork: null,
    provider: "library",
    source: { kind: "library", count: 1 },
    availability: {
      state: "available",
      connectionId: "library",
      sourceCount: 1,
      availableSourceCount: 1,
      libraryAvailable: true,
    },
    metadata: {},
  };
}

function catalogTrack(title: string, artist = "Queen"): UnifiedSearchResult {
  return {
    type: "track",
    id: `cat-${title}`,
    title,
    subtitle: artist,
    artist,
    album: "A Night at the Opera",
    artwork: null,
    provider: "external",
    source: { kind: "external", count: 0 },
    availability: null,
    metadata: {},
  };
}

function catalogAlbum(title: string, artist = "Queen"): UnifiedSearchResult {
  return {
    type: "album",
    id: `cat-album-${title}`,
    title,
    subtitle: artist,
    artist,
    album: null,
    artwork: null,
    provider: "external",
    source: { kind: "external", count: 0 },
    availability: null,
    metadata: {},
  };
}

function catalogArtist(title: string): UnifiedSearchResult {
  return {
    type: "artist",
    id: `cat-artist-${title}`,
    title,
    subtitle: null,
    artist: null,
    album: null,
    artwork: null,
    provider: "external",
    source: { kind: "external", count: 0 },
    availability: null,
    metadata: {},
  };
}

describe("catalog-merge", () => {
  describe("mergeAlbumTracks", () => {
    it("keeps local tracks and appends undownloaded catalog tracks (12 known, 3 local)", () => {
      const local = [
        localTrack("Death on Two Legs"),
        localTrack("Bohemian Rhapsody"),
        localTrack("Love of My Life"),
      ];
      const catalog = [
        catalogTrack("Death on Two Legs"),
        catalogTrack("Bohemian Rhapsody"),
        catalogTrack("Love of My Life"),
        catalogTrack("I'm in Love with My Car"),
        catalogTrack("You're My Best Friend"),
        catalogTrack("'39"),
        catalogTrack("Sweet Lady"),
        catalogTrack("Seaside Rendezvous"),
        catalogTrack("The Prophet's Song"),
        catalogTrack("Good Company"),
        catalogTrack("The Millionaire Waltz"),
        catalogTrack("God Save the Queen"),
      ];

      const merged = mergeAlbumTracks(local, catalog);

      expect(merged).toHaveLength(12);
      expect(merged.slice(0, 3).map((track) => track.id)).toEqual(local.map((track) => track.id));
      // undownloaded entries are the 9 catalog-only tracks
      const undownloadedTitles = merged.slice(3).map((t) => t.title);
      expect(undownloadedTitles).toContain("I'm in Love with My Car");
      expect(undownloadedTitles).not.toContain("Bohemian Rhapsody");
    });

    it("still returns the full album when zero tracks are local", () => {
      const merged = mergeAlbumTracks([], [catalogTrack("A"), catalogTrack("B")]);
      expect(merged).toHaveLength(2);
    });

    it("uses one downloaded recording on every authoritative album that contains it", () => {
      const downloaded = localTrack("Bohemian Rhapsody");
      downloaded.album = "Greatest Hits I, II & III: The Platinum Collection";
      const originalAlbumTrack = catalogTrack("Bohemian Rhapsody");
      originalAlbumTrack.album = "A Night at the Opera";

      const merged = mergeAlbumTracks([downloaded], [originalAlbumTrack], {
        appendUnmatchedLocal: false,
      });

      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({
        id: downloaded.id,
        album: "A Night at the Opera",
        provider: "library",
        availability: { libraryAvailable: true },
      });
    });

    it("does not merge a live/remaster version into the original local recording", () => {
      const local = [localTrack("Bohemian Rhapsody")];
      const catalog = [catalogTrack("Bohemian Rhapsody - Live")];

      const merged = mergeAlbumTracks(local, catalog);

      // Both should be present distinctly, not collapsed into one entry.
      expect(merged).toHaveLength(2);
    });

    it("does not reuse a compilation recording when duration differs substantially", () => {
      const local = localTrack("Bohemian Rhapsody");
      local.metadata.durationSeconds = 355;
      const catalog = catalogTrack("Bohemian Rhapsody");
      catalog.metadata.durationSeconds = 240;

      const merged = mergeAlbumTracks([local], [catalog], { appendUnmatchedLocal: false });

      expect(merged).toEqual([catalog]);
    });

    it("ignores non-track catalog items", () => {
      const merged = mergeAlbumTracks([], [catalogAlbum("Some Album")]);
      expect(merged).toHaveLength(0);
    });
  });

  describe("mergeArtistAlbums", () => {
    it("keeps albums with zero local tracks visible alongside mixed albums", () => {
      const localAlbums = [catalogAlbum("Album A"), catalogAlbum("Album C")].map((a) => ({
        ...a,
        provider: "library" as const,
        source: { kind: "library" as const, count: 1 },
      }));
      const catalogAlbums = [catalogAlbum("Album A"), catalogAlbum("Album B"), catalogAlbum("Album C")];

      const merged = mergeArtistAlbums(localAlbums, catalogAlbums);

      expect(merged).toHaveLength(3);
      const titles = merged.map((a) => a.title);
      expect(titles).toEqual(["Album A", "Album C", "Album B"]);
    });
  });

  describe("findMatchingExternalAlbum", () => {
    it("finds a confident normalized title+artist match", () => {
      const results = [catalogAlbum("A Night at the Opera", "Queen"), catalogAlbum("Different Album", "Someone")];
      const match = findMatchingExternalAlbum(results, "A Night at the Opera", "Queen");
      expect(match?.title).toBe("A Night at the Opera");
    });

    it("returns null when there is no confident match", () => {
      const results = [catalogAlbum("Unrelated Album", "Other Artist")];
      const match = findMatchingExternalAlbum(results, "A Night at the Opera", "Queen");
      expect(match).toBeNull();
    });
  });

  describe("findMatchingExternalArtist", () => {
    it("finds a confident normalized artist match", () => {
      const results = [catalogArtist("Queen"), catalogArtist("Someone Else")];
      const match = findMatchingExternalArtist(results, "Queen");
      expect(match?.title).toBe("Queen");
    });

    it("returns null when there is no confident match", () => {
      const results = [catalogArtist("Someone Else")];
      const match = findMatchingExternalArtist(results, "Queen");
      expect(match).toBeNull();
    });
  });
});
