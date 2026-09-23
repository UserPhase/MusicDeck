import type { Db } from "../db/database.js";
import { createId } from "../utils/ids.js";
import type { CatalogService } from "./catalog.js";
import { toTrackSearchResult, type UnifiedSearchResult } from "./search.js";
import type { Available } from "./catalog.js";
import type { Track } from "../types.js";
import { canUseProviderHistory, listeningWindowStart } from "./recently-played.js";

export type RecommendationKind =
  | "continue-listening"
  | "favorites-mix"
  | "forgotten-favorites"
  | "discover"
  | "similar-tracks"
  | "similar-artists"
  | "radio-track"
  | "radio-artist"
  | "radio-album";

export type RecommendationContext = {
  userId: string;
  kind: RecommendationKind;
  limit: number;
  seed?: {
    type: "track" | "artist" | "album";
    id: string;
    title?: string;
    artist?: string;
    album?: string;
    artistId?: string | null;
    albumId?: string | null;
  };
};

export interface RecommendationProvider {
  id: string;
  name: string;
  recommend(context: RecommendationContext): Promise<UnifiedSearchResult[]>;
}

export type RecommendationSection = {
  id: RecommendationKind;
  title: string;
  items: UnifiedSearchResult[];
};

type TasteEntry = {
  trackId: string;
  score: number;
  playCount: number;
  favorite: boolean;
  lastPlayedAt: string | null;
  artistId: string | null;
  artistName: string;
  albumId: string | null;
  albumName: string;
};

type FeedbackAction =
  | "hide"
  | "not-interested"
  | "more-like-this"
  | "less-like-this"
  | "block-artist"
  | "block-album";

function parseRatio(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1, number));
}

function clampLimit(limit: number) {
  return Math.max(1, Math.min(Number(limit) || 12, 30));
}

function reasonFor(kind: RecommendationKind, entry?: TasteEntry) {
  if (kind === "continue-listening") return "Recently played";
  if (kind === "favorites-mix") return "From your favorites";
  if (kind === "forgotten-favorites") return entry?.artistName ? `A deep cut from ${entry.artistName}` : "A deep cut from your library";
  if (kind === "discover") return entry?.artistName ? `Because you listen to ${entry.artistName}` : "Discover something new";
  if (kind === "similar-artists") return entry?.artistName ? `Similar to ${entry.artistName}` : "Similar artists";
  return "Recommended for you";
}

function withReason(item: UnifiedSearchResult, reason: string): UnifiedSearchResult {
  return {
    ...item,
    metadata: {
      ...item.metadata,
      recommendationReason: reason,
    },
  };
}

function diversify(items: UnifiedSearchResult[], limit: number, maxPerArtist = 2, maxPerAlbum = 2) {
  const byArtist = new Map<string, number>();
  const byAlbum = new Map<string, number>();
  const selected: UnifiedSearchResult[] = [];
  const overflow: UnifiedSearchResult[] = [];

  for (const item of items) {
    const artistKey = item.metadata.artistId || item.artist || item.title;
    const albumKey = item.metadata.albumId || item.album || item.id;
    const artistCount = byArtist.get(artistKey) || 0;
    const albumCount = byAlbum.get(albumKey) || 0;

    if (artistCount >= maxPerArtist || albumCount >= maxPerAlbum) {
      overflow.push(item);
      continue;
    }

    byArtist.set(artistKey, artistCount + 1);
    byAlbum.set(albumKey, albumCount + 1);
    selected.push(item);
    if (selected.length >= limit) return selected;
  }

  for (const item of overflow) {
    selected.push(item);
    if (selected.length >= limit) break;
  }

  return selected;
}

export class RecommendationService {
  private readonly tasteCache = new Map<string, { expiresAt: number; entries: TasteEntry[] }>();
  private readonly libraryCache = new Map<string, { expiresAt: number; promise: Promise<Array<Available<Track>>> }>();
  constructor(
    private readonly db: Db,
    private readonly catalog: CatalogService
  ) {}

  recordListeningEvent(userId: string, trackId: string, eventType: "play" | "skip" | "complete", completionRatio?: unknown) {
    dbInsertEvent(this.db, userId, trackId, eventType, parseRatio(completionRatio));
    this.tasteCache.delete(userId);
    this.libraryCache.delete(userId);
  }

