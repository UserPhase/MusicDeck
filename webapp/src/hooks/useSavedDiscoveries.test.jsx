import { act, renderHook, waitFor } from "@testing-library/react";
import { createSavedDiscoveryStore, discoveryInput, savedDiscoveryItem, useSavedDiscoveries } from "./useSavedDiscoveries";
import { useAuth } from "../context/AuthContext";
import { getSavedDiscoveries } from "../api/musicdeck";

jest.mock("../context/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("../api/musicdeck", () => ({
  getSavedDiscoveries: jest.fn(), saveDiscovery: jest.fn(), removeSavedDiscovery: jest.fn(),
}));
const input = { provider: "deezer", external_id: "7", type: "album", title: "Night Drive", artist: "Neon", cover_url: null, metadata: {} };
const item = { ...input, id: "saved-7", created_at: "2026-10-17T12:00:00Z" };

test("normalizes provider identities and retains preview metadata without turning a bookmark into an import", () => {
  const payload = discoveryInput("track", {
    id: "external_itunes_track_23", title: "Night", artist: "Neon", provider: "external",
    previewUrl: "https://example.test/preview", coverUrl: "https://example.test/cover",
    album: "Night Drive", metadata: { durationSeconds: 180 },
  });
  expect(payload).toMatchObject({ provider: "itunes", external_id: "23", type: "track",
    metadata: { previewUrl: "https://example.test/preview", album: "Night Drive", durationSeconds: 180 } });
  expect(savedDiscoveryItem({ ...payload, id: "saved", created_at: item.created_at }).id).toBe("external_itunes_track_23");
  expect(savedDiscoveryItem({ ...payload, id: "saved", created_at: item.created_at })).toMatchObject({
    previewUrl: "https://example.test/preview", coverUrl: "https://example.test/cover",
  });
  expect(discoveryInput("album", { id: "spotify_1", provider: "spotify" })).toBeNull();
  expect(discoveryInput("album", { id: "external_deezer_track_7" })).toBeNull();
  expect(discoveryInput("track", { id: "external_deezer_track_7", identityHints: { isrc: "USABC1234567" } })
    .metadata.isrc).toBe("USABC1234567");
  expect(discoveryInput("album", { id: "external_deezer_album_7", trackCount: 12, songCount: 1 })
    .metadata.songCount).toBe(12);
});

test("coalesces saves and does not let an older refresh erase a successful mutation", async () => {
  let resolveList;
  const deps = {
    list: jest.fn(() => new Promise((resolve) => { resolveList = resolve; })),
    save: jest.fn(async () => ({ discovery: item })), remove: jest.fn(async () => null),
  };
  const store = createSavedDiscoveryStore(deps);
  const refresh = store.refresh();
  await Promise.resolve();
  const first = store.save(input);
  const second = store.save(input);
  expect(first).toBe(second);
  expect(await first).toBe(true);
  resolveList({ discoveries: [] });
  await refresh;
  expect(deps.save).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot().items).toEqual([item]);
});

test("failed deletes retain the bookmark and expose a clear network error; retry removes it", async () => {
  const remove = jest.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(null);
  const store = createSavedDiscoveryStore({
    list: async () => ({ discoveries: [item] }), save: jest.fn(), remove,
  });
  await store.refresh();
  expect(await store.remove(item.id)).toBe(false);
  expect(store.getSnapshot().items).toEqual([item]);
  expect(store.getSnapshot().error).toContain("Can't reach MusicDeck");
  expect(await store.remove(item.id)).toBe(true);
  expect(store.getSnapshot()).toMatchObject({ items: [], error: null });
});

test("a refresh started during a save cannot overwrite the acknowledged bookmark", async () => {
  let finishSave;
  let finishList;
  const store = createSavedDiscoveryStore({
    list: () => new Promise((resolve) => { finishList = resolve; }),
    save: () => new Promise((resolve) => { finishSave = resolve; }), remove: jest.fn(),
  });
  const saving = store.save(input);
  const refreshing = store.refresh();
  await Promise.resolve();
  finishSave({ discovery: item });
  await saving;
  finishList({ discoveries: [] });
  await refreshing;
  expect(store.getSnapshot().items).toEqual([item]);
});

test("switching accounts isolates cache and late responses", async () => {
  let finishFirst;
  useAuth.mockReturnValue({ session: { id: "saved-user-first" } });
  getSavedDiscoveries.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
    .mockResolvedValueOnce({ discoveries: [] });
  const { result, rerender } = renderHook(() => useSavedDiscoveries());
  await waitFor(() => expect(getSavedDiscoveries).toHaveBeenCalledTimes(1));
  useAuth.mockReturnValue({ session: { id: "saved-user-second" } });
  rerender();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { finishFirst({ discoveries: [item] }); });
  expect(result.current.items).toEqual([]);
});
