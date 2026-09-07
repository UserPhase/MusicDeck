import { afterEach, describe, expect, test, vi } from "vitest";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";
import { createId } from "../src/utils/ids.js";
import type { Track } from "../src/types.js";

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
