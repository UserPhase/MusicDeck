import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/database.js";
import type { LibraryService } from "../domain/library.js";
import type { SourceResolver } from "../domain/source-resolver.js";
import { SourceUnavailableError } from "../domain/source-resolver.js";
import type { TaskManager } from "../services/TaskManager.js";
import { requireUser } from "../auth/authorization.js";
import { getSessionUserById, SESSION_COOKIE } from "../auth/sessions.js";
import { subscribeSessionChanges } from "../auth/session-events.js";
import { sendError } from "../utils/http.js";
import type { PrivacyManager } from "../services/PrivacyManager.js";
import { sourceProperties } from "../services/AudioMetadataInspector.js";

const ticketSchema = z.object({ trackId: z.string().min(1).max(300),
  maxBitRate: z.union([z.literal(128), z.literal(256), z.literal(320)]).optional() }).strict();
const tokenSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const LEASE_MS = 24 * 60 * 60 * 1000;
interface Lease { session: string; userId: string; trackId: string; maxBitRate?: number; expires: number; releasePrivacy(): void; }

/** Track-scoped capabilities: the receiver never receives a login cookie or provider URL. */
export function registerCastRoutes(app: FastifyInstance, db: Db, config: AppConfig,
  library: LibraryService, resolver: SourceResolver, tasks: TaskManager, privacy: PrivacyManager): void {
  const leases = new Map<string, Lease>();
  const active = new Map<string, Set<() => void>>();
  const revoke = (key: string) => {
    leases.get(key)?.releasePrivacy();
    leases.delete(key);
    for (const stop of active.get(key) ?? []) stop();
    active.delete(key);
  };
  const prune = () => {
    for (const [key, lease] of leases) {
      if (!privacy.isExternalAllowed("external") || lease.expires <= Date.now() ||
          getSessionUserById(db, lease.session)?.id !== lease.userId) revoke(key);
    }
  };
  const timer = setInterval(prune, 15000);
  timer.unref();
  const unsubscribe = subscribeSessionChanges(db, prune);
  app.addHook("preClose", async () => {
    clearInterval(timer); unsubscribe();
    for (const key of leases.keys()) revoke(key);
  });
  app.post("/api/v1/cast/ticket", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    privacy.assertExternalAllowed("external");
    const parsed = ticketSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid Cast track request", "VALIDATION_ERROR");
    if (library.getItemType(parsed.data.trackId) !== "track") return sendError(reply, 404, "Library track not found");
    let contentType = "audio/mpeg";
    if (!parsed.data.maxBitRate) {
      const source = sourceProperties(await resolver.audioMetadata(parsed.data.trackId));
      const types: Record<string, string> = { FLAC: "audio/flac", MP3: "audio/mpeg", ALAC: "audio/mp4",
        AAC: /MP4|M4A/.test(source.container ?? "") ? "audio/mp4" : "audio/aac",
        PCM: source.container === "WAV" ? "audio/wav" : "", AIFF: "audio/aiff",
        OPUS: source.container === "WEBM" ? "audio/webm" : "audio/ogg", VORBIS: "audio/ogg" };
      contentType = source.codec ? types[source.codec] ?? "" : "";
      if (!contentType) return sendError(reply, 422, "The source format is unknown. Choose 128, 256 or 320 kbps in Audio Quality before casting.", "CAST_FORMAT_UNKNOWN");
    }
    prune();
    const session = request.cookies[SESSION_COOKIE]!;
    if ([...leases.values()].filter((lease) => lease.session === session).length >= 8 || leases.size >= 4096) {
      return sendError(reply, 429, "Too many active Cast streams. Stop an existing Cast session first.", "CAST_LIMIT");
    }
    const token = randomBytes(32).toString("hex");
    const expires = Date.now() + LEASE_MS;
    const key = digest(token);
    leases.set(key, { session, userId: user.id, ...parsed.data, expires,
      releasePrivacy: privacy.track("external", () => revoke(key)) });
    const url = new URL("/api/v1/cast/stream", config.publicUrl);
    url.searchParams.set("token", token);
    reply.header("Cache-Control", "private, no-store");
    return { token, url: url.href, contentType, expiresAt: new Date(expires).toISOString() };
  });
  app.delete("/api/v1/cast/ticket", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const parsed = tokenSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid Cast ticket", "VALIDATION_ERROR");
    const key = digest(parsed.data.token);
    const lease = leases.get(key);
    if (lease && lease.session !== request.cookies[SESSION_COOKIE]) return sendError(reply, 403, "Cast ticket belongs to another session");
    revoke(key);
    return reply.code(204).send();
  });
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range", "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
    "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
  app.options("/api/v1/cast/stream", { config: { cors: false } }, async (_request, reply) =>
    reply.headers(cors).code(204).send());
  app.get("/api/v1/cast/stream", { config: { cors: false } }, async (request, reply) => {
    reply.headers(cors);
    privacy.assertExternalAllowed("external");
    const parsed = tokenSchema.safeParse(request.query);
    if (!parsed.success) return sendError(reply, 401, "Valid Cast stream ticket required");
    const key = digest(parsed.data.token);
    const lease = leases.get(key);
    if (!lease || lease.expires <= Date.now() || getSessionUserById(db, lease.session)?.id !== lease.userId) {
      revoke(key);
      return sendError(reply, 401, "Cast stream ticket expired or revoked");
    }
    if ((active.get(key)?.size ?? 0) >= 4) return sendError(reply, 429, "Too many receiver connections");
    const release = tasks.acquireMediaStream();
    const connections = active.get(key) ?? new Set<() => void>();
    const stop = () => reply.raw.destroy();
    connections.add(stop); active.set(key, connections);
    const cleanup = () => {
      release(); connections.delete(stop);
      if (!connections.size) active.delete(key);
    };
    reply.raw.once("close", cleanup); reply.raw.once("finish", cleanup); reply.raw.once("error", cleanup);
    try {
      const result = await resolver.fetchStream(lease.trackId, request.headers.range, undefined, lease.maxBitRate);
      if (!leases.has(key) || reply.raw.destroyed) {
        await result.body?.cancel();
        cleanup();
        return reply;
      }
      if (!result.body) { cleanup(); return sendError(reply, 502, "Cast media response was empty"); }
      for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = result.headers.get(header);
        if (value) reply.header(header, value);
      }
      const reader = result.body.getReader();
      const cancel = () => { void reader.cancel().catch((error) => app.log.warn({ err: error }, "Could not cancel Cast upstream")); };
      reply.raw.once("close", cancel);
      const stream = Readable.from((async function* () {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) return;
            yield chunk.value;
          }
        } finally {
          reply.raw.removeListener("close", cancel);
          await reader.cancel();
          reader.releaseLock();
        }
      })());
      return reply.code(result.status).send(stream);
    } catch (error) {
      cleanup();
      app.log.warn({ err: error }, "Cast media stream failed");
      if (error instanceof SourceUnavailableError) return sendError(reply, 502, "Cast playback unavailable");
      throw error;
    }
  });
}
