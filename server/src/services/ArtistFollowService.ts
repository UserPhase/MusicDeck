import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Db } from "../db/database.js";
import type { TaskRunContext } from "./TaskManager.js";
import { gateFetch, privacyFetch, PrivacyBlockedError } from "./PrivacyManager.js";
import type { ExternalArtworkTokenStore } from "../domain/external-catalog.js";
import { normalizeMusicText, versionSignature } from "../domain/music-identity.js";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const provider = z.enum(["library", "deezer", "itunes"]);
export const followArtistInput = z.object({ artistId: z.string().trim().min(1).max(500),
  artistName: z.string().trim().min(1).max(300), provider }).strict();
export type FollowArtistInput = z.infer<typeof followArtistInput>;
export interface FollowedArtist extends FollowArtistInput {
  key: string; followedAt: string; checkedAt: string | null; nextScanAt: string; error: string | null;
}
const releaseSchema = z.object({
  id: z.string(), provider: z.enum(["deezer", "itunes"]), providerId: z.string().regex(/^\d+$/),
  title: z.string(), artist: z.string(), artistId: z.string(), releaseDate: z.string(),
  albumType: z.enum(["Album", "EP", "Single"]), coverUrl: z.string().nullable(),
  storeUrl: z.string().nullable(), trackCount: z.number().int().nonnegative(),
});
export type NewRelease = z.infer<typeof releaseSchema>;
type ArtistRow = { artist_key: string; artist_id: string; artist_name: string; provider: FollowArtistInput["provider"];
  resolved_id: string | null; failures: number; checked_at: number | null; next_scan_at: number; last_error: string | null };
type Item = Record<string, unknown>;
export class ReleaseLookupError extends Error {
  constructor(message: string, readonly retryAt = 0) { super(message); }
}
const text = (value: unknown): string => typeof value === "string" ? value.slice(0, 500) : "";
const numeric = (value: unknown): string | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ||
  (typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)) ? String(value) : null;
function safeUrl(value: unknown, domains: string[]): string | null {
  try { const url = new URL(text(value)); return url.protocol === "https:" && !url.username && !url.password && !url.port &&
    domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : null; } catch { return null; }
}
const canonical = (r: NewRelease) => JSON.stringify([normalizeMusicText(r.artist), normalizeMusicText(r.title), versionSignature(r.title), r.releaseDate]);
export function followedArtistKey(input: FollowArtistInput): string {
  return createHash("sha256").update(JSON.stringify([input.provider, input.artistId])).digest("hex");
}

/** Explicit per-user follows; shared, durable metadata caches never enqueue media downloads. */
export class ArtistFollowService {
  private readonly transport: typeof fetch;
  private readonly now: () => number;
  private readonly interval: number;
  private readonly artworkIds = new Map<string, string>();
  constructor(private readonly db: Db, private readonly options: {
    fetchImpl?: typeof fetch; now?: () => number; requestIntervalMs?: number; artwork?: ExternalArtworkTokenStore;
  } = {}) {
    this.transport = gateFetch(options.fetchImpl ?? privacyFetch, "metadata");
    this.now = options.now ?? Date.now;
    this.interval = options.requestIntervalMs ?? 3500;
    if (!Number.isFinite(this.interval) || this.interval < 0) throw new Error("Invalid release request interval");
  }

