import { describe, expect, test, vi } from "vitest";
import Database from "better-sqlite3";

import { SourceResolver, SourceUnavailableError } from "../src/domain/source-resolver.js";
import { LibraryService } from "../src/domain/library.js";
import { runMigrations } from "../src/db/migrations.js";
import { ProviderRegistry, type RegisteredProvider } from "../src/backends/registry.js";
import type { MusicBackend } from "../src/backends/music-backend.js";
import type { StreamResult } from "../src/backends/stream-provider.js";
import { createFakeBackend } from "./helpers.js";

function streamResult(marker: string): StreamResult {
  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(marker));
        controller.close();
      },
    }),
    status: 200,
    headers: new Headers({ "content-type": "audio/mpeg" }),
  };
}

function makeSetup(...providers: MusicBackend[]) {
  const db = new Database(":memory:");
  runMigrations(db);
  const library = new LibraryService(db);
  const registry = new ProviderRegistry(
    providers.map((provider, index) => ({
      connectionId: `conn-${index + 1}`,
      type: "navidrome",
      name: `Navidrome ${index + 1}`,
      enabled: true,
      provider,
    }))
  );

  return { db, library, registry, resolver: new SourceResolver(registry, library) };
}

describe("SourceResolver", () => {
  test("resolves a single source successfully", async () => {
    const backend = createFakeBackend({
      fetchStream: vi.fn(async () => streamResult("a")),
    });
    const { library, resolver } = makeSetup(backend);

    const id = library.ensureId("track", { connectionId: "conn-1", providerItemId: "t-1" });
    const result = await resolver.fetchStream(id);

    expect(result.status).toBe(200);
    expect(backend.fetchStream).toHaveBeenCalledWith("t-1", undefined);
  });

  test("prefers the first source in deterministic registry order", async () => {
    const a = createFakeBackend({ fetchStream: vi.fn(async () => streamResult("a")) });
    const b = createFakeBackend({ fetchStream: vi.fn(async () => streamResult("b")) });
    const { library, resolver } = makeSetup(a, b);

    const id = library.ensureId("track", { connectionId: "conn-1", providerItemId: "t-1" });
    library.addSource(id, { connectionId: 'conn-2', providerItemId: 't-2' });

    await resolver.fetchStream(id);

    expect(a.fetchStream).toHaveBeenCalledWith("t-1", undefined);
    expect(b.fetchStream).not.toHaveBeenCalled();
  });

  test("honors a preferred source and still falls back if it fails", async () => {
    const a = createFakeBackend({ fetchStream: vi.fn(async () => streamResult("a")) });
    const b = createFakeBackend({ fetchStream: vi.fn(async () => streamResult("b")) });
    const { library, resolver } = makeSetup(a, b);

    const id = library.ensureId("track", { connectionId: "conn-1", providerItemId: "t-1" });
    library.addSource(id, { connectionId: "conn-2", providerItemId: "t-2" });

    // Prefer conn-2 even though conn-1 is first in registry order.
    const result = await resolver.fetchStream(id, undefined, "conn-2");

    expect(result.status).toBe(200);
    expect(b.fetchStream).toHaveBeenCalledWith("t-2", undefined);
    expect(a.fetchStream).not.toHaveBeenCalled();
  });

  test("falls back to the default source when the preferred source fails", async () => {
    const a = createFakeBackend({ fetchStream: vi.fn(async () => streamResult("a")) });
    const b = createFakeBackend({
      fetchStream: vi.fn(async () => {
        throw new Error("B down");
      }),
    });
    const { library, resolver } = makeSetup(a, b);

    const id = library.ensureId("track", { connectionId: "conn-1", providerItemId: "t-1" });
    library.addSource(id, { connectionId: "conn-2", providerItemId: "t-2" });

    // Prefer conn-2 (fails); resolver falls back to conn-1.
    const result = await resolver.fetchStream(id, undefined, "conn-2");

    expect(result.status).toBe(200);
    expect(b.fetchStream).toHaveBeenCalledWith("t-2", undefined);
    expect(a.fetchStream).toHaveBeenCalledWith("t-1", undefined);
  });

  test("falls back to the next source when the preferred source fails", async () => {
    const failing = createFakeBackend({
      fetchStream: vi.fn(async () => {
        throw new Error("provider A exploded");
      }),
    });
    const working = createFakeBackend({ fetchStream: vi.fn(async () => streamResult("b")) });
    const { library, resolver } = makeSetup(failing, working);

    const id = library.ensureId("track", { connectionId: "conn-1", providerItemId: "t-1" });
    library.addSource(id, { connectionId: 'conn-2', providerItemId: 't-2' });

    const result = await resolver.fetchStream(id);

    expect(result.status).toBe(200);
    expect(failing.fetchStream).toHaveBeenCalled();
    expect(working.fetchStream).toHaveBeenCalledWith("t-2", undefined);
  });

  test("throws SourceUnavailableError when every source fails", async () => {
    const a = createFakeBackend({
      fetchStream: vi.fn(async () => {
        throw new Error("A down");
      }),
    });
    const b = createFakeBackend({
      fetchStream: vi.fn(async () => {
        throw new Error("B down");
      }),
    });
    const { library, resolver } = makeSetup(a, b);

    const id = library.ensureId("track", { connectionId: "conn-1", providerItemId: "t-1" });
    library.addSource(id, { connectionId: 'conn-2', providerItemId: 't-2' });

    await expect(resolver.fetchStream(id)).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  test("throws SourceUnavailableError when no source mapping exists", async () => {
    const { resolver } = makeSetup(createFakeBackend());

    await expect(resolver.fetchStream("md_unmapped")).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  test("does not leak raw provider error messages", async () => {
    const leaking = createFakeBackend({
      fetchStream: vi.fn(async () => {
        throw new Error("Navidrome returned 401 for user=service-user password=secret");
      }),
    });
    const { library, resolver } = makeSetup(leaking);

    const id = library.ensureId("track", { connectionId: "conn-1", providerItemId: "t-1" });

    const failure = await resolver.fetchStream(id).catch((error) => error);
    expect(failure).toBeInstanceOf(SourceUnavailableError);
    expect(String(failure.message)).not.toContain("password");
    expect(String(failure.message)).not.toContain("service-user");
  });

  test("resolves artwork through the same source fallback", async () => {
    const failing = createFakeBackend({
      fetchArtwork: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    const working = createFakeBackend({ fetchArtwork: vi.fn(async () => streamResult("img")) });
    const { library, resolver } = makeSetup(failing, working);

    const id = library.ensureId("album", { connectionId: "conn-1", providerItemId: "art-1" });
    library.addSource(id, { connectionId: 'conn-2', providerItemId: 'art-2' });

    const result = await resolver.fetchArtwork(id);

    expect(result.status).toBe(200);
    expect(working.fetchArtwork).toHaveBeenCalledWith("art-2");
  });

  test("forwards range headers to the selected provider", async () => {
    const backend = createFakeBackend({ fetchStream: vi.fn(async () => streamResult("chunk")) });
    const { library, resolver } = makeSetup(backend);

    const id = library.ensureId("track", { connectionId: "conn-1", providerItemId: "t-1" });
    await resolver.fetchStream(id, "bytes=0-2");

    expect(backend.fetchStream).toHaveBeenCalledWith("t-1", "bytes=0-2");
  });

  test("skips sources whose connection is no longer enabled", async () => {
    const a = createFakeBackend({ fetchStream: vi.fn(async () => streamResult("a")) });
    const { library, resolver } = makeSetup(a);

    const id = library.ensureId("track", { connectionId: "conn-1", providerItemId: "t-1" });
    // Add a mapping to a connection that is not in the registry.
    library.addSource(id, { connectionId: 'conn-gone', providerItemId: 't-x' });

    const result = await resolver.fetchStream(id);

    // conn-1 (registered) is used; conn-gone is ignored.
    expect(result.status).toBe(200);
    expect(a.fetchStream).toHaveBeenCalledWith("t-1", undefined);
  });
});
