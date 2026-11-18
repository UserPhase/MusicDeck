import { act } from "@testing-library/react";
import { getPrivacySettings } from "./privacy";

const policy = {
  localOnly: true, allowMetadata: true, allowImports: true, allowArtwork: true,
  enforcedByEnvironment: false,
  effective: { metadata: false, imports: false, artwork: false, external: false },
};
const originalFetch = global.fetch;
const reply = (status, body) => ({
  ok: status === 200, status, json: async () => JSON.parse(body),
});

beforeEach(() => {
  jest.useFakeTimers();
  global.fetch = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

test("retries a temporary gateway failure on startup even when its body is not JSON", async () => {
  global.fetch.mockResolvedValueOnce(reply(502, "<html>Bad Gateway</html>"))
    .mockResolvedValueOnce(reply(200, JSON.stringify(policy)));
  const pending = getPrivacySettings(undefined, true);
  await act(async () => {});
  expect(global.fetch).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1500);
  await expect(pending).resolves.toEqual(policy);
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("keeps the HTTP status and does not retry an unauthenticated startup", async () => {
  global.fetch.mockResolvedValueOnce(reply(401, "<html>Unauthorized</html>"));
  await expect(getPrivacySettings(undefined, true)).rejects.toMatchObject({
    status: 401, message: "MusicDeck returned 401",
  });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test("cancels the delayed retry when the first request is aborted", async () => {
  const controller = new AbortController();
  global.fetch.mockResolvedValueOnce(reply(503, "{}"));
  const result = expect(getPrivacySettings(controller.signal, true)).rejects.toMatchObject({ name: "AbortError" });
  await act(async () => {});
  controller.abort();
  jest.advanceTimersByTime(1500);
  await result;
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
