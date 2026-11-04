import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../src/db/migrations.js";
import { recordPlayback, type PlaybackEvent } from "../src/domain/listening-activity.js";
import { PrivacyManager } from "../src/services/PrivacyManager.js";
import { ScrobbleQueueService } from "../src/services/scrobble/ScrobbleQueueService.js";

let db: Database.Database, privacy: PrivacyManager, now: number;
const services: ScrobbleQueueService[] = [];
const temporary: string[] = [];
const ok = () => new Response('{"status":"ok"}');
const transport = (submit: (init?: RequestInit) => Promise<Response> = async () => ok(), username = "listener"): typeof fetch =>
  vi.fn(async (url, init) => String(url).includes("validate-token")
    ? new Response(JSON.stringify({ valid: true, user_name: username })) : submit(init));
function service(fetchImpl: typeof fetch) {
  const worker = new ScrobbleQueueService(db, privacy, { fetchImpl, now: () => now, random: () => 0 });
  services.push(worker); return worker;
}
function seed(database: Database.Database) {
  database.pragma("foreign_keys=ON"); runMigrations(database);
  database.exec(`INSERT INTO roles VALUES ('user','User');
    INSERT INTO users(id,username,password_hash,display_name,role,created_at,updated_at)
    VALUES ('user-1','one','hash','One','user','2026-01-01','2026-01-01'),('user-2','two','hash','Two','user','2026-01-01','2026-01-01');`);
  for (const provider of ["listenbrainz", "lastfm"]) database.prepare("INSERT INTO plugin_configs VALUES (?,1,?,'[\"history.read\",\"network.request\"]','2026-01-01')")
    .run(provider, JSON.stringify(provider === "lastfm" ? { apiKey: "api-key", apiSecret: "api-secret" } : {}));
}
beforeEach(() => { now = Date.parse("2026-11-01T12:00:00Z"); db = new Database(":memory:"); seed(db); privacy = new PrivacyManager(db); });
afterEach(async () => {
  for (const worker of services.splice(0)) await worker.close();
  if (db.open) db.close();
  for (const directory of temporary.splice(0)) {
    const resolved = path.resolve(directory), root = path.resolve(os.tmpdir());
    if (!resolved.startsWith(root + path.sep) || !path.basename(resolved).startsWith("scrobble-test-")) throw new Error("Unexpected test directory");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
function event(id = "session-00000001", seconds = 100, duration = 180, started = now - 100_000): PlaybackEvent {
  return { playbackSessionId: id, trackId: "track-1", startedAt: new Date(started).toISOString(), listenedSeconds: seconds,
    durationSeconds: duration, finished: false, track: { title: "Song", artist: "Artist", album: "Album" } };
}
function report(worker: ScrobbleQueueService, input = event(), userId = "user-1") {
  return recordPlayback(db, userId, input, now, (id, seconds, duration) => worker.enqueuePlayback(userId, id, input, seconds, duration));
}
async function connect(worker: ScrobbleQueueService, userId = "user-1") {
  await worker.connectListenBrainz(userId, "private-user-token"); now += 200_000;
}
const jobs = () => db.prepare("SELECT * FROM scrobble_queue ORDER BY listened_at,id").all() as any[];

test("retries with exponential backoff, deduplicates cumulative reports, and preserves the original timestamp", async () => {
  let failures = true;
  const sent: any[] = [];
  const worker = service(transport(async (init) => { sent.push(JSON.parse(String(init?.body))); if (failures) throw new Error("offline"); return ok(); }));
  await connect(worker);
  const input = event(); report(worker, input); report(worker, { ...input, listenedSeconds: 110 });
  expect(jobs()).toHaveLength(1); const original = jobs()[0].listened_at;
  await worker.drain(); expect(jobs()[0]).toMatchObject({ state: "pending", attempts: 1, next_attempt_at: now + 30_000 });
  await worker.drain(); expect(sent).toHaveLength(1);
  now += 30_000; await worker.drain(); expect(jobs()[0]).toMatchObject({ attempts: 2, next_attempt_at: now + 60_000 });
  failures = false; now += 60_000; await worker.drain();
  expect(jobs()[0].state).toBe("sent");
  expect(sent.map((body) => body.payload[0].listened_at)).toEqual([original, original, original]);
  expect(worker.statuses("user-1")[1]).toMatchObject({ pending: 0, lastListenedAt: new Date(original * 1000).toISOString() });
  expect(JSON.stringify(worker.statuses("user-1"))).not.toContain("private-user-token");
  expect(jobs()[0].payload_json).not.toContain("private-user-token");
  report(worker, input); await worker.drain(); expect(sent).toHaveLength(3);
  report(worker, { ...input, track: { ...input.track, title: "Corrected title" } });
  await worker.drain(); expect(sent).toHaveLength(3); // same playback event remains idempotent after metadata edits
});
test("queues separately for each user and rejects pre-consent plays and unqualified listens", async () => {
  const fetchImpl = transport(), worker = service(fetchImpl);
  const beforeConnection = now - 1000;
  await connect(worker);
  report(worker, event("before-consent", 100, 180, beforeConnection));
  report(worker, event("short-session-1", 20));
  report(worker, event("other-user-0001"), "user-2");
  expect(jobs()).toHaveLength(0);
  report(worker); expect(jobs()).toHaveLength(1);
  expect(worker.statuses("user-2")[1].pending).toBe(0);
  db.prepare("UPDATE users SET disabled=1 WHERE id='user-1'").run();
  await worker.drain(); expect(fetchImpl).toHaveBeenCalledTimes(1); // credential validation only
});
test("the listening event and outbox roll back together on storage failure", async () => {
  const worker = service(transport()); await connect(worker);
  expect(() => recordPlayback(db, "user-1", event(), now, (id, seconds, duration) => {
    worker.enqueuePlayback("user-1", id, event(), seconds, duration); throw new Error("simulated disk failure");
  })).toThrow("simulated disk failure");
  expect(jobs()).toHaveLength(0);
  expect(db.prepare("SELECT COUNT(*) AS count FROM listening_events").get()).toEqual({ count: 0 });
});
test("SQLite outbox survives closing and reopening the database", async () => {
  db.close(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scrobble-test-")); temporary.push(directory);
  const filename = path.join(directory, "queue.sqlite"); db = new Database(filename); seed(db); privacy = new PrivacyManager(db);
  const first = service(transport(async () => { throw new Error("offline"); })); await connect(first); report(first);
  await first.drain(); await first.close(); db.close();
  db = new Database(filename); db.pragma("foreign_keys=ON"); privacy = new PrivacyManager(db); now += 30_000;
  const next = service(transport()); await next.drain(); expect(jobs()[0]).toMatchObject({ state: "sent", attempts: 1 });
});
test("authentication errors block the account until it is successfully tested or reconnected", async () => {
  let rejected = true;
  const worker = service(transport(async () => rejected ? new Response('{}', { status: 401 }) : ok()));
  await connect(worker); report(worker); await worker.drain();
  expect(jobs()[0].state).toBe("blocked");
  expect(worker.statuses("user-1")[1].status).toBe("auth-error");
  expect(() => worker.retry("user-1", "listenbrainz")).toThrow("Reconnect");
  rejected = false; await worker.testConnection("user-1", "listenbrainz"); await worker.drain();
  expect(jobs()[0].state).toBe("sent");
});
test("account changes cancel old submissions and disconnect erases stored credentials", async () => {
  let remoteName = "first-account";
  const fetchImpl: typeof fetch = vi.fn(async (url) => new Response(JSON.stringify(String(url).includes("validate-token") ? { valid: true, user_name: remoteName } : { status: "ok" })));
  const worker = service(fetchImpl); await connect(worker); report(worker);
  remoteName = "second-account"; await worker.connectListenBrainz("user-1", "new-user-token"); await worker.drain();
  expect(jobs()[0].state).toBe("cancelled"); expect(fetchImpl).toHaveBeenCalledTimes(2);
  now += 200_000; report(worker, event("new-account-session"));
  await worker.disconnect("user-1", "listenbrainz");
  expect(jobs().every((job) => job.state === "cancelled")).toBe(true);
  expect(db.prepare("SELECT enabled,credentials_json FROM scrobble_connections").get()).toEqual({ enabled: 0, credentials_json: "{}" });
});
test("preserves chronological retry ordering while allowing other accounts to progress", async () => {
  const bodyTimes: number[] = [];
  let rejectFirst = true;
  const worker = service(transport(async (init) => {
    const time = JSON.parse(String(init?.body)).payload[0].listened_at; bodyTimes.push(time);
    if (rejectFirst) { rejectFirst = false; return new Response('{}', { status: 429, headers: { "retry-after": "120" } }); } return ok();
  }));
  await connect(worker); await worker.connectListenBrainz("user-2", "other-user-token"); now += 200_000;
  report(worker, event("oldest-session-01", 100, 180, now - 150_000));
  report(worker, event("second-session-01", 100, 180, now - 100_000));
  report(worker, event("other-session-001", 100, 180, now - 100_000), "user-2");
  await worker.drain(); expect(bodyTimes).toHaveLength(2);
  expect(jobs().filter((job) => job.user_id === "user-1").map((job) => job.state)).toEqual(["pending", "pending"]);
  worker.retry("user-1", "listenbrainz"); await worker.drain(); expect(bodyTimes).toHaveLength(2);
  now += 120_000; await worker.drain(); expect(bodyTimes.slice(2)).toEqual(jobs().filter((job) => job.user_id === "user-1").map((job) => job.listened_at));
});
test("privacy changes stop an in-flight submission and never queue plays made while sharing is disabled", async () => {
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  const worker = service(transport(async (init) => { entered(); return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); }));
  await connect(worker); report(worker); const running = worker.drain(); await started;
  await privacy.update({ localOnly: true, allowMetadata: true, allowImports: true, allowArtwork: true });
  await running; expect(jobs()[0]).toMatchObject({ state: "pending", attempts: 0 });
  now += 200_000; report(worker, event("private-session-01")); expect(jobs()).toHaveLength(1);
});
test("two workers cannot claim a live lease and shutdown releases it without losing the listen", async () => {
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  const worker = service(transport(async (init) => { entered(); return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("closed")), { once: true })); }));
  await connect(worker); report(worker); const running = worker.drain(); await started;
  const secondTransport = transport(), second = service(secondTransport);
  await second.drain(); expect(secondTransport).not.toHaveBeenCalled();
  await worker.close(); await running; expect(jobs()[0]).toMatchObject({ state: "pending", attempts: 0 });
  now += 15_000; await second.drain(); expect(jobs()[0].state).toBe("sent");
});
test("expired leases are recovered and a stale worker cannot acknowledge the replacement lease", async () => {
  let entered!: () => void, finish!: (response: Response) => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const first = service(transport(async () => { entered(); return new Promise<Response>((resolve) => { finish = resolve; }); }));
  await connect(first); report(first); const running = first.drain(); await started;
  const second = service(transport()); now += 60_001; await second.drain();
  const deliveredAt = jobs()[0].delivered_at;
  now += 1000; finish(ok()); await running;
  expect(jobs()[0]).toMatchObject({ state: "sent", delivered_at: deliveredAt });
});
test("permanent and ignored errors are inspectable without reporting a success", async () => {
  const worker = service(transport(async () => new Response('{"error":"invalid metadata","code":400}')));
  await connect(worker); report(worker); await worker.drain();
  expect(jobs()[0].state).toBe("failed");
  expect(worker.statuses("user-1")[1]).toMatchObject({ failed: 1, lastSuccessfulScrobble: null,
    diagnostics: [expect.objectContaining({ code: "LISTENBRAINZ_400", attempts: 1, track: "Song" })] });
});
test("stops automatic retries after the attempt limit and retains manual recovery", async () => {
  const worker = service(transport(async () => { throw new Error("offline"); }));
  await connect(worker); report(worker);
  for (let attempt = 1; attempt <= 12; attempt++) {
    await worker.drain();
    expect(jobs()[0].attempts).toBe(attempt);
    now = jobs()[0].next_attempt_at;
  }
  expect(jobs()[0].state).toBe("failed");
  worker.retry("user-1", "listenbrainz");
  expect(jobs()[0]).toMatchObject({ state: "pending", attempts: 0 });
});
test("Last.fm API auth errors block until reconnect; ignored listens never become successful", async () => {
  let reply: unknown = { error: 9, message: "Invalid session" };
  const worker = service(async (url) => new Response(JSON.stringify(String(url).includes("user.getInfo") ? { user: { name: "lastfm-listener" } } : reply)));
  await worker.connectLastFm("user-1", { sessionKey: "lastfm-session-key" }); now += 200_000;
  report(worker); await worker.drain();
  expect(jobs()[0]).toMatchObject({ provider: "lastfm", state: "blocked", error_code: "LASTFM_9" });
  expect(worker.statuses("user-1")[0].lastSuccessfulScrobble).toBeNull();
  reply = { scrobbles: { "@attr": { accepted: "0", ignored: "1" }, scrobble: { ignoredMessage: { code: "3" } } } };
  await worker.connectLastFm("user-1", { sessionKey: "new-lastfm-session" }); await worker.drain();
  expect(jobs()[0]).toMatchObject({ state: "ignored", error_code: "LASTFM_IGNORED_3" });
  expect(worker.statuses("user-1")[0].lastSuccessfulScrobble).toBeNull();
});
test("migration 40 upgrades an existing database without changing its listening history or credentials", async () => {
  const input = event(); recordPlayback(db, "user-1", input, now);
  db.exec(`DROP TABLE scrobble_queue; DROP TABLE scrobble_connections; DROP TABLE scrobble_auth_states;
    DELETE FROM schema_migrations WHERE id=40;`);
  const before = db.prepare("SELECT * FROM listening_events").all();
  runMigrations(db);
  expect(db.prepare("SELECT * FROM listening_events").all()).toEqual(before);
  expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 2 });
  expect(db.prepare("SELECT config_json FROM plugin_configs WHERE plugin_id='lastfm'").get())
    .toEqual({ config_json: '{"apiKey":"api-key","apiSecret":"api-secret"}' });
  expect(db.prepare("SELECT COUNT(*) AS n FROM scrobble_connections").get()).toEqual({ n: 0 });
});
test("Unicode account names use the same normalized key when enqueuing and claiming", async () => {
  const worker = service(transport(undefined, "Дима")); await connect(worker); report(worker);
  await worker.drain(); expect(jobs()[0]).toMatchObject({ state: "sent", account_name: "дима" });
});
test("upgrading an enabled legacy Last.fm plugin preserves its configuration and disables it until a shared secret is configured", () => {
  const legacy = JSON.stringify({ apiKey: "legacy-api-key", sessionKey: "legacy-session-key" });
  db.prepare("UPDATE plugin_configs SET config_json=? WHERE plugin_id='lastfm'").run(legacy);
  db.exec(`DROP TABLE scrobble_queue; DROP TABLE scrobble_connections; DROP TABLE scrobble_auth_states;
    DELETE FROM schema_migrations WHERE id=40;`);
  runMigrations(db);
  expect(db.prepare("SELECT enabled,config_json FROM plugin_configs WHERE plugin_id='lastfm'").get()).toEqual({ enabled: 0, config_json: legacy });
});
test("delayed reports cannot backfill plays from before a privacy-policy change", async () => {
  const worker = service(transport()); await connect(worker);
  const privateListen = event();
  await privacy.update({ localOnly: true, allowMetadata: true, allowImports: true, allowArtwork: true });
  report(worker, privateListen); expect(jobs()).toHaveLength(0);
  await privacy.update({ localOnly: false, allowMetadata: true, allowImports: true, allowArtwork: true });
  // Anchor the policy transition to the queue's deterministic clock.
  db.prepare("UPDATE server_settings SET updated_at=? WHERE key='privacy.policy'").run(new Date(now).toISOString());
  report(worker, privateListen); expect(jobs()).toHaveLength(0);
  now += 200_000; report(worker, event("new-public-session")); await worker.drain(); expect(jobs()[0].state).toBe("sent");
});
