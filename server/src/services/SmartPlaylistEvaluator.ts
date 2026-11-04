import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/database.js";
import type { CatalogListResult, CatalogService } from "../domain/catalog.js";
import type { Track } from "../types.js";
import { parseSmartPlaylistRule, type SmartPlaylistRule, type MixOptions } from "../types/smart-playlist.js";

const columns = {
  title: "t.title", artist: "t.artist", album: "t.album", genre: "t.genre",
  year: "t.year", era_year: "COALESCE(t.original_year,t.year)", bpm: "t.bpm", play_count: "MAX(COALESCE(s.plays,0),COALESCE(s.recent_plays,0))",
  skip_count: "COALESCE(s.skips,0)", is_favorite: "(f.track_id IS NOT NULL)",
  last_played: "MAX(COALESCE(s.last_played,0),COALESCE(s.recent_last_played,0))",
} as const;
type Parameter = string | number;

export function compileSmartPlaylistRule(input: unknown, now = Date.now()) {
  const rule = parseSmartPlaylistRule(input);
  const params: Parameter[] = [];
  const fields = new Set<string>();
  function visit(node: SmartPlaylistRule): string {
    if ("rules" in node) return `(${node.rules.map(visit).join(` ${node.operator} `)})`;
    fields.add(node.field);
    if (node.field === "similar_to") {
      params.push(String(node.value));
      // Metadata-based similarity, evaluated entirely in the local catalog.
      // Tempo refines a shared genre only when both tracks have BPM tags.
      return `t.id IN (SELECT candidate.id FROM smart_playlist_tracks candidate
        JOIN smart_playlist_tracks seed ON seed.id=?
        WHERE candidate.id!=seed.id AND (
          (LOWER(TRIM(seed.artist)) NOT IN ('','unknown artist','[unknown artist]','various artists')
            AND candidate.artist COLLATE NOCASE=seed.artist
            AND (seed.genre IS NULL OR candidate.genre IS NULL))
          OR (EXISTS (SELECT 1 FROM smart_playlist_genres cg
            JOIN smart_playlist_genres sg ON sg.track_id=seed.id AND sg.genre COLLATE NOCASE=cg.genre
            WHERE cg.track_id=candidate.id)
            AND (seed.bpm IS NULL OR seed.bpm<=0 OR candidate.bpm IS NULL OR candidate.bpm<=0
              OR ABS(candidate.bpm-seed.bpm)<=seed.bpm*0.15))))`;
    }
    const column = columns[node.field];
    if (node.field === "genre") {
      const contains = node.operator === "contains";
      params.push(contains ? `%${String(node.value).replace(/[\\%_]/g, "\\$&")}%` : String(node.value));
      // The separator is forbidden in rule values, so substring matches cannot
      // cross between tags. Exact matches use the normalized genre table.
      if (contains) return "t.genre LIKE ? ESCAPE '\\'";
      const match = "g.genre COLLATE NOCASE = ?";
      return `(t.genre IS NOT NULL AND t.id ${node.operator === "not_equals" ? "NOT " : ""}
        IN(SELECT g.track_id FROM smart_playlist_genres g WHERE ${match}))`;
    }
    if (node.operator === "in_last_days" || node.operator === "not_in_last_days") {
      params.push(now - Number(node.value) * 86_400_000);
      return node.operator === "in_last_days" ? `(${column}>0 AND ${column}>=?)`
        : `(${column}=0 OR ${column}<?)`;
    }
    if (node.operator === "contains") {
      // Treat user-supplied wildcard characters as text, never as LIKE patterns.
      params.push(`%${String(node.value).replace(/[\\%_]/g, "\\$&")}%`);
      return `${column} LIKE ? ESCAPE '\\'`;
    }
    const value = node.field === "last_played" ? Date.parse(String(node.value))
      : typeof node.value === "boolean" ? Number(node.value) : node.value;
    const operator = { equals: "=", not_equals: "!=", greater_than: ">", less_than: "<", matches: "=" }[node.operator];
    params.push(value);
    const comparison = `${column}${typeof value === "string" ? " COLLATE NOCASE" : ""} ${operator} ?`;
    return node.field === "last_played" ? `(${column}>0 AND ${comparison})` : comparison;
  }
  return { where: visit(rule), params, fields };
}

