import { act, renderHook, waitFor } from "@testing-library/react";
import { useCastSession } from "./useCastSession";
import { CastManager } from "../services/cast/CastManager";
import { PlaybackEngine } from "../services/audio/PlaybackEngine";

beforeEach(() => {
  jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });
function setup(allowed = true) {
  const engine = new PlaybackEngine({ audioContext: null });
  const attach = jest.spyOn(engine, "setRemoteOutput").mockResolvedValue();
  const release = jest.spyOn(engine, "releaseRemoteOutput").mockResolvedValue();
  const connect = jest.spyOn(CastManager.prototype, "connect").mockResolvedValue();
  const disconnect = jest.spyOn(CastManager.prototype, "disconnect").mockResolvedValue();
  const result = renderHook(({ owner, policy }: { owner: string | null; policy: boolean }) => useCastSession(engine, owner, policy),
    { initialProps: { owner: "user", policy: allowed } });
  return { engine, attach, release, connect, disconnect, ...result };
}
test("connecting attaches the remote engine output, and stopping restores only a paused local deck", async () => {
  const current = setup();
  await act(async () => { await current.result.current.connect(); });
  expect(current.connect).toHaveBeenCalledTimes(1);
  expect(current.attach).toHaveBeenCalledWith(expect.any(CastManager));
  await act(async () => { await current.result.current.disconnect(); });
  expect(current.disconnect).toHaveBeenCalledTimes(1);
  expect(current.release).toHaveBeenCalledTimes(1);
  current.unmount(); current.engine.destroy();
});
test("privacy policy changing while the picker is open cancels attachment and stops the selected receiver", async () => {
  const current = setup();
  let finish: (() => void) | undefined;
  current.connect.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  let connecting: Promise<void> | undefined;
  act(() => { connecting = current.result.current.connect(); });
  current.rerender({ owner: "user", policy: false });
  await act(async () => {
    finish?.();
    await expect(connecting).rejects.toThrow("privacy policy changed");
  });
  expect(current.attach).not.toHaveBeenCalled();
  expect(current.disconnect).toHaveBeenCalled();
  current.unmount(); current.engine.destroy();
});
test("blocked policies do not initialize Cast and changing accounts disposes the previous controller", async () => {
  const current = setup(false);
  await expect(current.result.current.connect()).rejects.toThrow("disabled");
  expect(current.connect).not.toHaveBeenCalled();
  current.rerender({ owner: "other-user", policy: false });
  await waitFor(() => expect(current.disconnect).toHaveBeenCalledTimes(1));
  expect(current.release).toHaveBeenCalledWith(expect.any(CastManager));
  current.unmount(); current.engine.destroy();
});
