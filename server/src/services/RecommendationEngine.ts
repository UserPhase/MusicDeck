import type { Db } from "../db/database.js";
import type { Available } from "../domain/catalog.js";
import type { Track } from "../types.js";
import { tasteProfile, tasteTarget, type TasteTarget } from "./TasteProfileManager.js";
import type { SonicMatch, SonicRecommendationService } from "./SonicRecommendationService.js";

export const RECENT_PLAY_WINDOW_MS = 4 * 60 * 60 * 1000;
const POOL_SIZE = 2048;
const CACHE_LIMIT = 64;
const CACHE_TTL_MS = 30_000;

type Features = {
  target: TasteTarget;
  track: Available<Track>;
  genres: Set<string>;
  moods: Set<string>;
  artist: string;
};
type Feedback = { itemType: string; itemId: string; action: string; weight: number };
type Profile = {
  version: number;
  allows: ReturnType<ReturnType<typeof tasteProfile>["feedbackFilter"]>;
  expires: number;
  affinity: Map<string, number>;
  artists: Map<string, number>;
  genres: Map<string, number>;
  weights: Map<string, number>;
  hidden: Set<string>;
};
type Candidate = { feature: Features; score: number; reason: string };

export interface LocalRecommendation {
  track: Available<Track>;
  score: number;
  reason: string;
}

export class RecommendationSeedNotFoundError extends Error {
  constructor() {
    super("Recommendation seed is not in the local catalog");
  }
}

function tags(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const tag of left) if (right.has(tag)) shared++;
  return shared / (left.size + right.size - shared);
}

function bounded(value: number): number {
  return Math.max(-3, Math.min(3, value / 10));
}

function put<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/**
 * Selection only reads an in-memory catalog snapshot and indexed local SQLite
 * signals. Catalog I/O belongs to the caller's background refresh, never here.
 * Ranked pools are bounded and cached; live recent-play/hidden filters are
 * reapplied on every selection, including a cache hit.
 */
