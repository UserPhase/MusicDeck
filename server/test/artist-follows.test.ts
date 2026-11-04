import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { ArtistFollowService } from "../src/services/ArtistFollowService.js";
import { TaskManager } from "../src/services/TaskManager.js";
import { createNewReleaseScannerRunner, enqueueReleaseScan, scheduleReleaseScans } from "../src/tasks/runners/newReleaseScannerRunner.js";
import { ExternalArtworkTokenStore } from "../src/domain/external-catalog.js";
import { PrivacyManager } from "../src/services/PrivacyManager.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let db: Database.Database, now: number;
const cleanups: (() => void | Promise<void>)[] = [];
const album = (id = 101, extra: Record<string, unknown> = {}) => ({ wrapperType: "collection", collectionId: id,
  collectionName: "A New Beginning", artistId: 17, artistName: "Artist One", releaseDate: "2026-10-25T00:00:00Z", trackCount: 12,
  artworkUrl100: "https://is1-ssl.mzstatic.com/image/100x100bb.jpg", collectionViewUrl: `https://music.apple.com/us/album/${id}`, ...extra });
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const transport = () => vi.fn<typeof fetch>(async input => {
  const url = new URL(String(input));
  if (url.pathname === "/search") return json({ results: [{ artistId: 17, artistName: "Artist One" }] });
  return json({ results: [album()] });
});
const follow = (service: ArtistFollowService, owner = "alice") => service.follow(owner, { artistId: "external_itunes_artist_17", artistName: "Artist One", provider: "itunes" });
const context = (signal = new AbortController().signal) => ({ signal, checkpoint: vi.fn(async () => signal.throwIfAborted()),
  throwIfCancelled: () => signal.throwIfAborted(), report: vi.fn() });
beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); runMigrations(db); now = Date.parse("2026-11-02T12:00:00Z");
  db.exec(`INSERT INTO roles VALUES('user','Listener'); INSERT INTO users(id,username,password_hash,display_name,role,created_at,updated_at)
    VALUES('alice','alice','unused','Alice','user','2026','2026'),('bob','bob','unused','Bob','user','2026','2026')`);
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); db.close(); vi.restoreAllMocks(); });

test("follows are explicit, idempotent, per-account, and never create imports", async () => {
  const fetchImpl = transport(), service = new ArtistFollowService(db, { fetchImpl, now: () => now, requestIntervalMs: 0 });
  expect(service.list("alice")).toEqual([]); expect(fetchImpl).not.toHaveBeenCalled();
  const first = follow(service); follow(service);
  service.follow("alice", { artistId: "17", artistName: "Artist One", provider: "itunes" });
  expect(service.list("alice")).toHaveLength(1); expect(service.list("bob")).toEqual([]);
  await service.scan(context()); expect(service.feed("alice").releases).toHaveLength(1);
  expect(service.feed("bob").releases).toEqual([]); expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT COUNT(*) AS n FROM acquisition_jobs").get()).toEqual({ n: 0 });
  service.unfollow("bob", first.key); expect(service.list("alice")).toHaveLength(1);
  service.unfollow("alice", first.key); expect(service.feed("alice").releases).toEqual([]);
  expect(db.pragma("foreign_key_check")).toEqual([]);
});

test("30-day feed rejects future/old/foreign-artist releases and deduplicates before pagination", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => json({ results: [album(), album(), album(102, { collectionName: "Fresh - EP" }),
    album(103, { releaseDate: "2026-09-01" }), album(104, { releaseDate: "2026-12-01" }), album(105, { artistId: 19 }), album(106, { releaseDate: "bad" })] }));
  const service = new ArtistFollowService(db, { fetchImpl, now: () => now, requestIntervalMs: 0 }); follow(service);
  await service.scan(context()); const feed = service.feed("alice", 0, 1);
  expect(feed.releases).toHaveLength(1); expect(feed.hasMore).toBe(true);
  expect(service.feed("alice", 1, 1).releases).toHaveLength(1); expect(service.feed("alice", 1, 1).hasMore).toBe(false);
  expect(service.feed("alice").releases.map(r => r.albumType).sort()).toEqual(["Album", "EP"]);
  now += 40 * 86400_000; expect(service.feed("alice").releases).toEqual([]);
});

