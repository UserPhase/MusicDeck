import { Readable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import path from "node:path";
import archiver from "archiver";
import type { Db } from "../db/database.js";
import type { CatalogService } from "../domain/catalog.js";
import { ALLOWED_USER_SETTINGS } from "../domain/settings.js";
import { playlistReadPredicate } from "./PlaylistCollaborationService.js";

export const EXPORT_PAGE_SIZE = 500;
export type PlaylistExportFormat = "m3u8" | "xspf";
export type ExportKind = "playlists" | "history" | "favorites" | "settings" | "bundle";
type Row = Record<string, unknown>;
type PlaylistRow = { id: string; name: string; description: string | null };
type ExportTrack = {
  occurrence_id: string; track_id: string; provider_track_id: string; connection_id: string;
  title: string; artist: string; album: string; duration_seconds: number | null;
  location: string; location_type: "media-relative" | "authenticated-stream"; unavailable: boolean;
};
export interface ExportSummary {
  generatedAt: string;
  playlists: { id: string; name: string; tracks: number; estimatedBytes: { m3u8: number; xspf: number } }[];
  counts: { playlists: number; playlistTracks: number; history: number; favorites: number; feedback: number; ratings: number; settings: number; smartPlaylists: number; savedDiscoveries: number };
  estimatedBytes: { history: number; favorites: number; settings: number; json: number; zip: number };
  notes: string[];
}
export class ExportNotFoundError extends Error {}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function objectJson(value: unknown): Row {
  if (value === null || value === undefined) return {};
  const parsed: unknown = JSON.parse(String(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Stored export metadata is not an object.");
  return parsed as Row;
}
function line(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, " "); }
export function xmlText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udfff]/gu, "")
    .replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}
