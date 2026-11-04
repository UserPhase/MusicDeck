import { getPlaylistSharing } from "./playlistCollaboration";
import { request } from "./musicdeck";
jest.mock("./musicdeck", () => ({ request: jest.fn() }));
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); });
afterEach(() => jest.useRealTimers());
test("unreachable sharing requests time out with a retryable diagnostic", async () => {
  (request as jest.Mock).mockImplementation((_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason));
  }));
  const pending = expect(getPlaylistSharing("list")).rejects.toMatchObject({ status: 0, message: expect.stringContaining("did not respond in time") });
  jest.advanceTimersByTime(30000); await pending; expect(jest.getTimerCount()).toBe(0);
});
test("account/unmount cancellation aborts the underlying request without converting it to a server timeout", async () => {
  (request as jest.Mock).mockImplementation((_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  const controller = new AbortController(), pending = expect(getPlaylistSharing("list", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  controller.abort(); await pending; expect(jest.getTimerCount()).toBe(0);
});
test("HTTP permission status survives the API adapter for host revocation handling", async () => {
  const denied = Object.assign(new Error("Playlist access denied"), { status: 403 });
  (request as jest.Mock).mockRejectedValueOnce(denied); await expect(getPlaylistSharing("list")).rejects.toBe(denied);
});
