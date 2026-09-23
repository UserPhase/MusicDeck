import type { Db } from "../db/database.js";
import type { Artist } from "../types.js";
import { normalizeMusicText } from "./music-identity.js";

const MUSICBRAINZ = "https://musicbrainz.org/ws/2/artist/";
const WIKIDATA = "https://www.wikidata.org/w/api.php";
const COMMONS = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT = "MusicDeck/0.1 (https://github.com/UserPhase/MusicDeck)";
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WIKIDATA_ID = /^Q[1-9]\d*$/;

type MusicBrainzArtist = {
  id?: string;
  name?: string;
  type?: string;
  relations?: Array<{ type?: string; url?: { resource?: string } }>;
};
type MusicBrainzSearch = { artists?: MusicBrainzArtist[] };
type WikidataResponse = { entities?: Record<string, {
  claims?: { P18?: Array<{ mainsnak?: { datavalue?: { value?: string } } }> };
}> };
type CommonsResponse = { query?: { pages?: Record<string, {
  imageinfo?: Array<{ thumburl?: string; url?: string }>;
}> } };

// Shared by all worker instances so concurrent artist pages cannot exceed MB's limit.
let musicBrainzQueue = Promise.resolve();
let lastMusicBrainzRequestAt = 0;

async function throttledMusicBrainz<T>(fetchImpl: typeof fetch, url: URL, intervalMs: number): Promise<T | null> {
  const previous = musicBrainzQueue;
  let release!: () => void;
  musicBrainzQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const pause = lastMusicBrainzRequestAt + intervalMs - Date.now();
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
    lastMusicBrainzRequestAt = Date.now();
    const response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? await response.json() as T : null;
  } catch {
    return null;
  } finally {
    release();
  }
}

function artistRelation(artist: MusicBrainzArtist): { wikidataId?: string; commonsFile?: string } {
  for (const relation of artist.relations || []) {
    const resource = relation.url?.resource;
    if (!resource) continue;
    if (relation.type === "wikidata") {
      const id = resource.match(/\/(Q[1-9]\d*)\/?$/)?.[1];
      if (id) return { wikidataId: id };
    }
    if (relation.type === "wikimedia commons") {
      const file = resource.match(/\/wiki\/(?:File:|Special:FilePath\/)([^?#]+)/i)?.[1];
      if (file) {
        try { return { commonsFile: decodeURIComponent(file).replaceAll("_", " ") }; }
        catch { /* Malformed external URL; continue looking for Wikidata. */ }
      }
    }
  }
  return {};
}

function validWikimediaImage(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "upload.wikimedia.org"
      && url.pathname.startsWith("/wikipedia/commons/");
  } catch { return false; }
}

/** Slow, ID-scoped avatar enrichment; never call this from the artist overview. */
export class MusicBrainzAvatarWorker {
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly negativeUntil = new Map<string, number>();

  constructor(private readonly db: Db, private readonly fetchImpl: typeof fetch = fetch,
    private readonly intervalMs = 1_100) {}

  cached(artist: Pick<Artist, "id" | "name">): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?")
      .get(`artist_avatar_mb:${artist.id}`) as { value: string } | undefined;
    if (!row) return null;
    try {
      const value = JSON.parse(row.value) as { name?: string; url?: string };
      return value.name === artist.name && validWikimediaImage(value.url) ? value.url : null;
    } catch { return null; }
  }

  purge(artistId: string) {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(`artist_avatar_mb:${artistId}`);
    this.negativeUntil.delete(artistId);
  }

  resolve(artist: Pick<Artist, "id" | "name" | "identityHints">): Promise<string | null> {
    const cached = this.cached(artist);
    if (cached) return Promise.resolve(cached);
    if ((this.negativeUntil.get(artist.id) || 0) > Date.now()) return Promise.resolve(null);
    const pending = this.pending.get(artist.id);
    if (pending) return pending;
    const lookup = this.lookup(artist).then((url) => {
      if (url) this.db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(`artist_avatar_mb:${artist.id}`, JSON.stringify({ name: artist.name, url }), new Date().toISOString());
      else this.negativeUntil.set(artist.id, Date.now() + 60 * 60_000);
      return url;
    }).catch(() => {
      this.negativeUntil.set(artist.id, Date.now() + 60_000);
      return null;
    }).finally(() => this.pending.delete(artist.id));
    this.pending.set(artist.id, lookup);
    return lookup;
  }

  private async lookup(artist: Pick<Artist, "name" | "identityHints">): Promise<string | null> {
    let mbid = artist.identityHints?.musicBrainzId;
    if (!mbid || !MBID.test(mbid)) {
      const search = new URL(MUSICBRAINZ);
      search.searchParams.set("query", `artist:"${artist.name.replaceAll('"', '\\"')}"`);
      search.searchParams.set("fmt", "json");
      search.searchParams.set("limit", "10");
      const result = await throttledMusicBrainz<MusicBrainzSearch>(this.fetchImpl, search, this.intervalMs);
      const exact = (result?.artists || []).filter((item) => MBID.test(item.id || "")
        && normalizeMusicText(item.name) === normalizeMusicText(artist.name)
        && (!item.type || ["Person", "Group", "Orchestra", "Choir", "Other"].includes(item.type)));
      // A shared artist name is not sufficient evidence to choose one entity.
      if (exact.length !== 1) return null;
      mbid = exact[0].id;
    }
    if (!mbid || !MBID.test(mbid)) return null;
    const detail = new URL(mbid, MUSICBRAINZ);
    detail.searchParams.set("inc", "url-rels");
    detail.searchParams.set("fmt", "json");
    const entry = await throttledMusicBrainz<MusicBrainzArtist>(this.fetchImpl, detail, this.intervalMs);
    if (!entry || normalizeMusicText(entry.name) !== normalizeMusicText(artist.name)) return null;
    let { wikidataId, commonsFile } = artistRelation(entry);
    if (!commonsFile && wikidataId && WIKIDATA_ID.test(wikidataId)) {
      const url = new URL(WIKIDATA);
      url.search = new URLSearchParams({ action: "wbgetentities", ids: wikidataId,
        props: "claims", format: "json" }).toString();
      const entity = await this.getJson<WikidataResponse>(url);
      commonsFile = entity?.entities?.[wikidataId]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    }
    if (!commonsFile || commonsFile.length > 300) return null;
    const commons = new URL(COMMONS);
    commons.search = new URLSearchParams({ action: "query", titles: `File:${commonsFile}`,
      prop: "imageinfo", iiprop: "url", iiurlwidth: "500", format: "json" }).toString();
    const image = await this.getJson<CommonsResponse>(commons);
    const info = Object.values(image?.query?.pages || {})[0]?.imageinfo?.[0];
    const url = info?.thumburl || info?.url;
    return validWikimediaImage(url) ? url : null;
  }

  private async getJson<T>(url: URL): Promise<T | null> {
    try {
      const response = await this.fetchImpl(url, { headers: { "User-Agent": USER_AGENT,
        Accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
      return response.ok ? await response.json() as T : null;
    } catch { return null; }
  }
}
