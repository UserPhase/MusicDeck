import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ResumableMediaService, MEDIA_SESSION_TTL } from "../src/services/ResumableMediaService.js";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";

let current: Awaited<ReturnType<typeof createTestServer>>;
let cookie: string;
let otherCookie: string;
let userId: string;
let now = Date.now();
const input = () => ({
  type: "album" as const, mediaId: "album-one", title: "Long album", trackId: "track-two",
  trackIndex: 1, trackCount: 3, positionSeconds: 102.125, durationSeconds: 600, capturedAt: now,
});
beforeAll(async () => {
  current = await createTestServer(createFakeBackend());
  cookie = (await login(current.app)).cookie!;
  userId = (current.db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string }).id;
  await createUser(current.db, { username: "resume-listener", password: "listener-password" });
  otherCookie = (await login(current.app, "resume-listener", "listener-password")).cookie!;
});
afterAll(async () => { await closeTestServer(current.app, current.db); });
beforeEach(() => { current.db.exec("DELETE FROM media_sessions; DELETE FROM media_session_completions"); now = Date.now(); });
describe("resumable checkpoints", () => {
  test("upserts exact seconds, duplicates and ordering without creating multiple bookmarks", () => {
    const service = new ResumableMediaService(current.db, () => now);
    expect(service.save(userId, input())).toMatchObject({ positionSeconds: 102.125, trackIndex: 1 });
    service.save(userId, { ...input(), positionSeconds: 110, capturedAt: now + 1 });
    service.save(userId, { ...input(), positionSeconds: 10, capturedAt: now - 1 });
    expect(service.list(userId)).toHaveLength(1);
    expect(service.list(userId)[0].positionSeconds).toBe(110);
    expect(service.list(userId)[0].progress).toBeCloseTo((1 + 110 / 600) / 3);
  });
  test("unknown duration is resumable and stale or completed bookmarks are pruned", () => {
    const service = new ResumableMediaService(current.db, () => now);
    service.save(userId, { ...input(), durationSeconds: null });
    expect(service.list(userId)[0].durationSeconds).toBeNull();
    now += MEDIA_SESSION_TTL + 1;
    expect(service.list(userId)).toEqual([]);
    service.save(userId, input());
    expect(service.save(userId, { ...input(), capturedAt: now + 1, completed: true })).toBeNull();
    expect(service.list(userId)).toEqual([]);
    service.save(userId, { ...input(), trackIndex: 2, positionSeconds: 600 });
    expect(service.list(userId)).toEqual([]);
  });
  test("late progress cannot resurrect a completed bookmark, but a new listening session can", () => {
    const service = new ResumableMediaService(current.db, () => now);
    service.save(userId, input());
    service.save(userId, { ...input(), capturedAt: now + 2, completed: true });
    expect(service.save(userId, { ...input(), capturedAt: now + 1 })).toBeNull();
    expect(service.list(userId)).toEqual([]);
    expect(service.save(userId, { ...input(), capturedAt: now + 3 })).toMatchObject({ positionSeconds: 102.125 });
    expect(service.list(userId)).toHaveLength(1);
  });
  test("requires authentication and rejects untrusted identity, timestamps and malformed positions", async () => {
    for (const method of ["GET", "POST", "DELETE"] as const) {
      expect((await current.app.inject({ method, url: "/api/v1/user/media-sessions" })).statusCode).toBe(401);
    }
    for (const payload of [
      { ...input(), userId: "other" }, { ...input(), trackIndex: 3 },
      { ...input(), positionSeconds: -1 }, { ...input(), positionSeconds: 601 },
      { ...input(), capturedAt: now + 60_000 }, { ...input(), capturedAt: now - MEDIA_SESSION_TTL - 1 },
    ]) {
      expect((await current.app.inject({ method: "POST", url: "/api/v1/user/media-sessions", headers: { cookie }, payload })).statusCode).toBe(400);
    }
  });
  test("syncs across clients for the same account, isolates accounts and scopes deletions", async () => {
    expect((await current.app.inject({ method: "POST", url: "/api/v1/user/media-sessions", headers: { cookie }, payload: input() })).statusCode).toBe(200);
    const list = await current.app.inject({ method: "GET", url: "/api/v1/user/media-sessions", headers: { cookie } });
    expect(list.json().items[0]).toMatchObject({ trackId: "track-two", positionSeconds: 102.125 });
    expect(list.headers["cache-control"]).toBe("private, no-store");
    expect((await current.app.inject({ method: "GET", url: "/api/v1/user/media-sessions", headers: { cookie: otherCookie } })).json().items).toEqual([]);
    await current.app.inject({ method: "DELETE", url: "/api/v1/user/media-sessions?type=album&mediaId=album-one", headers: { cookie: otherCookie } });
    expect((await current.app.inject({ method: "GET", url: "/api/v1/user/media-sessions", headers: { cookie } })).json().items).toHaveLength(1);
  });
  test("does not accept another account's playlist or retain deleted playlists", async () => {
    current.db.prepare("INSERT INTO playlists (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run("resume-private", "Private", userId, new Date(now).toISOString(), new Date(now).toISOString());
    try {
      const payload = { ...input(), type: "playlist", mediaId: "resume-private" };
      expect((await current.app.inject({ method: "POST", url: "/api/v1/user/media-sessions", headers: { cookie: otherCookie }, payload })).statusCode).toBe(404);
      expect((await current.app.inject({ method: "POST", url: "/api/v1/user/media-sessions", headers: { cookie }, payload })).statusCode).toBe(200);
      current.db.prepare("DELETE FROM playlists WHERE id='resume-private'").run();
      expect(new ResumableMediaService(current.db).list(userId)).toEqual([]);
    } finally {
      current.db.prepare("DELETE FROM playlists WHERE id='resume-private'").run();
    }
  });
  test("detail lookups can resume collections beyond the recent shelf limit and reject ambiguous queries", async () => {
    const service = new ResumableMediaService(current.db, () => now);
    for (let index = 0; index < 105; index++) service.save(userId, { ...input(), mediaId: `album-${index}` });
    expect(service.list(userId)).toHaveLength(100);
    const result = await current.app.inject({ method: "GET",
      url: "/api/v1/user/media-sessions?type=album&mediaId=album-104", headers: { cookie } });
    expect(result.json().items[0].mediaId).toBe("album-104");
    expect((await current.app.inject({ method: "GET",
      url: "/api/v1/user/media-sessions?type=album&mediaId=album-104", headers: { cookie: otherCookie } })).json().items).toEqual([]);
    for (const query of ["?type=album", "?mediaId=album-104", "?userId=admin"]) {
      expect((await current.app.inject({ method: "GET", url: `/api/v1/user/media-sessions${query}`, headers: { cookie } })).statusCode).toBe(400);
    }
  });
});
