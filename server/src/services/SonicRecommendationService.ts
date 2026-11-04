import { setImmediate as yieldTurn } from "node:timers/promises";
import type { Db } from "../db/database.js";

export const SONIC_DIMENSIONS = 128;
const VERSION = 1;
const PAGE_SIZE = 128;
const SETTINGS_KEY = "sonic.analysis";
const MAX_CACHE_ENTRIES = 32;
export type SonicSettings = { enabled: boolean; threads: number; weight: number };
export type SonicMatch = { trackId: string; cosine: number };
const defaults: SonicSettings = { enabled: false, threads: 1, weight: 2.5 };

function encode(features: Float32Array): Buffer {
  if (features.length !== SONIC_DIMENSIONS || !features.every(Number.isFinite)) throw new Error("Invalid sonic feature vector");
  const norm = Math.hypot(...features);
  if (norm <= 0) throw new Error("Sonic feature vector has zero length");
  const result = Buffer.alloc(SONIC_DIMENSIONS * 4);
  features.forEach((value, index) => result.writeFloatLE(value / norm, index * 4));
  return result;
}

export class SonicRecommendationService {
  private config = { ...defaults };
  private indexRevision = 0;
  private readonly matches = new Map<string, { revision: number; expires: number; value: SonicMatch[] }>();
  private readonly active = new Map<string, Promise<SonicMatch[]>>();

  constructor(private readonly db: Db) {
    const row = db.prepare("SELECT value FROM server_settings WHERE key=?").get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return;
    try {
      const settings = JSON.parse(row.value);
      if (typeof settings?.enabled === "boolean" && Number.isInteger(settings.threads) && settings.threads >= 1 &&
        settings.threads <= 4 && Number.isFinite(settings.weight) && settings.weight >= 0 && settings.weight <= 6) {
        this.config = { enabled: settings.enabled, threads: settings.threads, weight: settings.weight };
      }
    } catch { /* Corrupt settings leave the extension disabled. */ }
  }

