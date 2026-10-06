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
});
