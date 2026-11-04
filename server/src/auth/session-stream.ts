import type { FastifyRequest } from "fastify";
import type { Db } from "../db/database.js";
import type { SessionUser } from "../types.js";
import { getSessionUserById, SESSION_COOKIE } from "./sessions.js";
import { subscribeSessionChanges } from "./session-events.js";

export const STREAM_AUTH_CHECK_MS = 5000;

export class SessionStreamGuard {
  private readonly sessionId: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;

  constructor(
    private readonly db: Db,
    request: FastifyRequest,
    private readonly requiresAdmin: boolean,
    private readonly onInvalid: () => void,
    private readonly onError: (error: unknown) => void,
  ) {
    this.sessionId = request.cookies[SESSION_COOKIE];
  }

  currentUser(): SessionUser | null {
    if (this.closed) return null;
    try {
      const user = getSessionUserById(this.db, this.sessionId);
      if (user && (!this.requiresAdmin || user.role === "admin")) return user;
    } catch (error) {
      this.close();
      this.onInvalid();
      this.onError(error);
      return null;
    }
    this.close();
    this.onInvalid();
    return null;
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.unsubscribe = subscribeSessionChanges(this.db, () => { this.currentUser(); });
    this.timer = setInterval(() => { this.currentUser(); }, STREAM_AUTH_CHECK_MS);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
