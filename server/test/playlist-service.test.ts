import { afterEach, describe, expect, test, vi } from "vitest";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";
import { createId } from "../src/utils/ids.js";
import type { Track } from "../src/types.js";
import { getUserById } from "../src/users/users.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

function track(id: string, title = `Track ${id}`): Track {
  return {
    id, providerId: id, title, artistId: null, artistName: "A",
    albumId: null, albumName: "AL", durationSeconds: null, trackNumber: null,
    artworkId: null, artworkUrl: null, streamUrl: `/api/tracks/${id}/stream`,
  };
}

async function setup(backend = createFakeBackend()) {
  current = await createTestServer(backend);
  return current;
}

async function createPlaylistViaApi(name = "My Playlist") {
  const { cookie } = await login(current!.app);
  const response = await current!.app.inject({
    method: "POST",
    url: "/api/playlists",
    headers: { cookie },
    payload: { name },
  });

  return { cookie, playlistId: response.json().playlist.id as string, response };
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("MusicDeck-owned playlists", () => {
  test("owner-private lists, detail, search, and artwork preserve admin and legacy access", async () => {
    const { app, db, playlists, backend } = await setup();
    const alice = (await createUser(db, { username: "alice", password: "alice-password" }))!;
    const bob = (await createUser(db, { username: "bob", password: "bob-password" }))!;
    const aliceCookie = (await login(app, "alice", "alice-password")).cookie;
    const bobCookie = (await login(app, "bob", "bob-password")).cookie;
    const adminCookie = (await login(app)).cookie;
    const create = async (cookie: string | undefined, name: string) => {
      const response = await app.inject({
        method: "POST", url: "/api/playlists", headers: { cookie }, payload: { name },
      });
      expect(response.statusCode).toBe(201);
      return response.json().playlist as { id: string; ownerUserId: string };
    };
    const alicePlaylist = await create(aliceCookie, "Private Alice Mix");
    const bobPlaylist = await create(bobCookie, "Private Bob Mix");
    expect(alicePlaylist.ownerUserId).toBe(alice.id);
    expect(bobPlaylist.ownerUserId).toBe(bob.id);
    vi.mocked(backend.listPlaylists).mockResolvedValue([{
      id: "legacy-shared", providerId: "legacy-shared", name: "Shared Mix",
      description: null, artworkId: null, artworkUrl: null, songCount: 0, tracks: [],
    }]);
    const legacy = await playlists.list(alice);
    const shared = legacy.find((playlist) => playlist.ownerUserId === null)!;
    expect(shared).toBeDefined();
    const image = Buffer.from("custom-private-artwork");
    playlists.setCustomArtwork(alicePlaylist.id, image, "image/png");
    await playlists.addTrack(alicePlaylist.id, "track-1");
    const artworkUrl = (await playlists.get(alicePlaylist.id, alice))!.artworkUrl!;
    const privateResponse = await app.inject({
      url: `/api/playlists/${alicePlaylist.id}`, headers: { cookie: bobCookie },
    });
    const missingResponse = await app.inject({
      url: "/api/playlists/does-not-exist", headers: { cookie: bobCookie },
    });
    expect(privateResponse.statusCode).toBe(404);
    expect(privateResponse.json()).toEqual(missingResponse.json());
    expect(privateResponse.body).not.toContain("Private Alice");

    for (const [cookie, own, other] of [
      [aliceCookie, alicePlaylist.id, bobPlaylist.id],
      [bobCookie, bobPlaylist.id, alicePlaylist.id],
    ]) {
      const list = await app.inject({ url: "/api/playlists", headers: { cookie } });
      const ids = list.json().playlists.map((playlist: { id: string }) => playlist.id);
      expect(ids).toContain(own);
      expect(ids).toContain(shared.id);
      expect(ids).not.toContain(other);
      expect((await app.inject({ url: `/api/playlists/${own}`, headers: { cookie } })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/playlists/${shared.id}`, headers: { cookie } })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/playlists/${other}`, headers: { cookie } })).statusCode).toBe(404);
    }
    for (const phase of ["", "&phase=local"]) {
      const search = await app.inject({
        url: `/api/search?q=Private&types=playlists&mode=library${phase}`, headers: { cookie: bobCookie },
      });
      expect(search.statusCode).toBe(200);
      expect(search.body).toContain("Private Bob Mix");
      expect(search.body).not.toContain("Private Alice Mix");
    }
    expect(await playlists.search("Private")).toEqual([]);
    expect((await app.inject({ url: artworkUrl, headers: { cookie: bobCookie } })).statusCode).toBe(404);
    for (const cookie of [aliceCookie, adminCookie]) {
      const art = await app.inject({ url: artworkUrl, headers: { cookie } });
      expect(art.statusCode).toBe(200);
      expect(art.rawPayload).toEqual(image);
    }
    vi.mocked(backend.getTrack).mockClear();
    expect(await playlists.get(alicePlaylist.id, bob)).toBeNull();
    expect(backend.getTrack).not.toHaveBeenCalled();
    const adminList = await app.inject({ url: "/api/playlists", headers: { cookie: adminCookie } });
    expect(adminList.json().playlists.map((playlist: { id: string }) => playlist.id))
      .toEqual(expect.arrayContaining([alicePlaylist.id, bobPlaylist.id, shared.id]));
    expect((await app.inject({ url: `/api/playlists/${alicePlaylist.id}`, headers: { cookie: adminCookie } })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PATCH", url: `/api/playlists/${shared.id}`, headers: { cookie: bobCookie },
      payload: { name: "Shared Legacy Mix" },
    })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/api/playlists/${shared.id}`, headers: { cookie: adminCookie },
      payload: { name: "Shared Legacy Mix" } })).statusCode).toBe(200);
  });

  test("regular owner can edit, add, reorder, and delete without weakening mutation authorization", async () => {
    const { app, db } = await setup(createFakeBackend({ getTrack: vi.fn(async (id: string) => track(id)) }));
    await createUser(db, { username: "owner", password: "owner-password" });
    await createUser(db, { username: "other", password: "other-password" });
    const { cookie } = await login(app, "owner", "owner-password");
    const outsider = (await login(app, "other", "other-password")).cookie;
    const created = await app.inject({ method: "POST", url: "/api/playlists", headers: { cookie }, payload: { name: "Mix" } });
    const url = `/api/playlists/${created.json().playlist.id}`;
    expect((await app.inject({ method: "PATCH", url, headers: { cookie }, payload: { name: "Edited" } })).statusCode).toBe(200);
    for (const trackId of ["t-1", "t-2"]) {
      expect((await app.inject({ method: "POST", url: `${url}/tracks`, headers: { cookie }, payload: { trackId } })).statusCode).toBe(200);
    }
    const reordered = await app.inject({
      method: "PUT", url: `${url}/tracks/reorder`, headers: { cookie }, payload: { trackIds: ["t-2", "t-1"] },
    });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().playlist.tracks.map((item: Track) => item.id)).toEqual(["t-2", "t-1"]);
    for (const method of ["PATCH", "DELETE", "PUT"] as const) {
      const denied = await app.inject({
        method, url: method === "PUT" ? `${url}/tracks/reorder` : url,
        headers: { cookie: outsider },
        ...(method === "PATCH" ? { payload: { name: "Stolen" } } : method === "PUT" ? { payload: { trackIds: [] } } : {}),
      });
      expect(denied.statusCode).toBe(403);
    }
    expect((await app.inject({ method: "DELETE", url, headers: { cookie } })).statusCode).toBe(204);
    expect((await app.inject({ url, headers: { cookie } })).statusCode).toBe(404);
  });
  test("reuses a durable import identity and cannot duplicate or change its ownership", async () => {
    const backend = createFakeBackend({ createPlaylist: vi.fn() }); const context = await setup(backend);
    const { response } = await login(context.app);
    const owner = getUserById(context.db, response.json().user.id)!;
    const first = await context.playlists.create("Imported", owner, "Spotify description", "mdpl_spimp_restart");
    const second = await context.playlists.create("Retry", owner, "Changed", "mdpl_spimp_restart");
    expect(second.id).toBe(first.id); expect(second.name).toBe("Imported"); expect(second.description).toBe("Spotify description");
    expect(context.db.prepare("SELECT COUNT(*) AS count FROM playlists WHERE id = ?").get(first.id)).toEqual({ count: 1 });
    expect(backend.createPlaylist).not.toHaveBeenCalled();
    await expect(context.playlists.create("Wrong owner", { ...owner, id: "other" }, undefined, first.id)).rejects.toThrow("another user");
  });
  test("creates, reads, and owns a MusicDeck playlist", async () => {
    await setup();
    const { playlistId, response } = await createPlaylistViaApi("Focus Mix");

    expect(response.statusCode).toBe(201);
    expect(playlistId).toMatch(/^mdpl_/);

    const row = current!.db.prepare(
      "SELECT owner_user_id, name FROM playlists WHERE id = ?"
    ).get(playlistId) as any;
    expect(row.name).toBe("Focus Mix");
    expect(row.owner_user_id).toBeTruthy();

    const { cookie } = await login(current!.app);
    const detail = await current!.app.inject({
      method: "GET",
      url: `/api/playlists/${playlistId}`,
      headers: { cookie },
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().playlist).toMatchObject({ id: playlistId, name: "Focus Mix", songCount: 0 });
    expect(detail.json().playlist.ownerUserId).toBeTruthy();
  });

  test("stores the optional description of a blank playlist", async () => {
    await setup();
    const { cookie } = await login(current!.app);
    const response = await current!.app.inject({
      method: "POST", url: "/api/playlists", headers: { cookie },
      payload: { name: "Quiet Hours", description: "After midnight" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().playlist.description).toBe("After midnight");
  });

  test("adopts a scanned provider playlist without creating a duplicate", async () => {
    const backend = createFakeBackend({
      getPlaylist: vi.fn(async (id: string) => ({
        id, providerId: id, name: "Spotify import", description: null,
        artworkId: null, artworkUrl: null, songCount: 1,
        tracks: [track("new-track")],
      })),
    });
    await setup(backend);
    const { cookie } = await login(current!.app);
    const user = current!.db.prepare("SELECT * FROM users WHERE username = ?").get("admin") as any;
    const playlist = await current!.playlists.adoptProviderPlaylist("nav-import-1", user, "Road Trip");

    expect(playlist.name).toBe("Road Trip");
    expect(playlist.songCount).toBe(1);
    expect(backend.createPlaylist).not.toHaveBeenCalled();
    const response = await current!.app.inject({
      method: "GET", url: `/api/playlists/${playlist.id}`, headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().playlist).toMatchObject({ name: "Road Trip", songCount: 1 });
  });

  test("updates name and description", async () => {
    await setup();
    const { cookie, playlistId } = await createPlaylistViaApi();

    const update = await current!.app.inject({
      method: "PATCH",
      url: `/api/playlists/${playlistId}`,
      headers: { cookie },
      payload: { name: "Renamed", description: "New description" },
    });

    expect(update.statusCode).toBe(200);
    expect(update.json().playlist).toMatchObject({ name: "Renamed", description: "New description" });
  });

  test("rejects empty playlist updates and overlong details", async () => {
    await setup();
    const { cookie, playlistId } = await createPlaylistViaApi();
    const requestUpdate = (payload: Record<string, unknown>) => current!.app.inject({
      method: "PATCH",
      url: `/api/playlists/${playlistId}`,
      headers: { cookie },
      payload,
    });

    expect((await requestUpdate({})).statusCode).toBe(400);
    expect((await requestUpdate({ name: "x".repeat(201) })).statusCode).toBe(400);
    expect((await requestUpdate({ description: "x".repeat(1001) })).statusCode).toBe(400);
  });

  test("deletes a playlist and returns 404 afterward", async () => {
    await setup();
    const { cookie, playlistId } = await createPlaylistViaApi();

    const deleted = await current!.app.inject({
      method: "DELETE",
      url: `/api/playlists/${playlistId}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(204);

    const detail = await current!.app.inject({
      method: "GET",
      url: `/api/playlists/${playlistId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(404);
  });

  test("adds a provider-scoped track and preserves order on reorder", async () => {
    await setup(createFakeBackend({
      getTrack: vi.fn(async (id: string) => track(id)),
    }));
    const { cookie, playlistId } = await createPlaylistViaApi();

    for (const trackId of ["t-1", "t-2", "t-3"]) {
      await current!.app.inject({
        method: "POST",
        url: `/api/playlists/${playlistId}/tracks`,
        headers: { cookie },
        payload: { trackId },
      });
    }

    let detail = await current!.app.inject({
      method: "GET",
      url: `/api/playlists/${playlistId}`,
      headers: { cookie },
    });
    expect(detail.json().playlist.tracks.map((t: any) => t.id)).toEqual(["t-1", "t-2", "t-3"]);

    const reorder = await current!.app.inject({
      method: "PUT",
      url: `/api/playlists/${playlistId}/tracks/reorder`,
      headers: { cookie },
      payload: { trackIds: ["t-3", "t-1", "t-2"] },
    });
    expect(reorder.statusCode).toBe(200);

    detail = await current!.app.inject({
      method: "GET",
      url: `/api/playlists/${playlistId}`,
      headers: { cookie },
    });
    expect(detail.json().playlist.tracks.map((t: any) => t.id)).toEqual(["t-3", "t-1", "t-2"]);
  });

  test("prevents duplicate adds of the same provider-scoped track", async () => {
    await setup();
    const { cookie, playlistId } = await createPlaylistViaApi();

    await current!.app.inject({
      method: "POST",
      url: `/api/playlists/${playlistId}/tracks`,
      headers: { cookie },
      payload: { trackId: "track-1" },
    });
    const duplicate = await current!.app.inject({
      method: "POST",
      url: `/api/playlists/${playlistId}/tracks`,
      headers: { cookie },
      payload: { trackId: "track-1" },
    });

    expect(duplicate.json()).toEqual({ added: false });
  });

  test("links an imported provider track to SQLite once with a stable library ID", async () => {
    await setup(createFakeBackend({ getTrack: vi.fn(async (id: string) => track(id)) }));
    const { playlistId } = await createPlaylistViaApi("Imported songs");

    expect(current!.playlists.hasProviderTrack(playlistId, "nav-track-1")).toBe(false);
    expect(await current!.playlists.addProviderTrack(playlistId, "nav-track-1")).toEqual({ added: true });
    expect(current!.playlists.hasProviderTrack(playlistId, "nav-track-1")).toBe(true);
    expect(await current!.playlists.addProviderTrack(playlistId, "nav-track-1")).toEqual({ added: false });
    const rows = current!.db.prepare(
      "SELECT provider_track_id, library_track_id FROM playlist_items WHERE playlist_id = ?"
    ).all(playlistId) as Array<{ provider_track_id: string; library_track_id: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].provider_track_id).toBe("nav-track-1");
    expect(rows[0].library_track_id).toMatch(/^md_/);
  });

  test("supports tracks from multiple provider connections in one playlist", async () => {
    await setup();
    const { db } = current!;
    const { cookie, playlistId } = await createPlaylistViaApi();

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO backend_connections (id, type, name, config_json, enabled, created_at, updated_at) VALUES ('conn-b', 'navidrome', 'Second', '{}', 1, ?, ?)"
    ).run(now, now);

    const insertItem = db.prepare(`
      INSERT INTO playlist_items (id, playlist_id, position, connection_id, provider_track_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertItem.run(createId("mdpli"), playlistId, 0, "conn-b", "track-b1", now);
    insertItem.run(createId("mdpli"), playlistId, 1, "conn-a", "track-a1", now);

    const items = db.prepare(
      "SELECT connection_id, provider_track_id FROM playlist_items WHERE playlist_id = ? ORDER BY position"
    ).all(playlistId) as Array<{ connection_id: string; provider_track_id: string }>;

    expect(items).toEqual([
      { connection_id: "conn-b", provider_track_id: "track-b1" },
      { connection_id: "conn-a", provider_track_id: "track-a1" },
    ]);

    const detail = await current!.app.inject({
      method: "GET",
      url: `/api/playlists/${playlistId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
  });

  test("owner and admin can modify; other users cannot", async () => {
    await setup();
    const { db } = current!;
    const owner = await createUser(db, { username: "owner", password: "owner-pass", role: "user" });
    const outsider = await createUser(db, { username: "outsider", password: "out-pass", role: "user" });

    const now = new Date().toISOString();
    const playlistId = createId("mdpl");
    db.prepare(`
      INSERT INTO playlists (id, owner_user_id, name, description, source_connection_id, source_playlist_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(playlistId, owner!.id, "Owned", now, now);

    const ownerLogin = await login(current!.app, "owner", "owner-pass");
    const outsiderLogin = await login(current!.app, "outsider", "out-pass");
    const adminLogin = await login(current!.app);

    const outsiderAdd = await current!.app.inject({
      method: "POST",
      url: `/api/playlists/${playlistId}/tracks`,
      headers: { cookie: outsiderLogin.cookie },
      payload: { trackId: "track-1" },
    });
    expect(outsiderAdd.statusCode).toBe(403);

    const ownerAdd = await current!.app.inject({
      method: "POST",
      url: `/api/playlists/${playlistId}/tracks`,
      headers: { cookie: ownerLogin.cookie },
      payload: { trackId: "track-1" },
    });
    expect(ownerAdd.statusCode).toBe(200);

    const adminDelete = await current!.app.inject({
      method: "DELETE",
      url: `/api/playlists/${playlistId}`,
      headers: { cookie: adminLogin.cookie },
    });
    expect(adminDelete.statusCode).toBe(204);

    expect(outsider).toBeTruthy();
  });

  test("imports a legacy provider playlist once and preserves order", async () => {
    const legacyTracks = [track("lt-1"), track("lt-2"), track("lt-3")];
    const backend = createFakeBackend({
      listPlaylists: vi.fn(async () => [{
        id: "nav-pl-1",
        providerId: "nav-pl-1",
        name: "Legacy Navidrome Mix",
        description: "imported",
        artworkId: null,
        artworkUrl: null,
        songCount: 3,
        tracks: legacyTracks,
      }]),
      getTrack: vi.fn(async (id: string) => track(id)),
    });
    await setup(backend);
    const { cookie } = await login(current!.app);

    const firstList = await current!.app.inject({
      method: "GET",
      url: "/api/playlists",
      headers: { cookie },
    });
    const imported = firstList.json().playlists.find((p: any) => p.name === "Legacy Navidrome Mix");
    expect(imported).toBeTruthy();

    // Re-listing must not duplicate the import.
    const secondList = await current!.app.inject({
      method: "GET",
      url: "/api/playlists",
      headers: { cookie },
    });
    const matches = secondList.json().playlists.filter((p: any) => p.name === "Legacy Navidrome Mix");
    expect(matches).toHaveLength(1);

    const detail = await current!.app.inject({
      method: "GET",
      url: `/api/playlists/${imported.id}`,
      headers: { cookie },
    });
    const ids = detail.json().playlist.tracks.map((t: any) => t.id);
    // Imported items are hydrated to stable MusicDeck IDs, order preserved.
    expect(ids).toHaveLength(3);
    expect(ids.every((id: string) => id.startsWith("md_"))).toBe(true);
    expect(detail.json().playlist.tracks.map((t: any) => t.title)).toEqual([
      "Track lt-1", "Track lt-2", "Track lt-3",
    ]);
  });

  test("a provider sync failure does not corrupt the local playlist", async () => {
    const backend = createFakeBackend({
      createPlaylist: vi.fn(async () => {
        throw new Error("Navidrome down");
      }),
    });
    await setup(backend);
    const { cookie, playlistId, response } = await createPlaylistViaApi("Offline Mix");

    // Local playlist is created and readable despite the provider failure.
    expect(response.statusCode).toBe(201);

    const detail = await current!.app.inject({
      method: "GET",
      url: `/api/playlists/${playlistId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().playlist.name).toBe("Offline Mix");
  });
});
