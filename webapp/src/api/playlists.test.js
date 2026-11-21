import {
  addSongToPlaylist,
  removeSongFromPlaylist,
  updatePlaylist,
  startSpotifyPlaylistImport,
  getSpotifyPlaylistImport,
  getPlaylistRecommendations,
} from "./playlists";

import {
  addSongToPlaylist as addSongToPlaylistApi,
  removeSongFromPlaylist as removeSongFromPlaylistApi,
} from "./musicdeck";


jest.mock("./musicdeck", () => ({
  request: jest.requireActual("./musicdeck").request,
  getPlaylists: jest.fn(),
  getPlaylist: jest.fn(),
  createPlaylist: jest.fn(),
  patchPlaylist: jest.fn(),
  addSongToPlaylist: jest.fn(),
  removeSongFromPlaylist: jest.fn(),
  deletePlaylist: jest.fn(),
}));


beforeEach(() => {
  jest.clearAllMocks();
});

test("playlist recommendations request fresh data and allow a valid empty result", async () => {
  const result = { items: [], canModify: true, message: null };
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => result });
  const { signal } = new AbortController();
  await expect(getPlaylistRecommendations("mix/id", "external", signal)).resolves.toEqual(result);
  expect(global.fetch).toHaveBeenCalledWith("/api/v1/playlists/mix%2Fid/recommendations?source=external",
    expect.objectContaining({ cache: "no-store", signal }));
});

test.each([
  [204, async () => undefined, "empty or unreadable"],
  [200, async () => { throw new SyntaxError("Unexpected end of JSON input"); }, "empty or unreadable"],
  [200, async () => ({ tracks: [] }), "older playlist recommendations API"],
])("playlist recommendations report unexpected HTTP %s payloads as errors", async (status, json, message) => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status, json });
  await expect(getPlaylistRecommendations("mix")).rejects.toMatchObject({
    code: "INVALID_PLAYLIST_RECOMMENDATIONS",
    message: expect.stringContaining(message),
  });
});


test("adding a song preserves existing songs and only sends the new song ID", async () => {

  addSongToPlaylistApi.mockResolvedValue({ added: true });

  const result =
    await addSongToPlaylist("playlist-1", "song-3");

  expect(result).toEqual({ added: true });

  expect(addSongToPlaylistApi).toHaveBeenCalledTimes(1);
  expect(addSongToPlaylistApi).toHaveBeenCalledWith(
    "playlist-1",
    "song-3"
  );
});


test("does not re-add a song already in the playlist", async () => {

  addSongToPlaylistApi.mockResolvedValue({ added: false });

  const result =
    await addSongToPlaylist("playlist-1", "song-2");

  expect(result).toEqual({ added: false });
  expect(addSongToPlaylistApi).toHaveBeenCalledWith(
    "playlist-1",
    "song-2"
  );
});


test("treats string and number IDs as the same song", async () => {

  addSongToPlaylistApi.mockResolvedValue({ added: false });

  const result =
    await addSongToPlaylist("playlist-1", "123");

  expect(result).toEqual({ added: false });
  expect(addSongToPlaylistApi).toHaveBeenCalledWith(
    "playlist-1",
    "123"
  );
});


test("adding to an empty playlist adds the song without error", async () => {

  addSongToPlaylistApi.mockResolvedValue({ added: true });

  const result =
    await addSongToPlaylist("playlist-1", "song-1");

  expect(result).toEqual({ added: true });
  expect(addSongToPlaylistApi).toHaveBeenCalledWith(
    "playlist-1",
    "song-1"
  );
});


test("adding to a playlist with no entry field does not error", async () => {

  addSongToPlaylistApi.mockResolvedValue({ added: true });

  const result =
    await addSongToPlaylist("playlist-1", "song-1");

  expect(result).toEqual({ added: true });
});


test("propagates failures from the underlying playlist update", async () => {

  addSongToPlaylistApi.mockRejectedValue(
    new Error("Navidrome API error")
  );

  await expect(
    addSongToPlaylist("playlist-1", "song-1")
  ).rejects.toThrow("Navidrome API error");
});


test("removing a song passes through the intended playlist and index only", async () => {

  removeSongFromPlaylistApi.mockResolvedValue({});

  await removeSongFromPlaylist("playlist-1", 2);

  expect(removeSongFromPlaylistApi).toHaveBeenCalledTimes(1);
  expect(removeSongFromPlaylistApi).toHaveBeenCalledWith(
    "playlist-1",
    2
  );
});

test("updates playlist name and description through the MusicDeck API", async () => {
  const patchPlaylist = jest.requireMock("./musicdeck").patchPlaylist;
  const updated = { id: "playlist-1", name: "New name", description: "New description" };
  patchPlaylist.mockResolvedValue(updated);

  await expect(updatePlaylist("playlist-1", {
    name: "New name",
    description: "New description",
  })).resolves.toEqual(updated);
  expect(patchPlaylist).toHaveBeenCalledWith("playlist-1", {
    name: "New name",
    description: "New description",
  });
});

test("starts and polls a Spotify playlist import with session credentials", async () => {
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ job: { id: "job-1", status: "queued" } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ job: { id: "job-1", status: "completed", playlistId: "mdpl_1" } }) });

  const timeout = { mode: "manual", minutes: 90 };
  await expect(startSpotifyPlaylistImport("https://open.spotify.com/playlist/abc123", timeout)).resolves.toMatchObject({ id: "job-1" });
  expect(global.fetch).toHaveBeenCalledWith("/api/v1/playlists/import-spotify", expect.objectContaining({
    method: "POST", credentials: "include", body: JSON.stringify({ playlistUrl: "https://open.spotify.com/playlist/abc123", timeout }),
  }));
  await expect(getSpotifyPlaylistImport("job-1")).resolves.toMatchObject({ playlistId: "mdpl_1" });
  expect(global.fetch).toHaveBeenCalledWith("/api/v1/playlists/import-spotify/job-1", expect.objectContaining({ credentials: "include" }));
});