  follow(userId: string, raw: FollowArtistInput): FollowedArtist {
    const input = followArtistInput.parse(raw);
    // External identities must be explicit provider IDs, never arbitrary URLs.
    const externalId = input.artistId.replace(new RegExp(`^external_${input.provider}_artist_`), "");
    if (input.provider !== "library" && !numeric(externalId)) throw new ReleaseLookupError("Choose a valid artist from discovery search.");
    if (input.provider !== "library") input.artistId = `external_${input.provider}_artist_${externalId}`;
    const key = followedArtistKey(input);
    this.db.transaction(() => {
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM followed_artists WHERE user_id=?").get(userId) as { n: number };
      if (count.n >= 1000 && !this.db.prepare("SELECT 1 FROM followed_artists WHERE user_id=? AND artist_key=?").get(userId, key))
        throw new ReleaseLookupError("You can follow up to 1,000 artists. Unfollow an artist before adding another.");
      this.db.prepare(`INSERT INTO followed_artist_catalog(artist_key,artist_id,artist_name,provider,resolved_id)
        VALUES(?,?,?,?,?) ON CONFLICT(artist_key) DO NOTHING`)
        .run(key, input.artistId, input.artistName, input.provider, input.provider === "library" ? null : externalId);
      this.db.prepare("INSERT OR IGNORE INTO followed_artists(user_id,artist_key,followed_at) VALUES(?,?,?)")
        .run(userId, key, new Date(this.now()).toISOString());
    })();
    return this.list(userId).find(item => item.key === key)!;
  }

  unfollow(userId: string, key: string): void {
    this.db.prepare("DELETE FROM followed_artists WHERE user_id=? AND artist_key=?").run(userId, key);
  }
  hasFollowers(): boolean { return Boolean(this.db.prepare("SELECT 1 FROM followed_artists LIMIT 1").get()); }

  list(userId: string): FollowedArtist[] {
    const rows = this.db.prepare(`SELECT c.*,f.followed_at FROM followed_artists f
      JOIN followed_artist_catalog c ON c.artist_key=f.artist_key WHERE f.user_id=? ORDER BY c.artist_name COLLATE NOCASE,c.artist_key`)
      .all(userId) as (ArtistRow & { followed_at: string })[];
    return rows.map(row => ({ key: row.artist_key, artistId: row.artist_id, artistName: row.artist_name, provider: row.provider,
      followedAt: row.followed_at, checkedAt: row.checked_at === null ? null : new Date(row.checked_at).toISOString(),
      nextScanAt: new Date(row.next_scan_at).toISOString(), error: row.last_error }));
  }

  feed(userId: string, offset = 0, limit = 30) {
    const since = new Date(this.now() - 30 * DAY).toISOString().slice(0, 10), today = new Date(this.now()).toISOString().slice(0, 10);
    // Group duplicate store editions before pagination. EXISTS prevents a follower-count multiplier.
    const rows = this.db.prepare(`SELECT MIN(r.data_json) AS data_json FROM new_release_cache r WHERE r.release_date BETWEEN ? AND ?
      AND EXISTS(SELECT 1 FROM followed_artists f WHERE f.artist_key=r.artist_key AND f.user_id=?)
      GROUP BY r.canonical_key ORDER BY r.release_date DESC,r.canonical_key LIMIT ? OFFSET ?`)
      .all(since, today, userId, limit + 1, offset) as { data_json: string }[];
    return { releases: rows.slice(0, limit).flatMap(row => {
      try { const r = releaseSchema.parse(JSON.parse(row.data_json)); return [{ ...r, coverUrl: this.artwork(r.coverUrl) }]; }
      catch { return []; } // Corrupt cache rows never break a user's whole feed; next scan repairs them.
    }), hasMore: rows.length > limit };
  }

  private artwork(url: string | null): string | null {
    if (!url || !this.options.artwork) return null;
    const previous = this.artworkIds.get(url);
    if (previous && this.options.artwork.get(previous)) return `/api/artwork/external/${encodeURIComponent(previous)}`;
    const id = this.options.artwork.token(url, [".mzstatic.com", ".dzcdn.net"]);
    if (id) {
      this.artworkIds.set(url, id);
      if (this.artworkIds.size > 1000) this.artworkIds.delete(this.artworkIds.keys().next().value!);
    }
    return id ? `/api/artwork/external/${encodeURIComponent(id)}` : null;
  }