export class RecommendationEngine {
  private sonic?: SonicRecommendationService;
  private tracks = new Map<string, Features>();
  private readonly byGenre = new Map<string, Features[]>();
  private readonly byArtist = new Map<string, Features[]>();
  private readonly byMood = new Map<string, Features[]>();
  private readonly profiles = new Map<string, Profile>();
  private readonly pools = new Map<string, { version: number; expires: number; candidates: Candidate[] }>();
  private readonly recent;
  private readonly events;
  private readonly favorites;
  private readonly feedback;
  private readonly recentEvents;
  private readonly playCounts;

  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    this.recent = db.prepare("SELECT DISTINCT track_id FROM taste_recently_played WHERE user_id = ? AND played_at > ?");
    this.events = db.prepare(`SELECT track_id,
      COUNT(DISTINCT CASE WHEN event_type IN ('play','complete') THEN COALESCE(playback_session_id,id) END) AS plays,
      SUM(CASE WHEN event_type = 'skip' OR
        (event_type = 'progress' AND finished = 1 AND listened_seconds > 0) THEN 1 ELSE 0 END) AS skips
      FROM taste_listening_events WHERE user_id = ? GROUP BY track_id`);
    this.favorites = db.prepare("SELECT track_id FROM favorites WHERE user_id = ?");
    this.playCounts = db.prepare("SELECT track_id, COUNT(*) AS plays FROM taste_recently_played WHERE user_id = ? GROUP BY track_id");
    this.feedback = db.prepare(`SELECT item_type AS itemType, item_id AS itemId, action, weight
      FROM recommendation_feedback WHERE user_id = ?`);
    this.recentEvents = db.prepare(`SELECT DISTINCT track_id FROM taste_listening_events
      WHERE user_id = ? AND created_at > ? AND (event_type IN ('play','complete','skip') OR listened_seconds > 0)`);
  }

  bindSonic(service: SonicRecommendationService): void {
    this.sonic = service;
    this.pools.clear();
  }

  async selectWithSonic(userId: string, seedId: string, limit: number, excludeIds: readonly string[]) {
    const matches = this.sonic?.settings.enabled
      ? await this.sonic.nearest(seedId).catch(() => [])
      : [];
    return this.select(userId, seedId, limit, excludeIds, matches);
  }

  replaceCatalog(tracks: readonly Available<Track>[]): void {
    const next = new Map<string, Features>();
    for (const track of tracks) {
      next.set(track.id, {
        target: tasteTarget(track),
        track, genres: tags(track.genres), moods: tags(track.moods),
        artist: track.artistId || track.artistName.trim().toLowerCase(),
      });
    }
    this.tracks = next;
    for (const index of [this.byGenre, this.byArtist, this.byMood]) index.clear();
    const index = (map: Map<string, Features[]>, key: string, feature: Features) => {
      const entries = map.get(key);
      if (entries) entries.push(feature);
      else map.set(key, [feature]);
    };
    for (const feature of next.values()) {
      index(this.byArtist, feature.artist, feature);
      for (const genre of feature.genres) index(this.byGenre, genre, feature);
      for (const mood of feature.moods) index(this.byMood, mood, feature);
    }
    this.profiles.clear();
    this.pools.clear();
  }

  invalidate(userId: string): void {
    this.profiles.delete(userId);
    for (const key of this.pools.keys()) {
      if ((JSON.parse(key) as string[])[0] === userId) this.pools.delete(key);
    }
  }

  private profile(userId: string): Profile {
    const version = tasteProfile(this.db).state(userId).revision;
    const existing = this.profiles.get(userId);
    if (existing && existing.expires > this.now() && existing.version === version) return existing;
    const allows = tasteProfile(this.db).feedbackFilter(userId, [...this.tracks.values()].map(feature => feature.target));
    const affinity = new Map<string, number>();
    const artists = new Map<string, number>();
    const genres = new Map<string, number>();
    const weights = new Map<string, number>();
    const hidden = new Set<string>();
    const rows = this.events.all(userId) as Array<{ track_id: string; plays: number; skips: number }>;
    const legacyPlays = new Map((this.playCounts.all(userId) as Array<{ track_id: string; plays: number }>)
      .map((row) => [row.track_id, row.plays]));
    for (const row of rows) {
      affinity.set(row.track_id, Math.max(row.plays, legacyPlays.get(row.track_id) ?? 0) - row.skips);
      legacyPlays.delete(row.track_id);
    }
    for (const [id, plays] of legacyPlays) affinity.set(id, plays);
    for (const row of this.favorites.all(userId) as Array<{ track_id: string }>) {
      affinity.set(row.track_id, (affinity.get(row.track_id) ?? 0) + 1);
    }
    for (const row of this.feedback.all(userId) as Feedback[]) {
      const key = `${row.itemType}:${row.itemId}`;
      if (["hide", "not-interested", "block-artist", "block-album"].includes(row.action)) hidden.add(key);
      else weights.set(key, (weights.get(key) ?? 0) + row.weight * 8);
    }
    const signalledIds = new Set(affinity.keys());
    for (const key of weights.keys()) if (key.startsWith("track:")) signalledIds.add(key.slice(6));
    for (const id of signalledIds) {
      const feature = this.tracks.get(id);
      if (!feature || !allows(feature.target)) continue;
      const value = affinity.get(id) ?? 0;
      const explicit = weights.get(`track:${id}`) ?? 0;
      const artistValue = value + explicit;
      if (!artistValue) continue;
      artists.set(feature.artist, (artists.get(feature.artist) ?? 0) + artistValue);
      for (const genre of feature.genres) genres.set(genre, (genres.get(genre) ?? 0) + explicit);
    }
    const profile = { version, allows, expires: this.now() + CACHE_TTL_MS, affinity, artists, genres, weights, hidden };
    put(this.profiles, userId, profile);
    return profile;
  }

  private candidates(seed: Features, profile: Profile, excluded: Set<string>, sonic: readonly SonicMatch[]): Features[] {
    const selected = new Set<Features>();
    const add = (feature: Features | undefined) => {
      if (feature && selected.size < POOL_SIZE && !excluded.has(feature.track.id) && !this.blocked(feature, profile)) selected.add(feature);
    };
    for (const match of sonic) add(this.tracks.get(match.trackId));
    // Personal affinity is not lost when a very large genre cluster is capped.
    for (const [id, affinity] of profile.affinity) {
      if (affinity > 0) add(this.tracks.get(id));
      if (selected.size >= POOL_SIZE / 4) break;
    }
    const clusters = [
      this.byArtist.get(seed.artist) ?? [],
      ...(seed.track.relatedArtistIds ?? []).map((id) => this.byArtist.get(id) ?? []),
      ...[...seed.genres].map((genre) => this.byGenre.get(genre) ?? []),
      ...[...seed.moods].map((mood) => this.byMood.get(mood) ?? []),
    ];
    // Round-robin avoids letting one prolific artist consume the candidate pool.
    for (let offset = 0; selected.size < POOL_SIZE; offset++) {
      let available = false;
      for (const cluster of clusters) {
        if (offset < cluster.length) { available = true; add(cluster[offset]); }
      }
      if (!available) break;
    }
    for (const feature of this.tracks.values()) {
      if (selected.size >= POOL_SIZE) break;
      add(feature);
    }
    return [...selected];
  }

  private blocked(feature: Features, profile: Profile): boolean {
    const track = feature.track;
    return !profile.allows(feature.target) || profile.hidden.has(`track:${track.id}`) ||
      Boolean(track.artistId && profile.hidden.has(`artist:${track.artistId}`)) ||
      Boolean(track.albumId && profile.hidden.has(`album:${track.albumId}`));
  }

  select(userId: string, seedId: string, limit = 10, excludeIds: readonly string[] = [], sonic: readonly SonicMatch[] = []): LocalRecommendation[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RangeError("Recommendation limit must be from 1 to 50");
    const seed = this.tracks.get(seedId);
    if (!seed) throw new RecommendationSeedNotFoundError();
    const profile = this.profile(userId);
    const recentIds = new Set<string>([seedId]);
    const cutoff = new Date(this.now() - RECENT_PLAY_WINDOW_MS).toISOString();
    for (const row of this.recent.all(userId, cutoff) as Array<{ track_id: string }>) recentIds.add(row.track_id);
    for (const row of this.recentEvents.all(userId, cutoff) as Array<{ track_id: string }>) recentIds.add(row.track_id);
    const sonicWeight = this.sonic?.settings.enabled ? this.sonic.settings.weight : 0;
    const acoustic = sonicWeight ? sonic : [];
    const key = JSON.stringify([userId, seedId, acoustic.length ? [sonicWeight, acoustic] : null]);
    let pool = this.pools.get(key);
    if (!pool || pool.expires <= this.now() || pool.version !== profile.version) {
      const candidates: Candidate[] = [];
      const similarity = new Map(acoustic.map(match => [match.trackId, match.cosine]));
      for (const feature of this.candidates(seed, profile, recentIds, acoustic)) {
        const track = feature.track;
        if (track.id === seedId || this.blocked(feature, profile)) continue;
        const sharedGenres = overlap(seed.genres, feature.genres);
        const sharedMoods = overlap(seed.moods, feature.moods);
        const artistMatch = feature.artist === seed.artist;
        const related = Boolean(seed.track.relatedArtistIds?.includes(track.artistId ?? ""));
        const year = seed.track.year && track.year ? Math.max(0, 1 - Math.abs(seed.track.year - track.year) / 20) : 0;
        const bpm = seed.track.bpm && track.bpm ? Math.max(0, 1 - Math.abs(seed.track.bpm - track.bpm) / 40) : 0;
        const artistAffinity = bounded(profile.artists.get(feature.artist) ?? 0);
        let genreFeedback = 0;
        for (const genre of feature.genres) genreFeedback += bounded(profile.genres.get(genre) ?? 0);
        const sonicScore = Math.max(0, similarity.get(track.id) ?? 0) * sonicWeight;
        const score = sonicScore + sharedGenres * 6 + (artistMatch ? 4 : related ? 2 : 0) +
          year + bpm * 2 + sharedMoods * 2 + bounded(profile.affinity.get(track.id) ?? 0) +
          artistAffinity + genreFeedback +
          (profile.weights.get(`track:${track.id}`) ?? 0) +
          (profile.weights.get(`artist:${track.artistId}`) ?? 0) +
          (profile.weights.get(`album:${track.albumId}`) ?? 0);
        const shared = [...feature.genres].filter((genre) => seed.genres.has(genre)).slice(0, 2);
        const reasons = [
          sonicScore > 0 ? "acoustic similarity" : "",
          shared.length ? shared.join(" & ") : "",
          artistMatch ? `the same artist as ${seed.track.title}` : related ? "related artists" : "",
          artistAffinity > 0 ? "artists you play and favorite" : "",
          sharedMoods > 0 ? "a similar mood" : "",
          bpm > 0.5 ? "a similar tempo" : "",
        ].filter(Boolean);
        candidates.push({ feature, score, reason: `Based on ${reasons.join(", ") || `your library near ${seed.track.title}`}` });
      }
      candidates.sort((a, b) => b.score - a.score || a.feature.track.id.localeCompare(b.feature.track.id));
      pool = { version: profile.version, expires: this.now() + CACHE_TTL_MS, candidates: candidates.slice(0, POOL_SIZE) };
      put(this.pools, key, pool);
    }
    const excluded = new Set(excludeIds);
    for (const id of recentIds) excluded.add(id);
    const selected: LocalRecommendation[] = [];
    const artistCounts = new Map<string, number>();
    const eligible = pool.candidates.filter(({ feature }) => !excluded.has(feature.track.id) && !this.blocked(feature, profile));
    for (const maxPerArtist of [2, Number.POSITIVE_INFINITY]) {
      for (const candidate of eligible) {
        const { feature, score, reason } = candidate;
        if (excluded.has(feature.track.id) || (artistCounts.get(feature.artist) ?? 0) >= maxPerArtist) continue;
        selected.push({ track: feature.track, score, reason });
        excluded.add(feature.track.id);
        artistCounts.set(feature.artist, (artistCounts.get(feature.artist) ?? 0) + 1);
        if (selected.length >= limit) return selected;
      }
    }
    return selected;
  }
}
