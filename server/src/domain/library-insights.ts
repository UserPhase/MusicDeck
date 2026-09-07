import type { Db } from "../db/database.js";
import { createId } from "../utils/ids.js";
import type { CatalogService, Available } from "./catalog.js";
import type { Track } from "../types.js";
import { deriveCanonicalIdentity } from "./music-identity.js";
import { toTrackSearchResult } from "./search.js";

export type LibraryFilter = {
  field: string;
  op?: "eq" | "gte" | "lte" | "contains" | "boolean";
  value: unknown;
};

export type LibraryInsightsOptions = {
  userId: string;
  filters?: LibraryFilter[];
  limit?: number;
};

export type LibraryHealthIssue = {
  type:
    | "missing-artwork"
    | "missing-metadata"
    | "missing-artist"
    | "missing-album"
    | "duplicate-track"
    | "duplicate-album"
    | "unavailable"
    | "incomplete-album";
  itemType: "track" | "album" | "artist";
  itemId: string;
  title: string;
  detail: string;
};

function limit(value?: number) {
  return Math.max(1, Math.min(Number(value || 100), 500));
}

function ratings(db: Db, userId: string) {
  const rows = db.prepare(
    "SELECT item_type AS itemType, item_id AS itemId, rating FROM media_ratings WHERE user_id = ?"
  ).all(userId) as Array<{ itemType: string; itemId: string; rating: number }>;
  return new Map(rows.map((row) => [`${row.itemType}:${row.itemId}`, row.rating]));
}

function favorites(db: Db, userId: string) {
  const trackRows = db.prepare("SELECT track_id FROM favorites WHERE user_id = ?").all(userId) as Array<{ track_id: string }>;
  const mediaRows = db.prepare(
    "SELECT item_type AS itemType, item_id AS itemId FROM media_favorites WHERE user_id = ?"
  ).all(userId) as Array<{ itemType: string; itemId: string }>;
  return new Set([
    ...trackRows.map((row) => `track:${row.track_id}`),
    ...mediaRows.map((row) => `${row.itemType}:${row.itemId}`),
  ]);
}

function playStats(db: Db, userId: string) {
  const rows = db.prepare(`
    SELECT track_id AS trackId, COUNT(*) AS playCount, MAX(played_at) AS lastPlayedAt
    FROM recently_played
    WHERE user_id = ?
    GROUP BY track_id
  `).all(userId) as Array<{ trackId: string; playCount: number; lastPlayedAt: string }>;
  return new Map(rows.map((row) => [row.trackId, row]));
}

function match(item: Record<string, unknown>, filter: LibraryFilter) {
  const value = item[filter.field];
  const expected = filter.value;
  const op = filter.op || "eq";

  if (op === "boolean") return Boolean(value) === Boolean(expected);
  if (op === "gte") return Number(value ?? -Infinity) >= Number(expected);
  if (op === "lte") return Number(value ?? Infinity) <= Number(expected);
  if (op === "contains") {
    return String(value || "").toLowerCase().includes(String(expected || "").toLowerCase());
  }
  return String(value ?? "") === String(expected ?? "");
}

function decorateTrack(track: Available<Track>, db: Db, userId: string) {
  const rating = ratings(db, userId).get(`track:${track.id}`) ?? null;
  const favorite = favorites(db, userId).has(`track:${track.id}`);
  const play = playStats(db, userId).get(track.id);

  return {
    ...track,
    rating,
    favorite,
    playCount: play?.playCount || 0,
    played: Boolean(play),
    lastPlayedAt: play?.lastPlayedAt || null,
    libraryState: "owned",
    externalState: track.sources?.some((source) => source.id.startsWith("external")) ? "external" : "none",
  };
}

export class LibraryInsightsService {
  constructor(
    private readonly db: Db,
    private readonly catalog: CatalogService
  ) {}

