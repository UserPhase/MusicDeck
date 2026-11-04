import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { closeTestServer, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";

let current: Awaited<ReturnType<typeof createTestServer>>, cookie: string, otherCookie: string, userId: string;
let lastfmError = false;
const fetchImpl: typeof fetch = vi.fn(async (url) => {
  const target = new URL(String(url));
  if (target.hostname === "api.listenbrainz.org") {
    if (target.pathname.endsWith("validate-token")) return new Response('{"valid":true,"user_name":"listener"}');
    return new Response('{"status":"ok"}');
  }
  if (lastfmError) return new Response('{"error":9,"message":"SECRET_INVALID_SESSION"}');
  if (target.searchParams.get("method") === "auth.getSession") return new Response('{"session":{"name":"lastfm-user","key":"private-session-key"}}');
  return new Response('{"user":{"name":"lastfm-user"}}');
});
beforeAll(async () => {
  current = await createTestServer(undefined, {}, undefined, undefined, undefined, undefined, { scrobbleFetch: fetchImpl });
  cookie = (await login(current.app)).cookie!;
  await createUser(current.db, { username: "listener", password: "listener-password", role: "user" });
  otherCookie = (await login(current.app, "listener", "listener-password")).cookie!;
  userId = (current.db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string }).id;
  for (const provider of ["lastfm", "listenbrainz"]) {
    const response = await current.app.inject({ method: "PATCH", url: `/api/admin/plugins/${provider}`, headers: { cookie },
      payload: { enabled: true, config: provider === "lastfm" ? { apiKey: "application-key", apiSecret: "application-secret" } : {}, permissions: ["history.read", "network.request"] } });
    expect(response.statusCode).toBe(200);
  }
});
beforeEach(() => { lastfmError = false; vi.mocked(fetchImpl).mockClear();
  current.db.exec("DELETE FROM scrobble_queue; DELETE FROM scrobble_connections; DELETE FROM scrobble_auth_states; DELETE FROM listening_events");
});
afterAll(async () => { await closeTestServer(current.app, current.db); });
const request = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>, session = cookie) =>
  current.app.inject({ method, url, headers: { cookie: session }, ...(payload !== undefined ? { payload } : {}) });

