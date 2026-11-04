export type ShuffleMode = "standard" | "smart";
export const SMART_SHUFFLE_WINDOW_MS = 2 * 60 * 60 * 1000;
export interface ShuffleTrack {
  readonly id: string | number;
  readonly artist?: string;
  readonly artistId?: string | number | null;
}
export interface ShufflePlay extends ShuffleTrack {
  readonly playedAt: number;
}
export interface SmartShuffleOptions {
  readonly seed: number;
  readonly now: number;
  readonly recentPlays: readonly ShufflePlay[];
  readonly favoriteIds: readonly string[];
  /** The selected track stays in place, but its artist counts for the next draw. */
  readonly currentTrack?: ShuffleTrack;
}
export function isShuffleMode(value: unknown): value is ShuffleMode {
  return value === "standard" || value === "smart";
}
const imul = Math.imul;
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = imul(state ^ (state >>> 15), state | 1);
    value ^= value + imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffleArtist(track: ShuffleTrack): string {
  // A name key also matches history records that don't carry backend artist IDs.
  const name = track.artist?.normalize("NFKC").trim().toLowerCase();
  if (name === "various artists") return `track:${track.id}`;
  if (name && !["unknown artist", "unknown", "various artists"].includes(name)) return `name:${name}`;
  return track.artistId != null ? `id:${track.artistId}` : `track:${track.id}`;
}

/** Artist-group totals make each weighted draw and five-track-window update O(log N). */
class WeightTree {
  private readonly tree: Float64Array;
  private readonly values: Float64Array;
  private readonly step: number;
  total = 0;
  offset = 0;
  constructor(size: number) {
    this.tree = new Float64Array(size + 1);
    this.values = new Float64Array(size);
    this.step = size > 0 ? 2 ** Math.floor(Math.log2(size)) : 0;
  }
  set(index: number, value: number) {
    const delta = value - this.values[index];
    this.values[index] = value;
    this.total += delta;
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i] += delta;
  }
  pick(target: number): number {
    let index = 0;
    for (let bit = this.step; bit; bit >>= 1) {
      const next = index + bit;
      if (next < this.tree.length && this.tree[next] <= target) {
        index = next;
        target -= this.tree[next];
      }
    }
    this.offset = target;
    return index;
  }
}

export interface SmartShuffleResult<T> {
  readonly tracks: T[];
  readonly excludedCount: number;
}

export function weightedShuffle<T>(
  items: readonly T[],
  options: SmartShuffleOptions,
  trackOf: (item: T) => ShuffleTrack,
): SmartShuffleResult<T> {
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff || !Number.isFinite(options.now)) {
    throw new RangeError("Smart Shuffle requires a uint32 seed and a finite timestamp.");
  }
  const random = seededRandom(options.seed);
  const history = options.recentPlays.filter((play) => Number.isFinite(play.playedAt) &&
    play.playedAt <= options.now && options.now - play.playedAt < SMART_SHUFFLE_WINDOW_MS);
  const excluded = new Set(history.map((play) => String(play.id)));
  if (options.currentTrack) excluded.add(String(options.currentTrack.id));
  const favorites = new Set(options.favoriteIds);
  const seen = new Set<string>();
  const groups: Array<{ artist: string; normal: T[]; favorites: T[] }> = [];
  const groupByArtist = new Map<string, number>();
  let count = 0;
  const artistKeys = new Map<string, string>();
  for (const item of items) {
    const track = trackOf(item);
    const id = String(track.id);
    if (excluded.has(id) || seen.has(id)) continue;
    seen.add(id);
    const identity = track.artist;
    let artist = identity ? artistKeys.get(identity) : undefined;
    if (artist === undefined) {
      artist = shuffleArtist(track);
      // Unknown/compilation artist keys are intentionally per-track.
      if (identity && artist.startsWith("name:")) artistKeys.set(identity, artist);
    }
    let index = groupByArtist.get(artist);
    if (index === undefined) {
      index = groups.length;
      groupByArtist.set(artist, index);
      groups.push({ artist, normal: [], favorites: [] });
    }
    (favorites.has(id) ? groups[index].favorites : groups[index].normal).push(item);
    count++;
  }
  const lastPlays = history.slice().sort((a, b) => a.playedAt - b.playedAt).slice(-5);
  if (options.currentTrack && String(lastPlays[lastPlays.length - 1]?.id) !== String(options.currentTrack.id)) {
    lastPlays.push({ ...options.currentTrack, playedAt: options.now });
  }
  const window = lastPlays.slice(-5).map(shuffleArtist);
  const recency = new Map<string, number>();
  window.forEach((artist) => recency.set(artist, (recency.get(artist) ?? 0) + 1));
  const tree = new WeightTree(groups.length);
  const update = (index: number) => {
    const group = groups[index];
    // Integer-scaled weights avoid residual floating-point totals near exhaustion.
    tree.set(index, (10 * group.normal.length + 15 * group.favorites.length) * (recency.has(group.artist) ? 0.2 : 1));
  };
  groups.forEach((_group, index) => update(index));
  const tracks: T[] = [];
  while (tracks.length < count) {
    const index = tree.pick(random() * tree.total);
    const group = groups[index];
    // The remainder of the weighted tree draw is uniform within this artist:
    // use it for both favorite selection and the item index, without a second draw.
    const local = tree.offset / (recency.has(group.artist) ? 0.2 : 1);
    const favoriteWeight = group.favorites.length * 15;
    const favorite = local < favoriteWeight;
    const bucket = favorite ? group.favorites : group.normal;
    const pick = Math.floor(favorite ? local / 15 : (local - favoriteWeight) / 10);
    const item = bucket[pick];
    bucket[pick] = bucket[bucket.length - 1];
    bucket.pop();
    tracks.push(item);
    window.push(group.artist);
    recency.set(group.artist, (recency.get(group.artist) ?? 0) + 1);
    if (window.length > 5) {
      const expired = window.shift()!;
      const remaining = (recency.get(expired) ?? 1) - 1;
      if (remaining) recency.set(expired, remaining);
      else recency.delete(expired);
      const expiredIndex = groupByArtist.get(expired);
      if (expiredIndex !== undefined && expiredIndex !== index) update(expiredIndex);
    }
    update(index);
  }
  return { tracks, excludedCount: items.length - tracks.length };
}

export function smartShuffle<T extends ShuffleTrack>(tracks: readonly T[], options: SmartShuffleOptions): SmartShuffleResult<T> {
  return weightedShuffle(tracks, options, (track) => track);
}
