import { performance } from "perf_hooks";
import { seededRandom, shuffleArtist, smartShuffle, SMART_SHUFFLE_WINDOW_MS } from "./shuffle";
import type { ShuffleTrack } from "./shuffle";

const now = 1_800_000_000_000;
const options = { seed: 42, now, recentPlays: [], favoriteIds: [] };
const song = (id: string, artist = id) => ({ id, artist });

test("seeded weighted permutations are deterministic, unique and don't mutate input", () => {
  const tracks = Array.from({ length: 200 }, (_, i) => song(String(i), `Artist ${i % 12}`));
  const original = [...tracks];
  const first = smartShuffle(tracks, options);
  expect(first).toEqual(smartShuffle(tracks, options));
  expect(first).not.toEqual(smartShuffle(tracks, { ...options, seed: 43 }));
  expect(new Set(first.tracks.map((track) => track.id)).size).toBe(200);
  expect(tracks).toEqual(original);
  expect(first.excludedCount).toBe(0);
  expect(seededRandom(0)()).toBeGreaterThanOrEqual(0);
});

test("excludes recent/current track duplicates without substituting recent tracks on exhaustion", () => {
  const tracks = [song("recent"), song("boundary"), song("future"), song("current"), song("fresh"), song("fresh")];
  const result = smartShuffle(tracks, {
    ...options, currentTrack: song("current"),
    recentPlays: [
      { ...song("recent"), playedAt: now - SMART_SHUFFLE_WINDOW_MS + 1 },
      { ...song("boundary"), playedAt: now - SMART_SHUFFLE_WINDOW_MS },
      { ...song("future"), playedAt: now + 1 },
    ],
  });
  expect(result.tracks.map((track) => track.id).sort()).toEqual(["boundary", "fresh", "future"]);
  expect(result.excludedCount).toBe(3);
  expect(smartShuffle([song("recent")], { ...options, recentPlays: [{ ...song("recent"), playedAt: now }] }).tracks).toEqual([]);
});

test("first-draw favorite odds match 1.5x and recent-artist odds match the 80% penalty", () => {
  const tracks = [song("normal", "New"), song("favorite", "Favorite"), song("penalized", "Recent"), song("combined", "Recent")];
  const counts = { normal: 0, favorite: 0, penalized: 0, combined: 0 };
  for (let seed = 0; seed < 20_000; seed++) {
    const first = smartShuffle(tracks, {
      ...options, seed, favoriteIds: ["favorite", "combined"], recentPlays: [{ ...song("heard", "Recent"), playedAt: now }],
    }).tracks[0].id as keyof typeof counts;
    counts[first]++;
  }
  // P = weight / (1 + 1.5 + .2 + .3).
  expect(counts.normal / 20_000).toBeCloseTo(1 / 3, 1);
  expect(counts.favorite / counts.normal).toBeCloseTo(1.5, 1);
  expect(counts.penalized / counts.normal).toBeCloseTo(.2, 1);
  expect(counts.combined / counts.normal).toBeCloseTo(.3, 1);
});

test("artist penalty follows the newly generated rolling five-track window, not just the initial history", () => {
  const tracks = Array.from({ length: 80 }, (_, i) => song(String(i), `Artist ${i % 8}`));
  let repeats = 0;
  let comparisons = 0;
  for (let seed = 0; seed < 300; seed++) {
    const shuffled = smartShuffle(tracks, { ...options, seed }).tracks;
    // Early draws have adequate supply across artists, avoiding exhaustion effects.
    for (let i = 5; i < 35; i++) {
      if (shuffled.slice(i - 5, i).some((track) => track.artist === shuffled[i].artist)) repeats++;
      comparisons++;
    }
  }
  expect(repeats / comparisons).toBeLessThan(.4);
});

test("only the last five played artists are penalized and missing/compilation artists don't cluster as one", () => {
  const tracks = [song("old", "Expired"), song("fresh", "Fresh")];
  let expiredFirst = 0;
  for (let seed = 0; seed < 5000; seed++) {
    const recentPlays = Array.from({ length: 6 }, (_, i) => ({ ...song(`history${i}`, i === 0 ? "Expired" : `other${i}`), playedAt: now - 6 + i }));
    if (smartShuffle(tracks, { ...options, seed, recentPlays }).tracks[0].id === "old") expiredFirst++;
  }
  expect(expiredFirst / 5000).toBeCloseTo(.5, 1);
  expect(shuffleArtist(song("one", "  SYNTH  "))).toBe(shuffleArtist(song("two", "synth")));
  expect(shuffleArtist(song("one", "Unknown artist"))).not.toBe(shuffleArtist(song("two", "Unknown artist")));
  expect(shuffleArtist({ id: "one", artist: "Unknown artist", artistId: 4 })).toBe("id:4");
  expect(shuffleArtist({ id: "one", artist: "Various Artists", artistId: 4 })).toBe("track:one");
});

test("artist-ID cache keys cannot alias real artist names", () => {
  const recentPlays = [{ ...song("heard", "Name"), playedAt: now }];
  for (let seed = 0; seed < 100; seed++) {
    const draw = (artistId: string) => smartShuffle([
      { id: "unrelated", artistId }, song("named", "Name"),
    ], { ...options, seed, recentPlays }).tracks.map((track) => track.id);
    expect(draw("Name")).toEqual(draw("Unrelated"));
  }
});

test("handles empty, single-artist and all-favorite pools without empty draws", () => {
  expect(smartShuffle([], options).tracks).toEqual([]);
  const tracks = Array.from({ length: 5000 }, (_, i) => song(String(i), "Same artist"));
  const result = smartShuffle(tracks, { ...options, favoriteIds: tracks.map((track) => track.id) });
  expect(result.tracks).toHaveLength(5000);
  expect(result.tracks.every(Boolean)).toBe(true);
  expect(() => smartShuffle(tracks, { ...options, seed: -1 })).toThrow(RangeError);
});

test("shuffles 5,000 tracks in under 10 ms at p95", () => {
  const tracks: ShuffleTrack[] = Array.from({ length: 5000 }, (_, i) => song(String(i), `Artist ${i % 600}`));
  const config = { ...options, favoriteIds: tracks.filter((_track, i) => i % 3 === 0).map((track) => String(track.id)) };
  for (let i = 0; i < 15; i++) smartShuffle(tracks, { ...config, seed: i });
  const timings: number[] = [];
  for (let seed = 0; seed < 50; seed++) {
    const start = performance.now();
    const result = smartShuffle(tracks, { ...config, seed });
    timings.push(performance.now() - start);
    expect(result.tracks).toHaveLength(5000);
  }
  timings.sort((a, b) => a - b);
  const p95 = timings[Math.ceil(timings.length * .95) - 1];
  console.info(`Smart Shuffle 5000 tracks: p95=${p95.toFixed(2)}ms max=${timings[timings.length - 1].toFixed(2)}ms`);
  expect(p95).toBeLessThan(10);
});
