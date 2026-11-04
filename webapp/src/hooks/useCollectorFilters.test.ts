import { performance } from "node:perf_hooks";
import { collectorMetadata, createCollectorIndex, emptyCollectorFilters } from "./useCollectorFilters";

test("intersects four facets in catalog order across bitset boundaries", () => {
  const tracks = Array.from({ length: 20_000 }, (_, i) => ({
    id: i, title: i === 31 ? "Single (2021 Remaster)" : "Track",
    year: 1950 + i % 77,
    metadata: {
      sourceServer: i % 2 ? "jellyfin" : "navidrome",
      genres: i % 3 ? ["Rock"] : ["Ambient", "Rock"],
      audioMetadata: { codec: i % 5 ? "flac" : "mp3", bitDepth: 24, sampleRateHz: 96000 },
    },
  }));
  const index = createCollectorIndex(tracks);
  const filters = { ...emptyCollectorFilters, from: "1960", to: "2020", genre: "ambient", format: "FLAC", source: "Jellyfin" };
  const expected = tracks.filter(track => track.id % 5 !== 0 && track.year >= 1960 && track.year <= 2020
    && track.id % 3 === 0 && track.id % 2 === 1);
  expect(index.filter(filters)).toEqual(expected);
  expect(index.filter({ ...filters, genre: "missing" })).toEqual([]);
  expect(index.filter(emptyCollectorFilters)).toBe(tracks);
  expect(collectorMetadata(tracks[31])).toMatchObject({ remaster: true, formats: ["FLAC", "24-bit Hi-Res"] });
  for (let i = 0; i < 20; i++) index.filter(filters);
  const samples = Array.from({ length: 100 }, () => {
    const start = performance.now();
    index.filter(filters);
    return performance.now() - start;
  }).sort((left, right) => left - right);
  console.info(`20,000 tracks, filter evaluation p50=${samples[50].toFixed(3)} ms, p95=${samples[95].toFixed(3)} ms`);
  expect(samples[95]).toBeLessThan(12);
});