  private async request(store: "itunes" | "deezer", path: string, params: Record<string, string>, signal: AbortSignal): Promise<Item> {
    signal.throwIfAborted();
    // A SQLite reservation serializes requests across jobs and server processes, including Retry-After cooldowns.
    const slot = this.db.transaction(() => {
      const row = this.db.prepare("SELECT next_request_at FROM release_provider_throttle WHERE provider=?").get(store) as { next_request_at: number } | undefined;
      const at = Math.max(this.now(), row?.next_request_at ?? 0);
      if (at - this.now() > 30_000) throw new ReleaseLookupError(`${store} is cooling down; the scanner will retry automatically.`, at);
      this.db.prepare(`INSERT INTO release_provider_throttle VALUES(?,?) ON CONFLICT(provider)
        DO UPDATE SET next_request_at=excluded.next_request_at`).run(store, at + this.interval);
      return at;
    })();
    if (slot > this.now()) await delay(slot - this.now(), undefined, { signal });
    const url = new URL(path, store === "itunes" ? "https://itunes.apple.com/" : "https://api.deezer.com/");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    const response = await this.transport(url, { signal: combined, redirect: "error" });
    if (response.status === 429 || response.status === 503) {
      const value = response.headers.get("retry-after") || "";
      const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - this.now();
      const retryAt = this.now() + Math.max(60_000, Math.min(DAY, Number.isFinite(ms) ? ms : 60_000));
      this.db.prepare("UPDATE release_provider_throttle SET next_request_at=MAX(next_request_at,?) WHERE provider=?").run(retryAt, store);
      await response.body?.cancel();
      throw new ReleaseLookupError(`${store} is temporarily unavailable; cached releases are still available.`, retryAt);
    }
    if (!response.ok) { await response.body?.cancel(); throw new ReleaseLookupError(`${store} metadata lookup failed (HTTP ${response.status}).`); }
    // Bound decompressed response size as well as request time.
    const reader = response.body?.getReader();
    if (!reader) throw new ReleaseLookupError(`${store} returned an empty response.`);
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 2 * 1024 * 1024) throw new ReleaseLookupError("Metadata response exceeded the safe size limit."); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ReleaseLookupError(`${store} returned invalid metadata.`);
    const result = body as Item;
    if (result.error) {
      const code = typeof result.error === "object" && result.error !== null ? (result.error as Item).code : null;
      if (store === "deezer" && code === 4) {
        const retryAt = this.now() + 60_000;
        this.db.prepare("UPDATE release_provider_throttle SET next_request_at=MAX(next_request_at,?) WHERE provider=?").run(retryAt, store);
        throw new ReleaseLookupError("deezer rejected the metadata lookup due to its quota; it will be retried automatically.", retryAt);
      }
      throw new ReleaseLookupError(`${store} rejected the metadata lookup; it will be retried automatically.`);
    }
    return result;
  }

  private items(body: Item, field: string): Item[] {
    if (!Array.isArray(body[field])) throw new ReleaseLookupError("The metadata provider returned an invalid release list.");
    return (body[field] as unknown[]).filter((item): item is Item => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  }

  private async releases(row: ArtistRow, signal: AbortSignal, checkpoint: () => Promise<void>): Promise<NewRelease[]> {
    const store = row.provider === "deezer" ? "deezer" : "itunes";
    let id = row.resolved_id;
    if (!id) {
      const body = await this.request("itunes", "search", { term: row.artist_name, media: "music", entity: "musicArtist", limit: "50", country: "US" }, signal);
      const matches = new Set(this.items(body, "results").filter(item => normalizeMusicText(text(item.artistName)) === normalizeMusicText(row.artist_name))
        .map(item => numeric(item.artistId)).filter((value): value is string => Boolean(value)));
      if (matches.size !== 1) throw new ReleaseLookupError("Artist identity is ambiguous or unavailable. Follow the specific iTunes or Deezer artist from discovery search instead.");
      id = [...matches][0];
      this.db.prepare("UPDATE followed_artist_catalog SET resolved_id=? WHERE artist_key=?").run(id, row.artist_key);
    }
    let artistName = row.artist_name;
    if (store === "deezer") {
      await checkpoint();
      const artist = await this.request(store, `artist/${id}`, {}, signal);
      if (numeric(artist.id) !== id || !text(artist.name)) throw new ReleaseLookupError("The followed artist is no longer available on Deezer.");
      artistName = text(artist.name);
    }
    const items: Item[] = [];
    for (let page = 0; page < (store === "deezer" ? 3 : 1); page++) {
      await checkpoint();
      const body = await this.request(store, store === "itunes" ? "lookup" : `artist/${id}/albums`,
        store === "itunes" ? { id, entity: "album", limit: "200", sort: "recent", country: "US" } : { limit: "100", index: String(page * 100) }, signal);
      const batch = this.items(body, store === "itunes" ? "results" : "data"); items.push(...batch);
      if (store === "itunes" || !body.next || batch.length < 100) break;
    }
    const verifiedName = store === "itunes" ? text(items.find(item => numeric(item.artistId) === id && text(item.artistName))?.artistName) : artistName;
    if (row.provider !== "library" && verifiedName) this.db.prepare("UPDATE followed_artist_catalog SET artist_name=? WHERE artist_key=?")
      .run(verifiedName.slice(0, 300), row.artist_key);
    const since = new Date(this.now() - 30 * DAY).toISOString().slice(0, 10), today = new Date(this.now()).toISOString().slice(0, 10);
    const releases = new Map<string, NewRelease>();
    for (const item of items) {
      const releaseId = numeric(store === "itunes" ? item.collectionId : item.id);
      if (!releaseId || (store === "itunes" && (item.wrapperType !== "collection" || numeric(item.artistId) !== id))) continue;
      const date = text(store === "itunes" ? item.releaseDate : item.release_date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || date < since || date > today) continue;
      const title = text(store === "itunes" ? item.collectionName : item.title); if (!title) continue;
      const count = typeof item.trackCount === "number" ? item.trackCount : typeof item.nb_tracks === "number" ? item.nb_tracks : 0;
      const type = text(item.record_type).toLowerCase();
      const r: NewRelease = { id: `external_${store}_album_${releaseId}`, provider: store, providerId: releaseId, title,
        artist: store === "itunes" ? text(item.artistName) || row.artist_name : artistName,
        artistId: `external_${store}_artist_${id}`, releaseDate: date,
        albumType: type === "single" || /\s-\sSingle$/i.test(title) ? "Single" : type === "ep" || /\s-\sEP$/i.test(title) ? "EP" : "Album",
        trackCount: Math.max(0, Math.floor(Number.isFinite(count) ? count : 0)),
        coverUrl: safeUrl(store === "itunes" ? item.artworkUrl100 : item.cover_big || item.cover_medium, store === "itunes" ? ["mzstatic.com"] : ["dzcdn.net"]),
        storeUrl: safeUrl(store === "itunes" ? item.collectionViewUrl : item.link, store === "itunes" ? ["music.apple.com", "itunes.apple.com"] : ["deezer.com"])
          ?? (store === "itunes" ? `https://music.apple.com/us/album/${releaseId}` : `https://www.deezer.com/album/${releaseId}`) };
      releases.set(r.id, r);
    }
    return [...releases.values()];
  }

  async scan(task: Pick<TaskRunContext, "signal" | "checkpoint" | "report" | "throwIfCancelled">): Promise<void> {
    const rows = this.db.prepare(`SELECT * FROM followed_artist_catalog c WHERE next_scan_at<=? AND lease_until<=?
      AND EXISTS(SELECT 1 FROM followed_artists f WHERE f.artist_key=c.artist_key)
      ORDER BY next_scan_at,artist_key LIMIT 100`).all(this.now(), this.now()) as ArtistRow[];
    let processed = 0, failures = 0;
    task.report({ totalItems: rows.length, itemsProcessed: 0, message: "Checking followed artists" });
    for (const row of rows) {
      await task.checkpoint(); task.throwIfCancelled();
      let lease = this.now() + 5 * 60_000;
      const claimed = this.db.prepare("UPDATE followed_artist_catalog SET lease_until=? WHERE artist_key=? AND lease_until<=? AND next_scan_at<=?")
        .run(lease, row.artist_key, this.now(), this.now());
      if (!claimed.changes) continue;
      try {
        const found = await this.releases(row, task.signal, async () => {
          await task.checkpoint(); task.throwIfCancelled();
          const renewed = this.now() + 5 * 60_000;
          if (!this.db.prepare("UPDATE followed_artist_catalog SET lease_until=? WHERE artist_key=? AND lease_until=?")
            .run(renewed, row.artist_key, lease).changes) throw new ReleaseLookupError("Another scanner is checking this artist.");
          lease = renewed;
        }); task.throwIfCancelled();
        this.db.transaction(() => {
          if (!this.db.prepare("SELECT 1 FROM followed_artist_catalog WHERE artist_key=? AND lease_until=?").get(row.artist_key, lease)) return;
          const put = this.db.prepare(`INSERT INTO new_release_cache(artist_key,release_id,canonical_key,release_date,data_json,cached_at)
            VALUES(?,?,?,?,?,?) ON CONFLICT(artist_key,release_id) DO UPDATE SET canonical_key=excluded.canonical_key,
            release_date=excluded.release_date,data_json=excluded.data_json,cached_at=excluded.cached_at`);
          for (const release of found) put.run(row.artist_key, release.id, canonical(release), release.releaseDate, JSON.stringify(release), this.now());
          this.db.prepare("UPDATE followed_artist_catalog SET checked_at=?,next_scan_at=?,failures=0,last_error=NULL WHERE artist_key=? AND lease_until=?")
            .run(this.now(), this.now() + 6 * HOUR, row.artist_key, lease);
        })();
      } catch (error) {
        task.signal.throwIfAborted(); failures++;
        const next = Math.max(this.now() + Math.min(DAY, 15 * 60_000 * 2 ** Math.min(row.failures, 7)), error instanceof ReleaseLookupError ? error.retryAt : 0);
        this.db.prepare("UPDATE followed_artist_catalog SET failures=failures+1,next_scan_at=?,last_error=? WHERE artist_key=? AND lease_until=?")
          .run(next, error instanceof PrivacyBlockedError ? `${error.message}. Enable external metadata in server privacy settings to check releases.` :
            error instanceof ReleaseLookupError ? error.message : "Could not check releases. The scanner will retry automatically.", row.artist_key, lease);
      } finally {
        this.db.prepare("UPDATE followed_artist_catalog SET lease_until=0 WHERE artist_key=? AND lease_until=?").run(row.artist_key, lease);
      }
      processed++; task.report({ itemsProcessed: processed, percent: rows.length ? processed / rows.length * 100 : 100,
        message: `${processed} artists checked${failures ? `; ${failures} will retry automatically` : ""}` });
    }
    this.db.prepare("DELETE FROM new_release_cache WHERE release_date<?").run(new Date(this.now() - 45 * DAY).toISOString().slice(0, 10));
    this.db.prepare(`DELETE FROM followed_artist_catalog WHERE NOT EXISTS(SELECT 1 FROM followed_artists f WHERE f.artist_key=followed_artist_catalog.artist_key)
      AND lease_until=0 AND COALESCE(checked_at,0)<?`).run(this.now() - 45 * DAY);
    task.report({ percent: 100, message: rows.length ? `Release scan finished; ${failures} artists need a retry` : "Followed artists are up to date" });
  }

  /** Authorize against current follows before resolving an album through the existing catalog. */
  releaseForUser(userId: string, releaseId: string): NewRelease | null {
    const row = this.db.prepare(`SELECT r.data_json FROM new_release_cache r JOIN followed_artists f ON f.artist_key=r.artist_key
      WHERE f.user_id=? AND r.release_id=? LIMIT 1`).get(userId, releaseId) as { data_json: string } | undefined;
    if (!row) return null;
    try { return releaseSchema.parse(JSON.parse(row.data_json)); } catch { return null; }
  }
}
