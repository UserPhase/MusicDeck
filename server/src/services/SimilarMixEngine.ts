import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/database.js";
import type { Track } from "../types.js";
import { normalizeMusicText, versionSignature } from "../domain/music-identity.js";
import { currentPrivacyManager, gateFetch, privacyFetch } from "./PrivacyManager.js";
import { tasteProfile, tasteTarget } from "./TasteProfileManager.js";

export type MixScope = "LIBRARY_ONLY" | "DISCOVERY_ONLY" | "HYBRID_MIX";
export interface SimilarMixInput {
  seedTrackIds: string[]; scope: MixScope; adventurousness: number;
  lockedTrackIds?: string[]; excludeTrackIds?: string[]; shuffleSeed?: string;
}
export interface MixCandidate {
  id: string; title: string; artist: string; album: string; inLibrary: boolean;
  similarity: number; familiarity: number; score: number; reason: string; track: Track;
}
export interface SimilarMixPreview {
  tracks: MixCandidate[]; warnings: string[]; shuffleSeed: string; cached: boolean; generatedInMs: number;
}
export class SimilarMixError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 | 429 | 503 = 503, readonly retryAfterMs?: number) { super(message); }
}
interface Recording { id: string; title: string; artist: string; mbid?: string | null; preview_url?: string | null }
interface Neighbor extends Recording { match: number }
interface Vector { neighbors: Neighbor[]; expires: number; retry: number }
interface CacheRow { payload_json: string | null; expires_at: number; retry_at: number }
const DAY = 86_400_000, TTL = 7 * DAY, STALE = 30 * DAY;
const key = (title: string, artist: string) => JSON.stringify([normalizeMusicText(artist), normalizeMusicText(title), versionSignature(title)]);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const externalId = (title: string, artist: string) => `external_lastfm_track_${hash(key(title, artist)).slice(0, 32)}`;
const artistId = (artist: string) => `external_lastfm_artist_${hash(normalizeMusicText(artist)).slice(0, 32)}`;
const bounded = (value: number) => Math.max(0, Math.min(1, value));
const text = z.string().trim().min(1).max(500);
const neighborSchema = z.object({ id: text, title: text, artist: text, mbid: z.string().nullable().optional(), match: z.number().finite().min(0).max(1) });
const inputSchema = z.object({
  seedTrackIds: z.array(text).min(1).max(5).refine(ids => new Set(ids).size === ids.length),
  scope: z.enum(["LIBRARY_ONLY", "DISCOVERY_ONLY", "HYBRID_MIX"]), adventurousness: z.number().finite().min(0).max(1),
  lockedTrackIds: z.array(text).max(25).default([]), excludeTrackIds: z.array(text).max(1000).default([]),
  shuffleSeed: z.string().min(1).max(100).optional(),
}).strict();

/** Public recording vectors persist in SQLite. User history/feedback is never cached with them.
 * Library indexing is amortized across previews; ranking never enumerates a provider. */
export class SimilarMixEngine {
  private readonly transport: typeof fetch;
  private readonly now: () => number;
  private catalogVersion: string | null = null;
  private catalogDegraded = false;
  private local = new Map<string, Track>();
  private known = new Map<string, Track>();
  private byRecording = new Map<string, Track>();
  private byArtist = new Map<string, Track[]>();
  private artistNames = new Map<string, Set<string>>();
  private vectors = new Map<string, Vector>();
  private pending = new Map<string, Promise<Vector>>();
  private rateTail: Promise<unknown> = Promise.resolve();
  private nextRequest = 0;
  private closed = false;
  private readonly stop = new AbortController();
  constructor(private readonly db: Db, private readonly options: {
    apiKey(): string | null; fetchImpl?: typeof fetch; now?: () => number; requestSpacingMs?: number;
  }) { this.transport = gateFetch(options.fetchImpl ?? privacyFetch, "metadata"); this.now = options.now ?? Date.now; }

