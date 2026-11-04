import { AutoDownloadPolicyManager } from "./AutoDownloadPolicyManager";
import { offlineDownloadEngine, permitsAutomaticDownload } from "./OfflineDownloadEngine";
import { getPlaylist, getStarred } from "../../api/musicdeck";
import { readDownload, listDownloads } from "./offlineDatabase";

jest.mock("../../api/musicdeck", () => ({ getPlaylist: jest.fn(), getStarred: jest.fn() }));
jest.mock("./offlineDatabase", () => ({ ...jest.requireActual("./offlineDatabase"), readDownload: jest.fn(), listDownloads: jest.fn() }));
jest.mock("./OfflineDownloadEngine", () => ({
  permitsAutomaticDownload: jest.fn(() => true),
  offlineDownloadEngine: { getOwner: () => "alice", setAutomaticGate: jest.fn(), saveCollection: jest.fn(), enqueueDownload: jest.fn(), drain: jest.fn() },
}));
const one = { id: "one", title: "First", source: { kind: "library" } };
const two = { id: "two", title: "New favorite", availability: { libraryAvailable: true } };
const policy = { key: "rule", owner: "alice", id: "favorites", kind: "favorites", name: "Favorites", enabled: true, quality: "320kbps" };
beforeEach(() => {
  jest.clearAllMocks();
  (permitsAutomaticDownload as jest.Mock).mockReturnValue(true);
  (listDownloads as jest.Mock).mockResolvedValue([policy]);
  (readDownload as jest.Mock).mockImplementation((_store, key) => Promise.resolve(key === "rule" ? policy : undefined));
});
test("reconciles new favorites and excludes external previews", async () => {
  const manager = new AutoDownloadPolicyManager();
  (getStarred as jest.Mock).mockResolvedValueOnce([one]).mockResolvedValueOnce([one, two, { id: "external", source: { kind: "external" } }]);
  await manager.reconcile();
  (offlineDownloadEngine.enqueueDownload as jest.Mock).mockClear();
  await manager.reconcile();
  expect(offlineDownloadEngine.enqueueDownload).toHaveBeenCalledWith(two, "320kbps", true);
  expect(offlineDownloadEngine.enqueueDownload).toHaveBeenCalledTimes(2);
  expect(offlineDownloadEngine.saveCollection).toHaveBeenLastCalledWith(expect.objectContaining({ trackIds: ["one", "two", "external"] }));
});
test("pauses reconciliation on metered connections", async () => {
  (permitsAutomaticDownload as jest.Mock).mockReturnValue(false);
  await new AutoDownloadPolicyManager().reconcile();
  expect(getStarred).not.toHaveBeenCalled();
  expect(offlineDownloadEngine.enqueueDownload).not.toHaveBeenCalled();
});
test("a rule disabled during a playlist fetch does not enqueue its tracks", async () => {
  (listDownloads as jest.Mock).mockResolvedValue([{ ...policy, kind: "playlist", id: "p" }]);
  (getPlaylist as jest.Mock).mockResolvedValue({ name: "Road trip", entry: [one] });
  (readDownload as jest.Mock).mockResolvedValue({ ...policy, enabled: false });
  await new AutoDownloadPolicyManager().reconcile();
  expect(offlineDownloadEngine.enqueueDownload).not.toHaveBeenCalled();
});
