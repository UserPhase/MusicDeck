import { spawn, type ChildProcess } from "node:child_process";

export type ProcessOptions = {
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
    let child: ChildProcess | undefined;
    let stdoutData: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderrData: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderrBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timeoutTimer: NodeJS.Timeout | undefined;
    let isTerminated = false;

    const promise = new Promise<ProcessResult>((resolve, reject) => {
      try {
        child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        return reject(err);
      }

      if (options.timeoutMs && options.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          isTerminated = true;
          try {
            child?.kill("SIGKILL");
          } catch {}
          reject(new Error(`Process timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
      }

      const onAbort = () => {
        isTerminated = true;
        try {
          child?.kill("SIGTERM");
          setTimeout(() => {
            try {
              child?.kill("SIGKILL");
            } catch {}
          }, 1000);
        } catch {}
        reject(new Error("Process was cancelled"));
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
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (options.signal) options.signal.removeEventListener("abort", onAbort);
        if (!isTerminated) {
          reject(err);
        }
      });

      child.on("close", (exitCode, signal) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (options.signal) options.signal.removeEventListener("abort", onAbort);

        if (isTerminated || options.signal?.aborted) {
          return reject(new Error("Process was cancelled"));
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
      kill(signal = "SIGTERM") {
        isTerminated = true;
        try {
          child?.kill(signal);
        } catch {}
      },
      cancel(signal = "SIGTERM") {
        isTerminated = true;
        try {
          child?.kill(signal);
        } catch {}
      },
      promise,
      completion: promise,
    };
  }
}