test("shared caches survive service restart and prevent repeated requests across users", async () => {
  const fetchImpl = transport(), opts = { fetchImpl, now: () => now, requestIntervalMs: 0 };
  const first = new ArtistFollowService(db, opts); follow(first); await first.scan(context());
  const restarted = new ArtistFollowService(db, opts); follow(restarted, "bob"); await restarted.scan(context());
  expect(fetchImpl).toHaveBeenCalledTimes(1); expect(restarted.feed("bob").releases).toHaveLength(1);
  now += 6 * 3600_000; await restarted.scan(context()); expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test("rate-limit Retry-After persists and a later failure preserves cached releases", async () => {
  const fetchImpl = transport(), service = new ArtistFollowService(db, { fetchImpl, now: () => now, requestIntervalMs: 0 }); follow(service);
  await service.scan(context()); now += 6 * 3600_000;
  fetchImpl.mockImplementation(async () => json({}, 429, { "retry-after": "7200" }));
  await service.scan(context()); expect(service.feed("alice").releases).toHaveLength(1);
  expect(service.list("alice")[0].error).toContain("temporarily unavailable");
  expect(Date.parse(service.list("alice")[0].nextScanAt)).toBe(now + 7200_000);
  const restarted = new ArtistFollowService(db, { fetchImpl, now: () => now, requestIntervalMs: 0 });
  await restarted.scan(context()); expect(fetchImpl).toHaveBeenCalledTimes(2);
  const extra = restarted.follow("bob", { artistId: "18", artistName: "Another Artist", provider: "itunes" });
  await restarted.scan(context()); expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(restarted.list("bob").find(r => r.key === extra.key)?.error).toContain("cooling down");
});

test("library names require a unique exact identity; ambiguous search never leaks a homonym's releases", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => json({ results: [{ artistId: 17, artistName: "Artist One" }, { artistId: 18, artistName: "Artist One" }] }));
  const service = new ArtistFollowService(db, { fetchImpl, now: () => now, requestIntervalMs: 0 });
  service.follow("alice", { artistId: "md_artist", artistName: "Artist One", provider: "library" }); await service.scan(context());
  expect(service.feed("alice").releases).toEqual([]); expect(service.list("alice")[0].error).toContain("ambiguous"); expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("unique library artist resolution is cached and request pacing is applied across scan requests", async () => {
  const at: number[] = [], fetchImpl = transport(); fetchImpl.mockImplementation(async input => {
    at.push(Date.now()); return String(input).includes("/search") ? json({ results: [{ artistId: 17, artistName: "Artist One" }] }) : json({ results: [album()] });
  });
  const service = new ArtistFollowService(db, { fetchImpl, requestIntervalMs: 40 });
  service.follow("alice", { artistId: "md_artist", artistName: "Artist One", provider: "library" }); await service.scan(context());
  expect(at).toHaveLength(2); expect(at[1] - at[0]).toBeGreaterThanOrEqual(30);
  expect(db.prepare("SELECT resolved_id FROM followed_artist_catalog").get()).toEqual({ resolved_id: "17" });
});

test("Deezer metadata honors provider IDs, handles API-level failures and infers explicit release types", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async input => String(input).includes("/albums") ? json({ data: [
    { id: 40, title: "Tiny Record", record_type: "single", release_date: "2026-11-01", cover_big: "https://e-cdns-images.dzcdn.net/images/cover.jpg", link: "https://www.deezer.com/album/40" },
  ] }) : json({ id: 18, name: "True Artist" }));
  const artwork = new ExternalArtworkTokenStore(), service = new ArtistFollowService(db, { fetchImpl, artwork, now: () => now, requestIntervalMs: 0 });
  service.follow("alice", { artistId: "18", artistName: "Unverified Label", provider: "deezer" }); await service.scan(context());
  expect(service.feed("alice").releases[0]).toMatchObject({ artist: "True Artist", albumType: "Single", id: "external_deezer_album_40" });
  expect(service.feed("alice").releases[0].coverUrl).toMatch(/^\/api\/artwork\/external\//);
  now += 6 * 3600_000; fetchImpl.mockImplementation(async () => json({ error: { code: 4, message: "Quota" } })); await service.scan(context());
  expect(service.list("alice")[0].error).toContain("rejected"); expect(service.feed("alice").releases).toHaveLength(1);
});

test("cancelled scans release their durable lease without corrupting cache or swallowing cancellation", async () => {
  const controller = new AbortController(), fetchImpl = vi.fn<typeof fetch>(async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); });
  const service = new ArtistFollowService(db, { fetchImpl, now: () => now, requestIntervalMs: 0 }); follow(service);
  await expect(service.scan(context(controller.signal))).rejects.toThrow();
  expect(db.prepare("SELECT lease_until,failures FROM followed_artist_catalog").get()).toEqual({ lease_until: 0, failures: 0 });
  expect(service.feed("alice").releases).toEqual([]);
});

test("Local Only Mode blocks scanner egress, retains follows, and surfaces actionable diagnostics", async () => {
  const native = transport(), privacy = new PrivacyManager(db, true);
  const service = new ArtistFollowService(db, { fetchImpl: (input, init) => privacy.fetch(input, init, native, "metadata"), now: () => now, requestIntervalMs: 0 });
  follow(service); await service.scan(context()); expect(native).not.toHaveBeenCalled();
  expect(service.list("alice")[0].error).toBeTruthy(); expect(service.feed("alice").releases).toEqual([]);
});

