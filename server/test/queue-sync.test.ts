import Database from "better-sqlite3";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { beforeEach, afterEach, test, expect } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { LibraryService } from "../src/domain/library.js";
import { createSession } from "../src/auth/sessions.js";
import { registerQueueSessionRoutes } from "../src/routes/queue-session.js";
import { QueueSyncService, QueueSyncError, type QueueCheckpoint } from "../src/services/QueueSyncService.js";
let db: Database.Database, service: QueueSyncService, now: number;
const content = (count = 5000) => ({ version: 2 as const, entries: Array.from({ length: count }, (_, i) => ({ entryId: `q${i}`, track: { id: `track-${i % 3}`, title: `Occurrence ${i}`, excludeFromTaste: true } })) });
const checkpoint = (index = 4999): QueueCheckpoint => ({ index, position: 42.875, repeatOne: false, shuffle: true, shuffleSeed: 0, shuffleMode: "smart", albumAware: true, volume: 0.35, wasPlaying: false, context: null, capturedAt: now });
beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); runMigrations(db); now = Date.now();
  db.exec("INSERT INTO roles VALUES('user','Listener')");
  for (const id of ["alice", "bob"]) db.prepare("INSERT INTO users(id,username,password_hash,display_name,role,created_at,updated_at) VALUES(?,?,'unused',?,'user','2026','2026')").run(id, id, id);
  for (let i = 0; i < 3; i++) {
    db.prepare("INSERT INTO library_items(id,type,created_at,updated_at) VALUES(?,'track','2026','2026')").run(`track-${i}`);
    db.prepare("INSERT INTO library_item_sources(library_item_id,item_type,connection_id,provider_item_id,created_at) VALUES(?,'track','nav',?,'2026')").run(`track-${i}`, `provider-${i}`);
  }
  service = new QueueSyncService(db, new LibraryService(db), () => now);
});
afterEach(() => db.close());
test("10,000 occurrences survive compression and separate checkpoints without truncation", async () => {
  const original = content(10_000), stored = await service.storeContent("alice", original);
  expect(stored.trackCount).toBe(10_000); expect(await service.content("alice", stored.contentId)).toEqual(original);
  expect(await service.storeContent("alice", original)).toEqual(stored);
  service.saveSession("alice", "desktop", "Desktop", stored.contentId, checkpoint(9999), 1);
  now++; service.saveSession("alice", "desktop", "Desktop", stored.contentId, { ...checkpoint(9999), position: 81.125 }, 2);
  expect(service.sessions("alice")[0]).toMatchObject({ trackCount: 10_000, checkpoint: { index: 9999, position: 81.125, shuffleSeed: 0 } });
  expect(db.prepare("SELECT COUNT(*) AS n FROM queue_contents").get()).toEqual({ n: 1 });
  expect(service.saveSession("alice", "desktop", "Desktop", stored.contentId, checkpoint(0), 1)).toMatchObject({ saved: false });
  expect(() => service.saveSession("alice", "desktop", "Desktop", stored.contentId, checkpoint(10_000), 3)).toThrow("index");
});
test("named queues are private, idempotent, revision checked and retained during pruning", async () => {
  const { contentId } = await service.storeContent("alice", content());
  const named = service.saveNamed("alice", "Late night", contentId, checkpoint(), "operation");
  expect(service.saveNamed("alice", "Late night", contentId, checkpoint(), "operation")).toEqual(named);
  expect(() => service.saveNamed("alice", "Different", contentId, checkpoint(), "operation")).toThrow("another");
  expect(service.named("bob")).toEqual([]); await expect(service.content("bob", contentId)).rejects.toMatchObject({ statusCode: 404 });
  expect(() => service.removeNamed("bob", named.id, 1)).toThrow(); expect(() => service.removeNamed("alice", named.id, 2)).toThrow();
  service.saveSession("alice", "desktop", "Desktop", contentId, checkpoint(), 1);
  now += 31 * 86400_000; service.prune(); expect(service.sessions("alice")).toEqual([]);
  expect((await service.content("alice", contentId)).entries).toHaveLength(5000);
  service.removeNamed("alice", named.id, 0); service.prune(); await expect(service.content("alice", contentId)).rejects.toThrow("unavailable");
});
test("saving a 5,000-entry queue as a private playlist preserves every duplicate and attribution", async () => {
  const { contentId } = await service.storeContent("alice", content());
  const result = await service.saveAsPlaylist("alice", "Road trip", contentId, "save-one");
  expect(await service.saveAsPlaylist("alice", "Road trip", contentId, "save-one")).toEqual(result);
  const items = db.prepare("SELECT position,library_track_id,added_by_user_id FROM playlist_items WHERE playlist_id=? ORDER BY position").all(result.playlistId);
  expect(items).toHaveLength(5000); expect(items[4999]).toEqual({ position: 4999, library_track_id: "track-1", added_by_user_id: "alice" });
  expect(db.prepare("SELECT owner_user_id,sharing_mode FROM playlists WHERE id=?").get(result.playlistId)).toEqual({ owner_user_id: "alice", sharing_mode: "PRIVATE" });
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
test("a missing library track rolls back the entire playlist; discovery items remain metadata only", async () => {
  const invalid = content(4); invalid.entries[3].track.id = "missing";
  const saved = await service.storeContent("alice", invalid);
  await expect(service.saveAsPlaylist("alice", "Invalid", saved.contentId, "bad")).rejects.toMatchObject({ statusCode: 409 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM playlists").get()).toEqual({ n: 0 }); expect(db.prepare("SELECT COUNT(*) AS n FROM playlist_items").get()).toEqual({ n: 0 });
  const external = await service.storeContent("alice", { version: 2, entries: [{ entryId: "x", track: { id: "external_new", external: true, title: "Discovery", artist: "Artist" } }] });
  const list = await service.saveAsPlaylist("alice", "Discoveries", external.contentId, "external");
  const row = db.prepare("SELECT external_track_json,library_track_id FROM playlist_items WHERE playlist_id=?").get(list.playlistId) as { external_track_json: string; library_track_id: null };
  expect(row.library_track_id).toBeNull(); expect(JSON.parse(row.external_track_json)).toMatchObject({ title: "Discovery", streamUrl: "", external: true });
});
test("invalid content, duplicate occurrences, unsafe URLs, corruption, and device limits fail explicitly", async () => {
  const duplicate = content(2); duplicate.entries[1].entryId = "q0";
  await expect(service.storeContent("alice", duplicate)).rejects.toMatchObject({ statusCode: 400 });
  await expect(service.storeContent("alice", { version: 2, entries: [{ entryId: "x", track: { id: "x", previewUrl: "https://evil.test/stream" } }] })).rejects.toThrow("invalid");
  const { contentId } = await service.storeContent("alice", content(1));
  for (let i = 0; i < 12; i++) service.saveSession("alice", `device-${i}`, "Desktop", contentId, checkpoint(0), 1);
  expect(() => service.saveSession("alice", "extra", "Desktop", contentId, checkpoint(0), 1)).toThrow("12 recent");
  db.prepare("UPDATE queue_contents SET compressed=? WHERE user_id='alice'").run(Buffer.from("corrupt"));
  await expect(service.content("alice", contentId)).rejects.toMatchObject({ statusCode: 409 });
});
test("HTTP queue endpoints enforce authentication, account ownership and content isolation", async () => {
  const app = Fastify(); await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof QueueSyncError ? error.statusCode : 500).send({ error: { message: error.message } }));
  registerQueueSessionRoutes(app, db, new LibraryService(db));
  const alice = { cookie: `musicdeck_session=${createSession(db, "alice").id}` }, bob = { cookie: `musicdeck_session=${createSession(db, "bob").id}` };
  const base = "/api/v1/user/queue-session";
  try {
    expect((await app.inject({ url: base })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `${base}/content?ownerId=bob`, headers: alice, payload: content(1) })).statusCode).toBe(409);
    const upload = await app.inject({ method: "POST", url: `${base}/content?ownerId=alice`, headers: alice, payload: content(600) });
    expect(upload.statusCode).toBe(200); const { contentId } = upload.json();
    expect((await app.inject({ url: `${base}/content/${contentId}`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: base, headers: bob, payload: { ownerId: "alice", deviceId: "desktop", deviceName: "Desktop", contentId, checkpoint: checkpoint(599), sequence: 1 } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: base, headers: alice, payload: { ownerId: "alice", deviceId: "desktop", deviceName: "Desktop", contentId, checkpoint: checkpoint(599), sequence: 1 } })).statusCode).toBe(200);
    const summary = await app.inject({ url: base, headers: alice }); expect(summary.headers["cache-control"]).toContain("no-store"); expect(summary.json().sessions[0].trackCount).toBe(600);
    expect((await app.inject({ url: base, headers: bob })).json()).toEqual({ sessions: [], namedQueues: [] });
  } finally { await app.close(); }
});