/** RFC 4180 quoting, plus spreadsheet formula-injection protection for textual cells. */
export function csvCell(value: unknown): string {
  let result = value == null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(result) || /^[\t\r\n]/.test(result)) result = `'${result}`;
  return `"${result.replace(/"/g, '""')}"`;
}
function safeFileName(name: string, id: string): string {
  const clean = name.normalize("NFKC").replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+|[. ]+$/g, "").slice(0, 80);
  return `${clean || "playlist"}-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/** All database enumeration is bounded; no long-lived SQLite iterator or transaction
 * remains open while the HTTP client is applying backpressure. */
export class DataExportService {
  private readonly baseUrl: URL;
  constructor(
    private readonly db: Db,
    private readonly catalog: Pick<CatalogService, "getTrack" | "getTrackFilePath">,
    private readonly options: { publicUrl: string; musicRoot: string; log(error: unknown, message: string): void },
  ) {
    this.baseUrl = new URL(options.publicUrl);
    if (!["http:", "https:"].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password
      || this.baseUrl.search || this.baseUrl.hash) throw new Error("Export public URL must be an HTTP(S) URL without credentials, query or fragment.");
    if (!this.baseUrl.pathname.endsWith("/")) this.baseUrl.pathname += "/";
  }

  private async *rows(table: string, where: string, params: (string | number)[], signal?: AbortSignal, columns = "t.*", joins = ""): AsyncGenerator<Row> {
    const upper = (this.db.prepare(`SELECT COALESCE(MAX(rowid),0) AS last FROM ${table} t WHERE ${where}`).get(...params) as { last: number }).last;
    const statement = this.db.prepare(`SELECT ${columns},t.rowid AS _export_row FROM ${table} t ${joins}
      WHERE ${where} AND t.rowid>? AND t.rowid<=? ORDER BY t.rowid LIMIT ${EXPORT_PAGE_SIZE}`);
    let cursor = 0;
    while (cursor < upper) {
      signal?.throwIfAborted();
      const page = statement.all(...params, cursor, upper) as Row[];
      if (!page.length) break;
      for (const row of page) {
        signal?.throwIfAborted();
        cursor = Number(row._export_row);
        const { _export_row, ...value } = row;
        yield value;
      }
      await nextTurn(undefined, { signal });
    }
  }

  private owned(userId: string, playlistId: string): PlaylistRow {
    const result = this.db.prepare(`SELECT id,name,description FROM playlists p WHERE id=@playlistId AND deleted_at IS NULL AND ${playlistReadPredicate()}`)
      .get({ playlistId, viewer: userId, isAdmin: 0 }) as PlaylistRow | undefined;
    if (!result) throw new ExportNotFoundError("Playlist not found.");
    return result;
  }

  private playlists(userId: string, signal?: AbortSignal) {
    return this.rows("playlists", `t.deleted_at IS NULL AND ${playlistReadPredicate("t").replace(/@viewer/g, "?").replace(/@isAdmin/g, "0")}`, [userId, userId], signal, "t.id,t.name,t.description,t.created_at,t.updated_at");
  }

  summary(userId: string): ExportSummary {
    const playlists = this.db.prepare(`SELECT p.id,p.name,COUNT(i.id) AS tracks
      FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id=p.id WHERE p.deleted_at IS NULL AND ${playlistReadPredicate()} GROUP BY p.id ORDER BY p.name,p.id`)
      .all({ viewer: userId, isAdmin: 0 }) as { id: string; name: string; tracks: number }[];
    const count = (table: string, extra = "") => (this.db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE user_id=? ${extra}`).get(userId) as { total: number }).total;
    const favorites = (this.db.prepare(`SELECT COUNT(*) AS total FROM (
      SELECT 'track',track_id FROM favorites WHERE user_id=? UNION
      SELECT item_type,item_id FROM media_favorites WHERE user_id=?)`).get(userId, userId) as { total: number }).total;
    const counts = {
      playlists: playlists.length, playlistTracks: playlists.reduce((sum, item) => sum + item.tracks, 0),
      history: count("listening_events"), favorites, feedback: count("recommendation_feedback"), ratings: count("media_ratings"),
      settings: (this.db.prepare(`SELECT key FROM user_settings WHERE user_id=?`).all(userId) as { key: string }[])
        .filter((row) => ALLOWED_USER_SETTINGS.has(row.key)).length,
      smartPlaylists: count("smart_playlists"), savedDiscoveries: count("saved_discoveries"),
    };
    // Estimates deliberately avoid provider requests and scanning all history payloads.
    const history = 110 + counts.history * 240;
    const favoriteBytes = 100 + (favorites + counts.feedback + counts.ratings) * 300;
    const settings = 100 + counts.settings * 120;
    const json = history * 2 + favoriteBytes + settings + counts.playlistTracks * 700
      + counts.smartPlaylists * 1500 + counts.savedDiscoveries * 2000 + 2000;
    return {
      generatedAt: new Date().toISOString(),
      playlists: playlists.map((item) => ({ ...item, estimatedBytes: { m3u8: 100 + item.tracks * 320, xspf: 250 + item.tracks * 600 } })),
      counts, estimatedBytes: { history, favorites: favoriteBytes, settings, json, zip: Math.ceil(json * .4) },
      notes: [
        "Sizes are estimates; metadata length and ZIP compression vary. Playlists include your private lists and shared legacy lists, never another user's private lists.",
        "Media files are not included. Media-relative playlist paths resolve from the music root; move exported playlist files there before playback.",
        "Missing or inaccessible media paths use credential-free MusicDeck stream URLs, which require a signed-in session and are not portable media files.",
        "History includes all recorded listening events, including partial listens. Unknown legacy durations and client names remain empty.",
        "Exports read live data in bounded pages, not a database-wide point-in-time snapshot. Avoid editing data during generation.",
        "Settings are saved account preferences only. The existing preference backup exports unsaved/device-only preferences.",
      ],
    };
  }

  private async *items(playlistId: string, signal?: AbortSignal, userId?: string): AsyncGenerator<Row> {
    const statement = this.db.prepare(`SELECT i.*,p.track_json FROM playlist_items i
      LEFT JOIN smart_playlist_track_payloads p ON p.track_id=i.library_track_id
      WHERE i.playlist_id=? AND (i.position>? OR (i.position=? AND i.id>?))
      ORDER BY i.position,i.id LIMIT ${EXPORT_PAGE_SIZE}`);
    let position = -1, id = "";
    while (true) {
      signal?.throwIfAborted();
      if (userId) this.owned(userId, playlistId);
      const page = statement.all(playlistId, position, position, id) as Row[];
      if (!page.length) return;
      for (const item of page) {
        signal?.throwIfAborted();
        position = Number(item.position); id = text(item.id);
        yield item;
      }
      await nextTurn(undefined, { signal });
    }
  }

  private async track(item: Row, signal?: AbortSignal): Promise<ExportTrack> {
    const id = text(item.library_track_id) || text(item.provider_track_id);
    let metadata = objectJson(item.external_track_json ?? item.track_json);
    let unavailable = Boolean(item.external_track_json);
    if (!Object.keys(metadata).length && item.library_track_id) {
      try {
        const track = await this.catalog.getTrack(id);
        if (track) metadata = { title: track.title, artistName: track.artistName, albumName: track.albumName, durationSeconds: track.durationSeconds };
        else unavailable = true;
      } catch (error) {
        this.options.log(error, `Could not resolve export metadata for track ${id}`);
        unavailable = true;
      }
    } else if (!Object.keys(metadata).length) unavailable = true;
    signal?.throwIfAborted();
    let location = new URL(`api/tracks/${encodeURIComponent(id)}/stream`, this.baseUrl).href;
    let locationType: ExportTrack["location_type"] = "authenticated-stream";
    if (item.library_track_id) {
      try {
        const mediaPath = await this.catalog.getTrackFilePath(id);
        signal?.throwIfAborted();
        if (mediaPath && !/[\u0000-\u001f\u007f]/.test(mediaPath)) {
          const relative = path.relative(path.resolve(this.options.musicRoot), path.resolve(this.options.musicRoot, mediaPath));
          if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
            // URI escaping prevents #EXT directives, URL fragments and XSPF XML from changing the path.
            location = relative.split(path.sep).map(encodeURIComponent).join("/");
            locationType = "media-relative";
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        this.options.log(error, `Could not resolve portable export path for track ${id}; using authenticated stream URL`);
      }
    }
    return {
      occurrence_id: text(item.id), track_id: id, provider_track_id: text(item.provider_track_id), connection_id: text(item.connection_id),
      title: text(metadata.title) || id, artist: text(metadata.artistName), album: text(metadata.albumName),
      duration_seconds: number(metadata.durationSeconds), location, location_type: locationType, unavailable,
    };
  }

  private async *playlistText(playlist: PlaylistRow, format: PlaylistExportFormat, signal?: AbortSignal, userId?: string) {
    if (format === "m3u8") yield `#EXTM3U\n#PLAYLIST:${line(playlist.name)}\n`;
    else yield `<?xml version="1.0" encoding="UTF-8"?>\n<playlist version="1" xmlns="http://xspf.org/ns/0/"><title>${xmlText(playlist.name)}</title><trackList>\n`;
    for await (const item of this.items(playlist.id, signal, userId)) {
      const track = await this.track(item, signal);
      if (format === "m3u8") {
        yield `#EXTINF:${track.duration_seconds === null ? -1 : Math.max(0, Math.round(track.duration_seconds))},${line(track.artist)} - ${line(track.title)}\n${track.location}\n`;
      } else {
        yield `<track><location>${xmlText(track.location)}</location><identifier>urn:musicdeck:track:${encodeURIComponent(track.track_id)}</identifier>`
          + `<title>${xmlText(track.title)}</title><creator>${xmlText(track.artist)}</creator><album>${xmlText(track.album)}</album>`
          + (track.duration_seconds === null ? "" : `<duration>${Math.max(0, Math.round(track.duration_seconds * 1000))}</duration>`)
          + "</track>\n";
      }
    }
    if (format === "xspf") yield "</trackList></playlist>\n";
  }

  private async *historyRows(userId: string, signal?: AbortSignal) {
    for await (const row of this.rows("listening_events", "t.user_id=?", [userId], signal,
      "t.*,c.title AS cached_title,c.artist AS cached_artist,c.album AS cached_album",
      "LEFT JOIN smart_playlist_tracks c ON c.id=t.track_id")) {
      const snapshot = objectJson(row.track_json);
      yield {
        id: text(row.id), playback_session_id: text(row.playback_session_id) || null,
        timestamp: text(row.created_at), track_title: text(snapshot.title) || text(row.cached_title) || text(row.track_id),
        artist: text(snapshot.artist) || text(row.cached_artist), album: text(snapshot.album) || text(row.cached_album), play_duration_seconds: number(row.listened_seconds),
        client_name: text(row.client_name),
        track_id: text(row.track_id), event_type: text(row.event_type), counted: Boolean(row.counted), finished: Boolean(row.finished),
        duration_seconds: number(row.duration_seconds), completion_ratio: number(row.completion_ratio),
      };
    }
  }

  private async *historyCsv(userId: string, signal?: AbortSignal) {
    yield "timestamp,track_title,artist,album,play_duration_seconds,client_name\r\n";
    for await (const row of this.historyRows(userId, signal)) {
      yield [row.timestamp, row.track_title, row.artist, row.album, row.play_duration_seconds, row.client_name].map(csvCell).join(",") + "\r\n";
    }
  }

  private async *jsonArray(rows: AsyncIterable<unknown>, signal?: AbortSignal) {
    yield "[";
    let first = true;
    for await (const row of rows) {
      signal?.throwIfAborted();
      yield `${first ? "" : ","}${JSON.stringify(row)}`;
      first = false;
    }
    yield "]";
  }

  private async *favoriteRows(userId: string, signal?: AbortSignal) {
    for await (const row of this.rows("favorites", "t.user_id=?", [userId], signal, "t.track_id,t.created_at")) {
      yield { item_type: "track", item_id: row.track_id, created_at: row.created_at, ...this.itemReferences("track", text(row.track_id)) };
    }
    for await (const row of this.rows("media_favorites",
      "t.user_id=? AND NOT(t.item_type='track' AND EXISTS(SELECT 1 FROM favorites f WHERE f.user_id=t.user_id AND f.track_id=t.item_id))",
      [userId], signal, "t.item_type,t.item_id,t.created_at")) yield { ...row, ...this.itemReferences(text(row.item_type), text(row.item_id)) };
  }

  private itemReferences(type: string, id: string) {
    const metadata = type === "track" ? this.db.prepare("SELECT title,artist,album,year,bpm FROM smart_playlist_tracks WHERE id=?").get(id) : null;
    const sources = this.db.prepare("SELECT connection_id,provider_item_id FROM library_item_sources WHERE library_item_id=? ORDER BY connection_id,provider_item_id").all(id);
    return { metadata: metadata ?? null, sources };
  }

  private async *settingsRows(userId: string, signal?: AbortSignal) {
    for await (const row of this.rows("user_settings", "t.user_id=?", [userId], signal, "t.key,t.value,t.updated_at")) {
      if (ALLOWED_USER_SETTINGS.has(text(row.key))) yield { key: row.key, value: JSON.parse(text(row.value)), updated_at: row.updated_at };
    }
  }

  private async *favoritesJson(userId: string, signal?: AbortSignal) {
    yield '{"schema":"musicdeck-favorites","version":1,"favorites":';
    yield* this.jsonArray(this.favoriteRows(userId, signal), signal);
    yield ',"feedback":';
    yield* this.jsonArray(this.feedbackRows(userId, signal), signal);
    yield ',"ratings":';
    yield* this.jsonArray(this.rows("media_ratings", "t.user_id=?", [userId], signal, "t.item_type,t.item_id,t.rating,t.created_at,t.updated_at"), signal);
    yield "}\n";
  }

  private async *feedbackRows(userId: string, signal?: AbortSignal) {
    for await (const row of this.rows("recommendation_feedback", "t.user_id=?", [userId], signal,
      "t.item_type,t.item_id,t.action,t.weight AS score_modifier,t.created_at,t.updated_at")) {
      yield { ...row, is_hidden: row.action === "hide", ...this.itemReferences(text(row.item_type), text(row.item_id)) };
    }
  }

  private async *playlistJson(userId: string, signal?: AbortSignal) {
    yield "[";
    let first = true;
    for await (const row of this.playlists(userId, signal)) {
      yield `${first ? "" : ","}${JSON.stringify(row).slice(0, -1)},"tracks":[`;
      first = false;
      let firstTrack = true;
      for await (const item of this.items(text(row.id), signal, userId)) {
        yield `${firstTrack ? "" : ","}${JSON.stringify(await this.track(item, signal))}`;
        firstTrack = false;
      }
      yield "]}";
    }
    yield "]";
  }

  private async *bundleJson(userId: string, signal?: AbortSignal) {
    yield `{"schema":"musicdeck-user-export","version":1,"exported_at":${JSON.stringify(new Date().toISOString())},"playlists":`;
    yield* this.playlistJson(userId, signal);
    yield ',"history":';
    yield* this.jsonArray(this.historyRows(userId, signal), signal);
    yield ',"settings":';
    yield* this.jsonArray(this.settingsRows(userId, signal), signal);
    yield ',"favorites_and_scores":';
    yield* this.favoritesJson(userId, signal);
    yield ',"smart_playlists":';
    yield* this.jsonArray(this.decodedRows("smart_playlists", userId, "rules_json", "rules", signal), signal);
    yield ',"saved_discoveries":';
    yield* this.jsonArray(this.decodedRows("saved_discoveries", userId, "metadata_json", "metadata", signal), signal);
    yield "}\n";
  }

  private async *decodedRows(table: "smart_playlists" | "saved_discoveries", userId: string, column: string, field: string, signal?: AbortSignal) {
    for await (const row of this.rows(table, "t.user_id=?", [userId], signal)) {
      const { user_id, [column]: encoded, ...value } = row;
      if (table === "saved_discoveries") {
        const metadata = objectJson(encoded);
        const portable: Row = {};
        // Preserve descriptive attributes, not arbitrary provider data or signed media URLs.
        for (const key of ["album", "albumTitle", "albumName", "artist", "artistName", "title", "year", "duration", "durationSeconds", "trackNumber", "discNumber", "isrc", "upc", "genre"]) {
          if (["string", "number", "boolean"].includes(typeof metadata[key])) portable[key] = metadata[key];
        }
        yield { id: value.id, provider: value.provider, external_id: value.external_id, type: value.type, title: value.title,
          artist: value.artist, created_at: value.created_at, metadata: portable };
      } else {
        const { options_json, ...portable } = value;
        yield { ...portable, [field]: JSON.parse(String(encoded)), ...(options_json ? { options: JSON.parse(String(options_json)) } : {}) };
      }
    }
  }

  stream(userId: string, kind: ExportKind, format: string, playlistId?: string, signal?: AbortSignal): Readable {
    if (kind === "playlists" && playlistId) {
      const playlist = this.owned(userId, playlistId);
      if (format !== "m3u8" && format !== "xspf") throw new Error("Invalid playlist export format.");
      return Readable.from(this.playlistText(playlist, format, signal, userId), { objectMode: false, highWaterMark: 16 * 1024 });
    }
    if (kind === "history" && format === "csv") return Readable.from(this.historyCsv(userId, signal), { objectMode: false });
    if (kind === "favorites" && format === "json") return Readable.from(this.favoritesJson(userId, signal), { objectMode: false });
    if (kind === "settings" && format === "json") return Readable.from(this.jsonArray(this.settingsRows(userId, signal), signal), { objectMode: false });
    if (kind === "bundle" && format === "json") return Readable.from(this.bundleJson(userId, signal), { objectMode: false });
    if (kind === "bundle" && format === "zip") return this.zip(userId, null, signal);
    if (kind === "playlists" && (format === "m3u8" || format === "xspf")) return this.zip(userId, format, signal);
    throw new Error("Invalid data export format.");
  }

  private zip(userId: string, playlistFormat: PlaylistExportFormat | null, signal?: AbortSignal): Readable {
    const archive = archiver("zip", { zlib: { level: 6 }, forceZip64: true });
    let active: Readable | null = null;
    let stopped = false;
    const stop = () => {
      stopped = true;
      active?.destroy();
      archive.abort();
    };
    signal?.addEventListener("abort", stop, { once: true });
    archive.once("close", () => { stop(); signal?.removeEventListener("abort", stop); });
    archive.on("warning", (error: Error) => archive.destroy(error));
    const append = async (name: string, chunks: AsyncIterable<string> | string) => {
      if (stopped) throw new Error("Export download closed.");
      signal?.throwIfAborted();
      const source = Readable.from(typeof chunks === "string" ? [chunks] : chunks, { objectMode: false, highWaterMark: 16 * 1024 });
      active = source;
      await new Promise<void>((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const closed = () => { cleanup(); reject(new Error("Export download closed.")); };
        const cleanup = () => {
          archive.off("entry", done); archive.off("error", failed); archive.off("close", closed); source.off("error", failed);
        };
        archive.once("entry", done); archive.once("error", failed); archive.once("close", closed); source.once("error", failed);
        archive.append(source, { name, date: new Date(0) });
      });
      active = null;
    };
    // Start after Fastify has attached its stream error handlers.
    setImmediate(() => {
      void (async () => {
        if (!playlistFormat) {
          await append("user.json", this.bundleJson(userId, signal));
          await append("history.csv", this.historyCsv(userId, signal));
          await append("favorites.json", this.favoritesJson(userId, signal));
          await append("settings.json", this.jsonArray(this.settingsRows(userId, signal), signal));
        }
        for await (const row of this.playlists(userId, signal)) {
          for (const format of playlistFormat ? [playlistFormat] : ["m3u8", "xspf"] as const) {
            await append(`playlists/${safeFileName(text(row.name), text(row.id))}.${format}`,
              this.playlistText({ id: text(row.id), name: text(row.name), description: text(row.description) }, format, signal, userId));
          }
        }
        await append("README.txt", "MusicDeck portable export, schema version 1\n\n" + this.summary(userId).notes.join("\n") + "\n");
        await archive.finalize();
      })().catch((error: unknown) => {
        stop();
        if (!archive.destroyed) archive.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    return archive;
  }
}
