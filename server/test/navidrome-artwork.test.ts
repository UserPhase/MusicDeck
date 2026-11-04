import { expect, test, vi } from "vitest";
import { NavidromeBackend } from "../src/backends/navidrome/navidrome-backend.js";
import { NavidromeArtwork } from "../src/services/media/navidromeArtwork.js";
import { isDefaultPlaceholder } from "../src/services/media/placeholderDetector.js";

const config = { url: "http://navidrome.test", username: "test", password: "test" };

test("HTTP 200 default cover bytes are rejected for an opaque album ID before rendering", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const id = new URL(String(input)).searchParams.get("id");
    return new Response(id === "genuine" ? "real-image-bytes" : "blue-vinyl-bytes",
      { headers: { "content-type": "image/png" } });
  });
  const backend = new NavidromeBackend(config, fetchImpl);
  expect((await backend.fetchArtwork("opaque-album")).status).toBe(404);
  const real = await backend.fetchArtwork("genuine");
  expect(real.status).toBe(200);
  expect(await new Response(real.body).text()).toBe("real-image-bytes");
  expect(fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).searchParams.get("id") === "al-0")).toHaveLength(1);
});

test("known placeholder IDs never request artwork; valid ID prefixes are preserved", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const backend = new NavidromeBackend(config, fetchImpl);
  expect((await backend.fetchArtwork("al-0")).status).toBe(404);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(isDefaultPlaceholder("/api/artwork/al-0?size=300")).toBe(true);
  expect(isDefaultPlaceholder("al-0123")).toBe(false);
});

test("default comparisons are scoped to provider instance and thumbnail size", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const size = new URL(String(input)).searchParams.get("size");
    return new Response(`default-${size}`, { headers: { "content-type": "image/png" } });
  });
  const backend = new NavidromeBackend(config, fetchImpl);
  expect((await backend.fetchArtwork("opaque", 300)).status).toBe(404);
  expect((await backend.fetchArtwork("opaque", 600)).status).toBe(404);
  expect(fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).searchParams.get("id") === "al-0")).toHaveLength(2);
});

test("servers without al-0 defaults retain genuine covers; fingerprint failures are surfaced and retried", async () => {
  const inspector = new NavidromeArtwork();
  const image = () => Promise.resolve(new Response("real", { headers: { "content-type": "image/png" } }));
  await expect(inspector.read("cover", undefined, image, async () => new Response(null, { status: 503 })))
    .rejects.toThrow("503");
  const result = await inspector.read("cover", undefined, image, async () => new Response(null, { status: 404 }));
  expect(result.status).toBe(200);
  await result.body?.cancel();
});

test("falls back to a secondary reference when al-0 returns an error document", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const id = new URL(String(input)).searchParams.get("id");
    if (id === "al-0") return new Response(null, { status: 404 });
    if (id === "genuine") return new Response("real", { headers: { "content-type": "image/png" } });
    return new Response("placeholder", { headers: { "content-type": "image/png" } });
  });
  const backend = new NavidromeBackend(config, fetchImpl);
  // al-0 errors, but ar-0 yields the placeholder fingerprint, so the no-art album is detected.
  expect((await backend.fetchArtwork("al-noart")).status).toBe(404);
  const genuine = await backend.fetchArtwork("genuine");
  expect(genuine.status).toBe(200);
  await genuine.body?.cancel();
});

test("self-calibrates the placeholder from repeated identical images when every reference errors", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const id = new URL(String(input)).searchParams.get("id");
    if (["al-0", "ar-0", "mf-0"].includes(id!)) return new Response(null, { status: 404 });
    return new Response("placeholder", { headers: { "content-type": "image/png" } });
  });
  const backend = new NavidromeBackend(config, fetchImpl);
  // First no-art entity cannot be proven yet: served but flagged uncertain.
  const first = await backend.fetchArtwork("al-one");
  expect(first.status).toBe(200);
  expect(first.headers.get("x-musicdeck-artwork")).toBe("uncertain");
  await first.body?.cancel();
  // The same image served for a second distinct entity is the default placeholder.
  expect((await backend.fetchArtwork("al-two")).status).toBe(404);
  expect((await backend.fetchArtwork("al-three")).status).toBe(404);
});

