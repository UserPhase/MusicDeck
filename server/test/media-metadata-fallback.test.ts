import { describe, expect, test, vi } from "vitest";
import { MediaMetadataFallback } from "../src/domain/media-metadata-fallback.js";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";

describe("Media metadata fallback", () => {
  test("matches both album and artist, coalesces lookups, and upgrades cover resolution", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ results: [
      { collectionName: "Album", artistName: "Other", artworkUrl100: "https://is1.mzstatic.com/other/100x100bb.jpg" },
      { collectionName: "Album", artistName: "Artist", artworkUrl100: "https://is1.mzstatic.com/match/100x100bb.jpg" },
    ] }));
    const service = new MediaMetadataFallback(fetchImpl);
    const results = await Promise.all([service.getAlbumCover("Artist", "Album"), service.getAlbumCover("Artist", "Album")]);
    expect(results).toEqual(["https://is1.mzstatic.com/match/1000x1000bb.jpg", "https://is1.mzstatic.com/match/1000x1000bb.jpg"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await service.getAlbumCover("Artist", "Album");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("rejects hostile cover URLs and falls back to verified Deezer covers", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes("itunes.apple.com")
      ? Response.json({ results: [{ collectionName: "Album", artistName: "Artist", artworkUrl100: "https://mzstatic.com.evil.test/a.jpg" }] })
      : Response.json({ data: [{ title: "Album", artist: { name: "Artist" }, cover_xl: "https://cdn.dzcdn.net/images/cover/a.jpg" }] }));
    const service = new MediaMetadataFallback(fetchImpl);
    expect(await service.getAlbumCover("Artist", "Album")).toBe("https://cdn.dzcdn.net/images/cover/a.jpg");
    await expect(service.fetchCover("http://localhost/private")).rejects.toThrow("Invalid metadata artwork URL");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("uses Deezer when iTunes is unavailable and caches genuine misses", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes("itunes.apple.com")
      ? new Response("", { status: 503 })
      : Response.json({ data: [{ title: "Album", artist: { name: "Artist" }, cover_xl: "https://cdn.dzcdn.net/images/cover/a.jpg" }] }));
    expect(await new MediaMetadataFallback(fetchImpl).getAlbumCover("Artist", "Album"))
      .toBe("https://cdn.dzcdn.net/images/cover/a.jpg");
    const noMatches = vi.fn(async (input: string | URL | Request) => String(input).includes("itunes.apple.com")
      ? Response.json({ results: [] }) : Response.json({ data: [] }));
    const service = new MediaMetadataFallback(noMatches);
    expect(await service.getAlbumCover("Missing", "Album")).toBeNull();
    expect(await service.getAlbumCover("Missing", "Album")).toBeNull();
    expect(noMatches).toHaveBeenCalledTimes(2);
  });

  test("throttles distinct lookups to five concurrent upstream requests", async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return Response.json({ extract: "This artist is a singer." });
    });
    const service = new MediaMetadataFallback(fetchImpl);
    await Promise.all(Array.from({ length: 12 }, (_, index) => service.getBiography(`Artist ${index}`)));
    expect(peak).toBe(5);
  });

  test("rejects unrelated/disambiguation summaries and caches the musical biography", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/Muse")
      ? Response.json({ type: "disambiguation", extract: "A mythological figure" })
      : Response.json({ title: "Muse (band)", description: "English rock band", extract: "<b>Muse</b> are an English rock band. [1]" }));
    const service = new MediaMetadataFallback(fetchImpl);
    expect(await service.getBiography("Muse")).toEqual({ text: "Muse are an English rock band.",
      source: "wikipedia", url: "https://en.wikipedia.org/wiki/Muse_(band)" });
    await service.getBiography("Muse");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("serves fallback media through authenticated routes and validates parameters", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes("itunes.apple.com")
      ? Response.json({ results: [{ collectionName: "Album", artistName: "Artist", artworkUrl100: "https://is1.mzstatic.com/a/100x100bb.jpg" }] })
      : String(input).includes("mzstatic.com")
        ? new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/jpeg" } })
        : Response.json({ title: "Artist", extract: "Artist is a singer and musician." }));
    const { app, db } = await createTestServer(createFakeBackend(), {}, undefined, fetchImpl);
    try {
      expect((await app.inject("/api/metadata/album-artwork?artist=Artist&album=Album")).statusCode).toBe(401);
      const { cookie } = await login(app);
      const image = await app.inject({ url: "/api/metadata/album-artwork?artist=Artist&album=Album", headers: { cookie } });
      expect(image.statusCode).toBe(200);
      expect(image.headers["content-type"]).toBe("image/jpeg");
      expect(image.rawPayload).toEqual(Buffer.from([1, 2]));
      expect((await app.inject({ url: "/api/metadata/artist-biography?artist=Artist", headers: { cookie } })).json().biography.text)
        .toBe("Artist is a singer and musician.");
      expect((await app.inject({ url: "/api/metadata/album-artwork?artist=Artist", headers: { cookie } })).statusCode).toBe(400);
    } finally { await closeTestServer(app, db); }
  });

  test("rejects oversized CDN payloads instead of buffering them without a limit", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes("itunes.apple.com")
      ? Response.json({ results: [{ collectionName: "Album", artistName: "Artist", artworkUrl100: "https://is1.mzstatic.com/a/100x100bb.jpg" }] })
      : new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { "Content-Type": "image/jpeg" } }));
    const { app, db } = await createTestServer(createFakeBackend(), {}, undefined, fetchImpl);
    try {
      const { cookie } = await login(app);
      const image = await app.inject({ url: "/api/metadata/album-artwork?artist=Artist&album=Album", headers: { cookie } });
      expect(image.statusCode).toBe(502);
      expect(image.json().error.message).toContain("size limit");
    } finally { await closeTestServer(app, db); }
  });
});
