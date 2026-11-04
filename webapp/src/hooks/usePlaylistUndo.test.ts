import { act, renderHook } from "@testing-library/react";
import { playlistCommands, setPlaylistCommandNotifier } from "../services/playlists/PlaylistCommandStore";
import { usePlaylistUndo } from "./usePlaylistUndo";

const reply = (data: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => data } as Response);
const response = (id: string, revision: number) => ({ revision, deletedAt: null, command: { id, playlistId: "one", label: "Tracks removed" }, playlist: { id: "one", tracks: [] } });
beforeEach(() => { playlistCommands.activate(null); playlistCommands.activate("alice"); global.fetch = jest.fn(); setPlaylistCommandNotifier(jest.fn()); });
afterEach(() => { playlistCommands.activate(null); jest.restoreAllMocks(); });

test("two commands support consecutive undo and redo with current server revisions", async () => {
  const { result } = renderHook(() => usePlaylistUndo());
  (fetch as jest.Mock).mockImplementationOnce(() => reply({ revision: 0 })).mockImplementationOnce(() => reply(response("a", 1)))
    .mockImplementationOnce(() => reply({ revision: 1 })).mockImplementationOnce(() => reply(response("b", 2)))
    .mockImplementationOnce(() => reply(response("b", 3))).mockImplementationOnce(() => reply(response("a", 4)))
    .mockImplementationOnce(() => reply(response("a", 5))).mockImplementationOnce(() => reply(response("b", 6)));
  await act(async () => { await result.current.execute("one", { kind: "remove", itemIds: ["entry-a"] }); await result.current.execute("one", { kind: "remove", itemIds: ["entry-b"] }); });
  expect(result.current.undoHistory.map(item => item.id)).toEqual(["a", "b"]);
  await act(async () => { await result.current.undo(); await result.current.undo(); });
  expect(result.current.canUndo).toBe(false); expect(result.current.redoHistory.map(item => item.id)).toEqual(["b", "a"]);
  await act(async () => { await result.current.redo(); await result.current.redo(); });
  expect(result.current.undoHistory.map(item => item.id)).toEqual(["a", "b"]);
  const calls = (fetch as jest.Mock).mock.calls;
  expect(calls.slice(4).map(call => [call[0], JSON.parse(call[1].body).revision])).toEqual([
    ["/api/v1/playlist-commands/b/undo", 2], ["/api/v1/playlist-commands/a/undo", 3],
    ["/api/v1/playlist-commands/a/redo", 4], ["/api/v1/playlist-commands/b/redo", 5],
  ]);
});

test("validation failures preserve known history; conflicts invalidate it without retrying the write", async () => {
  (fetch as jest.Mock).mockImplementationOnce(() => reply({ revision: 0 })).mockImplementationOnce(() => reply(response("a", 1)));
  await playlistCommands.execute("one", { kind: "trash" });
  (fetch as jest.Mock).mockImplementationOnce(() => reply({ revision: 1 })).mockImplementationOnce(() => reply({ error: { message: "Invalid tracks" } }, 400));
  await expect(playlistCommands.execute("one", { kind: "add", trackIds: ["bad"] })).rejects.toThrow("Invalid tracks");
  expect(playlistCommands.getSnapshot().undo).toHaveLength(1);
  (fetch as jest.Mock).mockImplementationOnce(() => reply({ error: { message: "Changed elsewhere" } }, 409));
  await expect(playlistCommands.undo()).rejects.toThrow("Changed elsewhere");
  expect(playlistCommands.getSnapshot().undo).toEqual([]);
});

test("changing accounts during preflight aborts the action before POST and clears private history", async () => {
  let finish!: (value: Response) => void;
  (fetch as jest.Mock).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = playlistCommands.execute("one", { kind: "trash" });
  const observed = pending.catch(error => error);
  await Promise.resolve();
  playlistCommands.activate("bob");
  finish(await reply({ revision: 0 }));
  expect(await observed).toBeInstanceOf(Error);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(playlistCommands.getSnapshot()).toMatchObject({ owner: "bob", undo: [], redo: [], error: null, busy: false });
});
