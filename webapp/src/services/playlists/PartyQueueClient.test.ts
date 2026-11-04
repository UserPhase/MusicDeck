import { partyHost, partyDeviceId, partyRequestKey } from "./PartyQueueClient";
import { startPlaylistParty, controlPlaylistParty } from "../../api/playlistCollaboration";
import { webcrypto } from "crypto";
import { waitFor } from "@testing-library/react";
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
jest.mock("../../api/playlistCollaboration", () => ({ startPlaylistParty: jest.fn(), controlPlaylistParty: jest.fn() }));
beforeEach(() => { partyHost.activate(null); sessionStorage.clear(); jest.useFakeTimers(); jest.clearAllMocks();
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  (startPlaylistParty as jest.Mock).mockResolvedValue({ id: "party", expiresAt: Date.now() + 90000 });
  (controlPlaylistParty as jest.Mock).mockResolvedValue({ ok: true }); });
afterEach(() => { partyHost.activate(null); jest.useRealTimers(); });
afterAll(() => { if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto); else Reflect.deleteProperty(globalThis, "crypto"); });
test("device identity is stable per tab while request keys are distinct secure UUIDs", () => {
  const device = partyDeviceId(); expect(partyDeviceId()).toBe(device); expect(partyRequestKey()).not.toBe(device);
  expect(device).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
test("revoked or expired hosting clears the local lease instead of blocking future parties", async () => {
  partyHost.activate("owner"); await partyHost.start("playlist", "owner", new AbortController().signal);
  (controlPlaylistParty as jest.Mock).mockRejectedValueOnce(Object.assign(new Error("Playlist access denied"), { status: 403 }));
  jest.advanceTimersByTime(20000);
  await waitFor(() => expect(partyHost.getSnapshot().playlistId).toBeNull()); expect(sessionStorage.getItem("musicdeck:party-host:owner")).toBeNull();
  await partyHost.start("another", "owner", new AbortController().signal); expect(partyHost.getSnapshot().playlistId).toBe("another");
});
test("a late start response never crosses accounts", async () => {
  let finish!: (value: unknown) => void;
  (startPlaylistParty as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  partyHost.activate("owner"); const started = partyHost.start("playlist", "owner", new AbortController().signal);
  partyHost.activate("other"); finish({ id: "party", expiresAt: Date.now() + 90000 }); await started;
  expect(partyHost.getSnapshot()).toMatchObject({ ownerId: "other", playlistId: null });
});
