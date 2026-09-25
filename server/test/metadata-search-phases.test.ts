import { afterEach, expect, test, vi } from "vitest";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

afterEach(async () => {
  if (current) await closeTestServer(current.app, current.db);
  current = null;
});

test("local search returns without keyless requests; external phase marks library matches", async () => {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input.toString());
    const payload = url.pathname === "/search/track"
      ? { data: [{ id: 8, title: "Track One", artist: { name: "Artist One" }, album: { title: "Album One" } }] }
      : url.pathname === "/search/album"
        ? { data: [{ id: 9, title: "Album One", artist: { name: "Artist One" } }] }
        : url.pathname === "/search/artist"
          ? { data: [] }
          : { results: [] };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  current = await createTestServer(undefined, {}, undefined, fetchImpl);
  const { cookie } = await login(current.app);

  const local = await current.app.inject({
    method: "GET", url: "/api/search?q=Track%20One&phase=local", headers: { cookie },
  });
  expect(local.statusCode).toBe(200);
  expect(local.json().results.track[0].provider).toBe("library");
  expect(fetchImpl).not.toHaveBeenCalled();

  const external = await current.app.inject({
    method: "GET", url: "/api/search?q=Track%20One&phase=external", headers: { cookie },
  });
  expect(external.statusCode).toBe(200);
  const track = external.json().results.track.find((item: { id: string }) => item.id === "external_deezer_track_8");
  const album = external.json().results.album.find((item: { id: string }) => item.id === "external_deezer_album_9");
  expect(track).toMatchObject({ inLibrary: true, localTrackId: local.json().results.track[0].id });
  expect(album).toMatchObject({ inLibrary: true, localAlbumId: expect.any(String) });

  const backgroundMatch = await current.app.inject({
    method: "POST", url: "/api/library/matches", headers: { cookie },
    payload: { items: [{ id: "discography-album", type: "album", title: "Album One", artist: "Artist One" }] },
  });
  expect(backgroundMatch.statusCode).toBe(200);
  expect(backgroundMatch.json().matches[0]).toMatchObject({ inLibrary: true, localAlbumId: album.localAlbumId });
});
