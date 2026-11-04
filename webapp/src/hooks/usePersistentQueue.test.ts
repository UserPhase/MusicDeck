import { act, renderHook, waitFor } from "@testing-library/react";
import { usePersistentQueue, useQueueStore, queueInvariantViolations } from "./useQueueStore";
import { readLocalQueue, writeLocalQueue, writeQueueCheckpoint, type LocalQueue, type QueueCheckpoint } from "../services/storage/QueueDatabase";
jest.mock("../services/storage/QueueDatabase", () => ({ readLocalQueue: jest.fn(), writeLocalQueue: jest.fn(), writeQueueCheckpoint: jest.fn(),
  queueStorageError: (error: Error) => error.message, sanitizeQueueTrack: (track: unknown) => track }));
const checkpoint = (index: number): QueueCheckpoint => ({ index, position: 42.875, repeatOne: false, shuffle: false, shuffleSeed: null, shuffleMode: "standard", albumAware: false, volume: 1, wasPlaying: false, context: null, capturedAt: Date.now() });
function saved(owner: string, count = 10_000): LocalQueue {
  return { content: { version: 2, entries: Array.from({ length: count }, (_, i) => ({ entryId: `q${100_000 + i}`, track: { id: `track-${i % 3}` } })) },
    head: { owner, contentKey: owner, checkpoint: checkpoint(count - 1), sequence: 1, updatedAt: Date.now() }, serialized: "", timing: { ioMs: 0, decodeMs: 0 } };
}
const restored = jest.fn(() => ({ deferLoad: true })), ready = jest.fn(), error = jest.fn();
function useTest(owner: string | null) {
  const queue = useQueueStore(null, { toPlayable: entry => ({ key: entry.entryId, src: "/stream/test" }) });
  const persistence = usePersistentQueue(queue, { ownerId: owner, getCheckpoint: () => checkpoint(queue.state.currentIndex), onRestore: restored, onReady: ready, onError: error });
  return { queue, persistence };
}
beforeEach(() => { jest.clearAllMocks(); restored.mockReturnValue({ deferLoad: true }); (readLocalQueue as jest.Mock).mockResolvedValue(null); (writeLocalQueue as jest.Mock).mockImplementation(async (owner, _content, cp) => ({ owner, contentKey: "new", checkpoint: cp, sequence: 1 })); (writeQueueCheckpoint as jest.Mock).mockResolvedValue(null); });
test("hydration adopts all 10,000 occurrences without cloning and append never reuses saved IDs", async () => {
  const original = saved("alice"); (readLocalQueue as jest.Mock).mockResolvedValue(original);
  const { result } = renderHook(() => useTest("alice"));
  await waitFor(() => expect(result.current.persistence.ready).toBe(true));
  expect(result.current.queue.state.entries).toBe(original.content.entries); expect(result.current.queue.state.currentIndex).toBe(9999);
  act(() => result.current.queue.append([{ id: "new" }]));
  expect(queueInvariantViolations(result.current.queue.state)).toEqual([]); expect(result.current.queue.state.entries[10_000].entryId).toBe("q110000");
});
test("a delayed local read cannot overwrite the queue selected during startup", async () => {
  let finish!: (value: LocalQueue) => void; (readLocalQueue as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useTest("alice"));
  act(() => result.current.queue.setQueue([{ id: "user-selected" }], 0, { deferLoad: true }));
  await act(async () => { finish(saved("alice")); });
  expect(result.current.queue.state.entries.map(entry => entry.track.id)).toEqual(["user-selected"]); expect(restored).not.toHaveBeenCalled();
});
test("account switching clears the old queue and ignores its pending hydration response", async () => {
  let finish!: (value: LocalQueue) => void; (readLocalQueue as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(saved("bob", 2));
  const { result, rerender } = renderHook(({ owner }) => useTest(owner), { initialProps: { owner: "alice" } });
  rerender({ owner: "bob" }); await waitFor(() => expect(result.current.persistence.ready).toBe(true));
  await act(async () => { finish(saved("alice")); });
  expect(result.current.queue.state.entries).toHaveLength(2); expect(ready).toHaveBeenCalledWith("bob"); expect(ready).not.toHaveBeenCalledWith("alice");
});
test("a queue edit invalidates the exit checkpoint until the new contents commit", async () => {
  (readLocalQueue as jest.Mock).mockResolvedValue(saved("alice", 2));
  const { result } = renderHook(() => useTest("alice")); await waitFor(() => expect(result.current.persistence.ready).toBe(true));
  expect(result.current.persistence.getHead()?.contentKey).toBe("alice");
  act(() => result.current.queue.append([{ id: "new" }])); expect(result.current.persistence.getHead()).toBeNull();
  await act(async () => { await result.current.persistence.flush(); });
  expect(result.current.persistence.getHead()?.contentKey).toBe("new"); expect(writeLocalQueue).toHaveBeenCalledWith("alice", expect.objectContaining({ entries: expect.any(Array) }), expect.any(Object));
});