test("runner is low priority, deduplicates, schedules durably, and yields while media streams are active", async () => {
  const fetchImpl = transport(), service = new ArtistFollowService(db, { fetchImpl, now: () => now, requestIntervalMs: 0 }); follow(service);
  const tasks = new TaskManager(db, { maxConcurrent: 1, minFreeMemoryBytes: 0, maxCpuLoadPerCore: 100 }); cleanups.push(() => tasks.close());
  tasks.register("NEW_RELEASES_SCAN", createNewReleaseScannerRunner(service)); const release = tasks.acquireMediaStream();
  scheduleReleaseScans(tasks); const id = enqueueReleaseScan(tasks); expect(enqueueReleaseScan(tasks)).toBe(id);
  expect(tasks.get(id)).toMatchObject({ state: "QUEUED", priority: 50 }); expect(fetchImpl).not.toHaveBeenCalled();
  expect(tasks.listSchedules()).toMatchObject([{ type: "NEW_RELEASES_SCAN", expression: "17 * * * *" }]);
  release(); expect((await tasks.waitForSettlement(id)).state).toBe("FINISHED"); expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("task schema upgrade preserves existing jobs, schedule IDs, and diagnostic log foreign keys", async () => {
  const first = new TaskManager(db); await first.close();
  db.exec(`INSERT INTO background_tasks(id,type,state,priority,payload_json,progress_json,created_by,created_at,updated_at)
    VALUES('old','LIBRARY_SCAN','FINISHED',200,'{}','{}','admin','2026','2026');
    INSERT INTO background_task_logs(task_id,at,source,message) VALUES('old','2026','progress','Keep this log');`);
  // Rebuild a genuine pre-release CHECK constraint with a child log table.
  const taskSchema = (db.prepare("SELECT sql FROM sqlite_master WHERE name='background_tasks'").get() as { sql: string }).sql;
  db.exec("CREATE TEMP TABLE old_logs AS SELECT * FROM background_task_logs; DROP TABLE background_task_logs;");
  db.exec(taskSchema.replace("background_tasks", "tasks_old").replace(",'NEW_RELEASES_SCAN'", ""));
  db.exec(`INSERT INTO tasks_old SELECT * FROM background_tasks; DROP TABLE background_tasks; ALTER TABLE tasks_old RENAME TO background_tasks;
    CREATE TABLE background_task_logs(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES background_tasks(id) ON DELETE CASCADE,at TEXT,source TEXT,message TEXT);
    INSERT INTO background_task_logs SELECT * FROM old_logs; DROP TABLE old_logs;`);
  const second = new TaskManager(db); cleanups.push(() => second.close());
  expect(second.get("old")?.state).toBe("FINISHED"); expect(second.diagnostics("old")[0].message).toBe("Keep this log");
  expect(db.pragma("foreign_key_check")).toEqual([]);
  second.register("NEW_RELEASES_SCAN", createNewReleaseScannerRunner(new ArtistFollowService(db)));
  expect((await second.waitForSettlement(enqueueReleaseScan(second))).state).toBe("FINISHED");
});

test("authenticated routes enforce account ownership, persist follows, and register the real scanner", async () => {
  const fixture = await createTestServer(undefined, {}, undefined, transport());
  cleanups.push(() => closeTestServer(fixture.app, fixture.db));
  const { cookie } = await login(fixture.app), headers = { cookie };
  // Login returns the server session owner; do not accept a body-selected account.
  const owner = fixture.db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  const payload = { ownerId: owner.id, artistId: "external_itunes_artist_17", artistName: "Artist One", provider: "itunes" };
  expect((await fixture.app.inject({ url: "/api/v1/new-releases" })).statusCode).toBe(401);
  expect((await fixture.app.inject({ method: "POST", url: "/api/v1/artist-follows", headers, payload: { ...payload, ownerId: "bob" } })).statusCode).toBe(409);
  const added = await fixture.app.inject({ method: "POST", url: "/api/v1/artist-follows", headers, payload }); expect(added.statusCode).toBe(201);
  await vi.waitFor(async () => { const feed = await fixture.app.inject({ url: "/api/v1/new-releases", headers }); expect(feed.json().releases).toHaveLength(1); });
  const removed = await fixture.app.inject({ method: "DELETE", url: `/api/v1/artist-follows/${added.json().artist.key}`, headers, payload: { ownerId: owner.id } });
  expect(removed.statusCode).toBe(204); expect((await fixture.app.inject({ url: "/api/v1/new-releases", headers })).json().releases).toEqual([]);
  expect((await fixture.app.inject({ url: "/api/v1/new-releases?limit=99999", headers })).statusCode).toBe(400);
});