test("requires authentication and never returns stored credentials", async () => {
  expect((await current.app.inject({ url: "/api/v1/scrobble" })).statusCode).toBe(401);
  const connected = await request("PUT", "/api/v1/scrobble/listenbrainz", { token: "private-listenbrainz-token" });
  expect(connected.statusCode).toBe(200);
  expect(connected.body).not.toContain("private-listenbrainz-token");
  expect(connected.headers["cache-control"]).toContain("no-store");
  expect(connected.headers["referrer-policy"]).toBe("no-referrer");
  expect((await request("GET", "/api/v1/scrobble", undefined, otherCookie)).json().connections[1].enabled).toBe(false);
  expect((await request("PUT", "/api/v1/scrobble/listenbrainz", { token: "token", userId: "someone-else" })).statusCode).toBe(400);
  expect((await current.app.inject({ method: "DELETE", url: "/api/v1/scrobble/listenbrainz", headers: { cookie, origin: "https://evil.test" } })).statusCode).toBe(403);
});
test("Last.fm authorization is bound to the initiating user's session and cannot be replayed", async () => {
  const started = await request("POST", "/api/v1/scrobble/lastfm/authorize"); expect(started.statusCode).toBe(200);
  const auth = new URL(started.json().authorizationUrl);
  expect(auth.origin).toBe("https://www.last.fm");
  const callback = new URL(auth.searchParams.get("cb")!);
  callback.searchParams.set("token", "a".repeat(32));
  const url = callback.pathname + callback.search;
  expect((await request("GET", url, undefined, otherCookie)).statusCode).toBe(400);
  const anotherSession = (await login(current.app)).cookie!;
  expect((await request("GET", url, undefined, anotherSession)).statusCode).toBe(400);
  const completed = await request("GET", url);
  expect(completed.statusCode).toBe(302);
  expect(completed.headers.location).toContain("/admin/server?scrobble=connected#scrobble-title");
  expect((await request("GET", url)).statusCode).toBe(400);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const status = (await request("GET", "/api/v1/scrobble")).json();
  expect(status.connections[0]).toMatchObject({ username: "lastfm-user", enabled: true, status: "connected" });
  expect(JSON.stringify(status)).not.toContain("private-session-key");
});
test("expired authorization and API-level session errors cannot connect an account", async () => {
  const started = await request("POST", "/api/v1/scrobble/lastfm/authorize");
  const callback = new URL(new URL(started.json().authorizationUrl).searchParams.get("cb")!);
  callback.searchParams.set("token", "b".repeat(32));
  current.db.exec("UPDATE scrobble_auth_states SET expires_at=1");
  expect((await request("GET", callback.pathname + callback.search)).statusCode).toBe(400);
  expect(fetchImpl).not.toHaveBeenCalled();
  lastfmError = true;
  const invalid = await request("PUT", "/api/v1/scrobble/lastfm", { sessionKey: "private-invalid-key" });
  expect(invalid.statusCode).toBe(400); expect(invalid.json().error.code).toBe("LASTFM_9");
  expect(invalid.body).not.toContain("SECRET_INVALID_SESSION");
  expect(invalid.body).not.toContain("private-invalid-key");
});
test("real playback reports enqueue once at the external threshold and submit the original listening time", async () => {
  await request("PUT", "/api/v1/scrobble/listenbrainz", { token: "playback-token" });
  // Model a connection that already existed when playback began.
  current.db.prepare("UPDATE scrobble_connections SET connected_at=? WHERE user_id=?").run(Date.now() - 600_000, userId);
  const startedAt = new Date(Date.now() - 200_000).toISOString();
  const body = { playbackSessionId: "live-session-0001", ownerUserId: userId, trackId: "track-1", startedAt, listenedSeconds: 20,
    durationSeconds: 180, finished: false, track: { title: "Song", artist: "Artist", album: "Album" } };
  expect((await request("POST", "/api/listening-events", body)).statusCode).toBe(200);
  expect(current.db.prepare("SELECT COUNT(*) AS n FROM scrobble_queue").get()).toEqual({ n: 0 });
  await request("POST", "/api/listening-events", { ...body, listenedSeconds: 90 });
  await request("POST", "/api/listening-events", { ...body, listenedSeconds: 100 });
  await vi.waitFor(() => expect(current.db.prepare("SELECT state FROM scrobble_queue").get()).toEqual({ state: "sent" }));
  const calls = vi.mocked(fetchImpl).mock.calls.filter(([url]) => String(url).includes("submit-listens"));
  expect(calls).toHaveLength(1);
  expect(JSON.parse(String(calls[0][1]?.body)).payload[0].listened_at).toBe(Math.floor(Date.parse(startedAt) / 1000));
});
test("privacy mode blocks new connections but still allows disconnecting existing accounts", async () => {
  await request("PUT", "/api/v1/scrobble/listenbrainz", { token: "privacy-token" });
  const policy = { localOnly: true, allowMetadata: true, allowImports: true, allowArtwork: true };
  await current.app.inject({ method: "PATCH", url: "/api/v1/privacy", headers: { cookie }, payload: policy });
  try {
    expect((await request("PUT", "/api/v1/scrobble/listenbrainz", { token: "another-token" })).statusCode).toBe(409);
    expect((await request("DELETE", "/api/v1/scrobble/listenbrainz")).statusCode).toBe(200);
    expect((await request("GET", "/api/v1/scrobble")).json().connections[1]).toMatchObject({ enabled: false, available: false });
  } finally { await current.app.inject({ method: "PATCH", url: "/api/v1/privacy", headers: { cookie }, payload: { ...policy, localOnly: false } }); }
});