  setRating(userId: string, itemType: "track" | "album" | "artist", itemId: string, rating: number | null) {
    if (rating === null) {
      this.db.prepare(
        "DELETE FROM media_ratings WHERE user_id = ? AND item_type = ? AND item_id = ?"
      ).run(userId, itemType, itemId);
      return;
    }

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new Error("Rating must be an integer between 1 and 5");
    }

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO media_ratings (user_id, item_type, item_id, rating, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET
        rating = excluded.rating,
        updated_at = excluded.updated_at
    `).run(userId, itemType, itemId, rating, now, now);
  }

  setFavorite(userId: string, itemType: "track" | "album" | "artist" | "playlist", itemId: string, favorite: boolean) {
    if (favorite) {
      this.db.prepare(`
        INSERT OR IGNORE INTO media_favorites (user_id, item_type, item_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(userId, itemType, itemId, new Date().toISOString());
    } else {
      this.db.prepare(
        "DELETE FROM media_favorites WHERE user_id = ? AND item_type = ? AND item_id = ?"
      ).run(userId, itemType, itemId);
    }
  }

  async tracks(options: LibraryInsightsOptions) {
    const result = await this.catalog.listTracks();
    const items = result.items
      .map((track) => decorateTrack(track, this.db, options.userId))
      .filter((track) => (options.filters || []).every((filter) => match(track as Record<string, unknown>, filter)))
      .slice(0, limit(options.limit));

    return { tracks: items, degraded: result.degraded };
  }

  async albums(userId: string) {
    const result = await this.catalog.listAlbums(1000);
    const ratingMap = ratings(this.db, userId);
    const favoriteSet = favorites(this.db, userId);
    return result.items.map((album) => ({
      ...album,
      rating: ratingMap.get(`album:${album.id}`) ?? null,
      favorite: favoriteSet.has(`album:${album.id}`),
      libraryState: "owned",
      completeness: "unknown",
    }));
  }

  async health(userId: string) {
    const [tracksResult, albumsResult, artistsResult] = await Promise.all([
      this.catalog.listTracks(),
      this.catalog.listAlbums(1000),
      this.catalog.listArtists(),
    ]);

    const issues: LibraryHealthIssue[] = [];
    const albumsById = new Map(albumsResult.items.map((album) => [album.id, album]));
    const trackCounts = new Map<string, number>();

    for (const track of tracksResult.items) {
      if (!track.artworkId) issues.push({ type: "missing-artwork", itemType: "track", itemId: track.id, title: track.title, detail: "Missing artwork" });
      if (!track.title) issues.push({ type: "missing-metadata", itemType: "track", itemId: track.id, title: "Untitled", detail: "Missing title" });
      if (!track.artistId || !track.artistName) issues.push({ type: "missing-artist", itemType: "track", itemId: track.id, title: track.title, detail: "Missing artist" });
      if (!track.albumId || !track.albumName) issues.push({ type: "missing-album", itemType: "track", itemId: track.id, title: track.title, detail: "Missing album" });
      if (track.availability.state === "unavailable") issues.push({ type: "unavailable", itemType: "track", itemId: track.id, title: track.title, detail: "Unavailable" });
      if (track.albumId) trackCounts.set(track.albumId, (trackCounts.get(track.albumId) || 0) + 1);
    }

    const trackGroups = new Map<string, Available<Track>[]>();
    for (const track of tracksResult.items) {
      const identity = deriveCanonicalIdentity(toTrackSearchResult(track));
      const key = identity.id;
      const group = trackGroups.get(key) || [];
      group.push(track);
      trackGroups.set(key, group);
    }

    for (const group of trackGroups.values()) {
      if (group.length > 1) {
        for (const track of group) {
          issues.push({ type: "duplicate-track", itemType: "track", itemId: track.id, title: track.title, detail: "Possible duplicate" });
        }
      }
    }

    for (const album of albumsResult.items) {
      if (!album.artworkId) issues.push({ type: "missing-artwork", itemType: "album", itemId: album.id, title: album.name, detail: "Missing artwork" });
      if (!album.artistId || !album.artistName) issues.push({ type: "missing-artist", itemType: "album", itemId: album.id, title: album.name, detail: "Missing artist" });
      if (album.availability.state === "unavailable") issues.push({ type: "unavailable", itemType: "album", itemId: album.id, title: album.name, detail: "Unavailable" });
      const count = trackCounts.get(album.id) || 0;
      if (album.songCount > 0 && count > 0 && count < album.songCount) {
        issues.push({ type: "incomplete-album", itemType: "album", itemId: album.id, title: album.name, detail: `${count} / ${album.songCount} tracks available` });
      }
    }

    const summary = {
      albums: albumsResult.items.length,
      tracks: tracksResult.items.length,
      artists: artistsResult.items.length,
      missingArtwork: issues.filter((issue) => issue.type === "missing-artwork").length,
      metadataIssues: issues.filter((issue) => ["missing-metadata", "missing-artist", "missing-album"].includes(issue.type)).length,
      duplicates: issues.filter((issue) => issue.type === "duplicate-track" || issue.type === "duplicate-album").length,
      unavailable: issues.filter((issue) => issue.type === "unavailable").length,
      incompleteAlbums: issues.filter((issue) => issue.type === "incomplete-album").length,
    };

    return {
      summary,
      issues: issues.slice(0, 200),
      degraded: tracksResult.degraded || albumsResult.degraded || artistsResult.degraded,
    };
  }

