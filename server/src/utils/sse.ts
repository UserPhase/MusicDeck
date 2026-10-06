import type { ServerResponse } from "node:http";

type PendingEvent = { event: string; payload: Record<string, unknown>; frame: string };

const DEFAULT_MAX_PENDING = 100;
const DEFAULT_STALL_TIMEOUT_MS = 30_000;

function isProgress(event: string): boolean {
  return event.endsWith(".progress");
}

export class SseEventWriter {
  private readonly pending: PendingEvent[] = [];
  private blocked = false;
  private closed = false;
  private stallTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly response: ServerResponse,
    private readonly maxPending = DEFAULT_MAX_PENDING,
    private readonly stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS
  ) {
    response.on("drain", this.onDrain);
    response.on("close", this.close);
    response.on("error", this.close);
  }

  push(event: string, payload: Record<string, unknown>): void {
    if (this.closed) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    if (!this.blocked) {
      if (this.response.write(frame)) return;
      this.blocked = true;
      this.startStallTimer();
      return;
    }
    this.blocked = true;

    if (isProgress(event)) {
      const jobId = payload.jobId;
      const index = this.pending.findIndex((item) =>
        isProgress(item.event) && item.event === event && item.payload.jobId === jobId
      );
      if (index >= 0) {
        this.pending[index] = { event, payload, frame };
        return;
      }
    }

    if (this.pending.length >= this.maxPending) {
      const progressIndex = this.pending.findIndex((item) => isProgress(item.event));
      if (progressIndex >= 0) this.pending.splice(progressIndex, 1);
      else if (isProgress(event)) return;
      else {
        this.close();
        return;
      }
    }
    this.pending.push({ event, payload, frame });
    this.startStallTimer();
  }

  private readonly onDrain = (): void => {
    if (this.closed) return;
    this.blocked = false;
    this.clearStallTimer();
    while (this.pending.length && !this.blocked) {
      const next = this.pending.shift()!;
      if (!this.response.write(next.frame)) this.blocked = true;
    }
    if (this.blocked) this.startStallTimer();
  };

  private startStallTimer(): void {
    if (this.stallTimer || this.closed) return;
    this.stallTimer = setTimeout(() => this.close(), this.stallTimeoutMs);
    this.stallTimer.unref?.();
  }

  private clearStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
  }

  private readonly close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    this.clearStallTimer();
    this.response.removeListener("drain", this.onDrain);
    this.response.removeListener("close", this.close);
    this.response.removeListener("error", this.close);
    if (!this.response.destroyed && !this.response.writableEnded) this.response.end();
  };
}