test("a placeholder album cover falls back to the album's genuine track cover", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/getAlbum.view")) {
      return new Response(JSON.stringify({ "subsonic-response": { status: "ok", album: {
        id: "album", song: [{ id: "t1" }, { id: "t2", coverArt: "mf-real" }],
      } } }), { headers: { "content-type": "application/json" } });
    }
    const id = url.searchParams.get("id");
    if (id === "mf-real") return new Response("real-track-art", { headers: { "content-type": "image/png" } });
    return new Response("placeholder", { headers: { "content-type": "image/png" } });
  });
  const backend = new NavidromeBackend(config, fetchImpl);
  const result = await backend.fetchArtwork("al-album");
  expect(result.status).toBe(200);
  expect(await new Response(result.body).text()).toBe("real-track-art");
  // The resolution is cached: a second request does not re-query the album.
  await backend.fetchArtwork("al-album");
  expect(fetchImpl.mock.calls.filter(([input]) => String(input).includes("getAlbum"))).toHaveLength(1);
});

test("a placeholder album cover with no track art stays 404, and genuine album art never queries tracks", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/getAlbum.view")) {
      return new Response(JSON.stringify({ "subsonic-response": { status: "ok", album: { id: "album", song: [{ id: "t1" }] } } }),
        { headers: { "content-type": "application/json" } });
    }
    const id = url.searchParams.get("id");
    return new Response(id === "al-genuine" ? "real-album-art" : "placeholder", { headers: { "content-type": "image/png" } });
  });
  const backend = new NavidromeBackend(config, fetchImpl);
  expect((await backend.fetchArtwork("al-empty")).status).toBe(404);
  const genuine = await backend.fetchArtwork("al-genuine");
  expect(genuine.status).toBe(200);
  expect(await new Response(genuine.body).text()).toBe("real-album-art");
  // Track covers never trigger the album fallback.
  expect((await backend.fetchArtwork("mf-noart")).status).toBe(404);
  expect(fetchImpl.mock.calls.filter(([input]) => String(input).includes("getAlbum"))).toHaveLength(1);
});

test("an unproven album cover yields to track art, and a failing album lookup preserves the original verdict", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (["al-0", "ar-0", "mf-0"].includes(url.searchParams.get("id")!)) return new Response(null, { status: 404 });
    if (url.pathname.endsWith("/getAlbum.view")) {
      const id = url.searchParams.get("id");
      if (id === "broken") return new Response("not json", { status: 200 });
      return new Response(JSON.stringify({ "subsonic-response": { status: "ok", album: {
        id, song: [{ id: "t1", coverArt: "mf-real" }],
      } } }), { headers: { "content-type": "application/json" } });
    }
    const id = url.searchParams.get("id");
    if (id === "mf-real") return new Response("real-track-art", { headers: { "content-type": "image/png" } });
    if (id === "al-broken") return new Response("other-image", { headers: { "content-type": "image/png" } });
    return new Response("placeholder", { headers: { "content-type": "image/png" } });
  });
  const backend = new NavidromeBackend(config, fetchImpl);
  // No fingerprint available: the unproven album cover is replaced by track art.
  const result = await backend.fetchArtwork("al-album");
  expect(result.status).toBe(200);
  expect(await new Response(result.body).text()).toBe("real-track-art");
  // A failing album lookup keeps the original unproven image rather than erroring.
  const broken = await backend.fetchArtwork("al-broken");
  expect(broken.status).toBe(200);
  expect(broken.headers.get("x-musicdeck-artwork")).toBe("uncertain");
  await broken.body?.cancel();
});

test("oversized artwork is cancelled rather than buffered without limit", async () => {
  const cancel = vi.fn();
  const inspector = new NavidromeArtwork();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel,
  });
  await expect(inspector.read("cover", undefined,
    async () => new Response(body, { headers: { "content-type": "image/png" } }),
    async () => new Response(null, { status: 404 }))).rejects.toThrow("5 MB");
  expect(cancel).toHaveBeenCalled();
});
