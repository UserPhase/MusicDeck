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
