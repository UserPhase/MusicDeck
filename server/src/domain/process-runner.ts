import { spawn, type ChildProcess } from "node:child_process";
import { currentPrivacyManager, type PrivacyCategory } from "../services/PrivacyManager.js";

export type ProcessOptions = {
  privacyCategory?: PrivacyCategory;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
};

export type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal?: string | null;
};

export interface ProcessHandle {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals | number): void;
  cancel?(signal?: NodeJS.Signals | number): void;
  readonly promise: Promise<ProcessResult>;
  readonly completion?: Promise<ProcessResult>;
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: ProcessOptions): ProcessHandle;
}

const MAX_CAPTURE_BYTES_PER_STREAM = 512 * 1024;
const MAX_PARTIAL_LINE_BYTES = 64 * 1024;

function appendBounded(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (chunk.length >= limit) return chunk.subarray(chunk.length - limit);
  const combined = Buffer.concat([current, chunk]);
  return combined.length > limit ? combined.subarray(combined.length - limit) : combined;
}

/**
 * DefaultProcessRunner executes external binaries safely using argument arrays.
 * It strictly avoids shell string concatenation and supports cancellation, timeouts,
 * and real-time stdout/stderr stream parsing.
 */
export class DefaultProcessRunner implements ProcessRunner {
  run(command: string, args: string[], options: ProcessOptions = {}): ProcessHandle {
    const privacy = currentPrivacyManager();
    if (options.privacyCategory) privacy?.assertExternalAllowed(options.privacyCategory);
    let child: ChildProcess | undefined;
    let stdoutData: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderrData: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderrBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let isTerminated = false;
    let closed = false;
    let terminationError: Error | undefined;
    let releasePrivacy: (() => void) | undefined;
    const terminate = (signal: NodeJS.Signals | number) => {
      if (!child?.pid || closed) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else {
          const killer = spawn("taskkill.exe", [
            "/PID", String(child.pid), "/T",
            ...(signal === "SIGKILL" || signal === 9 ? ["/F"] : []),
          ], { windowsHide: true, stdio: "ignore" });
          killer.on("error", (error) => {
            console.warn("Could not terminate media process tree", error);
            if (!closed) child?.kill(signal);
          });
          killer.on("exit", (code) => {
            if (code !== 0 && !closed) {
              console.warn(`Media process tree termination exited with code ${code}`);
              child?.kill(signal);
            }
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.warn("Could not terminate media process", error);
      }
    };
    const cancel = (signal: NodeJS.Signals | number = "SIGTERM") => {
      if (isTerminated || closed) return;
      isTerminated = true;
      terminationError = new Error("Process was cancelled");
      terminationError.name = "AbortError";
      if (timeoutTimer) clearTimeout(timeoutTimer);
      terminate(signal);
      if (signal !== "SIGKILL" && signal !== 9) {
        killTimer = setTimeout(() => terminate("SIGKILL"), 3000);
      }
    };

    const promise = new Promise<ProcessResult>((resolve, reject) => {
      if (options.signal?.aborted) {
        const error = new Error("Process was cancelled");
        error.name = "AbortError";
        reject(error);
        return;
      }
      try {
        if (options.privacyCategory) releasePrivacy = privacy?.track(options.privacyCategory, () => {
          cancel("SIGKILL");
          return promise.then(() => undefined, (error: unknown) => { if (!isTerminated) throw error; });
        });
        child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        releasePrivacy?.();
        return reject(err);
      }

      if (options.timeoutMs && options.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          isTerminated = true;
          terminationError = new Error(`Process timed out after ${options.timeoutMs}ms`);
          terminate("SIGKILL");
        }, options.timeoutMs);
      }

      const onAbort = () => {
        cancel();
      };

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutData = appendBounded(stdoutData, chunk, MAX_CAPTURE_BYTES_PER_STREAM);
        const text = chunk.toString("utf8");
        options.onStdoutChunk?.(text);

        if (options.onStdoutLine) {
          const lines = Buffer.concat([stdoutBuffer, chunk]).toString("utf8").split(/\r?\n|\r/);
          stdoutBuffer = Buffer.from(lines.pop() || "").subarray(-MAX_PARTIAL_LINE_BYTES);
          for (const line of lines) {
            if (line.trim()) {
              options.onStdoutLine(line);
            }
          }
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrData = appendBounded(stderrData, chunk, MAX_CAPTURE_BYTES_PER_STREAM);
        const text = chunk.toString("utf8");
        options.onStderrChunk?.(text);

        if (options.onStderrLine) {
          const lines = Buffer.concat([stderrBuffer, chunk]).toString("utf8").split(/\r?\n|\r/);
          stderrBuffer = Buffer.from(lines.pop() || "").subarray(-MAX_PARTIAL_LINE_BYTES);
          for (const line of lines) {
            if (line.trim()) {
              options.onStderrLine(line);
            }
          }
        }
      });

      child.on("error", (err) => {
        releasePrivacy?.();
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        if (options.signal) options.signal.removeEventListener("abort", onAbort);
        reject(terminationError ?? err);
      });

      child.on("close", (exitCode, signal) => {
        releasePrivacy?.();
        if (isTerminated && process.platform !== "win32") terminate("SIGKILL");
        closed = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        if (options.signal) options.signal.removeEventListener("abort", onAbort);

        if (isTerminated || options.signal?.aborted) {
          return reject(terminationError ?? new Error("Process was cancelled"));
        }

        if (options.onStdoutLine && stdoutBuffer.toString("utf8").trim()) {
          options.onStdoutLine(stdoutBuffer.toString("utf8").trim());
        }
        if (options.onStderrLine && stderrBuffer.toString("utf8").trim()) {
          options.onStderrLine(stderrBuffer.toString("utf8").trim());
        }

        resolve({
          exitCode,
          stdout: stdoutData.toString("utf8"),
          stderr: stderrData.toString("utf8"),
          signal: signal || null,
        });
      });
    });

    return {
      get pid() {
        return child?.pid;
      },
      kill: cancel,
      cancel,
      promise,
      completion: promise,
    };
  }
}
