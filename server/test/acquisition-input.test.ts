import { describe, expect, test, vi } from "vitest";
import { acquisitionRequestSchema } from "../src/domain/acquisition-input.js";
import type { AcquisitionJob } from "../src/domain/acquisition.js";
import { normalizeDeezerChart } from "../src/domain/deezer-discovery.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

function chartDownloadPayload() {
  const song = normalizeDeezerChart({
    artists: { data: [] }, albums: { data: [] },
    tracks: { data: [{
      id: 123, title: "Fixture Song", duration: 180, isrc: "USABC2600123",
      artist: { id: 456, name: "Fixture Artist" },
      album: { id: 789, title: "Fixture Album" },
    }] },
  }).tracks[0]!;
  // Same result envelope sent by track downloads, context menus and preview imports.
  return {
    result: {
      id: song.id, type: song.type, title: song.title, artist: song.artist,
      album: song.album, provider: song.provider, source: song.source, metadata: song.metadata,
    },
    trackId: song.id, sourceProvider: "spotdl",
  };
}

describe("acquisition discovery input contract", () => {
  test("real Deezer chart metadata reaches the authenticated acquisition API", async () => {
    const env = await createTestServer();
    const job: AcquisitionJob = {
      id: "fixture-job", userId: "fixture-user", status: "queued",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const create = vi.spyOn(env.acquisition, "createJob").mockResolvedValue(job);
    try {
      const { cookie } = await login(env.app);
      const response = await env.app.inject({
        method: "POST", url: "/api/acquisitions", headers: { cookie }, payload: chartDownloadPayload(),
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ jobId: job.id, status: "queued" });
      expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        trackId: "external_deezer_track_123", sourceProvider: "spotdl",
        result: expect.objectContaining({
          provider: "external",
          metadata: expect.objectContaining({ isrc: "USABC2600123", durationSeconds: 180 }),
        }),
      }));
    } finally {
      create.mockRestore();
      await closeTestServer(env.app, env.db);
    }
  });

  test.each(["deezer", "itunes", "spotify", "external"])("normalizes known external provenance: %s", (provider) => {
    const payload = chartDownloadPayload();
    const parsed = acquisitionRequestSchema.parse({
      ...payload, result: { ...payload.result, provider, providers: [provider] },
    });
    expect(parsed.result?.provider).toBe("external");
    expect(parsed.result?.providers).toEqual(["external"]);
  });

  test("accepts absent catalog URLs without passing null to the downloader URL policy", () => {
    const payload = chartDownloadPayload();
    const parsed = acquisitionRequestSchema.parse({
      ...payload, result: { ...payload.result, metadata: {
        ...payload.result.metadata, isrc: null, spotifyTrackUrl: null, deezerTrackUrl: null,
      } },
    });
    expect(parsed.result?.metadata?.spotifyTrackUrl).toBeUndefined();
    expect(parsed.result?.metadata?.deezerTrackUrl).toBeUndefined();
    expect(parsed.result?.metadata?.isrc).toBeNull();
  });

  test("continues to reject arbitrary providers, unknown fields and oversized metadata", () => {
    const payload = chartDownloadPayload();
    for (const result of [
      { ...payload.result, provider: "untrusted-provider" },
      { ...payload.result, providers: ["untrusted-provider"] },
      { ...payload.result, metadata: { ...payload.result.metadata, isrc: "x".repeat(33) } },
      { ...payload.result, metadata: { ...payload.result.metadata, isrc: 123 } },
      { ...payload.result, metadata: { ...payload.result.metadata, arbitraryArgument: "--config=/private" } },
    ]) {
      expect(acquisitionRequestSchema.safeParse({ ...payload, result }).success).toBe(false);
    }
  });
});
