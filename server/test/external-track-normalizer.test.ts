import { describe, expect, test, vi } from "vitest";
import {
  hydrateMissingPreviews,
  normalizeExternalTrack,
  type NormalizedExternalTrack,
} from "../src/services/discovery/externalTrackNormalizer.js";

const deezerPreview = "https://cdns-preview-a.dzcdn.net/stream.mp3";
const base = {
  id: "external_deezer_track_301",
  title: "Chart Song",
  artist: { name: "Chart Artist" },
  album: { title: "Chart Album", cover_xl: "https://cdn.dzcdn.net/cover.jpg" },
};

describe("external track normalization", () => {
  test.each(["preview", "preview_url", "previewUrl", "audio_preview_url"])(
    "normalizes the %s preview field",
    (key) => {
      const normalized = normalizeExternalTrack({ ...base, [key]: deezerPreview });
      expect(normalized).toEqual({
        id: "external_deezer_track_301",
        title: "Chart Song",
        artist: "Chart Artist",
        album: "Chart Album",
        coverUrl: "https://cdn.dzcdn.net/cover.jpg",
        previewUrl: deezerPreview,
        isrc: null,
        source: "external",
      });
    }
  );

  test("rejects malformed track data and untrusted preview URLs", () => {
    expect(normalizeExternalTrack({ ...base, preview: "https://attacker.example/audio.mp3" }))
      .toMatchObject({ previewUrl: null });
    expect(normalizeExternalTrack({
      ...base,
      previewUrl: "http://unsafe.example/preview.mp3",
      preview_url: deezerPreview,
    })).toMatchObject({ previewUrl: deezerPreview });
    expect(normalizeExternalTrack({ id: "missing-title", artist: "Artist" })).toBeNull();
    expect(normalizeExternalTrack({ trackId: 412, title: "Numeric ID Song", artistName: "Artist" }))
      .toMatchObject({ id: "412", title: "Numeric ID Song", artist: "Artist" });
  });

  test("hydrates missing previews with at most five concurrent lookups across batches and tolerates failures", async () => {
    let active = 0;
    let peak = 0;
    const lookup = async (query: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (query.includes("Failure Song")) throw new Error("provider unavailable");
      return [{
        id: "search-result",
        title: "Hydrated Song",
        artist: "Hydrated Artist",
        previewUrl: deezerPreview,
      }];
    };
    const tracks: NormalizedExternalTrack[] = Array.from({ length: 12 }, (_, index) => ({
      id: `track-${index}`,
      title: index === 11 ? "Failure Song" : "Hydrated Song",
      artist: index === 11 ? "Failure Artist" : "Hydrated Artist",
      album: null,
      coverUrl: null,
      previewUrl: null,
      isrc: null,
      source: "external",
    }));

    const [first, second] = await Promise.all([
      hydrateMissingPreviews(tracks.slice(0, 6), lookup),
      hydrateMissingPreviews(tracks.slice(6), lookup),
    ]);
    const result = [...first, ...second];
    expect(peak).toBeLessThanOrEqual(5);
    expect(result.slice(0, 11).every((track) => track.previewUrl === deezerPreview)).toBe(true);
    expect(result[11].previewUrl).toBeNull();
    expect(result[11]).toMatchObject({ title: "Failure Song", source: "external" });
  });

  test("falls back from a failed ISRC lookup to an exact artist/title search", async () => {
    const track: NormalizedExternalTrack = {
      id: "isrc-track",
      title: "ISRC Fallback Unique",
      artist: "Fallback Artist",
      album: null,
      coverUrl: null,
      previewUrl: null,
      isrc: "USABC2600001",
      source: "external",
    };
    const lookup = vi.fn(async (query: string) => {
      if (query === track.isrc) throw new Error("ISRC search unavailable");
      return [{
        id: "fallback-match",
        title: track.title,
        artist: track.artist,
        preview_url: deezerPreview,
      }];
    });

    await expect(hydrateMissingPreviews([track], lookup))
      .resolves.toMatchObject([{ previewUrl: deezerPreview }]);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test("caches resolved preview URLs across repeated chart loads", async () => {
    const track: NormalizedExternalTrack = {
      id: "cached-track",
      title: "Cached Lookup Unique 2026",
      artist: "Cache Artist",
      album: null,
      coverUrl: null,
      previewUrl: null,
      isrc: null,
      source: "external",
    };
    const lookup = async () => [{
      id: "search-result",
      title: track.title,
      artist: track.artist,
      previewUrl: deezerPreview,
    }];

    await hydrateMissingPreviews([track], lookup);
    const cachedLookup = vi.fn(lookup);
    const hydrated = await hydrateMissingPreviews([track], cachedLookup);
    expect(cachedLookup).not.toHaveBeenCalled();
    expect(hydrated[0].previewUrl).toBe(deezerPreview);
  });
});