  get settings(): Readonly<SonicSettings> { return this.config; }
  configure(settings: SonicSettings): void {
    if (typeof settings.enabled !== "boolean" || !Number.isInteger(settings.threads) || settings.threads < 1 ||
      settings.threads > 4 || !Number.isFinite(settings.weight) || settings.weight < 0 || settings.weight > 6) {
      throw new RangeError("Invalid sonic analysis settings");
    }
    this.db.prepare(`INSERT INTO server_settings(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(SETTINGS_KEY, JSON.stringify(settings), new Date().toISOString());
    this.config = { ...settings };
    this.invalidate();
  }

  contentRevision(trackId: string): string | null | undefined {
    const row = this.db.prepare("SELECT content_revision FROM library_items WHERE id=? AND type='track'")
      .get(trackId) as { content_revision: string | null } | undefined;
    return row?.content_revision;
  }

  hasCurrent(trackId: string, fileRevision: string, contentRevision: string | null): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM sonic_vectors WHERE track_id=? AND version=?
      AND file_revision=? AND content_revision IS ?`).get(trackId, VERSION, fileRevision, contentRevision));
  }

  remove(trackId: string): void {
    if (this.db.prepare("DELETE FROM sonic_vectors WHERE track_id=?").run(trackId).changes) this.invalidate();
  }

  put(trackId: string, fileRevision: string, contentRevision: string | null, features: Float32Array): boolean {
    if (!this.config.enabled || this.contentRevision(trackId) !== contentRevision) return false;
    this.db.prepare(`INSERT INTO sonic_vectors(track_id,version,content_revision,file_revision,vector,analyzed_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(track_id) DO UPDATE SET version=excluded.version,
      content_revision=excluded.content_revision,file_revision=excluded.file_revision,
      vector=excluded.vector,analyzed_at=excluded.analyzed_at`)
      .run(trackId, VERSION, contentRevision, fileRevision, encode(features), new Date().toISOString());
    this.invalidate();
    return true;
  }

  counts(): { indexed: number; catalog: number } {
    const indexed = this.db.prepare(`SELECT COUNT(*) AS count FROM sonic_vectors v JOIN library_items i
      ON i.id=v.track_id AND i.content_revision IS v.content_revision WHERE v.version=?`).get(VERSION) as { count: number };
    const catalog = this.db.prepare("SELECT COUNT(*) AS count FROM library_items WHERE type='track'").get() as { count: number };
    return { indexed: indexed.count, catalog: catalog.count };
  }

  async nearest(trackId: string, limit = 128): Promise<SonicMatch[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new RangeError("Invalid sonic neighbor limit");
    if (!this.config.enabled || this.config.weight === 0) return [];
    const key = JSON.stringify([trackId, limit]);
    const cached = this.matches.get(key);
    if (cached?.revision === this.indexRevision && cached.expires > Date.now()) {
      const ids = [trackId, ...cached.value.map(match => match.trackId)];
      const current = this.db.prepare(`SELECT COUNT(*) AS count FROM sonic_vectors v JOIN library_items i
        ON i.id=v.track_id AND i.content_revision IS v.content_revision
        WHERE v.version=? AND v.track_id IN (${ids.map(() => "?").join(",")})`).get(VERSION, ...ids) as { count: number };
      if (current.count === ids.length) return cached.value;
      this.matches.delete(key);
    }
    const inFlight = this.active.get(key);
    if (inFlight) return inFlight;
    if (this.active.size >= 2) return [];
    const revision = this.indexRevision;
    const search = this.search(trackId, limit);
    this.active.set(key, search);
    try {
      const value = await search;
      if (revision === this.indexRevision) {
        this.matches.delete(key);
        this.matches.set(key, { revision, expires: Date.now() + 30_000, value });
        if (this.matches.size > MAX_CACHE_ENTRIES) this.matches.delete(this.matches.keys().next().value!);
      }
      return this.config.enabled ? value : [];
    } finally {
      this.active.delete(key);
    }
  }

  private invalidate(): void {
    this.indexRevision++;
    this.matches.clear();
  }

  private async search(trackId: string, limit: number): Promise<SonicMatch[]> {
    const seed = this.db.prepare(`SELECT v.vector FROM sonic_vectors v JOIN library_items i
      ON i.id=v.track_id AND i.content_revision IS v.content_revision
      WHERE v.track_id=? AND v.version=?`).get(trackId, VERSION) as { vector: Buffer } | undefined;
    if (!seed) return [];
    const source = Float64Array.from({ length: SONIC_DIMENSIONS }, (_, index) => seed.vector.readFloatLE(index * 4));
    const page = this.db.prepare(`SELECT v.track_id AS trackId,v.vector FROM sonic_vectors v JOIN library_items i
      ON i.id=v.track_id AND i.content_revision IS v.content_revision
      WHERE v.version=? AND v.track_id>? ORDER BY v.track_id LIMIT ?`);
    const best: SonicMatch[] = [];
    let cursor = "";
    while (this.config.enabled) {
      const rows = page.all(VERSION, cursor, PAGE_SIZE) as Array<{ trackId: string; vector: Buffer }>;
      for (const row of rows) {
        if (row.trackId === trackId) continue;
        let cosine = 0;
        for (let index = 0; index < SONIC_DIMENSIONS; index++) cosine += source[index] * row.vector.readFloatLE(index * 4);
        if (!Number.isFinite(cosine)) continue;
        cosine = Math.max(-1, Math.min(1, cosine));
        if (best.length === limit && cosine <= best[best.length - 1].cosine) continue;
        const position = best.findIndex(match => cosine > match.cosine);
        best.splice(position < 0 ? best.length : position, 0, { trackId: row.trackId, cosine });
        if (best.length > limit) best.pop();
      }
      if (rows.length < PAGE_SIZE) break;
      cursor = rows[rows.length - 1].trackId;
      await yieldTurn();
    }
    return best;
  }
}
