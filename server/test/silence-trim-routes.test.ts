import { afterEach, describe, expect, test } from "vitest";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

async function setup() {
  current = await createTestServer();
  return current;
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("silence-trim API", () => {
  test("returns null analysis for a track that has never been analyzed", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const tracks = await app.inject({ method: "GET", url: "/api/tracks", headers: { cookie } });
    const trackId = tracks.json().tracks[0].id;

    const response = await app.inject({
      method: "GET",
      url: `/api/tracks/${trackId}/silence-analysis`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ analysis: null });
  });

  test("manual re-analysis persists a result retrievable through the GET endpoint", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const tracks = await app.inject({ method: "GET", url: "/api/tracks", headers: { cookie } });
    const trackId = tracks.json().tracks[0].id;

    const analyze = await app.inject({
      method: "POST",
      url: `/api/tracks/${trackId}/silence-analysis`,
      headers: { cookie },
      payload: {},
    });

    expect(analyze.statusCode).toBe(200);
    const analysis = analyze.json().analysis;
    expect(analysis.status).toBeDefined();

    const fetched = await app.inject({
      method: "GET",
      url: `/api/tracks/${trackId}/silence-analysis`,
      headers: { cookie },
    });
    expect(fetched.json().analysis.status).toBe(analysis.status);
  });

  test("manual re-analysis rejects an unknown track", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/tracks/does-not-exist/silence-analysis",
      headers: { cookie },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
  });

  test("silence-trim settings are persisted through the existing user settings API", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/settings/user",
      headers: { cookie },
      payload: {
        settings: {
          "playback.silenceTrim.enabled": true,
          "playback.silenceTrim.thresholdDb": -30,
          "playback.silenceTrim.minSilenceSeconds": 0.75,
        },
      },
    });

    expect(patch.statusCode).toBe(200);
    const keys = patch.json().settings.map((setting: { key: string }) => setting.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "playback.silenceTrim.enabled",
        "playback.silenceTrim.thresholdDb",
        "playback.silenceTrim.minSilenceSeconds",
      ])
    );
  });

  test("requires authentication", async () => {
    const { app } = await setup();

    const getResponse = await app.inject({ method: "GET", url: "/api/tracks/foo/silence-analysis" });
    expect(getResponse.statusCode).toBe(401);

    const postResponse = await app.inject({ method: "POST", url: "/api/tracks/foo/silence-analysis" });
    expect(postResponse.statusCode).toBe(401);
  });
});