  private catalog() {
    const state = this.db.prepare("SELECT refreshed_at,degraded,mix_revision FROM smart_playlist_catalog_state WHERE singleton=1").get() as
      { refreshed_at: string; degraded: number; mix_revision: number } | undefined;
    if (!state) throw new SimilarMixError("Your library is still being indexed. Try again shortly.");
    this.catalogDegraded = Boolean(state.degraded);
    const revision = `${state.refreshed_at}:${state.mix_revision}`;
    if (this.catalogVersion === revision) return;
    const local = new Map<string, Track>(), known = new Map<string, Track>(), recordings = new Map<string, Track>(), artists = new Map<string, Track[]>(), artistNames = new Map<string, Set<string>>();
    for (const row of this.db.prepare("SELECT track_json FROM smart_playlist_track_payloads").iterate() as Iterable<{ track_json: string }>) {
      let track: Track & { availability?: { state?: string; libraryAvailable?: boolean } };
      try { track = JSON.parse(row.track_json); } catch { continue; }
      if (!track || typeof track.id !== "string" || typeof track.title !== "string" || typeof track.artistName !== "string") continue;
      // Keep unavailable recordings in the identity index: they are still owned, not discoveries.
      known.set(track.id, track);
      const recordingKey = key(track.title, track.artistName), artist = normalizeMusicText(track.artistName);
      const available = track.availability?.libraryAvailable !== false && track.availability?.state !== "unavailable";
      if (!recordings.has(recordingKey) || available) recordings.set(recordingKey, track);
      if (track.artistId) { const names = artistNames.get(track.artistId) ?? new Set<string>(); names.add(artist); artistNames.set(track.artistId, names); }
      if (!available) continue;
      local.set(track.id, track);
      const rows = artists.get(artist) ?? [];
      rows.push(track); artists.set(artist, rows);
    }
    this.local = local; this.known = known; this.byRecording = recordings; this.byArtist = artists; this.artistNames = artistNames; this.catalogVersion = revision;
  }

  searchSeeds(query: string): Recording[] {
    this.catalog(); const terms = normalizeMusicText(query).split(" ").filter(Boolean); if (!terms.length) return [];
    const result: Recording[] = [];
    for (const track of this.local.values()) {
      if (terms.every(term => normalizeMusicText(`${track.title} ${track.artistName}`).includes(term))) result.push({ id: track.id, title: track.title, artist: track.artistName });
      if (result.length === 12) break;
    }
    return result;
  }

