import type { Db } from "../db/database.js";
import { createId } from "../utils/ids.js";
import type { CatalogService } from "./catalog.js";
import { toTrackSearchResult, type UnifiedSearchResult } from "./search.js";
import type { Available } from "./catalog.js";
import type { Track } from "../types.js";

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
  if (kind === "forgotten-favorites") return "You have not played this recently";
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
  constructor(
    private readonly db: Db,
    private readonly catalog: CatalogService
  ) {}

  recordListeningEvent(userId: string, trackId: string, eventType: "play" | "skip" | "complete", completionRatio?: unknown) {
    dbInsertEvent(this.db, userId, trackId, eventType, parseRatio(completionRatio));
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

  private async taste(userId: string) {
    const favoriteRows = this.db.prepare(
      "SELECT track_id FROM favorites WHERE user_id = ?"
    ).all(userId) as Array<{ track_id: string }>;
    const favorites = new Set(favoriteRows.map((row) => row.track_id));

    const recentRows = this.db.prepare(`
      SELECT track_id, COUNT(*) AS playCount, MAX(played_at) AS lastPlayedAt
      FROM recently_played
      WHERE user_id = ?
      GROUP BY track_id
    `).all(userId) as Array<{ track_id: string; playCount: number; lastPlayedAt: string }>;

    const eventRows = this.db.prepare(`
      SELECT track_id, event_type AS eventType, completion_ratio AS completionRatio
      FROM listening_events
      WHERE user_id = ?
    `).all(userId) as Array<{ track_id: string; eventType: string; completionRatio: number | null }>;

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

    for (const trackId of favorites) {
      const existing = byTrack.get(trackId) || { score: 0, playCount: 0, favorite: true, lastPlayedAt: null };
      byTrack.set(trackId, {
        ...existing,
        score: existing.score + 6,
        favorite: true,
      });
    }

    for (const event of eventRows) {
      const existing = byTrack.get(event.track_id) || { score: 0, playCount: 0, favorite: favorites.has(event.track_id), lastPlayedAt: null };
      const delta = event.eventType === "complete"
        ? 2 * (event.completionRatio ?? 1)
        : event.eventType === "skip"
          ? -2
          : 1;
      byTrack.set(event.track_id, {
        ...existing,
        score: existing.score + delta,
        playCount: existing.playCount + (event.eventType === "play" ? 1 : 0),
      });
    }

    const tracks: TasteEntry[] = [];
    for (const [trackId, stats] of byTrack) {
      try {
        const track = await this.catalog.getTrack(trackId);
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
      } catch {
        // Skip tracks whose provider is temporarily unavailable.
      }
    }

    return tracks;
  }

  private async libraryTracks(userId: string): Promise<Array<Available<Track>>> {
    const result = await this.catalog.listTracks();
    const feedback = this.feedback(userId);
    return result.items.filter((track) =>
      !feedback.blockedItems.has(track.id)
      && !(track.artistId && feedback.blockedArtists.has(track.artistId))
      && !(track.albumId && feedback.blockedAlbums.has(track.albumId))
    );
  }

  async recommend(context: RecommendationContext): Promise<UnifiedSearchResult[]> {
    const limit = clampLimit(context.limit);
    const [tracks, taste] = await Promise.all([
      this.libraryTracks(context.userId),
      this.taste(context.userId),
    ]);
    const tasteByTrack = new Map(taste.map((entry) => [entry.trackId, entry]));
    const topArtists = [...taste.values()]
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.artistId)
      .filter(Boolean)
      .slice(0, 5);
    const topAlbums = [...taste.values()]
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.albumId)
      .filter(Boolean)
      .slice(0, 5);
    const feedback = this.feedback(context.userId);

    let candidates: Array<{ track: Available<Track>; entry?: TasteEntry; score: number }> = [];

    for (const track of tracks) {
      const entry = tasteByTrack.get(track.id);
      const ageDays = entry?.lastPlayedAt
        ? (Date.now() - new Date(entry.lastPlayedAt).getTime()) / 86_400_000
        : Number.POSITIVE_INFINITY;
      let score = entry?.score || 0;

      if (context.kind === "continue-listening") {
        score = entry?.lastPlayedAt ? 10 - Math.min(ageDays, 10) : -100;
      } else if (context.kind === "favorites-mix") {
        score = entry?.favorite ? 20 + score : -100;
      } else if (context.kind === "forgotten-favorites") {
        score = (entry?.favorite || (entry?.playCount || 0) >= 2) && ageDays > 30 ? 15 + Math.min(ageDays / 30, 10) : -100;
      } else if (context.kind === "discover") {
        score = (entry?.playCount || 0) === 0
          ? (topArtists.includes(track.artistId) ? 8 : 2) + (topAlbums.includes(track.albumId) ? 3 : 0)
          : -100;
      } else if (context.kind === "radio-artist" || context.kind === "similar-artists") {
        score = track.artistId === context.seed?.artistId || track.artistName === context.seed?.artist ? 10 : topArtists.includes(track.artistId) ? 4 : 0;
      } else if (context.kind === "radio-album") {
        score = track.albumId === context.seed?.albumId || track.albumName === context.seed?.album ? 10 : topAlbums.includes(track.albumId) ? 4 : 0;
      } else if (context.kind === "radio-track" || context.kind === "similar-tracks") {
        if (track.id === context.seed?.id) continue;
        score = track.artistId === context.seed?.artistId || track.artistName === context.seed?.artist
          ? 8
          : track.albumId === context.seed?.albumId || track.albumName === context.seed?.album
            ? 6
            : topArtists.includes(track.artistId) ? 3 : 1;
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