/** SQL evaluation never calls providers. The persisted catalog projection is
 * refreshed by catalog snapshots; user signals are read live for every query. */
export class SmartPlaylistEvaluator {
  private unsubscribe: (() => void) | null = null;
  private refresh: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    db.function("musicdeck_mix_rank", { deterministic: true }, (value, seed) => {
      let hash = 2166136261;
      for (const char of `${seed}:${value}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      return hash >>> 0;
    });
  }

  findSeeds(query: string, id?: string) {
    if (id) return this.db.prepare("SELECT id,title,artist,album FROM smart_playlist_tracks WHERE id=?").all(id);
    if (query.trim().length < 2) return [];
    const pattern = `%${query.trim().replace(/[\\%_]/g, "\\$&")}%`;
    return this.db.prepare(`SELECT id,title,artist,album FROM smart_playlist_tracks
      WHERE title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\'
      ORDER BY title COLLATE NOCASE,id LIMIT 12`).all(pattern, pattern);
  }

  replaceCatalog(snapshot: CatalogListResult<Track>): void {
    const revision = randomUUID();
    const insert = this.db.prepare(`INSERT INTO smart_playlist_tracks
      (id,title,artist,album,genre,year,bpm,revision,original_year) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist=excluded.artist,album=excluded.album,
      genre=excluded.genre,year=excluded.year,bpm=excluded.bpm,revision=excluded.revision,original_year=excluded.original_year`);
    const insertPayload = this.db.prepare(`INSERT INTO smart_playlist_track_payloads VALUES (?,?)
      ON CONFLICT(track_id) DO UPDATE SET track_json=excluded.track_json`);
    const clearGenres = this.db.prepare("DELETE FROM smart_playlist_genres WHERE track_id=?");
    const insertGenre = this.db.prepare("INSERT OR IGNORE INTO smart_playlist_genres VALUES (?,?)");
    this.db.transaction(() => {
      for (const track of snapshot.items) {
        insert.run(track.id, track.title, track.artistName, track.albumName,
          track.genres?.length ? track.genres.join("\u001f") : null, track.year ?? null, track.bpm ?? null, revision,
          track.originalReleaseYear ?? null);
        insertPayload.run(track.id, JSON.stringify(track));
        clearGenres.run(track.id);
        for (const genre of track.genres ?? []) insertGenre.run(track.id, genre);
      }
      // A failed source must not make its previously indexed tracks disappear.
      if (!snapshot.degraded) this.db.prepare("DELETE FROM smart_playlist_tracks WHERE revision != ?").run(revision);
      this.db.prepare(`INSERT INTO smart_playlist_catalog_state(singleton,refreshed_at,degraded) VALUES (1,?,?)
        ON CONFLICT(singleton) DO UPDATE SET refreshed_at=excluded.refreshed_at,degraded=excluded.degraded,mix_revision=mix_revision+1`)
        .run(new Date(this.now()).toISOString(), Number(snapshot.degraded));
    })();
  }

  connect(catalog: Pick<CatalogService, "subscribeTrackSnapshots" | "tracksForWindow">, log: (error: unknown) => void): void {
    if (this.unsubscribe) throw new Error("Smart playlist evaluator is already connected");
    let snapshotVersion = 0;
    this.unsubscribe = catalog.subscribeTrackSnapshots((snapshot) => {
      snapshotVersion += 1;
      this.replaceCatalog(snapshot);
    });
    const refresh = () => {
      if (this.refresh) return;
      const version = snapshotVersion;
      this.refresh = catalog.tracksForWindow().then((snapshot) => {
        // A scan completed after this request began; don't overwrite its newer snapshot.
        if (version === snapshotVersion) this.replaceCatalog(snapshot);
      }).catch((error: unknown) => {
        if (version === snapshotVersion) this.db.prepare("UPDATE smart_playlist_catalog_state SET degraded=1 WHERE singleton=1").run();
        log(error);
      }).finally(() => { this.refresh = null; });
    };
    refresh();
    this.timer = setInterval(refresh, 5 * 60_000);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.refresh;
  }

  evaluate(userId: string, input: unknown, options: { limit?: number; offset?: number; mix?: MixOptions } = {}) {
    const { where, params, fields } = compileSmartPlaylistRule(input, this.now());
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) {
      throw new RangeError("Invalid smart playlist result window");
    }
    const activity = fields.has("play_count") || fields.has("skip_count") || fields.has("last_played") || options.mix?.order === "rediscover";
    const favorite = fields.has("is_favorite");
    const prefix: Parameter[] = [];
    if (activity) prefix.push(userId);
    if (favorite) prefix.push(userId);
    const from = `FROM smart_playlist_tracks t
      ${activity ? "LEFT JOIN smart_playlist_activity s ON s.track_id=t.id AND s.user_id=?" : ""}
      ${favorite ? "LEFT JOIN favorites f ON f.track_id=t.id AND f.user_id=?" : ""}
      WHERE ${where}`;
    const bindings = [...prefix, ...params];
    const available = (this.db.prepare(`SELECT COUNT(*) AS count ${from}`).get(...bindings) as { count: number }).count;
    const total = options.mix ? Math.min(available, options.mix.size) : available;
    let order = "t.title COLLATE NOCASE,t.id";
    const orderParams: Parameter[] = [];
    if (options.mix) {
      if (options.mix.order === "similar") {
        const pending: SmartPlaylistRule[] = [parseSmartPlaylistRule(input)];
        let seed: string | undefined;
        while (pending.length) {
          const node = pending.pop()!;
          if ("rules" in node) pending.push(...node.rules);
          else if (node.field === "similar_to") { seed = String(node.value); break; }
        }
        if (seed) {
          order = `(SELECT (CASE WHEN t.artist COLLATE NOCASE=seed.artist THEN 20 ELSE 0 END)
            + 35*(SELECT COUNT(*) FROM smart_playlist_genres g JOIN smart_playlist_genres sg
              ON sg.track_id=seed.id AND sg.genre COLLATE NOCASE=g.genre WHERE g.track_id=t.id)
            + CASE WHEN t.bpm>0 AND seed.bpm>0 THEN MAX(0,20-ABS(t.bpm-seed.bpm)) ELSE 0 END
            FROM smart_playlist_tracks seed WHERE seed.id=?) DESC,`;
          orderParams.push(seed);
        } else order = "";
      } else if (options.mix.order === "rediscover") order = `${columns.last_played} ASC,`;
      else order = "";
      order += "musicdeck_mix_rank(t.id,?),t.id";
      orderParams.push(options.mix.seed);
    }
    const rows = this.db.prepare(`SELECT payload.track_json ${from.replace("FROM smart_playlist_tracks t", "FROM smart_playlist_tracks t JOIN smart_playlist_track_payloads payload ON payload.track_id=t.id")}
      ORDER BY ${order} LIMIT ? OFFSET ?`).all(...bindings, ...orderParams, Math.max(0, Math.min(limit, total-offset)), offset) as Array<{ track_json: string }>;
    const selectionToken = options.mix ? createHash("sha256").update(JSON.stringify(this.db.prepare(`SELECT t.id ${from}
      ORDER BY ${order} LIMIT ?`).all(...bindings, ...orderParams, options.mix.size))).digest("hex") : undefined;
    const state = this.db.prepare("SELECT refreshed_at, degraded FROM smart_playlist_catalog_state WHERE singleton=1")
      .get() as { refreshed_at: string; degraded: number } | undefined;
    return {
      total, available, selectionToken, tracks: rows.map((row) => JSON.parse(row.track_json) as Track),
      refreshedAt: state?.refreshed_at ?? null,
      warning: !state ? "The local catalog index is still loading. Try previewing again shortly."
        : state.degraded ? "Some library sources are unavailable. Results include their last indexed metadata." : null,
    };
  }
}
