import type { ServerResponse } from "node:http";

export class SseConnectionLimiter {
  private readonly users = new Map<string, number>();
  private total = 0;

  constructor(private readonly perUser: number, private readonly global: number) {
    if (![perUser, global].every((limit) => Number.isSafeInteger(limit) && limit > 0)) {
      throw new Error("SSE connection limits must be positive safe integers");
    }
  }

  reserve(userId: string): (() => void) | null {
    const count = this.users.get(userId) || 0;
    if (count >= this.perUser || this.total >= this.global) return null;
    this.users.set(userId, count + 1);
    this.total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const remaining = (this.users.get(userId) || 1) - 1;
      if (remaining) this.users.set(userId, remaining);
      else this.users.delete(userId);
    };
  }
}

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
    private readonly stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    private readonly canSend: (event: string, payload: Record<string, unknown>) => boolean = () => true,
  ) {
    response.on("drain", this.onDrain);
    response.on("close", this.close);
    response.on("error", this.close);
  }

  push(event: string, payload: Record<string, unknown>, id?: string): void {
    if (this.closed || !this.canSend(event, payload) || this.closed) return;
    const frame = `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
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
      if (!this.canSend(next.event, next.payload)) continue;
      if (this.closed) return;
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

  public readonly close = (): void => {
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
