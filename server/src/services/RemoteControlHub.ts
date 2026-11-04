import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { Db } from "../db/database.js";
import { getSessionUserById, SESSION_COOKIE } from "../auth/sessions.js";
import { subscribeSessionChanges } from "../auth/session-events.js";

const id = z.string().min(1).max(160);
const position = z.number().finite().min(0).max(7 * 24 * 60 * 60 * 1000);
const track = z.object({ id, title: z.string().max(500) }).strict();
const stateSchema = z.object({
  current_track: track.nullable(), position_ms: position, duration_ms: position,
  playing: z.boolean(), volume: z.number().min(0).max(1),
}).strict();
const queueSchema = z.object({
  entries: z.array(z.object({ occurrenceId: id, trackId: id, title: z.string().max(500),
    artist: z.string().max(500), album: z.string().max(500), duration: z.number().finite().min(0).max(604800),
    albumPlaybackId: z.string().max(160).optional(), albumTrackIndex: z.number().int().min(0).optional(),
    resume: z.object({ type: z.enum(["album", "playlist"]), mediaId: z.string().min(1).max(300),
      title: z.string().min(1).max(500), trackIndex: z.number().int().min(0).max(1_000_000),
      trackCount: z.number().int().min(1).max(1_000_001), occurrenceId: z.string().min(1).max(300).nullable(),
    }).strict().refine((value) => value.trackIndex < value.trackCount).optional(),
  }).strict()).min(1).max(5000),
  index: z.number().int().min(0), repeatOne: z.boolean(), shuffle: z.boolean(),
  shuffleMode: z.enum(["standard", "smart"]), shuffleSeed: z.number().int().nullable(),
  albumAware: z.boolean(),
  context: z.object({ type: z.string().max(50), id, name: z.string().max(500), coverArt: z.string().max(500).nullable() }).strict().nullable(),
}).strict().refine((value) => value.index < value.entries.length &&
  new Set(value.entries.map((entry) => entry.occurrenceId)).size === value.entries.length, "Invalid queue occurrences");
const snapshotSchema = z.object({ queueState: queueSchema, trackId: id, exactPositionMs: position, playing: z.boolean(), volume: z.number().min(0).max(1) })
  .strict().refine((value) => value.queueState.entries[value.queueState.index]?.trackId === value.trackId, "Track/index mismatch");
const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PLAY") }).strict(), z.object({ type: z.literal("PAUSE") }).strict(),
  z.object({ type: z.literal("SKIP"), direction: z.enum(["next", "previous"]) }).strict(),
  z.object({ type: z.literal("SEEK"), position_ms: position }).strict(),
  z.object({ type: z.literal("SET_VOLUME"), volume: z.number().min(0).max(1) }).strict(),
]);
const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("REGISTER"), device_id: id, device_name: z.string().trim().min(1).max(80),
    device_type: z.enum(["computer", "phone", "tablet", "web"]), can_receive: z.boolean(), state: stateSchema }).strict(),
  z.object({ type: z.literal("STATE"), state: stateSchema, claim: z.boolean() }).strict(),
  z.object({ type: z.literal("COMMAND"), requestId: id, targetId: id.optional(), command: commandSchema }).strict(),
  z.object({ type: z.literal("COMMAND_RESULT"), requestId: id, ok: z.boolean(), message: z.string().max(500).optional() }).strict(),
  z.object({ type: z.literal("TRANSFER_PLAYBACK"), requestId: id, targetId: id }).strict(),
  z.object({ type: z.literal("SNAPSHOT"), transferId: id, snapshot: snapshotSchema }).strict(),
  z.object({ type: z.literal("READY"), transferId: id }).strict(),
  z.object({ type: z.literal("SOURCE_PAUSED"), transferId: id, snapshot: snapshotSchema }).strict(),
  z.object({ type: z.literal("STARTED"), transferId: id }).strict(),
  z.object({ type: z.literal("TRANSFER_FAILED"), transferId: id, message: z.string().max(500) }).strict(),
]);
type State = z.infer<typeof stateSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;
type Message = z.infer<typeof messageSchema>;
interface Client {
  socket: WebSocket; userId: string; sessionId: string; deviceId: string | null;
  name: string; kind: string; ready: boolean; state: State; alive: boolean; tokens: number; refill: number;
}
interface Transfer {
  id: string; requestId: string; controller: Client; source: Client; target: Client;
  stage: "snapshot" | "prepare" | "pause" | "start"; snapshot?: Snapshot; timer: NodeJS.Timeout;
}
const emptyState: State = { current_track: null, position_ms: 0, duration_ms: 0, playing: false, volume: 1 };
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const PATH = "/api/v1/remote";

