import { describe, expect, test } from "vitest";

import { deriveCanonicalIdentity, normalizeMusicText, versionSignature } from "../src/domain/music-identity.js";
import { deduplicateSearchGroups } from "../src/domain/search-deduplication.js";
import type { SearchGroups, UnifiedSearchResult } from "../src/domain/search.js";

function result(overrides: Partial<UnifiedSearchResult> = {}): UnifiedSearchResult {
  return {
    type: "track",
    id: "md_track_1",
    title: "Digital Love",
    subtitle: "Daft Punk",
    artist: "Daft Punk",
    album: "Discovery",
    artwork: null,
    provider: "library",
    source: { kind: "library", count: 1, options: [{ id: "source-a", name: "Home Library" }] },
    availability: {
      state: "available",
      connectionId: "source-a",
      sourceCount: 1,
      availableSourceCount: 1,
      libraryAvailable: true,
    },
    metadata: { durationSeconds: 300 },
    ...overrides,
  };
}

function groups(...tracks: UnifiedSearchResult[]): SearchGroups {
  return { track: tracks, album: [], artist: [], playlist: [] };
}

describe("music identity normalization", () => {
  test("normalizes case, Unicode, punctuation, whitespace, and featuring suffixes", () => {
    expect(normalizeMusicText("  BÉYONCÉ – Halo (feat. Someone) ")).toBe("beyonce halo");
  });

  test("preserves meaningful recording/version markers", () => {
    expect(versionSignature("Song (Live Remix)")).toBe("live+remix");
    expect(versionSignature("Song (Radio Edit)")).toBe("radio edit");
  });

  test("uses strong MusicBrainz, ISRC, and UPC identifiers before normalized metadata", () => {
    expect(deriveCanonicalIdentity(result({ identityHints: { musicBrainzId: "MBID-1" } })).strength).toBe("musicbrainz");
    expect(deriveCanonicalIdentity(result({ identityHints: { isrc: "GBUM71505078" } })).strength).toBe("isrc");
    expect(deriveCanonicalIdentity(result({ type: "album", identityHints: { upc: "123456789012" } })).strength).toBe("upc");
  });
});

describe("search deduplication", () => {
  test("merges exact strong identifier matches and preserves library/external sources", () => {
    const library = result({
      id: "md_track_library",
      identityHints: { isrc: "GBUM71505078" },
    });
    const external = result({
      id: "external_itunes_1",
      provider: "external",
      source: { kind: "external", count: 0 },
      availability: null,
      identityHints: { isrc: "GBUM71505078" },
    });

    const merged = deduplicateSearchGroups(groups(library, external)).track;

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "md_track_library",
      provider: "library",
      providers: ["library", "external"],
      source: { kind: "library", externalAvailable: true },
      identity: { strength: "isrc" },
    });
    expect(merged[0]).not.toHaveProperty("identityHints");
  });

  test("merges conservative normalized matches across punctuation and case", () => {
    const library = result({ id: "md_track_library", title: "Digital Love", artist: "Daft Punk", album: "Discovery" });
    const external = result({
      id: "external_1",
      title: "digital-love",
      artist: "DAFT PUNK",
      album: "DISCOVERY",
      provider: "external",
      source: { kind: "external", count: 0 },
      availability: null,
    });

    expect(deduplicateSearchGroups(groups(library, external)).track).toHaveLength(1);
  });

  test("keeps live, remix, radio edit, and distinct releases separate", () => {
    const original = result({ id: "md_original", title: "Digital Love" });
    const live = result({ id: "external_live", title: "Digital Love (Live)", provider: "external", source: { kind: "external", count: 0 }, availability: null });
    const remix = result({ id: "external_remix", title: "Digital Love (Remix)", provider: "external", source: { kind: "external", count: 0 }, availability: null });
    const radio = result({ id: "external_radio", title: "Digital Love (Radio Edit)", provider: "external", source: { kind: "external", count: 0 }, availability: null });

    expect(deduplicateSearchGroups(groups(original, live, remix, radio)).track).toHaveLength(4);
  });

  test("keeps similar tracks separate when album metadata is missing", () => {
    const library = result({ id: "md_library", album: null });
    const external = result({ id: "external_1", album: null, provider: "external", source: { kind: "external", count: 0 }, availability: null });

    expect(deduplicateSearchGroups(groups(library, external)).track).toHaveLength(2);
  });

  test("uses first-result order deterministically while preferring a playable library representative", () => {
    const external = result({ id: "external_1", provider: "external", source: { kind: "external", count: 0 }, availability: null });
    const library = result({ id: "md_library" });
    const another = result({ id: "md_another", title: "Around the World" });

    const merged = deduplicateSearchGroups(groups(external, library, another)).track;

    expect(merged.map((item) => item.title)).toEqual(["Digital Love", "Around the World"]);
    expect(merged[0].id).toBe("md_library");
  });
});
