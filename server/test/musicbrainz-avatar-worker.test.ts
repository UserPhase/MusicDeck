import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import { MusicBrainzAvatarWorker } from "../src/domain/musicbrainz-avatar-worker.js";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";

const mbid = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";
const imageUrl = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Queen.jpg/500px-Queen.jpg";
const artist = { id: "local-queen", name: "Queen" };

function memoryDb() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
  return db;
}

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("MusicBrainz background avatar worker", () => {
  test("resolves the artist's Wikidata P18 photo and persists it across workers", async () => {
    const db = memoryDb();
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "musicbrainz.org") {
        expect(init?.headers).toMatchObject({ "User-Agent": expect.stringContaining("MusicDeck/") });
        if (url.searchParams.has("query")) return response({ artists: [{ id: mbid, name: "Queen", type: "Group" }] });
        expect(url.searchParams.get("inc")).toBe("url-rels");
        return response({ id: mbid, name: "Queen", relations: [
          { type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q15862" } },
        ] });
      }
      if (url.hostname === "www.wikidata.org") {
        expect(url.searchParams.get("ids")).toBe("Q15862");
        return response({ entities: { Q15862: { claims: { P18: [
          { mainsnak: { datavalue: { value: "Queen.jpg" } } },
        ] } } } });
      }
      expect(url.hostname).toBe("commons.wikimedia.org");
      expect(url.searchParams.get("titles")).toBe("File:Queen.jpg");
      return response({ query: { pages: { "1": { imageinfo: [{ thumburl: imageUrl }] } } } });
    });
    try {
      const worker = new MusicBrainzAvatarWorker(db, fetchImpl as typeof fetch, 0);
      expect(await worker.resolve(artist)).toBe(imageUrl);
      expect(worker.cached(artist)).toBe(imageUrl);
      const calls = fetchImpl.mock.calls.length;
      expect(await new MusicBrainzAvatarWorker(db, fetchImpl as typeof fetch, 0).resolve(artist)).toBe(imageUrl);
      expect(fetchImpl).toHaveBeenCalledTimes(calls);
      worker.purge(artist.id);
      expect(worker.cached(artist)).toBeNull();
    } finally { db.close(); }
  });

  test("rejects ambiguous same-name artists instead of showing the wrong picture", async () => {
    const db = memoryDb();
    const fetchImpl = vi.fn(async () => response({ artists: [
      { id: mbid, name: "Queen" },
      { id: "5e372a49-5672-42ab-8697-18c8c7cdf183", name: "Queen" },
    ] }));
    try {
      const worker = new MusicBrainzAvatarWorker(db, fetchImpl as typeof fetch, 0);
      expect(await worker.resolve(artist)).toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(worker.cached(artist)).toBeNull();
    } finally { db.close(); }
  });

  test("uses an ID-scoped MBID hint and refuses non-Wikimedia image URLs", async () => {
    const db = memoryDb();
    const fetchImpl = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.hostname === "musicbrainz.org") return response({ id: mbid, name: "Queen", relations: [
        { type: "wikimedia commons", url: { resource: "https://commons.wikimedia.org/wiki/File:Queen.jpg" } },
      ] });
      return response({ query: { pages: { "1": { imageinfo: [
        { thumburl: "https://untrusted.example/album-cover.jpg" },
      ] } } } });
    });
    try {
      const worker = new MusicBrainzAvatarWorker(db, fetchImpl as typeof fetch, 0);
      expect(await worker.resolve({ ...artist, identityHints: { musicBrainzId: mbid } })).toBeNull();
      expect(fetchImpl.mock.calls.some(([input]) => new URL(String(input)).searchParams.has("query"))).toBe(false);
    } finally { db.close(); }
  });

  test("artist overview completes while the separate MusicBrainz request is still pending", async () => {
    let finishMusicBrainz!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { finishMusicBrainz = resolve; }));
    const current = await createTestServer(createFakeBackend(), {}, undefined, fetchImpl as typeof fetch);
    try {
      const { cookie } = await login(current.app);
      const artists = await current.app.inject({ method: "GET", url: "/api/artists", headers: { cookie } });
      const artistId = artists.json().artists[0].id;
      const slowPortrait = current.app.inject({ method: "GET",
        url: `/api/artists/${artistId}/portrait/musicbrainz`, headers: { cookie } });
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      const overview = await current.app.inject({ method: "GET",
        url: `/api/artists/${artistId}/overview?scope=local`, headers: { cookie } });
      expect(overview.statusCode).toBe(200);
      expect(overview.json().albums).toHaveLength(1);
      expect(overview.json().tracks).toHaveLength(1);
      finishMusicBrainz(response({ artists: [] }));
      expect((await slowPortrait).json().imageUrl).toBeNull();
    } finally {
      await closeTestServer(current.app, current.db);
    }
  });
});
