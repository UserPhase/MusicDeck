import {
  addSongToPlaylist,
  removeSongFromPlaylist,
  startSpotifyPlaylistImport,
  getSpotifyPlaylistImport,
} from "./playlists";

import {
  addSongToPlaylist as addSongToPlaylistApi,
  removeSongFromPlaylist as removeSongFromPlaylistApi,
} from "./musicdeck";


jest.mock("./musicdeck", () => ({
  getPlaylists: jest.fn(),
  getPlaylist: jest.fn(),
  createPlaylist: jest.fn(),
  addSongToPlaylist: jest.fn(),
  removeSongFromPlaylist: jest.fn(),
  deletePlaylist: jest.fn(),
}));


beforeEach(() => {
  jest.clearAllMocks();
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

test("starts and polls a Spotify playlist import with session credentials", async () => {
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ job: { id: "job-1", status: "queued" } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ job: { id: "job-1", status: "completed", playlistId: "mdpl_1" } }) });

  await expect(startSpotifyPlaylistImport("https://open.spotify.com/playlist/abc123")).resolves.toMatchObject({ id: "job-1" });
  expect(global.fetch).toHaveBeenCalledWith("/api/v1/playlists/import-spotify", expect.objectContaining({
    method: "POST", credentials: "include", body: JSON.stringify({ playlistUrl: "https://open.spotify.com/playlist/abc123" }),
  }));
  await expect(getSpotifyPlaylistImport("job-1")).resolves.toMatchObject({ playlistId: "mdpl_1" });
  expect(global.fetch).toHaveBeenCalledWith("/api/v1/playlists/import-spotify/job-1", { credentials: "include" });
});

