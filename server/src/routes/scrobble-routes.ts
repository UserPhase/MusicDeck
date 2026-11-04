import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import type { AppConfig } from "../config.js";
import { requireUser } from "../auth/authorization.js";
import { SESSION_COOKIE } from "../auth/sessions.js";
import { sendError } from "../utils/http.js";
import { registerLogSecret } from "../utils/logger.js";
import { ScrobbleQueueService } from "../services/scrobble/ScrobbleQueueService.js";
import { ScrobbleError } from "../services/scrobble/protocol.js";

const providerSchema = z.enum(["lastfm", "listenbrainz"]);
const credentialSchema = z.string().trim().min(1).max(4096).refine((value) => !/[\r\n\0]/.test(value));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function registerScrobbleRoutes(app: FastifyInstance, db: Db, config: AppConfig, queue: ScrobbleQueueService) {
  const authorize = (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer");
    const user = requireUser(db, request, reply);
    if (!user) return null;
    if (request.method !== "GET" && request.headers.origin && ![config.publicUrl, config.corsOrigin].some((url) => {
      try { return new URL(url).origin === request.headers.origin; } catch { return false; }
    })) { sendError(reply, 403, "Connection changes must originate from MusicDeck."); return null; }
    return user;
  };
  function failure(error: unknown, reply: FastifyReply) {
    if (error instanceof z.ZodError) return sendError(reply, 400, "Check the provider and credential fields.", "VALIDATION_ERROR");
    if (error instanceof ScrobbleError) return sendError(reply, error.kind === "transient" ? 503 : error.kind === "paused" ? 409 : 400, error.message, error.code);
    // Never serialize an upstream error containing credentials, headers, or query strings.
    app.log.error("Scrobble connection operation failed");
    return sendError(reply, 500, "Could not update the scrobble connection. Check server health.", "SCROBBLE_ERROR");
  }
  app.get("/api/v1/scrobble", async (request, reply) => {
    const user = authorize(request, reply); if (!user) return reply;
    return { connections: queue.statuses(user.id) };
  });
  app.post("/api/v1/scrobble/lastfm/authorize", async (request, reply) => {
    const user = authorize(request, reply); if (!user) return reply;
    try {
      const apiKey = queue.applicationKey();
      const state = randomBytes(32).toString("hex");
      const callback = new URL("/api/v1/scrobble/lastfm/callback", config.publicUrl);
      callback.searchParams.set("state", state);
      const url = new URL("https://www.last.fm/api/auth/");
      url.searchParams.set("api_key", apiKey); url.searchParams.set("cb", callback.toString());
      db.transaction(() => {
        db.prepare("DELETE FROM scrobble_auth_states WHERE user_id=? OR expires_at<?").run(user.id, Date.now());
        db.prepare("INSERT INTO scrobble_auth_states(state_hash,user_id,session_hash,expires_at) VALUES (?,?,?,?)")
          .run(hash(state), user.id, hash(request.cookies[SESSION_COOKIE]!), Date.now() + 10 * 60_000);
      })();
      return { authorizationUrl: url.toString() };
    } catch (error) { return failure(error, reply); }
  });
  app.get("/api/v1/scrobble/lastfm/callback", async (request, reply) => {
    const user = authorize(request, reply); if (!user) return reply;
    const parsed = z.object({ state: z.string().regex(/^[a-f0-9]{64}$/), token: z.string().regex(/^[a-fA-F0-9]{32}$/) }).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "Authorization callback is incomplete. Start authorization again.");
    const { state, token } = parsed.data;
    registerLogSecret(token);
    // Consume the session-bound state exactly once before the asynchronous exchange.
    const consumed = db.prepare("DELETE FROM scrobble_auth_states WHERE state_hash=? AND user_id=? AND session_hash=? AND expires_at>? RETURNING state_hash")
      .get(hash(state), user.id, hash(request.cookies[SESSION_COOKIE]!), Date.now());
    if (!consumed) return sendError(reply, 400, "Authorization expired or belongs to another session. Start authorization again.");
    try {
      await queue.connectLastFm(user.id, { token });
      const destination = user.role === "admin" ? "/admin/server?scrobble=connected#scrobble-title" : "/settings?scrobble=connected";
      return reply.redirect(new URL(destination, config.publicUrl).toString());
    }
    catch (error) { return failure(error, reply); }
  });
  app.put("/api/v1/scrobble/:provider", async (request, reply) => {
    const user = authorize(request, reply); if (!user) return reply;
    try {
      const provider = providerSchema.parse((request.params as { provider: string }).provider);
      if (provider === "lastfm") {
        const { sessionKey } = z.object({ sessionKey: credentialSchema }).strict().parse(request.body);
        await queue.connectLastFm(user.id, { sessionKey });
      } else {
        const { token } = z.object({ token: credentialSchema }).strict().parse(request.body);
        await queue.connectListenBrainz(user.id, token);
      }
      return { connections: queue.statuses(user.id) };
    } catch (error) { return failure(error, reply); }
  });
  app.delete("/api/v1/scrobble/:provider", async (request, reply) => {
    const user = authorize(request, reply); if (!user) return reply;
    try {
      await queue.disconnect(user.id, providerSchema.parse((request.params as { provider: string }).provider));
      return { connections: queue.statuses(user.id) };
    } catch (error) { return failure(error, reply); }
  });
  for (const action of ["test", "retry"] as const) app.post(`/api/v1/scrobble/:provider/${action}`, async (request, reply) => {
    const user = authorize(request, reply); if (!user) return reply;
    try {
      const provider = providerSchema.parse((request.params as { provider: string }).provider);
      if (action === "test") await queue.testConnection(user.id, provider); else queue.retry(user.id, provider);
      return { connections: queue.statuses(user.id) };
    } catch (error) { return failure(error, reply); }
  });
}
