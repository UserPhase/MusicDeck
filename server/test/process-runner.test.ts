import { describe, expect, test } from "vitest";
import { DefaultProcessRunner } from "../src/domain/process-runner.js";

describe("DefaultProcessRunner output capture", () => {
  test("bounds retained stdout and stderr while keeping their tails", async () => {
    const runner = new DefaultProcessRunner();
    const output = await runner.run(process.execPath, [
      "-e",
      "const b=Buffer.alloc(700*1024, 97); process.stdout.write(b); process.stdout.write('stdout-tail'); process.stderr.write(b); process.stderr.write('stderr-tail');",
    ], { timeoutMs: 15_000 }).promise;

    expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(512 * 1024);
    expect(Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(512 * 1024);
    expect(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(1024 * 1024);
    expect(output.stdout).toContain("stdout-tail");
    expect(output.stderr).toContain("stderr-tail");
  });

  test("preserves real-time line callbacks", async () => {
    const lines: string[] = [];
    const result = await new DefaultProcessRunner().run(process.execPath, [
      "-e",
      "process.stdout.write('first\\nsecond\\n')",
    ], { onStdoutLine: (line) => lines.push(line) }).promise;

    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(["first", "second"]);
  });

  test("does not spawn an already-cancelled process", async () => {
    const controller = new AbortController();
    controller.abort();
    const handle = new DefaultProcessRunner().run(process.execPath, ["-e", "process.exit(0)"], { signal: controller.signal });
    expect(handle.pid).toBeUndefined();
    await expect(handle.promise).rejects.toMatchObject({ name: "AbortError" });
  });

  test("cancellation settles only after the child has exited", async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const handle = new DefaultProcessRunner().run(process.execPath, [
      "-e", "console.log('ready'); setInterval(() => {}, 1000);",
    ], { signal: controller.signal, onStdoutLine: () => ready() });
    const cancelled = expect(handle.promise).rejects.toMatchObject({ name: "AbortError" });
    await started;
    controller.abort();
    await cancelled;
    expect(() => process.kill(handle.pid!, 0)).toThrow();
  });

  test.skipIf(process.platform === "win32")("escalates an ignored SIGTERM after three seconds", async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const handle = new DefaultProcessRunner().run(process.execPath, [
      "-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
    ], { signal: controller.signal, onStdoutLine: () => ready() });
    const cancelled = expect(handle.promise).rejects.toMatchObject({ name: "AbortError" });
    await started;
    const start = Date.now();
    controller.abort();
    await cancelled;
    expect(Date.now() - start).toBeGreaterThanOrEqual(2900);
    expect(() => process.kill(handle.pid!, 0)).toThrow();
  });
});
