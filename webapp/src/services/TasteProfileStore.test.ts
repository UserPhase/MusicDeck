import { waitFor } from "@testing-library/react";
import { tasteProfileStore as store } from "./TasteProfileStore";
const state = (extra = {}) => ({ privateListening: false, revision: 0, resetBefore: null, providerHistoryDisabled: false, excludedPlaylistIds: [], excludedTrackIds: [], ...extra });
const reply = (body: unknown) => Promise.resolve({ ok: true, json: async () => body } as Response);
beforeEach(() => { store.activate(null); localStorage.clear(); Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); global.fetch = jest.fn(() => reply(state())); });
afterEach(() => { store.activate(null); Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); });
test("private listening starts immediately offline and cannot end until the server acknowledges it", async () => {
  store.activate("alice"); await waitFor(() => expect(store.getSnapshot().loaded).toBe(true));
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  await store.setPrivate(true); expect(store.getSnapshot()).toMatchObject({ privateListening: true, pending: true });
  await store.setPrivate(false); expect(store.getSnapshot()).toMatchObject({ privateListening: true, pending: true });
  store.activate(null); store.activate("alice"); expect(store.getSnapshot().privateListening).toBe(true);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); await store.refresh();
  expect(store.getSnapshot()).toMatchObject({ privateListening: false, pending: false });
  expect(fetch).toHaveBeenCalledWith("/api/v1/taste-profile/private", expect.objectContaining({ body: JSON.stringify({ ownerId: "alice", enabled: false, revision: 0 }) }));
});
test("unavailable or invalid preferences fail closed on an uncached account", async () => {
  (fetch as jest.Mock).mockImplementation(() => reply({ invalid: true })); store.activate("alice");
  await waitFor(() => expect(store.getSnapshot().error).toContain("invalid taste")); expect(store.getSnapshot().privateListening).toBe(true);
});
test("account changes abort pending writes and never publish another user's preferences", async () => {
  store.activate("alice"); await waitFor(() => expect(store.getSnapshot().loaded).toBe(true));
  let finish!: (response: Response) => void;
  (fetch as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = store.request("/track", { trackId: "private-song", excluded: true }).catch(error => error);
  store.activate("bob"); finish(await reply(state({ revision: 8, excludedTrackIds: ["private-song"] })));
  expect(await pending).toBeInstanceOf(Error); await waitFor(() => expect(store.getSnapshot().loaded).toBe(true));
  expect(store.getSnapshot()).toMatchObject({ owner: "bob", excludedTrackIds: [] });
});
