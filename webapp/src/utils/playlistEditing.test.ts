import { reorderPlaylistEntries } from "./playlistEditing";

test("group moves preserve occurrence order, duplicates and original-boundary coordinates", () => {
  const ids = ["song-first", "b", "song-second", "d", "e"];
  expect(reorderPlaylistEntries(ids, new Set(["song-first", "song-second"]), 5)).toEqual(["b", "d", "e", "song-first", "song-second"]);
  expect(reorderPlaylistEntries(ids, new Set(["d", "e"]), 0)).toEqual(["d", "e", "song-first", "b", "song-second"]);
  expect(reorderPlaylistEntries(ids, new Set(["b", "song-second"]), 2)).toEqual(ids);
  expect(ids).toEqual(["song-first", "b", "song-second", "d", "e"]);
  expect(() => reorderPlaylistEntries(ids, new Set(), -1)).toThrow(RangeError);
});
