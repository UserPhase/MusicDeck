import type { Db } from "../db/database.js";
import { createId } from "../utils/ids.js";
import type { CatalogService, Available } from "./catalog.js";
import type { Track } from "../types.js";
import { auditCatalog, countIssues } from "./library-health.js";

export type LibraryFilter = {
  field: string;
  op?: "eq" | "gte" | "lte" | "contains" | "boolean";
  value: unknown;
};

export type LibraryInsightsOptions = {
  userId: string;
  filters?: LibraryFilter[];
  limit?: number;
  offset?: number;
};

export type { LibraryHealthIssue } from "./library-health.js";

function limit(value?: number) {
  return Math.max(1, Math.min(Number(value || 100), 500));
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

function match(value: unknown, filter: LibraryFilter) {
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

function trackAnnotations(db: Db, userId: string) {
  return { favorites: favorites(db, userId), plays: playStats(db, userId) };
}

type CatalogTrack = Available<Track>;
type TrackAnnotations = ReturnType<typeof trackAnnotations>;

const trackAnnotationFields = {
  favorite: (track: CatalogTrack, annotations: TrackAnnotations) => annotations.favorites.has(`track:${track.id}`),
  playCount: (track: CatalogTrack, annotations: TrackAnnotations) => annotations.plays.get(track.id)?.playCount || 0,
  played: (track: CatalogTrack, annotations: TrackAnnotations) => annotations.plays.has(track.id),
  lastPlayedAt: (track: CatalogTrack, annotations: TrackAnnotations) => annotations.plays.get(track.id)?.lastPlayedAt || null,
  libraryState: () => "owned",
  externalState: (track: CatalogTrack) => track.sources?.some((source) => source.id.startsWith("external")) ? "external" : "none",
};

function decorateTrack(track: CatalogTrack, annotations: TrackAnnotations) {
  return {
    ...track,
    favorite: trackAnnotationFields.favorite(track, annotations),
    playCount: trackAnnotationFields.playCount(track, annotations),
    played: trackAnnotationFields.played(track, annotations),
    lastPlayedAt: trackAnnotationFields.lastPlayedAt(track, annotations),
    libraryState: trackAnnotationFields.libraryState(),
    externalState: trackAnnotationFields.externalState(track),
  };
}

export class LibraryInsightsService {
  constructor(
    private readonly db: Db,
    private readonly catalog: CatalogService
  ) {}

  setFavorite(userId: string, itemType: "track" | "album" | "artist" | "playlist", itemId: string, favorite: boolean, metadata?: Record<string, unknown>) {
    if (favorite) {
      this.db.prepare(`
        INSERT INTO media_favorites (user_id, item_type, item_id, created_at, metadata_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET
          metadata_json = COALESCE(excluded.metadata_json, media_favorites.metadata_json)
      `).run(userId, itemType, itemId, new Date().toISOString(), metadata ? JSON.stringify(metadata) : null);
    } else {
      this.db.prepare(
        "DELETE FROM media_favorites WHERE user_id = ? AND item_type = ? AND item_id = ?"
      ).run(userId, itemType, itemId);
    }
  }

  async tracks(options: LibraryInsightsOptions) {
    const result = await (options.offset === undefined ? this.catalog.listTracks() : this.catalog.tracksForWindow());
    const offset = options.offset ?? 0;
    const end = offset + limit(options.limit);
    const revision = "revision" in result ? result.revision : undefined;
    const { items, degraded } = result;
    const filters = options.filters ?? [];

    if (!filters.length) {
      const page = items.slice(offset, end);
      if (!page.length) return { tracks: [], total: items.length, revision, degraded };
      const annotations = trackAnnotations(this.db, options.userId);
      return { tracks: page.map((track) => decorateTrack(track, annotations)), total: items.length, revision, degraded };
    }

    const annotations = trackAnnotations(this.db, options.userId);
    const predicates = filters.map((filter) => {
      const { field } = filter;
      const readAnnotation = Object.hasOwn(trackAnnotationFields, field)
        ? trackAnnotationFields[field as keyof typeof trackAnnotationFields]
        : undefined;
      return (track: CatalogTrack) => match(
        readAnnotation ? readAnnotation(track, annotations) : (track as Record<string, unknown>)[field], filter,
      );
    });
    const tracks: ReturnType<typeof decorateTrack>[] = [];
    let total = 0;
    // Exact totals require checking all matches, but only the requested page needs copies.
    catalog:
    for (const track of items) {
      for (const predicate of predicates) {
        if (!predicate(track)) continue catalog;
      }
      if (total >= offset && total < end) tracks.push(decorateTrack(track, annotations));
      total++;
    }
    return { tracks, total, revision, degraded };
  }

  async collectorTracks(userId: string) {
    const result = await this.catalog.tracksForWindow();
    const annotations = trackAnnotations(this.db, userId);
    return { tracks: result.items.map(track => decorateTrack(track, annotations)), degraded: result.degraded };
  }

  async albums(userId: string) {
    const result = await this.catalog.listAlbums(1000);
    const favoriteSet = favorites(this.db, userId);
    return result.items.map((album) => ({
      ...album,
      favorite: favoriteSet.has(`album:${album.id}`),
      libraryState: "owned",
      completeness: "unknown",
    }));
  }

  async health(_userId: string) {
    const [tracksResult, albumsResult, artistsResult] = await Promise.all([
      this.catalog.listTracks(),
      this.catalog.listAlbums(1000),
      this.catalog.listArtists(),
    ]);

    // The album listing is capped here, so missing-album sync checks stay off.
    const issues = await auditCatalog(tracksResult.items, albumsResult.items, { yieldEvery: 1000 });
    const counts = countIssues(issues);
    const summary = {
      albums: albumsResult.items.length,
      tracks: tracksResult.items.length,
      artists: artistsResult.items.length,
      missingArtwork: counts.missingArtwork,
      metadataIssues: counts.metadataIssues,
      duplicates: counts.duplicates,
      unavailable: counts.unavailable,
      incompleteAlbums: counts.incompleteAlbums,
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
    const annotations = trackAnnotations(this.db, userId);
    const tracks = tracksResult.items.map((track) => decorateTrack(track, annotations));
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
    } else if (kind === "favorite-artists") {
      const favoriteArtists = new Set(tracks.filter((track) => track.favorite).map((track) => track.artistId || track.artistName));
      items = tracks.filter((track) => favoriteArtists.has(track.artistId || track.artistName));
    }

    return { tracks: items.slice(0, limit(resultLimit)), degraded: false };
  }
}