  registerExternalSeed(title: string, artist: string): Recording {
    if (!text.safeParse(title).success || !text.safeParse(artist).success || !normalizeMusicText(title) || !normalizeMusicText(artist)) throw new SimilarMixError("Enter a song title and artist.", 400);
    const recording = { id: externalId(title, artist), title: title.trim(), artist: artist.trim() };
    this.storeRecordings([recording]); return recording;
  }
  private storeRecordings(recordings: Recording[]) {
    const insert = this.db.prepare(`INSERT INTO similar_mix_external_tracks(id,title,artist,mbid,touched_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist=excluded.artist,mbid=COALESCE(excluded.mbid,mbid),touched_at=excluded.touched_at`);
    this.db.transaction(() => { recordings.forEach(row => insert.run(row.id, row.title, row.artist, row.mbid ?? null, this.now())); })();
  }
  private recording(id: string): Recording {
    const track = this.known.get(id);
    if (track) return { id, title: track.title, artist: track.artistName, mbid: track.identityHints?.musicBrainzId };
    const row = this.db.prepare("SELECT id,title,artist,mbid,preview_url FROM similar_mix_external_tracks WHERE id=?").get(id) as Recording | undefined;
    if (!row) throw new SimilarMixError("A seed song is no longer available. Remove it and choose another.", 404);
    return row;
  }
  private vectorKey(seed: Recording) { return key(seed.title, seed.artist); }
  private readVector(seedKey: string): Vector | undefined {
    const memory = this.vectors.get(seedKey); if (memory) return memory;
    const row = this.db.prepare("SELECT payload_json,expires_at,retry_at FROM similar_mix_vectors WHERE seed_key=?").get(seedKey) as CacheRow | undefined;
    if (!row) return;
    let neighbors: Neighbor[] = [];
    if (row.payload_json) {
      try { neighbors = z.array(neighborSchema).max(200).parse(JSON.parse(row.payload_json)); }
      catch { this.db.prepare("DELETE FROM similar_mix_vectors WHERE seed_key=?").run(seedKey); return; }
    }
    const value = { neighbors, expires: row.expires_at, retry: row.retry_at }; this.remember(seedKey, value); return value;
  }
  private remember(seedKey: string, value: Vector) {
    this.vectors.delete(seedKey); this.vectors.set(seedKey, value);
    if (this.vectors.size > 256) this.vectors.delete(this.vectors.keys().next().value!);
  }
  private async slot<T>(work: () => Promise<T>): Promise<T> {
    const task = this.rateTail.then(async () => {
      if (this.closed) throw new SimilarMixError("Mix generation is stopping. Try again after reconnecting.");
      const delay = Math.max(0, this.nextRequest - this.now());
      if (delay) await new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); this.stop.signal.removeEventListener("abort", abort); };
        const abort = () => { finish(); reject(new SimilarMixError("Mix generation stopped.")); };
        const timer = setTimeout(() => { finish(); resolve(); }, delay);
        this.stop.signal.addEventListener("abort", abort, { once: true });
      });
      this.nextRequest = this.now() + (this.options.requestSpacingMs ?? 650);
      return work();
    });
    this.rateTail = task.catch(() => undefined); return task;
  }
  private async readJson(url: URL): Promise<unknown> {
    const signal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(6000)]);
    const response = await this.transport(url, { signal, redirect: "error", headers: { Accept: "application/json", "User-Agent": "MusicDeck/1.0 (similar-song mixes)" } });
    const chunks: Uint8Array[] = []; let size = 0; const reader = response.body?.getReader();
    try {
      if (reader) for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.length; if (size > 1024 * 1024) { await reader.cancel(); throw new SimilarMixError("Last.fm returned an oversized response."); }
        chunks.push(next.value);
      }
    } finally { reader?.releaseLock(); }
    let payload: unknown; try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new SimilarMixError("Last.fm returned an unreadable response."); }
    const errorCode = payload && typeof payload === "object" && "error" in payload ? Number(payload.error) : null;
    if (!response.ok || errorCode !== null) {
      if (response.status === 429 || errorCode === 29) {
        const header = response.headers.get("retry-after"), requested = header ? /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - this.now() : 300_000;
        throw new SimilarMixError("Last.fm is rate limiting similarity lookups. Cached matches remain available.", 429, Number.isFinite(requested) ? Math.max(60_000, Math.min(3_600_000, requested)) : 300_000);
      }
      if ([10, 26].includes(errorCode ?? -1)) throw new SimilarMixError("The Last.fm API key needs attention in Admin → Plugins.", 503, 600_000);
      if (errorCode === 6 || errorCode === 7) return { similartracks: { track: [] } };
      throw new SimilarMixError("Last.fm similarity is temporarily unavailable. Try again shortly.");
    }
    return payload;
  }
  private async vector(seed: Recording): Promise<{ vector: Vector; cached: boolean; warning?: string }> {
    const seedKey = this.vectorKey(seed), cached = this.readVector(seedKey);
    if (cached && cached.expires > this.now()) return { vector: cached, cached: true };
    const stale = cached && cached.expires + STALE > this.now() && cached.expires > 0 ? cached : undefined;
    if (cached && cached.retry > this.now()) return { vector: stale ?? { neighbors: [], expires: 0, retry: cached.retry }, cached: true, warning: "Similarity lookup is cooling down; showing cached matches where available." };
    const apiKey = this.options.apiKey();
    if (!apiKey) return { vector: stale ?? { neighbors: [], expires: 0, retry: 0 }, cached: true, warning: "Enable Last.fm and configure its API key in Admin → Plugins for song-similarity discovery." };
    const cooldown = `:service:${hash(apiKey).slice(0, 16)}`;
    const serviceState = this.db.prepare("SELECT retry_at FROM similar_mix_vectors WHERE seed_key=?").get(cooldown) as { retry_at: number } | undefined;
    if ((serviceState?.retry_at ?? 0) > this.now()) return { vector: stale ?? { neighbors: [], expires: 0, retry: serviceState!.retry_at }, cached: true, warning: "Last.fm lookups are paused after a provider error. Cached matches are still available." };
    const active = this.pending.get(seedKey);
    if (!active && this.pending.size >= 32) throw new SimilarMixError("Mix generation is busy. Try again shortly.", 429);
    const operation = active ?? this.slot(async () => {
      const latest = this.db.prepare("SELECT retry_at FROM similar_mix_vectors WHERE seed_key=?").get(cooldown) as { retry_at: number } | undefined;
      if (latest && latest.retry_at > this.now()) throw new SimilarMixError("Last.fm lookups are paused after a provider error. Cached matches are still available.", 429, latest.retry_at - this.now());
      const url = new URL("https://ws.audioscrobbler.com/2.0/");
      url.search = new URLSearchParams({ method: "track.getSimilar", artist: seed.artist, track: seed.title, autocorrect: "1", limit: "200", api_key: apiKey, format: "json" }).toString();
      const payload = await this.readJson(url);
      const parsed = z.object({ similartracks: z.object({ track: z.union([z.array(z.unknown()), z.object({}).strict(), z.string().length(0)]).optional() }) }).safeParse(payload);
      if (!parsed.success) throw new SimilarMixError("Last.fm returned invalid similarity data.");
      const raw = Array.isArray(parsed.data.similartracks.track) ? parsed.data.similartracks.track.slice(0, 200) : [];
      const found = raw.flatMap((row): Neighbor[] => {
        const item = z.object({ name: text, artist: z.union([text, z.object({ name: text })]), match: z.coerce.number().finite().nonnegative(), mbid: z.string().max(100).optional() }).safeParse(row);
        if (!item.success) return [];
        const artist = typeof item.data.artist === "string" ? item.data.artist : item.data.artist.name;
        if (!normalizeMusicText(item.data.name) || !normalizeMusicText(artist)) return [];
        return [{ id: externalId(item.data.name, artist), title: item.data.name, artist, match: item.data.match, mbid: item.data.mbid || null }];
      });
      // Legacy Last.fm responses can use a match scale above one. Normalize the vector together.
      const scale = Math.max(1, ...found.map(row => row.match));
      const unique = new Map<string, Neighbor>();
      for (const row of found) { row.match = bounded(row.match / scale); const previous = unique.get(row.id); if (!previous || previous.match < row.match) unique.set(row.id, row); }
      const neighbors = [...unique.values()], expires = this.now() + (neighbors.length ? TTL : DAY / 4);
      this.storeRecordings(neighbors);
      this.db.prepare(`INSERT INTO similar_mix_vectors(seed_key,payload_json,expires_at,retry_at,touched_at) VALUES(?,?,?,0,?)
        ON CONFLICT(seed_key) DO UPDATE SET payload_json=excluded.payload_json,expires_at=excluded.expires_at,retry_at=0,touched_at=excluded.touched_at`)
        .run(seedKey, JSON.stringify(neighbors), expires, this.now());
      this.db.prepare("DELETE FROM similar_mix_vectors WHERE seed_key IN (SELECT seed_key FROM similar_mix_vectors ORDER BY touched_at DESC LIMIT -1 OFFSET 2000)").run();
      const value = { neighbors, expires, retry: 0 }; this.remember(seedKey, value); return value;
    }).finally(() => { this.pending.delete(seedKey); });
    if (!active) this.pending.set(seedKey, operation);
    try { return { vector: await operation, cached: false }; }
    catch (error) {
      if (this.closed) throw new SimilarMixError("Mix generation stopped.");
      const retry = this.now() + (error instanceof SimilarMixError ? error.retryAfterMs ?? (error.statusCode === 429 ? 300_000 : 60_000) : 60_000);
      this.db.prepare(`INSERT INTO similar_mix_vectors(seed_key,expires_at,retry_at,touched_at) VALUES(?,0,?,?)
        ON CONFLICT(seed_key) DO UPDATE SET retry_at=excluded.retry_at,touched_at=excluded.touched_at`).run(seedKey, retry, this.now());
      if (error instanceof SimilarMixError && (error.statusCode === 429 || error.retryAfterMs)) this.db.prepare(`INSERT INTO similar_mix_vectors(seed_key,expires_at,retry_at,touched_at)
        VALUES(?,0,?,?) ON CONFLICT(seed_key) DO UPDATE SET retry_at=excluded.retry_at`).run(cooldown, retry, this.now());
      this.remember(seedKey, { neighbors: cached?.neighbors ?? [], expires: cached?.expires ?? 0, retry });
      return { vector: stale ?? { neighbors: [], expires: 0, retry }, cached: false, warning: error instanceof SimilarMixError ? error.message : "Could not reach Last.fm. Showing cached and related library matches." };
    }
  }

  private blocked(userId: string) {
    const shared = tasteProfile(this.db).feedbackFilter(userId);
    const ids = new Set<string>(), recordings = new Set<string>(), artists = new Set<string>();
    const rows = this.db.prepare(`SELECT item_type,item_id,identity_title,identity_artist FROM recommendation_feedback
      WHERE user_id=? AND action IN ('hide','not-interested','block-artist','block-album')`).all(userId) as
      Array<{ item_type: string; item_id: string; identity_title: string | null; identity_artist: string | null }>;
    for (const row of rows) {
      ids.add(`${row.item_type}:${row.item_id}`);
      if (row.item_type === "artist" && row.identity_artist) artists.add(normalizeMusicText(row.identity_artist));
      if (row.item_type === "track") {
        const track = this.known.get(row.item_id);
        const external = track ? null : this.db.prepare("SELECT title,artist FROM similar_mix_external_tracks WHERE id=?").get(row.item_id) as Recording | undefined;
        const title = row.identity_title ?? track?.title ?? external?.title, artist = row.identity_artist ?? track?.artistName ?? external?.artist;
        if (title && artist) recordings.add(key(title, artist));
      }
    }
    for (const row of rows) if (row.item_type === "artist") for (const name of this.artistNames.get(row.item_id) ?? []) artists.add(name);
    return (track: Track) => shared(tasteTarget(track)) && !ids.has(`track:${track.id}`) && !recordings.has(key(track.title, track.artistName)) &&
      !artists.has(normalizeMusicText(track.artistName)) && !ids.has(`artist:${artistId(track.artistName)}`) &&
      !(track.artistId && ids.has(`artist:${track.artistId}`)) && !(track.albumId && ids.has(`album:${track.albumId}`));
  }

  /** Live signals are restricted to this candidate pool, using existing (user,track) indexes. */
  private familiarity(userId: string, ids: string[]) {
    const candidates = JSON.stringify(ids);
    const rows = this.db.prepare(`SELECT track_id,MAX(plays) AS plays,MAX(favorite) AS favorite FROM (
      SELECT track_id,COUNT(*) AS plays,0 AS favorite FROM taste_recently_played WHERE user_id=? AND track_id IN (SELECT value FROM json_each(?)) GROUP BY track_id
      UNION ALL SELECT track_id,COUNT(DISTINCT COALESCE(playback_session_id,id)),0 FROM taste_listening_events
        WHERE user_id=? AND event_type IN ('play','complete') AND track_id IN (SELECT value FROM json_each(?)) GROUP BY track_id
      UNION ALL SELECT track_id,0,1 FROM favorites WHERE user_id=? AND track_id IN (SELECT value FROM json_each(?))
    ) GROUP BY track_id`).all(userId, candidates, userId, candidates, userId, candidates) as Array<{ track_id: string; plays: number; favorite: number }>;
    return new Map(rows.map(row => [row.track_id, bounded(Math.log1p(row.plays) / Math.log(21) * 0.75 + row.favorite * 0.25)]));
  }

  async generate(userId: string, input: SimilarMixInput): Promise<SimilarMixPreview> {
    const start = performance.now(), parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new SimilarMixError("Choose 1–5 unique seed songs, a valid scope, and adventurousness between 0 and 1.", 400);
    if (this.closed) throw new SimilarMixError("Mix generation is stopping.");
    this.catalog(); const request = parsed.data, adventure = request.adventurousness;
    const useExternal = request.scope !== "LIBRARY_ONLY";
    if (useExternal) currentPrivacyManager()?.assertExternalAllowed("metadata");
    if (useExternal && this.catalogDegraded) throw new SimilarMixError("Reconnect your library sources before building discovery mixes so owned songs can be identified accurately.");
    const seeds = request.seedTrackIds.map(id => this.recording(id)), seedKeys = new Set(seeds.map(seed => key(seed.title, seed.artist)));
    // Local-only mode may use previously cached public vectors without sending seed metadata out.
    const canLookup = currentPrivacyManager()?.isExternalAllowed("metadata") !== false;
    const vectors = await Promise.all(seeds.map(seed => canLookup ? this.vector(seed) : Promise.resolve({
      vector: this.readVector(this.vectorKey(seed)) ?? { neighbors: [], expires: 0, retry: 0 }, cached: true,
      warning: "External lookups are disabled. Using cached similarity and related library tracks.",
    })));
    const warnings = new Set(vectors.flatMap(result => result.warning ? [result.warning] : []));
    const pool = new Map<string, { track: Track; weights: number[]; graph: boolean }>();
    const add = (recording: Recording, strength: number, seedIndex: number, graph = true) => {
      const recordingKey = key(recording.title, recording.artist); if (seedKeys.has(recordingKey)) return;
      const owned = this.byRecording.get(recordingKey), local = owned ? this.local.get(owned.id) : undefined;
      if (owned && !local) return;
      if ((request.scope === "LIBRARY_ONLY" && !local) || (request.scope === "DISCOVERY_ONLY" && owned)) return;
      const track: Track = local ? { ...local, streamUrl: `/api/tracks/${encodeURIComponent(local.id)}/stream`, external: false, provider: "library", source: { kind: "library", count: 1 } } : {
        id: recording.id, providerId: recording.id, title: recording.title, artistName: recording.artist, artistId: artistId(recording.artist),
        albumName: "", albumId: null, durationSeconds: null, trackNumber: null, artworkId: null, artworkUrl: null, streamUrl: "",
        previewUrl: null, external: true, provider: "external", source: { kind: "external", count: 0 },
        ...(recording.mbid ? { identityHints: { musicBrainzId: recording.mbid } } : {}),
      };
      const existing = pool.get(recordingKey) ?? { track, weights: Array(seeds.length).fill(0), graph: false };
      existing.weights[seedIndex] = Math.max(existing.weights[seedIndex], strength); existing.graph ||= graph; pool.set(recordingKey, existing);
    };
    vectors.forEach(({ vector }, index) => {
      for (const neighbor of vector.neighbors) add(neighbor, neighbor.match, index);
      // Bounded second-hop traversal only uses existing cached vectors, never an unbounded API fan-out.
      if (adventure >= 0.6) for (const bridge of vector.neighbors.slice(0, 2)) {
        const next = this.readVector(this.vectorKey(bridge));
        if (next && next.expires + STALE > this.now()) for (const neighbor of next.neighbors.slice(0, 50)) add(neighbor, bridge.match * neighbor.match * 0.65, index);
      }
      if (request.scope !== "DISCOVERY_ONLY" && !["", "unknown", "unknown artist", "various artists"].includes(normalizeMusicText(seeds[index].artist))) for (const track of (this.byArtist.get(normalizeMusicText(seeds[index].artist)) ?? []).slice(0, 200)) {
        add({ id: track.id, title: track.title, artist: track.artistName }, 0.15, index, false);
      }
    });
    const allowed = this.blocked(userId), excluded = new Set(request.excludeTrackIds), excludedKeys = new Set<string>();
    for (const id of excluded) { try { const recording = this.recording(id); excludedKeys.add(key(recording.title, recording.artist)); } catch { /* Expired IDs still exclude by ID. */ } }
    const signals = this.familiarity(userId, [...pool.values()].filter(row => !row.track.external).map(row => row.track.id));
    const shuffleSeed = request.shuffleSeed ?? randomUUID();
    const scored: MixCandidate[] = [];
    for (const [identity, row] of pool) {
      const track = row.track; if (!allowed(track) || excluded.has(track.id) || excludedKeys.has(identity)) continue;
      const mean = row.weights.reduce((sum, value) => sum + value, 0) / seeds.length;
      const similarity = bounded(0.65 * Math.max(...row.weights) + 0.35 * mean);
      if (similarity <= 0) continue;
      const familiarity = track.external ? 0 : 0.25 + 0.75 * (signals.get(track.id) ?? 0);
      const closeness = Math.pow(similarity, 1.8 - adventure * 1.2);
      const novelty = 1 - familiarity;
      const score = closeness * 0.7 + (1 - adventure) * familiarity * 0.3 + adventure * novelty * 0.3;
      scored.push({ id: track.id, title: track.title, artist: track.artistName, album: track.albumName,
        inLibrary: !track.external, similarity, familiarity, score,
        reason: row.graph ? `Similar to ${row.weights.filter(value => value > 0).length} of your seed songs` : `Another song by ${track.artistName}`, track });
    }
    // Reproducible weighted exploration: refresh changes the nonce, while locks stay exact.
    const rank = (row: MixCandidate) => {
      const unit = (parseInt(hash(`${shuffleSeed}:${row.id}`).slice(0, 8), 16) + 1) / 4294967297;
      return row.score + (-Math.log(-Math.log(unit))) * (0.015 + adventure * 0.055);
    };
    const ranks = new Map(scored.map(row => [row.id, rank(row)]));
    scored.sort((a, b) => ranks.get(b.id)! - ranks.get(a.id)! || a.id.localeCompare(b.id));
    const byId = new Map(scored.map(row => [row.id, row]));
    const locks = [...new Set(request.lockedTrackIds)];
    if (locks.some(id => !byId.has(id))) throw new SimilarMixError("A locked song is no longer eligible. Unlock it and refresh the mix.", 409);
    const selected = locks.map(id => byId.get(id)!), seen = new Set(locks), artists = new Map<string, number>();
    selected.forEach(row => artists.set(normalizeMusicText(row.artist), (artists.get(normalizeMusicText(row.artist)) ?? 0) + 1));
    const externalTarget = request.scope === "HYBRID_MIX" ? Math.round(25 * adventure) : request.scope === "DISCOVERY_ONLY" ? 25 : 0;
    const take = (external: boolean | null, cap: number, target: number) => {
      for (const row of scored) {
        if (selected.length >= 25 || (external !== null && selected.filter(item => item.inLibrary !== external).length >= target)) break;
        const artist = normalizeMusicText(row.artist);
        if (seen.has(row.id) || (external !== null && row.inLibrary === external) || (artists.get(artist) ?? 0) >= cap) continue;
        selected.push(row); seen.add(row.id); artists.set(artist, (artists.get(artist) ?? 0) + 1);
      }
    };
    take(true, 2, externalTarget); take(false, 2, 25 - externalTarget);
    take(true, Infinity, externalTarget); take(false, Infinity, 25 - externalTarget);
    take(null, 2, 25); take(null, Infinity, 25);
    // Interleave discovery/familiar buckets and avoid consecutive artists when alternatives exist.
    const remaining = [...selected].sort((a, b) => ranks.get(b.id)! - ranks.get(a.id)!);
    const ordered: MixCandidate[] = [], externalCount = selected.filter(row => !row.inLibrary).length;
    let externalUsed = 0;
    while (remaining.length) {
      const wantExternal = Math.round((ordered.length + 1) * externalCount / selected.length) > externalUsed;
      const previousArtist = ordered.length ? normalizeMusicText(ordered[ordered.length - 1].artist) : "";
      const bucket = remaining.filter(row => row.inLibrary !== wantExternal);
      const next = bucket.find(row => normalizeMusicText(row.artist) !== previousArtist) ?? bucket[0] ?? remaining[0];
      remaining.splice(remaining.indexOf(next), 1); ordered.push(next); if (!next.inLibrary) externalUsed++;
    }
    if (selected.length < 25) warnings.add(`Found ${selected.length} eligible related songs. Add another seed to broaden the mix.`);
    if (this.catalogDegraded) warnings.add("Some library sources are unavailable; using the last indexed library snapshot.");
    if (useExternal) currentPrivacyManager()?.assertExternalAllowed("metadata");
    return { tracks: ordered, warnings: [...warnings], shuffleSeed, cached: vectors.every(result => result.cached), generatedInMs: performance.now() - start };
  }

  /** Revalidate live exclusions and scope before using a preview for save/queue. */
  materialize(userId: string, ids: string[]): Track[] {
    this.catalog(); const allowed = this.blocked(userId);
    return ids.map(id => {
      const local = this.local.get(id);
      if (local) { if (!allowed(local)) throw new SimilarMixError("A selected song was hidden. Refresh the mix.", 409); return { ...local, streamUrl: `/api/tracks/${encodeURIComponent(id)}/stream` }; }
      if (this.known.has(id)) throw new SimilarMixError("A selected library song is unavailable. Refresh the mix.", 409);
      currentPrivacyManager()?.assertExternalAllowed("metadata");
      const recording = this.recording(id), track: Track = {
        id, providerId: id, title: recording.title, artistName: recording.artist, artistId: artistId(recording.artist), albumName: "", albumId: null,
        durationSeconds: null, trackNumber: null, artworkId: null, artworkUrl: null, streamUrl: "", external: true, provider: "external", source: { kind: "external", count: 0 }, previewUrl: recording.preview_url ?? null,
      };
      if (this.byRecording.has(key(track.title, track.artistName))) throw new SimilarMixError("A discovery is now in your library. Refresh the mix before saving.", 409);
      if (!allowed(track)) throw new SimilarMixError("A selected song or artist was hidden. Refresh the mix.", 409);
      return track;
    });
  }
  async close() { this.closed = true; this.stop.abort(); await Promise.allSettled([...this.pending.values()]); }
}