  setFeedback(userId: string, action: FeedbackAction, itemType: "track" | "artist" | "album", itemId: string) {
    const weight = action === "more-like-this"
      ? 1
      : action === "less-like-this"
        ? -0.5
        : -1;

    this.db.prepare(`
      INSERT INTO recommendation_feedback (user_id, item_type, item_id, action, weight, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, item_type, item_id, action) DO UPDATE SET
        weight = excluded.weight,
        updated_at = excluded.updated_at
    `).run(userId, itemType, itemId, action, weight, new Date().toISOString(), new Date().toISOString());
    this.libraryCache.delete(userId);
    this.tasteCache.delete(userId);
  }

  private feedback(userId: string) {
    const rows = this.db.prepare(`
      SELECT item_type AS itemType, item_id AS itemId, action, weight
      FROM recommendation_feedback
      WHERE user_id = ?
    `).all(userId) as Array<{ itemType: string; itemId: string; action: string; weight: number }>;

    return {
      blockedItems: new Set(rows.filter((row) => row.action === "hide" || row.action === "not-interested").map((row) => row.itemId)),
      blockedArtists: new Set(rows.filter((row) => row.action === "block-artist").map((row) => row.itemId)),
      blockedAlbums: new Set(rows.filter((row) => row.action === "block-album").map((row) => row.itemId)),
      weightFor(id: string) {
        return rows.filter((row) => row.itemId === id).reduce((sum, row) => sum + row.weight, 0);
      },
    };
  }

  private taste(userId: string, libraryTracks: Array<Available<Track>>) {
    const cached = this.tasteCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.entries;
    const cutoff = listeningWindowStart();
    const favoriteRows = this.db.prepare(
      "SELECT track_id FROM favorites WHERE user_id = ?"
    ).all(userId) as Array<{ track_id: string }>;
    const favorites = new Set(favoriteRows.map((row) => row.track_id));

    const recentRows = this.db.prepare(`
      SELECT track_id, COUNT(*) AS playCount, MAX(played_at) AS lastPlayedAt
      FROM recently_played
      WHERE user_id = ? AND played_at >= ?
      GROUP BY track_id
    `).all(userId, cutoff) as Array<{ track_id: string; playCount: number; lastPlayedAt: string }>;

    const eventRows = this.db.prepare(`
      SELECT track_id,
        SUM(CASE event_type WHEN 'complete' THEN 2 * COALESCE(completion_ratio, 1)
          WHEN 'skip' THEN -2 ELSE 1 END) AS scoreDelta,
        SUM(CASE WHEN event_type = 'complete' THEN 1 ELSE 0 END) AS completedCount,
        MAX(CASE WHEN event_type = 'complete' THEN created_at END) AS lastCompletedAt
      FROM listening_events
      WHERE user_id = ? AND created_at >= ?
      GROUP BY track_id
    `).all(userId, cutoff) as Array<{
      track_id: string; scoreDelta: number; completedCount: number; lastCompletedAt: string | null;
    }>;

    const byTrack = new Map<string, {
      score: number;
      playCount: number;
      favorite: boolean;
      lastPlayedAt: string | null;
    }>();

    for (const row of recentRows) {
      byTrack.set(row.track_id, {
        score: row.playCount * 2,
        playCount: row.playCount,
        favorite: favorites.has(row.track_id),
        lastPlayedAt: row.lastPlayedAt,
      });
    }

    for (const event of eventRows) {
      const existing = byTrack.get(event.track_id) || { score: 0, playCount: 0, favorite: favorites.has(event.track_id), lastPlayedAt: null };
      byTrack.set(event.track_id, {
        ...existing,
        // A qualified event and its recently_played row describe the same
        // listen. Take the fuller count instead of double-counting it.
        score: (event.completedCount ? 0 : existing.score) + event.scoreDelta,
        playCount: Math.max(existing.playCount, event.completedCount),
        lastPlayedAt: event.lastCompletedAt && (!existing.lastPlayedAt || event.lastCompletedAt > existing.lastPlayedAt)
          ? event.lastCompletedAt : existing.lastPlayedAt,
      });
    }

    // Subsonic exposes only the last play and all-time count, not a dated
    // scrobble log. Use a recent provider timestamp as a coarse seed for
    // listens made in other clients; local qualified events remain precise.
    for (const track of canUseProviderHistory(this.db) ? libraryTracks : []) {
      if (!track.lastPlayedAt) continue;
      const playedAt = Date.parse(track.lastPlayedAt);
      if (!Number.isFinite(playedAt) || playedAt < Date.parse(cutoff)) continue;
      const existing = byTrack.get(track.id);
      if (existing) {
        if (!existing.lastPlayedAt || playedAt > Date.parse(existing.lastPlayedAt)) {
          byTrack.set(track.id, { ...existing, lastPlayedAt: track.lastPlayedAt });
        }
        continue;
      }
      byTrack.set(track.id, {
        score: 2, playCount: 1, favorite: favorites.has(track.id), lastPlayedAt: track.lastPlayedAt,
      });
    }

    const tracks: TasteEntry[] = [];
    const catalogById = new Map(libraryTracks.map((track) => [track.id, track]));
    for (const [trackId, stats] of byTrack) {
      const track = catalogById.get(trackId);
      if (!track) continue;
      tracks.push({
        trackId,
        score: stats.score,
        playCount: stats.playCount,
        favorite: stats.favorite,
        lastPlayedAt: stats.lastPlayedAt,
        artistId: track.artistId,
        artistName: track.artistName,
        albumId: track.albumId,
        albumName: track.albumName,
      });
    }
    this.tasteCache.set(userId, { entries: tracks, expiresAt: Date.now() + 30_000 });
    return tracks;
  }

