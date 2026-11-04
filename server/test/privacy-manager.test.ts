import Database from "better-sqlite3";
import http from "node:http";
import dns from "node:dns";
import net from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PrivacyBlockedError, PrivacyManager, privacyFetch, gateFetch } from "../src/services/PrivacyManager.js";
import { DefaultProcessRunner } from "../src/domain/process-runner.js";
import { DeezerDiscoveryService } from "../src/domain/deezer-discovery.js";

const defaults = { localOnly: false, allowMetadata: true, allowImports: true, allowArtwork: true };
const databases: Database.Database[] = [];
function setup(lock = false, libraries = ["http://library.test/music"]) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  return { db, manager: new PrivacyManager(db, lock, libraries) };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); });
describe("global privacy policy", () => {
  test("persists policy atomically and retains granular permissions under the master switch", () => {
    const { db, manager } = setup();
    manager.update({ ...defaults, allowArtwork: false });
    const restored = new PrivacyManager(db);
    expect(restored.snapshot()).toMatchObject({ allowArtwork: false, allowImports: true, effective: { metadata: true, imports: false, artwork: false } });
    restored.update({ ...defaults, allowArtwork: false, localOnly: true });
    expect(restored.snapshot().effective).toEqual({ metadata: false, imports: false, artwork: false, external: false });
    restored.update({ ...defaults, allowArtwork: false });
    expect(restored.snapshot().effective.metadata).toBe(true);
    expect(restored.snapshot().effective.artwork).toBe(false);
  });
  test("environment lock cannot be disabled in SQLite or by UI updates", () => {
    const { manager } = setup(true);
    manager.update(defaults);
    expect(manager.snapshot()).toMatchObject({ localOnly: false, enforcedByEnvironment: true, effective: { external: false } });
    expect(() => manager.assertExternalAllowed()).toThrow(PrivacyBlockedError);
  });
  test("injected transports are checked dynamically and cannot bypass the master switch", async () => {
    const { manager } = setup();
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("metadata"));
    const injected = gateFetch(transport);
    await manager.run(async () => {
      expect(await (await injected("https://api.deezer.com/chart")).text()).toBe("metadata");
      await manager.update({ ...defaults, localOnly: true });
      await expect(injected("https://api.deezer.com/chart")).rejects.toBeInstanceOf(PrivacyBlockedError);
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test("preserves a Request's upload body and replaces inferred categories without double transport wrapping", async () => {
    const { manager } = setup();
    await manager.update({ ...defaults, allowMetadata: false });
    const transport = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (!(input instanceof Request)) throw new Error("Expected the original Request");
      return new Response(await input.text());
    });
    const gated = gateFetch(gateFetch(transport), "artwork");
    const request = new Request("https://images.example/cover", { method: "POST", body: "upload bytes" });
    await manager.run(async () => expect(await (await gated(request)).text()).toBe("upload bytes"));
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test.each(["allowMetadata", "allowArtwork"] as const)("disables opaque downloader networking when %s is off", async (key) => {
    const { manager } = setup();
    await manager.update({ ...defaults, [key]: false });
    expect(manager.snapshot()).toMatchObject({ allowImports: true, effective: { imports: false } });
    expect(() => manager.assertExternalAllowed("imports")).toThrow(PrivacyBlockedError);
  });
  test("invalid stored policy refuses startup instead of enabling external connections", () => {
    const { db } = setup();
    db.prepare("INSERT INTO server_settings VALUES ('privacy.policy', ?, '')").run('{"localOnly":false}');
    expect(() => new PrivacyManager(db)).toThrow("Invalid stored privacy policy");
  });
  test.each([
    "https://api.deezer.com/chart", "https://itunes.apple.com/search",
    "https://api.spotify.com/v1/me", "https://i.scdn.co/image/reference",
    "https://upload.wikimedia.org/portrait.png", "https://musicbrainz.org/ws/2/artist",
    "https://api.listenbrainz.org/1/submit-listens", "https://unknown-third-party.invalid/data",
    "http://127.0.0.1:1234/not-the-library",
  ])("blocks %s before invoking fetch or DNS-capable transport", async (url) => {
    const { manager } = setup();
    manager.update({ ...defaults, localOnly: true });
    const transport = vi.fn<typeof fetch>();
    await expect(manager.fetch(url, undefined, transport)).rejects.toMatchObject({ code: "LOCAL_ONLY_MODE_ACTIVE", statusCode: 403 });
    expect(transport).not.toHaveBeenCalled();
  });
  test.each([
    ["allowMetadata", "https://api.deezer.com/chart", "https://itunes.apple.com/search"],
    ["allowImports", "https://accounts.spotify.com/api/token", "https://open.spotify.com/playlist/a"],
    ["allowArtwork", "https://i.scdn.co/image/cover", "https://unknown.test/image.jpg"],
  ] as const)("enforces granular %s before transport", async (setting, first, second) => {
    const { manager } = setup();
    manager.update({ ...defaults, [setting]: false });
    const transport = vi.fn<typeof fetch>();
    for (const url of [first, second]) await expect(manager.fetch(url, undefined, transport)).rejects.toMatchObject({ code: "EXTERNAL_INTEGRATION_DISABLED" });
    expect(transport).not.toHaveBeenCalled();
  });
  test("keeps configured library paths available without trusting private networks or lookalike hosts", async () => {
    const { manager } = setup();
    manager.update({ ...defaults, localOnly: true });
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response("local bytes"));
    const response = await manager.fetch("http://library.test/music/rest/stream.view", undefined, transport);
    expect(await response.text()).toBe("local bytes");
    for (const url of ["http://library.test/elsewhere", "http://library.test/musical", "http://library.test.evil/music", "http://library.test:81/music/a"]) {
      await expect(manager.fetch(url, undefined, transport)).rejects.toBeInstanceOf(PrivacyBlockedError);
    }
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test("checks redirect targets before a second connection, including backend redirects", async () => {
    const { manager } = setup();
    manager.update({ ...defaults, localOnly: true });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://api.deezer.com/" } }));
    await expect(manager.fetch("http://library.test/music/stream", undefined, transport)).rejects.toBeInstanceOf(PrivacyBlockedError);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]?.redirect).toBe("manual");
  });
  test("follows permitted redirects without forwarding credentials to another origin", async () => {
    const { manager } = setup();
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://other.test/results" } }))
      .mockResolvedValueOnce(new Response("ok"));
    expect(await (await manager.fetch("https://metadata.test/search", { headers: { Authorization: "private", Cookie: "private" } }, transport)).text()).toBe("ok");
    const headers = new Headers(transport.mock.calls[1][1]?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
  });
  test("aborts an active response on a newly enabled restriction but retains local streams", async () => {
    const { manager } = setup();
    const cancel = vi.fn();
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream({ cancel })));
    const response = await manager.fetch("https://api.deezer.com/chart", undefined, transport);
    const read = response.text();
    manager.update({ ...defaults, allowMetadata: false });
    await expect(read).rejects.toBeInstanceOf(PrivacyBlockedError);
    expect(cancel).toHaveBeenCalled();
    const local = await manager.fetch("http://library.test/music/a", undefined, async () => new Response("audio"));
    manager.update({ ...defaults, localOnly: true });
    expect(await local.text()).toBe("audio");
  });
  test("default discovery clients and scoped fetch consult policy on every call", async () => {
    const { manager } = setup();
    const network = vi.spyOn(globalThis, "fetch");
    const discovery = new DeezerDiscoveryService();
    manager.update({ ...defaults, localOnly: true });
    await expect(manager.run(() => privacyFetch("https://api.deezer.com/chart"))).rejects.toBeInstanceOf(PrivacyBlockedError);
    await expect(manager.run(() => discovery.getCharts())).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
  test("blocks external subprocess launch and kills a running managed process on activation", async () => {
    const { manager } = setup();
    const runner = new DefaultProcessRunner();
    manager.update({ ...defaults, localOnly: true });
    expect(() => manager.run(() => runner.run(process.execPath, ["-e", "process.exit(0)"], { privacyCategory: "imports" }))).toThrow(PrivacyBlockedError);
    manager.update(defaults);
    const handle = manager.run(() => runner.run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { privacyCategory: "imports", timeoutMs: 10000 }));
    const result = expect(handle.promise).rejects.toThrow("cancelled");
    expect(handle.pid).toBeTypeOf("number");
    await manager.update({ ...defaults, localOnly: true });
    await result;
  });
  test("real trusted-origin streaming survives while denied targets produce zero DNS lookups or socket connections", async () => {
    const server = http.createServer((request, response) => {
      if (request.url?.endsWith("/redirect")) {
        response.writeHead(302, { Location: "http://blocked.invalid/metadata" }).end();
      } else response.writeHead(206, { "Content-Type": "audio/flac" }).end("local audio bytes");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback address");
      const base = `http://127.0.0.1:${address.port}/library`;
      const { manager } = setup(false, [base]);
      await manager.update({ ...defaults, localOnly: true });
      const lookup = vi.spyOn(dns, "lookup");
      const connect = vi.spyOn(net.Socket.prototype, "connect");
      const transport = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== new URL(base).origin) throw new Error("Unexpected network admission in test");
        return globalThis.fetch(input, init);
      });
      const stream = await manager.fetch(`${base}/stream`, undefined, transport);
      expect(stream.status).toBe(206);
      expect(await stream.text()).toBe("local audio bytes");
      await expect(manager.fetch(`${base}/redirect`, undefined, transport)).rejects.toBeInstanceOf(PrivacyBlockedError);
      const localConnections = connect.mock.calls.length;
      const localTransports = transport.mock.calls.length;
      for (const url of ["http://blocked.invalid/metadata", "https://api.deezer.com/chart", "https://itunes.apple.com/search"]) {
        await expect(manager.fetch(url, undefined, transport)).rejects.toBeInstanceOf(PrivacyBlockedError);
      }
      expect(transport).toHaveBeenCalledTimes(localTransports);
      expect(connect).toHaveBeenCalledTimes(localConnections);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
