import { describe, expect, test, vi } from "vitest";
import { LastFmScrobbler, lastFmSignature } from "../src/services/scrobble/LastFmScrobbler.js";
import { ListenBrainzScrobbler, listenBrainzPayload } from "../src/services/scrobble/ListenBrainzScrobbler.js";
import { qualifiesForScrobble } from "../src/services/scrobble/ScrobbleQueueService.js";

const listen = { artist: "Björk & Co", track: "It's + music", album: "Vol. 1", listenedAt: 1700000000, duration: 300 };
const accepted = { scrobbles: { "@attr": { accepted: "1", ignored: "0" }, scrobble: { ignoredMessage: { code: "0", "#text": "" } } } };
const lastfm = (body: unknown, status = 200, headers?: HeadersInit) => new LastFmScrobbler({ apiKey: "app-key", apiSecret: "app-secret", sessionKey: "user-session" },
  async () => new Response(JSON.stringify(body), { status, headers }));
describe("Last.fm protocol", () => {
  test("matches independently hashed preimages from both official signing examples", () => {
    // Official documentation publishes concatenation examples, not expected digest vectors.
    // Expected hashes were independently calculated with .NET MD5, not this implementation.
    expect(lastFmSignature({ token: "yyyyyy", api_key: "xxxxxxxxxx", method: "auth.getSession" }, "ilovecher"))
      .toBe("b87d61da3cda91a8b6746c4aef55d6f8");
    expect(lastFmSignature({ token: "xxxxxxx", api_key: "xxxxxxxx", method: "auth.getSession" }, "mysecret"))
      .toBe("68afb32bee072407a63b6c41f3e1e2b4");
  });
  test("signs raw UTF-8 parameters before form encoding, excluding response formatting", async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify(accepted)));
    await new LastFmScrobbler({ apiKey: "app-key", apiSecret: "app-secret", sessionKey: "user-session" }, transport).scrobble(listen);
    const init = (transport.mock.calls as unknown as [string, RequestInit][])[0][1];
    const form = new URLSearchParams(String(init.body));
    expect(init.method).toBe("POST"); expect(form.get("artist")).toBe(listen.artist);
    expect(form.get("timestamp")).toBe("1700000000");
    const raw = Object.fromEntries(form);
    expect(form.get("api_sig")).toBe(lastFmSignature(raw, "app-secret"));
    expect(lastFmSignature({ artist: "Björk & Co", format: "json", callback: "cb", api_sig: "ignored" }, "secret"))
      .toBe(lastFmSignature({ artist: "Björk & Co" }, "secret"));
    expect(lastFmSignature({ artist: "Björk & Co" }, "secret")).not.toBe(lastFmSignature({ artist: "Bj%C3%B6rk+%26+Co" }, "secret"));
    expect(lastFmSignature({ artist: "Björk & Co" }, "secret")).toBe("c40de05d1376ca2273a7dcc5f034aa97");
  });
  test.each([[9, "auth"], [13, "configuration"], [11, "transient"], [16, "transient"], [29, "transient"], [6, "permanent"]])(
    "classifies API error %s even inside HTTP 200", async (code, kind) => {
      await expect(lastfm({ error: code, message: "secret MUST NOT be echoed" }).scrobble(listen)).rejects.toMatchObject({ code: `LASTFM_${code}`, kind });
    });
  test("also detects legacy XML failures and never accepts an empty JSON success", async () => {
    const client = new LastFmScrobbler({ apiKey: "k", apiSecret: "s", sessionKey: "sk" }, async () => new Response('<lfm status="failed"><error code="9">Invalid session</error></lfm>'));
    await expect(client.scrobble(listen)).rejects.toMatchObject({ code: "LASTFM_9", kind: "auth" });
    await expect(lastfm({}).scrobble(listen)).rejects.toMatchObject({ code: "INVALID_RESPONSE", kind: "transient" });
  });
  test("records ignored submissions as failures instead of a last-success timestamp", async () => {
    await expect(lastfm({ scrobbles: { "@attr": { accepted: "0", ignored: "1" }, scrobble: { ignoredMessage: { code: "3" } } } }).scrobble(listen))
      .rejects.toMatchObject({ code: "LASTFM_IGNORED_3", kind: "ignored" });
    await expect(lastfm({}, 429, { "retry-after": "120" }).scrobble(listen)).rejects.toMatchObject({ retryAfterMs: 120000, kind: "transient" });
  });
  test("validates the session account and exchanges authorization tokens", async () => {
    const transport = vi.fn(async (url: string | URL) => {
      const method = new URL(url).searchParams.get("method");
      return new Response(JSON.stringify(method === "auth.getSession" ? { session: { name: "listener", key: "key" } } : { user: { name: "listener" } }));
    });
    const client = new LastFmScrobbler({ apiKey: "app", apiSecret: "secret", sessionKey: "key" }, transport);
    expect(await client.validateSession()).toBe("listener");
    expect(await client.exchangeToken("authorized-token")).toEqual({ username: "listener", sessionKey: "key" });
  });
});
describe("ListenBrainz protocol", () => {
  test("sends the strict single-listen schema and original timestamp", async () => {
    const transport = vi.fn(async () => new Response('{"status":"ok"}'));
    await new ListenBrainzScrobbler("user-token", transport).scrobble(listen);
    expect(listenBrainzPayload(listen)).toEqual({ listen_type: "single", payload: [{ listened_at: 1700000000,
      track_metadata: { artist_name: "Björk & Co", track_name: "It's + music", release_name: "Vol. 1" } }] });
    const init = (transport.mock.calls as unknown as [string, RequestInit][])[0][1];
    expect(init.headers).toMatchObject({ authorization: "Token user-token" });
    expect(JSON.parse(String(init.body))).toEqual(listenBrainzPayload(listen));
    expect(listenBrainzPayload({ ...listen, album: undefined }).payload[0].track_metadata).not.toHaveProperty("release_name");
  });
  test("validates token bodies, not just HTTP status; tests never publish a listen", async () => {
    const transport = vi.fn(async () => new Response('{"valid":false,"code":200}'));
    await expect(new ListenBrainzScrobbler("invalid-token", transport).validateToken()).rejects.toMatchObject({ code: "INVALID_TOKEN", kind: "auth" });
    expect(transport).toHaveBeenCalledWith("https://api.listenbrainz.org/1/validate-token", expect.objectContaining({ method: "GET" }));
    await expect(new ListenBrainzScrobbler("valid-token", async () => new Response('{"valid":true,"user_name":"listener"}')).validateToken()).resolves.toBe("listener");
  });
  test("rejects internal errors, malformed responses, and network outages", async () => {
    await expect(new ListenBrainzScrobbler("token", async () => new Response('{"code":503,"error":"secret"}')).scrobble(listen)).rejects.toMatchObject({ kind: "transient" });
    await expect(new ListenBrainzScrobbler("token", async () => new Response('{}')).scrobble(listen)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(new ListenBrainzScrobbler("token", async () => { throw new Error("secret network URL"); }).scrobble(listen)).rejects.toMatchObject({ code: "NETWORK_ERROR", kind: "transient" });
  });
});
test("provider qualification is separate from MusicDeck's existing local 20-second policy", () => {
  expect(qualifiesForScrobble("lastfm", 20, 180)).toBe(false);
  expect(qualifiesForScrobble("lastfm", 90, 180)).toBe(true);
  expect(qualifiesForScrobble("lastfm", 15, 30)).toBe(false);
  expect(qualifiesForScrobble("lastfm", 240, null)).toBe(false);
  expect(qualifiesForScrobble("listenbrainz", 239, null)).toBe(false);
  expect(qualifiesForScrobble("listenbrainz", 240, null)).toBe(true);
  expect(qualifiesForScrobble("listenbrainz", 240, 1200)).toBe(true);
});
