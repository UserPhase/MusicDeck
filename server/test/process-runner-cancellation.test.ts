import { ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DefaultProcessRunner } from "../src/domain/process-runner.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

describe("process cancellation escalation", () => {
  test("keeps cancellation pending until close and escalates exactly at 3000ms", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new ChildProcess(), { pid: 12345 });
    vi.mocked(spawn).mockImplementation(() => child);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const controller = new AbortController();
    const handle = new DefaultProcessRunner().run("spotdl", [], { signal: controller.signal });
    let settled = false;
    const outcome = handle.promise.catch((error: unknown) => { settled = true; return error; });
    controller.abort();
    if (process.platform === "win32") {
      expect(spawn).toHaveBeenLastCalledWith("taskkill.exe", ["/PID", "12345", "/T"],
        { windowsHide: true, stdio: "ignore" });
    } else expect(kill).toHaveBeenLastCalledWith(-12345, "SIGTERM");
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    expect(process.platform === "win32" ? vi.mocked(spawn).mock.calls.length : kill.mock.calls.length)
      .toBe(process.platform === "win32" ? 2 : 1);
    await vi.advanceTimersByTimeAsync(1);
    if (process.platform === "win32") {
      expect(spawn).toHaveBeenLastCalledWith("taskkill.exe", ["/PID", "12345", "/T", "/F"],
        { windowsHide: true, stdio: "ignore" });
    } else expect(kill).toHaveBeenLastCalledWith(-12345, "SIGKILL");
    expect(settled).toBe(false);
    child.emit("close", null, "SIGKILL");
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("normal close clears the escalation timer and ignores late cancellation", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new ChildProcess(), { pid: 12345 });
    vi.mocked(spawn).mockImplementation(() => child);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const controller = new AbortController();
    const handle = new DefaultProcessRunner().run("spotdl", [], { signal: controller.signal });
    child.emit("close", 0, null);
    expect((await handle.promise).exitCode).toBe(0);
    controller.abort();
    handle.cancel?.();
    await vi.advanceTimersByTimeAsync(3000);
    expect(spawn).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
