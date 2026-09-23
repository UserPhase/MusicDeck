import { describe, expect, test, vi } from "vitest";
import { LyricsService, parseLrcLines, sanitizeTrackTitle } from "../src/domain/lyrics-service.js";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";

const track = { title: "Bohemian Rhapsody", artist: "Queen", album: "A Night at the Opera", durationSeconds: 354.4 };

describe("LyricsService", () => {
  test("omits album metadata, identifies the client, and coalesces repeat lookups", async () => {
    const fetchImpl = vi.fn(async (input: URL | string, options?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("lrclib.net");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        track_name: "Bohemian Rhapsody", artist_name: "Queen", duration: "354",
      });
      expect(options?.headers).toMatchObject({ "Lrclib-Client": expect.stringContaining("MusicDeck/") });
      return new Response(JSON.stringify({ syncedLyrics: "[00:15.22] Is this the real life?",
        plainLyrics: "Is this the real life?", instrumental: false }), { status: 200 });
    });
    const service = new LyricsService(fetchImpl as typeof fetch);
    const [first, second] = await Promise.all([service.get("track-id", track), service.get("track-id", track)]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ syncedLyrics: [{ time: 15.22, text: "Is this the real life?" }],
      isSynced: true, provider: "lrclib" });
    await service.get("track-id", track);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("caches an unsuccessful three-tier lookup rather than retrying forever", async () => {
    const fetchImpl = vi.fn(async (input: URL | string) => new URL(String(input)).pathname === "/api/get"
      ? new Response("", { status: 404 }) : new URL(String(input)).pathname === "/api/search"
        ? new Response("[]", { status: 200 }) : new Response("", { status: 404 }));
    const service = new LyricsService(fetchImpl as typeof fetch);
    expect(await service.get("missing", track)).toMatchObject({ provider: "none", isSynced: false, plainLyrics: null });
    expect(await service.get("missing", track)).toMatchObject({ provider: "none" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("finds x valentine by GEMS through search and caches the closest lyrics by track ID", async () => {
    const fetchImpl = vi.fn(async (input: URL | string, options?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("track_name")).toBe("x valentine");
      expect(url.searchParams.get("artist_name")).toBe("gems");
      expect(options?.headers).toMatchObject({ "Lrclib-Client": expect.stringContaining("MusicDeck/") });
      return url.pathname === "/api/get" ? new Response("", { status: 404 })
        : new Response(JSON.stringify([
          { duration: 182, plainLyrics: "", syncedLyrics: null },
          { duration: 190, plainLyrics: "Further away" },
          { duration: 187.8, syncedLyrics: "[00:10.00] Closest match" },
        ]), { status: 200 });
    });
    const service = new LyricsService(fetchImpl as typeof fetch);
    const song = { title: "x valentine", artist: "gems", album: "X Valentine", durationSeconds: 188 };
    expect((await service.get("gems-track", song)).syncedLyrics).toEqual([{ time: 10, text: "Closest match" }]);
    expect((await service.get("gems-track", song)).syncedLyrics).toEqual([{ time: 10, text: "Closest match" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("strips feature and edition suffixes before direct lookup", async () => {
    expect(sanitizeTrackTitle("Song Name (feat. Artist) - Single")).toBe("Song Name");
    expect(sanitizeTrackTitle("Song Name [Remastered] (Deluxe Edition)")).toBe("Song Name");
    const fetchImpl = vi.fn(async (input: URL | string) => {
      expect(new URL(String(input)).searchParams.get("track_name")).toBe("Song Name");
      return new Response(JSON.stringify({ plainLyrics: "Found" }), { status: 200 });
    });
    const service = new LyricsService(fetchImpl as typeof fetch);
    expect((await service.get("featured", { ...track, title: "Song Name (feat. Artist) - Single" }))?.plainLyrics).toBe("Found");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("searches the primary artist only after the full artist fails", async () => {
    const artists: string[] = [];
    const fetchImpl = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      artists.push(url.searchParams.get("artist_name") || "");
      if (url.pathname === "/api/get") return new Response("", { status: 404 });
      return new Response(url.searchParams.get("artist_name") === "GEMS"
        ? JSON.stringify([{ duration: 188, plainLyrics: "Found" }]) : "[]", { status: 200 });
    });
    const service = new LyricsService(fetchImpl as typeof fetch);
    expect((await service.get("collab", { title: "X Valentine", artist: "GEMS & Another Artist", durationSeconds: 188 }))?.plainLyrics).toBe("Found");
    expect(artists).toEqual(["GEMS & Another Artist", "GEMS & Another Artist", "GEMS"]);
  });

  test("accepts an eight-second search difference but rejects nine seconds", async () => {
    const fetchImpl = vi.fn(async (input: URL | string) => new URL(String(input)).pathname === "/api/get"
      ? new Response("", { status: 404 })
      : new Response(JSON.stringify([{ duration: 208, plainLyrics: "Within tolerance" }]), { status: 200 }));
    const service = new LyricsService(fetchImpl as typeof fetch);
    expect((await service.get("eight", { ...track, durationSeconds: 200 }))?.plainLyrics).toBe("Within tolerance");
    expect((await service.get("nine", { ...track, durationSeconds: 199 })).provider).toBe("none");
  });

  test("uses lyrics.ovh only after LRCLIB has no lyrics and normalizes plain text", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      calls.push(url.href);
      if (url.pathname === "/api/get") return new Response("", { status: 404 });
      if (url.pathname === "/api/search") return new Response("[]", { status: 200 });
      return new Response(JSON.stringify({ lyrics: "First line\r\nSecond line\r\n" }), { status: 200 });
    });
    const service = new LyricsService(fetchImpl as typeof fetch);
    const song = { title: "Song & More - Single", artist: "Artist / Band", durationSeconds: 200 };
    expect(await service.get("ovh-song", song)).toEqual({ syncedLyrics: null,
      plainLyrics: "First line\nSecond line", isSynced: false, provider: "lyricsovh", instrumental: false });
    expect(calls[2]).toBe("https://api.lyrics.ovh/v1/Artist%20%2F%20Band/Song%20%26%20More");
    await service.get("ovh-song", song);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("falls through LRCLIB network failures and settles silently when lyrics.ovh is unavailable", async () => {
    const fetchImpl = vi.fn(async (input: URL | string) => {
      if (String(input).startsWith("https://lrclib.net")) throw new Error("offline");
      return new Response("", { status: 404 });
    });
    const service = new LyricsService(fetchImpl as typeof fetch);
    expect(await service.get("offline", track)).toMatchObject({ provider: "none", isSynced: false, plainLyrics: null });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("parses repeated LRC timestamps without treating untimed text as synchronized", () => {
    expect(parseLrcLines("[00:10.22][00:12.300] Hello\nUntimed"))
      .toEqual([{ time: 10.22, text: "Hello" }, { time: 12.3, text: "Hello" }]);
    expect(parseLrcLines("Plain lyrics only")).toEqual([]);
  });

  test("the authenticated route accepts lyrics metadata without an album", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      syncedLyrics: "[00:15.22] Hello", plainLyrics: "Hello", instrumental: false,
    }), { status: 200 }));
    const server = await createTestServer(createFakeBackend(), {}, undefined, fetchImpl as typeof fetch);
    try {
      const { cookie } = await login(server.app);
      const query = new URLSearchParams({ track_name: "Hello", artist_name: "Artist", duration: "180" });
      const response = await server.app.inject({ method: "GET",
        url: `/api/tracks/track-1/lyrics?${query}`, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json().syncedLyrics).toEqual([{ time: 15.22, text: "Hello" }]);
      expect(response.json().isSynced).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await closeTestServer(server.app, server.db);
    }
  });
});