  private async libraryTracks(userId: string): Promise<Array<Available<Track>>> {
    const cached = this.libraryCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    const promise = this.catalog.listTracks().then((result) => {
      const feedback = this.feedback(userId);
      return result.items.filter((track) =>
        !feedback.blockedItems.has(track.id)
        && !(track.artistId && feedback.blockedArtists.has(track.artistId))
        && !(track.albumId && feedback.blockedAlbums.has(track.albumId))
      );
    }).catch((error) => {
      this.libraryCache.delete(userId);
      throw error;
    });
    this.libraryCache.set(userId, { expiresAt: Date.now() + 30_000, promise });
    return promise;
  }

  async recommend(context: RecommendationContext): Promise<UnifiedSearchResult[]> {
    const limit = clampLimit(context.limit);
    const tracks = await this.libraryTracks(context.userId);
    const taste = this.taste(context.userId, tracks);
    const tasteByTrack = new Map(taste.map((entry) => [entry.trackId, entry]));
    const favoriteIds = new Set((this.db.prepare("SELECT track_id FROM favorites WHERE user_id = ?")
      .all(context.userId) as Array<{ track_id: string }>).map((row) => row.track_id));
    const ranked = (key: "artistId" | "albumId") => [...taste.reduce((totals, entry) => {
      const id = entry[key];
      if (id) totals.set(id, (totals.get(id) || 0) + Math.max(0, entry.score));
      return totals;
    }, new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
    const topArtists = ranked("artistId");
    const topAlbums = ranked("albumId");
    const feedback = this.feedback(context.userId);
    const providerHistoryIsPersonal = canUseProviderHistory(this.db);
    const lifetimeRows = context.kind === "discover" || context.kind === "forgotten-favorites"
      ? this.db.prepare(`
          SELECT track_id, COUNT(*) AS playCount FROM listening_events
          WHERE user_id = ? AND event_type = 'complete' GROUP BY track_id
        `).all(context.userId) as Array<{ track_id: string; playCount: number }>
      : [];
    const localLifetime = new Map(lifetimeRows.map((row) => [row.track_id, row.playCount]));

    let candidates: Array<{ track: Available<Track>; entry?: TasteEntry; score: number }> = [];

    for (const track of tracks) {
      const entry = tasteByTrack.get(track.id);
      const ageDays = entry?.lastPlayedAt
        ? (Date.now() - new Date(entry.lastPlayedAt).getTime()) / 86_400_000
        : Number.POSITIVE_INFINITY;
      let score = entry?.score || 0;
      const lifetimePlays = Math.max(
        providerHistoryIsPersonal ? (track.playCount || 0) : 0,
        localLifetime.get(track.id) || 0,
        entry?.playCount || 0
      );
      const matchesArtist = Boolean(track.artistId && topArtists.includes(track.artistId));
      const matchesAlbum = Boolean(track.albumId && topAlbums.includes(track.albumId));

      if (context.kind === "continue-listening") {
        score = entry?.lastPlayedAt && ageDays <= 45 ? 45 - ageDays : -100;
      } else if (context.kind === "favorites-mix") {
        score = favoriteIds.has(track.id) ? 20 + score : -100;
      } else if (context.kind === "forgotten-favorites") {
        const affinity = (matchesArtist ? 10 : 0) + (matchesAlbum ? 3 : 0);
        score = affinity && lifetimePlays <= 1
          ? affinity + (lifetimePlays === 0 ? 3 : 0)
          : taste.length === 0 && lifetimePlays === 0 ? 1 : -100;
      } else if (context.kind === "discover") {
        score = lifetimePlays === 0
          ? (matchesArtist ? 8 : 2) + (matchesAlbum ? 3 : 0)
          : -100;
      } else if (context.kind === "radio-artist" || context.kind === "similar-artists") {
        score = track.artistId === context.seed?.artistId || track.artistName === context.seed?.artist ? 10 : matchesArtist ? 4 : 0;
      } else if (context.kind === "radio-album") {
        score = track.albumId === context.seed?.albumId || track.albumName === context.seed?.album ? 10 : matchesAlbum ? 4 : 0;
      } else if (context.kind === "radio-track" || context.kind === "similar-tracks") {
        if (track.id === context.seed?.id) continue;
        score = track.artistId === context.seed?.artistId || track.artistName === context.seed?.artist
          ? 8
          : track.albumId === context.seed?.albumId || track.albumName === context.seed?.album
            ? 6
            : matchesArtist ? 3 : 1;
      }

      score += feedback.weightFor(track.id);
      if (track.artistId) score += feedback.weightFor(track.artistId) * 0.5;
      if (track.albumId) score += feedback.weightFor(track.albumId) * 0.25;

      if (score > -50) {
        candidates.push({ track, entry, score });
      }
    }

    candidates.sort((left, right) => right.score - left.score || left.track.title.localeCompare(right.track.title));

    if (context.kind === "similar-artists") {
      const seenArtists = new Set<string>();
      candidates = candidates.filter(({ track }) => {
        const key = track.artistId || track.artistName;
        if (seenArtists.has(key)) return false;
        seenArtists.add(key);
        return true;
      });
    }

    return diversify(candidates.map(({ track, entry }) =>
      withReason(toTrackSearchResult(track), reasonFor(context.kind, entry))
    ), limit);
  }

  async radio(seed: RecommendationContext["seed"], userId: string, limit = 20) {
    if (!seed) return [];
    const kind: RecommendationKind = seed.type === "artist"
      ? "radio-artist"
      : seed.type === "album"
        ? "radio-album"
        : "radio-track";

    return this.recommend({
      userId,
      kind,
      limit,
      seed,
    });
  }
}

function dbInsertEvent(db: Db, userId: string, trackId: string, eventType: string, completionRatio: number | null) {
  db.prepare(`
    INSERT INTO listening_events (id, user_id, track_id, event_type, completion_ratio, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(createId("listen"), userId, trackId, eventType, completionRatio, new Date().toISOString());
}

/**
 * Provider-neutral recommendation registry. Built-in recommendations are
 * deterministic and local; future external/plugin providers register behind
 * the same interface and failures are isolated from local results.
 */
export class RecommendationRegistry {
  private readonly providers: RecommendationProvider[] = [];

  constructor(readonly local: RecommendationService) {
    this.providers.push({
      id: "local",
      name: "MusicDeck",
      recommend: (context) => this.local.recommend(context),
    });
  }

  register(provider: RecommendationProvider) {
    const existing = this.providers.findIndex((item) => item.id === provider.id);
    if (existing >= 0) {
      this.providers[existing] = provider;
      return;
    }
    this.providers.push(provider);
  }

  list() {
    return this.providers.map((provider) => ({ id: provider.id, name: provider.name }));
  }

  async recommend(context: RecommendationContext) {
    const outcomes = await Promise.all(this.providers.map(async (provider) => {
      try {
        return { ok: true as const, items: await provider.recommend(context) };
      } catch {
        return { ok: false as const, items: [] as UnifiedSearchResult[] };
      }
    }));

    const items = outcomes.flatMap((outcome) => outcome.items);
    const seen = new Set<string>();
    return {
      items: items.filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }).slice(0, clampLimit(context.limit)),
      degraded: outcomes.some((outcome) => !outcome.ok),
    };
  }

  async sections(userId: string, kinds: RecommendationKind[], limit = 12) {
    const sections: RecommendationSection[] = [];
    let degraded = false;

    for (const kind of kinds) {
      const result = await this.recommend({ userId, kind, limit });
      degraded ||= result.degraded;
      if (result.items.length > 0) {
        sections.push({
          id: kind,
          title: titleFor(kind),
          items: result.items,
        });
      }
    }

    return { sections, degraded };
  }
}

function titleFor(kind: RecommendationKind) {
  switch (kind) {
    case "continue-listening": return "Continue listening";
    case "favorites-mix": return "Made for you";
    case "forgotten-favorites": return "Forgotten favorites";
    case "discover": return "Discover something new";
    case "similar-artists": return "Similar artists";
    default: return "Recommended";
  }
}