/** Ephemeral, user-isolated control plane. Audio bytes never pass through this hub. */
export class RemoteControlHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  private readonly clients = new Set<Client>();
  private readonly active = new Map<string, Client>();
  private readonly transfers = new Map<string, Transfer>();
  private readonly commands = new Map<string, { controller: Client; target: Client; requestId: string; timer: NodeJS.Timeout }>();
  private readonly interval: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  private readonly upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

  constructor(private readonly app: FastifyInstance, private readonly db: Db, allowedOrigins: string[]) {
    const origins = new Set(allowedOrigins.filter(Boolean).map((value) => new URL(value).origin));
    app.get(PATH, async (_request, reply) => reply.code(426).send({ error: { code: "UPGRADE_REQUIRED", message: "Use a WebSocket connection" } }));
    this.upgrade = (request, socket, head) => {
      socket.on("error", (error) => app.log.warn({ err: error }, "Remote upgrade socket failed"));
      if (request.url?.split("?")[0] !== PATH) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
      }
      const reject = (code: number, message: string) => { socket.end(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
      try {
        if (!request.headers.origin || !origins.has(request.headers.origin)) return reject(403, "Forbidden");
        const sessionId = app.parseCookie(request.headers.cookie || "")[SESSION_COOKIE];
        const user = getSessionUserById(db, sessionId);
        if (!user || !sessionId) return reject(401, "Unauthorized");
        if ([...this.clients].filter((client) => client.userId === user.id).length >= 16) return reject(429, "Too Many Requests");
        this.wss.handleUpgrade(request, socket, head, (ws) => this.connect(ws, user.id, sessionId));
      } catch (error) { app.log.error({ err: error }, "Remote session upgrade failed"); reject(500, "Internal Server Error"); }
    };
    app.server.on("upgrade", this.upgrade);
    this.interval = setInterval(() => {
      for (const client of this.clients) {
        if (!this.authorized(client)) continue;
        if (!client.alive) { client.socket.terminate(); continue; }
        client.alive = false; client.socket.ping();
      }
    }, 15000);
    this.interval.unref();
    this.unsubscribe = subscribeSessionChanges(db, () => { for (const client of this.clients) this.authorized(client); });
    app.addHook("preClose", async () => this.close());
  }
  private authorized(client: Client): boolean {
    try { if (getSessionUserById(this.db, client.sessionId)?.id === client.userId) return true; }
    catch (error) { this.app.log.error({ err: error }, "Could not revalidate remote session"); }
    client.socket.close(4001, "Session expired"); this.remove(client); return false;
  }
  private send(client: Client, payload: object): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    if (client.socket.bufferedAmount > MAX_BUFFERED_BYTES) { client.socket.close(4008, "Slow remote consumer"); return; }
    client.socket.send(JSON.stringify(payload), (error) => {
      if (error) { this.app.log.warn({ err: error }, "Remote message delivery failed"); client.socket.terminate(); }
    });
  }
  private error(client: Client, message: string, requestId?: string): void {
    this.send(client, { type: "ERROR", message, requestId });
  }
  private peers(userId: string): Client[] { return [...this.clients].filter((client) => client.userId === userId && client.deviceId); }
  private broadcast(userId: string): void {
    const devices = this.peers(userId).map((client) => ({
      device_id: client.deviceId, device_name: client.name, device_type: client.kind,
      is_active_player: this.active.get(userId) === client, can_receive: client.ready, ...client.state,
    }));
    for (const client of this.peers(userId)) this.send(client, { type: "DEVICES", devices });
  }
  private connect(socket: WebSocket, userId: string, sessionId: string): void {
    const client: Client = { socket, userId, sessionId, deviceId: null, name: "", kind: "web",
      ready: false, state: { ...emptyState }, alive: true, tokens: 120, refill: Date.now() };
    this.clients.add(client);
    const registration = setTimeout(() => { if (!client.deviceId) socket.close(4000, "Registration timeout"); }, 10000);
    registration.unref();
    socket.on("pong", () => { client.alive = true; });
    socket.on("error", (error) => this.app.log.warn({ err: error }, "Remote socket error"));
    socket.on("close", () => { clearTimeout(registration); this.remove(client); });
    socket.on("message", (bytes, binary) => {
      if (!this.authorized(client)) return;
      const now = Date.now();
      client.tokens = Math.min(120, client.tokens + (now - client.refill) * .06); client.refill = now;
      if (--client.tokens < 0) { socket.close(4008, "Remote command rate exceeded"); return; }
      if (binary) { this.error(client, "Binary messages are not supported"); return; }
      let raw: unknown;
      try { raw = JSON.parse(bytes.toString()); }
      catch { this.error(client, "Malformed remote JSON"); return; }
      const parsed = messageSchema.safeParse(raw);
      if (!parsed.success) { this.error(client, "Invalid remote message"); return; }
      try { this.message(client, parsed.data); }
      catch (error) { this.app.log.error({ err: error }, "Remote command failed"); this.error(client, "Remote command could not be processed"); }
    });
  }
  private message(client: Client, message: Message): void {
    if (message.type === "REGISTER") {
      if (client.deviceId && client.deviceId !== message.device_id) return this.error(client, "Device identity cannot change on an open connection");
      const duplicate = this.peers(client.userId).find((peer) => peer !== client && peer.deviceId === message.device_id);
      if (duplicate) { duplicate.socket.close(4009, "Device reconnected"); this.remove(duplicate); }
      client.deviceId = message.device_id; client.name = message.device_name; client.kind = message.device_type;
      client.ready = message.can_receive; client.state = message.state;
      if (!this.active.has(client.userId) && message.state.current_track) this.active.set(client.userId, client);
      this.broadcast(client.userId); return;
    }
    if (!client.deviceId) return this.error(client, "Register this device first");
    if (message.type === "STATE") {
      client.state = message.state;
      if (message.claim && !this.transfers.has(client.userId)) {
        const old = this.active.get(client.userId);
        if (old && old !== client) this.send(old, { type: "DEACTIVATE" });
        this.active.set(client.userId, client);
      }
      if (!this.active.has(client.userId) && message.state.current_track) this.active.set(client.userId, client);
      this.broadcast(client.userId); return;
    }
    if (message.type === "COMMAND") {
      if (this.transfers.has(client.userId)) return this.error(client, "Playback transfer is in progress", message.requestId);
      const target = message.targetId ? this.peers(client.userId).find((peer) => peer.deviceId === message.targetId) : this.active.get(client.userId);
      if (!target) return this.error(client, "No active player is connected", message.requestId);
      if (target !== this.active.get(client.userId) && message.command.type !== "SET_VOLUME") return this.error(client, "Select the active player first", message.requestId);
      if ([...this.commands.values()].filter((item) => item.controller === client).length >= 64) return this.error(client, "Too many pending commands", message.requestId);
      const commandId = randomUUID();
      const timer = setTimeout(() => {
        this.commands.delete(commandId); this.error(client, "The player did not acknowledge the command", message.requestId);
      }, 8000); timer.unref();
      this.commands.set(commandId, { controller: client, target, requestId: message.requestId, timer });
      this.send(target, { type: "EXECUTE", requestId: commandId, command: message.command }); return;
    }
    if (message.type === "COMMAND_RESULT") {
      const command = this.commands.get(message.requestId);
      if (!command || command.target !== client) return this.error(client, "Unknown command acknowledgement");
      clearTimeout(command.timer); this.commands.delete(message.requestId);
      this.send(command.controller, { type: "COMMAND_RESULT", requestId: command.requestId, ok: message.ok, message: message.message }); return;
    }
    if (message.type === "TRANSFER_PLAYBACK") {
      if (this.transfers.has(client.userId)) return this.error(client, "A playback transfer is already in progress", message.requestId);
      const source = this.active.get(client.userId);
      const target = this.peers(client.userId).find((peer) => peer.deviceId === message.targetId);
      if (!source?.state.current_track || !target || source === target || !target.ready) return this.error(client, "Choose an online device with playback enabled", message.requestId);
      const transfer: Transfer = { id: randomUUID(), requestId: message.requestId, controller: client, source, target,
        stage: "snapshot", timer: setTimeout(() => this.abortTransfer(client.userId, "Playback transfer timed out"), 20000) };
      transfer.timer.unref(); this.transfers.set(client.userId, transfer);
      this.send(source, { type: "REQUEST_SNAPSHOT", transferId: transfer.id }); return;
    }
    const transfer = this.transfers.get(client.userId);
    if (!transfer || transfer.id !== message.transferId) return this.error(client, "Stale playback transfer");
    if (message.type === "TRANSFER_FAILED") {
      if (client !== transfer.target && client !== transfer.source) return this.error(client, "Not a participant in this transfer");
      // Target reports failure only after pausing itself; a missing/disconnected target is not proof of silence.
      this.abortTransfer(client.userId, message.message, client === transfer.target && transfer.stage === "start"); return;
    }
    if (message.type === "SNAPSHOT" && client === transfer.source && transfer.stage === "snapshot") {
      transfer.snapshot = message.snapshot; transfer.stage = "prepare";
      this.send(transfer.target, { type: "INITIALIZE_PLAYER", transferId: transfer.id, snapshot: message.snapshot }); return;
    }
    if (message.type === "READY" && client === transfer.target && transfer.stage === "prepare") {
      transfer.stage = "pause"; this.send(transfer.source, { type: "PAUSE_FOR_TRANSFER", transferId: transfer.id }); return;
    }
    if (message.type === "SOURCE_PAUSED" && client === transfer.source && transfer.stage === "pause") {
      const previous = transfer.snapshot;
      transfer.snapshot = message.snapshot;
      if (!previous || JSON.stringify(message.snapshot.queueState) !== JSON.stringify(previous.queueState) ||
          message.snapshot.trackId !== previous.trackId) return this.abortTransfer(client.userId, "The source queue changed during transfer", true);
      transfer.snapshot = message.snapshot; transfer.stage = "start";
      this.send(transfer.target, { type: "START_TRANSFER", transferId: transfer.id, snapshot: message.snapshot }); return;
    }
    if (message.type === "STARTED" && client === transfer.target && transfer.stage === "start" && transfer.snapshot) {
      clearTimeout(transfer.timer); this.transfers.delete(client.userId);
      this.active.set(client.userId, transfer.target);
      transfer.source.state = { ...transfer.source.state, playing: false };
      const snapshot = transfer.snapshot;
      const entry = snapshot.queueState.entries[snapshot.queueState.index];
      transfer.target.state = { current_track: { id: snapshot.trackId, title: entry.title },
        position_ms: snapshot.exactPositionMs,
        duration_ms: transfer.target.state.duration_ms || transfer.source.state.duration_ms,
        playing: snapshot.playing, volume: snapshot.volume };
      this.send(transfer.source, { type: "TRANSFER_COMPLETE", transferId: transfer.id });
      this.send(transfer.target, { type: "TRANSFER_COMPLETE", transferId: transfer.id });
      this.send(transfer.controller, { type: "TRANSFER_RESULT", requestId: transfer.requestId, ok: true });
      this.broadcast(client.userId); return;
    }
    this.error(client, "Unexpected playback transfer acknowledgement");
  }
  private abortTransfer(userId: string, message: string, resumeSource = false): void {
    const transfer = this.transfers.get(userId);
    if (!transfer) return;
    clearTimeout(transfer.timer); this.transfers.delete(userId);
    this.send(transfer.target, { type: "ABORT_TRANSFER", transferId: transfer.id });
    this.send(transfer.source, { type: "ABORT_TRANSFER", transferId: transfer.id, resume: resumeSource && transfer.snapshot?.playing });
    const detail = !resumeSource && (transfer.stage === "pause" || transfer.stage === "start")
      ? `${message}. Check both devices and resume manually if needed.` : message;
    this.send(transfer.controller, { type: "TRANSFER_RESULT", requestId: transfer.requestId, ok: false, message: detail });
  }
  private remove(client: Client): void {
    if (!this.clients.delete(client)) return;
    const transfer = this.transfers.get(client.userId);
    if (transfer && [transfer.source, transfer.target, transfer.controller].includes(client)) {
      this.abortTransfer(client.userId, "A participating device disconnected. Playback may need to be resumed manually.");
    }
    for (const [id, command] of this.commands) {
      if (command.controller !== client && command.target !== client) continue;
      clearTimeout(command.timer); this.commands.delete(id);
      if (command.controller !== client) this.error(command.controller, "The player disconnected", command.requestId);
    }
    if (this.active.get(client.userId) === client) this.active.delete(client.userId);
    this.broadcast(client.userId);
  }
  close(): void {
    clearInterval(this.interval); this.unsubscribe(); this.app.server.off("upgrade", this.upgrade);
    for (const transfer of this.transfers.values()) clearTimeout(transfer.timer);
    this.transfers.clear();
    for (const command of this.commands.values()) clearTimeout(command.timer);
    this.commands.clear();
    for (const client of this.clients) client.socket.terminate();
    this.clients.clear(); this.active.clear(); this.wss.close();
  }
}