  async statistics(userId: string) {
    const [tracksResult, albumsResult, artistsResult] = await Promise.all([
      this.catalog.listTracks(),
      this.catalog.listAlbums(1000),
      this.catalog.listArtists(),
    ]);
    const tracks = tracksResult.items.map((track) => decorateTrack(track, this.db, userId));
    const totalDuration = tracks.reduce((sum, track) => sum + (track.durationSeconds || 0), 0);
    const played = tracks.filter((track) => track.played).length;
    const favoriteCount = tracks.filter((track) => track.favorite).length;
    const years = new Map<number, number>();
    const byArtist = new Map<string, number>();

    for (const album of albumsResult.items) {
      if (album.year) years.set(album.year, (years.get(album.year) || 0) + 1);
    }
    for (const track of tracks) {
      byArtist.set(track.artistName, (byArtist.get(track.artistName) || 0) + 1);
    }

    return {
      collection: {
        tracks: tracks.length,
        albums: albumsResult.items.length,
        artists: artistsResult.items.length,
        totalDurationSeconds: totalDuration,
        playedPercentage: tracks.length ? Math.round((played / tracks.length) * 100) : 0,
        favoritePercentage: tracks.length ? Math.round((favoriteCount / tracks.length) * 100) : 0,
        yearDistribution: Object.fromEntries([...years.entries()].sort(([left], [right]) => left - right)),
        artistDistribution: Object.fromEntries([...byArtist.entries()].sort((left, right) => right[1] - left[1]).slice(0, 20)),
      },
      degraded: tracksResult.degraded || albumsResult.degraded || artistsResult.degraded,
    };
  }

  saveFilter(userId: string, name: string, filters: LibraryFilter[]) {
    const id = createId("filter");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO saved_filters (id, user_id, name, filters_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, name, JSON.stringify(filters), now, now);
    return { id, name, filters };
  }

  listFilters(userId: string) {
    const rows = this.db.prepare(`
      SELECT id, name, filters_json AS filtersJson
      FROM saved_filters
      WHERE user_id = ?
      ORDER BY updated_at DESC
    `).all(userId) as Array<{ id: string; name: string; filtersJson: string }>;

    return rows.map((row) => {
      try {
        return { id: row.id, name: row.name, filters: JSON.parse(row.filtersJson) };
      } catch {
        return { id: row.id, name: row.name, filters: [] };
      }
    });
  }

  async collection(userId: string, kind: string, resultLimit = 50) {
    const { tracks } = await this.tracks({ userId, limit: 500 });
    let items = tracks;

    if (kind === "recently-added") {
      items = [...tracks].sort((left, right) => right.id.localeCompare(left.id));
    } else if (kind === "most-played") {
      items = [...tracks].sort((left, right) => right.playCount - left.playCount);
    } else if (kind === "never-played") {
      items = tracks.filter((track) => !track.played);
    } else if (kind === "forgotten") {
      items = tracks.filter((track) => track.favorite && track.playCount > 0);
    } else if (kind === "highest-rated") {
      items = tracks.filter((track) => track.rating !== null).sort((left, right) => (right.rating || 0) - (left.rating || 0));
    } else if (kind === "favorite-artists") {
      const favoriteArtists = new Set(tracks.filter((track) => track.favorite).map((track) => track.artistId || track.artistName));
      items = tracks.filter((track) => favoriteArtists.has(track.artistId || track.artistName));
    }

    return { tracks: items.slice(0, limit(resultLimit)), degraded: false };
  }
}
