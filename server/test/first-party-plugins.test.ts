import { afterEach, describe, expect, test, vi } from "vitest";

import { conservativeSpotifyMatch } from "../src/plugins/in-progress/automation-plugins.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

async function setup(pluginFetchImpl?: typeof fetch) {
  current = await createTestServer(undefined, {}, undefined, undefined, pluginFetchImpl);
  return current;
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

async function enable(app: Awaited<ReturnType<typeof createTestServer>>["app"], pluginId: string, config: Record<string, unknown>, permissions: string[]) {
  const { cookie } = await login(app);
  return app.inject({
    method: "PATCH",
    url: `/api/admin/plugins/${pluginId}`,
    headers: { cookie },
    payload: { enabled: true, config, permissions },
  });
}

describe("first-party plugin suite", () => {
  test("registers all first-party plugins with safe metadata", async () => {
    const { plugins } = await setup();
    const list = plugins.list(false);

    expect(list.map((plugin) => plugin.id)).toEqual(expect.arrayContaining([
      "listenbrainz",
      "lastfm",
      "musicbrainz",
      "external-artwork",
      "spotify-importer",
      "discord-presence",
      "home-assistant",
      "authorized-external-source",
      "debrid-cloud-source",
      "site-sources",
      "archive-org-source",
    ]));
    expect(list.every((plugin) => plugin.origin === "first-party")).toBe(true);
    expect(JSON.stringify(list)).not.toContain("lb-token");
  });

  test("ListenBrainz scrobbles completed tracks only after explicit enablement", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const { app, plugins } = await setup(fetchMock as typeof fetch);

    plugins.emit("track.completed", { title: "Song", artist: "Artist", album: "Album" });
    expect(fetchMock).not.toHaveBeenCalled();

    const enabled = await enable(app, "listenbrainz", { token: "lb-token", username: "listener" }, ["history.read", "network.request"]);
    expect(enabled.statusCode).toBe(200);

    plugins.emit("track.completed", { title: "Song", artist: "Artist", album: "Album" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.listenbrainz.org/1/submit-listens",
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.stringify(plugins.get("listenbrainz", true))).not.toContain("lb-token");
  });

  test("Last.fm test connection uses configured credentials without exposing them", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const { app, plugins } = await setup(fetchMock as typeof fetch);

    await enable(app, "lastfm", { apiKey: "api-key", sessionKey: "session-key" }, ["history.read", "network.request"]);
    const { cookie } = await login(app);
    const tested = await app.inject({ method: "POST", url: "/api/admin/plugins/lastfm/test", headers: { cookie } });

    expect(tested.statusCode).toBe(200);
    expect(tested.json().test.ok).toBe(true);
    expect(JSON.stringify(plugins.get("lastfm", true))).not.toContain("session-key");
  });

  test("MusicBrainz and external artwork plugins expose testable metadata/artwork capabilities", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const { app } = await setup(fetchMock as typeof fetch);
    await enable(app, "musicbrainz", {}, ["network.request"]);
    await enable(app, "external-artwork", {}, ["network.request"]);
    const { cookie } = await login(app);

    const musicbrainz = await app.inject({ method: "POST", url: "/api/admin/plugins/musicbrainz/test", headers: { cookie } });
    const artwork = await app.inject({ method: "POST", url: "/api/admin/plugins/external-artwork/test", headers: { cookie } });

    expect(musicbrainz.statusCode).toBe(200);
    expect(artwork.statusCode).toBe(200);
  });

  test("Spotify matching is conservative and does not substitute wrong versions", () => {
    const local = [{
      title: "Digital Love",
      artistName: "Daft Punk",
      albumName: "Discovery",
    }];

    expect(conservativeSpotifyMatch(local, {
      name: "Digital Love",
      artists: [{ name: "Daft Punk" }],
      album: { name: "Discovery" },
    })).toMatchObject({ title: "Digital Love" });
    expect(conservativeSpotifyMatch(local, {
      name: "Digital Love (Live)",
      artists: [{ name: "Daft Punk" }],
      album: { name: "Discovery" },
    })).toBeNull();
  });

  test("Discord and Home Assistant subscribe to playback events without core player coupling", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const { app, plugins } = await setup(fetchMock as typeof fetch);

    await enable(app, "home-assistant", { url: "https://ha.example", token: "ha-token" }, ["history.read", "network.request"]);
    plugins.emit("track.started", { title: "Song", artist: "Artist" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ha.example/api/events/musicdeck_track_started",
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.stringify(plugins.get("home-assistant", true))).not.toContain("ha-token");
  });

  test("admin-disabled plugin cannot be enabled by a user", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/plugins/listenbrainz",
      headers: { cookie },
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(404);
  });
});
