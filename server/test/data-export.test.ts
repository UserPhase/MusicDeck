import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { inflateRawSync } from "node:zlib";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { DataExportService, EXPORT_PAGE_SIZE, csvCell, xmlText } from "../src/services/DataExportService.js";
import { createFakeBackend, createTestServer, closeTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";
import { recordPlayback } from "../src/domain/listening-activity.js";
import { runMigrations } from "../src/db/migrations.js";

let current: Awaited<ReturnType<typeof createTestServer>>;
let adminId: string;
let listenerId: string;
let cookie: string;
let listenerCookie: string;
let service: DataExportService;
const log = vi.fn();
const catalog = { getTrack: vi.fn(), getTrackFilePath: vi.fn() };
async function consume(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const buffers: Buffer[] = [];
  for await (const chunk of stream) buffers.push(Buffer.from(chunk));
  return Buffer.concat(buffers);
}
function unzip(buffer: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = buffer.indexOf(signature);
  while (offset >= 0 && buffer.readUInt32LE(offset) === 0x02014b50) {
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(start, start + compressed);
    result.set(name, (buffer.readUInt16LE(offset + 10) === 8 ? inflateRawSync(data) : data).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}
beforeAll(async () => {
  current = await createTestServer(createFakeBackend());
  const admin = await login(current.app);
  if (!admin.cookie) throw new Error("Admin login failed");
  cookie = admin.cookie;
  adminId = (current.db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string }).id;
  const listener = await createUser(current.db, { username: "export-listener", password: "listener-password" });
  if (!listener) throw new Error("Listener creation failed");
  listenerId = listener.id;
  const loginResult = await login(current.app, "export-listener", "listener-password");
  if (!loginResult.cookie) throw new Error("Listener login failed");
  listenerCookie = loginResult.cookie;
  service = new DataExportService(current.db, catalog, { publicUrl: "https://music.example.test/deck/", musicRoot: current.directory, log });
});
afterAll(async () => {
  current.app.server.closeIdleConnections();
  await closeTestServer(current.app, current.db);
});
beforeEach(() => {
  vi.restoreAllMocks();
  log.mockClear();
  catalog.getTrack.mockReset(); catalog.getTrackFilePath.mockReset();
  catalog.getTrackFilePath.mockResolvedValue(null);
  current.db.exec(`DELETE FROM playlists; DELETE FROM listening_events; DELETE FROM favorites; DELETE FROM media_favorites;
    DELETE FROM recommendation_feedback; DELETE FROM media_ratings; DELETE FROM user_settings; DELETE FROM smart_playlists; DELETE FROM saved_discoveries;`);
});
function seedPlaylist() {
  current.db.prepare("INSERT INTO playlists(id,owner_user_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run("list", adminId, "Night & <Archive>\n#evil", "Description", "2026-10-01", "2026-10-01");
  current.db.prepare("INSERT OR IGNORE INTO library_items(id,type,created_at,updated_at) VALUES ('md_export','track','2026','2026')").run();
  const insert = current.db.prepare(`INSERT INTO playlist_items
    (id,playlist_id,position,connection_id,provider_track_id,library_track_id,created_at) VALUES (?,'list',?,'connection',?,'md_export','2026')`);
  insert.run("first", 0, "provider"); insert.run("second", 1, "provider");
  catalog.getTrack.mockResolvedValue({ title: '日本語 "Title" & <Live>\n#EXTM3U', artistName: "Artist & Friends", albumName: "A < B", durationSeconds: 123.456 });
  catalog.getTrackFilePath.mockResolvedValue(path.join(current.directory, "Artist", "#intro & 日本語.wav"));
}
function seedHistory(total = 2) {
  const insert = current.db.prepare(`INSERT INTO listening_events
    (id,user_id,track_id,event_type,created_at,listened_seconds,track_json,client_name,counted,finished)
    VALUES (?,?,?,'complete',?,30,?,?,1,1)`);
  current.db.transaction(() => {
    for (let index = 0; index < total; index++) {
      insert.run(`listen_${index}`, adminId, `track-${index}`, `2026-10-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        JSON.stringify({ title: index === 0 ? '=SUM(1,2)\r\n"quoted"' : `Track ${index}`, artist: "Björk, Live", album: "A & B" }), "MusicDeck Web");
    }
  })();
}

describe("portable formats", () => {
  test("discovery playlist entries retain their metadata and remain marked unavailable as full audio", async () => {
    seedPlaylist();
    current.db.prepare("UPDATE playlist_items SET library_track_id=NULL,provider_track_id='external_lastfm_track_test',external_track_json=? WHERE id='first'")
      .run(JSON.stringify({ title: "Distant Signal", artistName: "A new artist", albumName: "", durationSeconds: null, external: true }));
    const data = JSON.parse((await consume(service.stream(adminId, "bundle", "json"))).toString());
    expect(data.playlists[0].tracks[0]).toMatchObject({ title: "Distant Signal", artist: "A new artist", unavailable: true });
  });
  test("M3U8 preserves UTF-8, duplicates and precise metadata without directive injection", async () => {
    seedPlaylist();
    const output = (await consume(service.stream(adminId, "playlists", "m3u8", "list"))).toString("utf8");
    expect(output.startsWith("#EXTM3U\n#PLAYLIST:Night & <Archive> #evil\n")).toBe(true);
    expect(output.match(/^#EXTINF:/gm)).toHaveLength(2);
    expect(output).toContain('#EXTINF:123,Artist & Friends - 日本語 "Title" & <Live> #EXTM3U\nArtist/%23intro%20%26%20%E6%97%A5%E6%9C%AC%E8%AA%9E.wav');
    expect(output.match(/^#EXTM3U$/gm)).toHaveLength(1);
  });
  test("XSPF is escaped XML with duration in milliseconds and URI-safe media paths", async () => {
    seedPlaylist();
    const output = (await consume(service.stream(adminId, "playlists", "xspf", "list"))).toString("utf8");
    expect(output).toContain('xmlns="http://xspf.org/ns/0/"');
    expect(output).toContain("<duration>123456</duration>");
    expect(output).toContain("Artist &amp; Friends");
    expect(output).toContain("&lt;Live&gt;");
    expect(output).toContain("<identifier>urn:musicdeck:track:md_export</identifier>");
    expect(output.match(/<track>/g)).toHaveLength(2);
    expect(xmlText("\0\u000b<&\ud800")).toBe("&lt;&amp;");
  });
  test("missing/provider-failed items survive with honest unknown duration and no secret URLs", async () => {
    seedPlaylist();
    catalog.getTrack.mockRejectedValue(new Error("Offline"));
    catalog.getTrackFilePath.mockResolvedValue(path.join(path.dirname(current.directory), "private", "outside.wav"));
    const output = (await consume(service.stream(adminId, "playlists", "m3u8", "list"))).toString("utf8");
    expect(output).toContain("#EXTINF:-1, - md_export\nhttps://music.example.test/deck/api/tracks/md_export/stream");
    expect(output).not.toContain("outside.wav");
    expect(log).toHaveBeenCalled();
    const bundle = JSON.parse((await consume(service.stream(adminId, "bundle", "json"))).toString());
    expect(bundle.playlists[0].tracks).toHaveLength(2);
    expect(bundle.playlists[0].tracks[0]).toMatchObject({ unavailable: true, location_type: "authenticated-stream" });
  });
  test("CSV follows RFC4180 and protects formulas while retaining unknown legacy values", async () => {
    seedHistory();
    current.db.prepare(`INSERT INTO listening_events(id,user_id,track_id,event_type,created_at) VALUES ('legacy',?,'old','play','2020')`).run(adminId);
    const output = (await consume(service.stream(adminId, "history", "csv"))).toString();
    expect(output.startsWith("timestamp,track_title,artist,album,play_duration_seconds,client_name\r\n")).toBe(true);
    expect(output).toContain(`"'=SUM(1,2)\r\n""quoted""","Björk, Live","A & B","30","MusicDeck Web"\r\n`);
    expect(output).toContain('"2020","old","","","",""\r\n');
    expect(csvCell(" \t@command")).toBe(`"' \t@command"`);
    expect(csvCell(null)).toBe('""');
  });
  test("favorites combine stores without duplicates, include albums, scores and safe account settings", async () => {
    current.db.prepare("INSERT INTO favorites VALUES (?, 'track-1','2026')").run(adminId);
    current.db.prepare("INSERT INTO media_favorites (user_id,item_type,item_id,created_at) VALUES (?,'track','track-1','2026'),(?,'album','album-1','2026')").run(adminId, adminId);
    current.db.prepare("INSERT INTO recommendation_feedback(user_id,item_type,item_id,action,weight,created_at,updated_at) VALUES (?,'artist','hidden-artist','hide',-100,'2026','2026')").run(adminId);
    current.db.prepare("INSERT INTO media_ratings VALUES (?,'track','track-1',5,'2026','2026')").run(adminId);
    current.db.prepare("INSERT INTO user_settings VALUES (?,'ui.theme','\"dark\"','2026'),(?,'sessionSecret','\"DO_NOT_EXPORT\"','2026')").run(adminId, adminId);
    const data = JSON.parse((await consume(service.stream(adminId, "favorites", "json"))).toString());
    expect(data.favorites).toHaveLength(2);
    expect(data.favorites[1]).toMatchObject({ item_type: "album", item_id: "album-1" });
    expect(data.feedback).toEqual([expect.objectContaining({ action: "hide", score_modifier: -100 })]);
    expect(data.ratings[0].rating).toBe(5);
    const settings = (await consume(service.stream(adminId, "settings", "json"))).toString();
    expect(JSON.parse(settings)).toEqual([{ key: "ui.theme", value: "dark", updated_at: "2026" }]);
    expect(settings).not.toContain("DO_NOT_EXPORT");
    expect(service.summary(adminId).counts).toMatchObject({ favorites: 2, feedback: 1, ratings: 1, settings: 1 });
  });
  test("ZIP bundles contain valid compressed individual files, unified JSON and safe unique archive paths", async () => {
    seedPlaylist(); seedHistory();
    const output = await consume(service.stream(adminId, "bundle", "zip"));
    const files = unzip(output);
    expect(files.size).toBe(7);
    expect(files.has("user.json")).toBe(true);
    expect(JSON.parse(files.get("user.json")!).schema).toBe("musicdeck-user-export");
    expect(files.get("history.csv")).toContain("timestamp,track_title");
    const m3u = [...files.keys()].find((key) => key.endsWith(".m3u8"))!;
    expect(m3u).not.toContain("<");
    expect(m3u).not.toContain("..");
    expect(files.get(m3u)).toContain("#EXTM3U");
    expect(files.get("README.txt")).toContain("signed-in session");
    const all = unzip(await consume(service.stream(adminId, "playlists", "xspf")));
    expect([...all.keys()].filter((key) => key.endsWith(".xspf"))).toHaveLength(1);
  });
  test("new sessions persist supplied client names without rewriting unknown legacy values", () => {
    const now = Date.now();
    recordPlayback(current.db, adminId, {
      playbackSessionId: "export-session", trackId: "one", startedAt: new Date(now - 60_000).toISOString(),
      listenedSeconds: 30, durationSeconds: 90, finished: false, clientName: "MusicDeck Web",
      track: { title: "A", artist: "B", album: "C" },
    }, now);
    expect((current.db.prepare("SELECT client_name FROM listening_events WHERE playback_session_id='export-session'").get() as { client_name: string }).client_name).toBe("MusicDeck Web");
  });
  test("client-name migration preserves legacy history and runs idempotently", () => {
    seedHistory(1);
    current.db.exec("ALTER TABLE listening_events DROP COLUMN client_name; DELETE FROM schema_migrations WHERE id=34;");
    runMigrations(current.db);
    runMigrations(current.db);
    expect(current.db.prepare("SELECT client_name,listened_seconds,counted FROM listening_events").get())
      .toEqual({ client_name: null, listened_seconds: 30, counted: 1 });
  });
  test("unified JSON retains smart rules and portable discovery metadata but excludes arbitrary signed URLs", async () => {
    current.db.prepare("INSERT INTO smart_playlists (id,user_id,name,rules_json,created_at,updated_at) VALUES ('smart',?,'Live mix',?,'2026','2026')")
      .run(adminId, JSON.stringify({ operator: "AND", rules: [{ field: "year", operator: "greater_than", value: 2020 }] }));
    current.db.prepare("UPDATE smart_playlists SET options_json=? WHERE id='smart'").run(JSON.stringify({ size: 25, order: "variety", seed: 42 }));
    current.db.prepare("INSERT INTO saved_discoveries VALUES ('saved',?,'deezer','123','track','Discovery','Artist',NULL,?,'2026')")
      .run(adminId, JSON.stringify({ isrc: "TEST123", album: "An album", streamUrl: "https://provider.test/song?token=PRIVATE", secret: "DO_NOT_EXPORT" }));
    const output = (await consume(service.stream(adminId, "bundle", "json"))).toString();
    const json = JSON.parse(output);
    expect(json.smart_playlists[0].rules.rules[0].field).toBe("year");
    expect(json.smart_playlists[0].options).toEqual({ size: 25, order: "variety", seed: 42 });
    expect(json.saved_discoveries[0].metadata).toEqual({ isrc: "TEST123", album: "An album" });
    expect(output).not.toContain("PRIVATE");
    expect(output).not.toContain("DO_NOT_EXPORT");
    expect(output).not.toContain("password_hash");
  });
  test("corrupt stored metadata fails explicitly instead of returning a success-shaped partial archive", async () => {
    seedHistory(1);
    current.db.prepare("UPDATE listening_events SET track_json='not-json' WHERE user_id=?").run(adminId);
    await expect(consume(service.stream(adminId, "history", "csv"))).rejects.toThrow();
    await expect(consume(service.stream(adminId, "bundle", "zip"))).rejects.toThrow();
  });
  test("empty playlist archives remain valid and invalid export formats fail explicitly", async () => {
    expect(unzip(await consume(service.stream(adminId, "playlists", "m3u8"))).has("README.txt")).toBe(true);
    expect(() => service.stream(adminId, "bundle", "exe")).toThrow("Invalid data export format");
    expect(() => new DataExportService(current.db, catalog, {
      publicUrl: "https://user:secret@music.example.test", musicRoot: current.directory, log,
    })).toThrow("without credentials");
  });
});

describe("export boundaries", () => {
  test("user routes scope counts, playlists and history to the signed-in account, including for admins", async () => {
    seedPlaylist(); seedHistory();
    const publicResponse = await current.app.inject({ url: "/api/v1/user/export/history" });
    expect(publicResponse.statusCode).toBe(401);
    const listener = await current.app.inject({ url: "/api/v1/user/export/summary", headers: { cookie: listenerCookie } });
    expect(listener.json().counts.history).toBe(0);
    for (const suffix of ["playlists/list", "playlists/list?format=xspf"]) {
      expect((await current.app.inject({ url: `/api/v1/user/export/${suffix}`, headers: { cookie: listenerCookie } })).statusCode).toBe(404);
    }
    expect((await current.app.inject({ url: `/api/v1/admin/users/${adminId}/export/summary`, headers: { cookie: listenerCookie } })).statusCode).toBe(403);
    const other = await current.app.inject({ url: `/api/v1/admin/users/${listenerId}/export/summary`, headers: { cookie } });
    expect(other.json().counts.history).toBe(0);
    const invalid = await current.app.inject({ url: "/api/v1/user/export/history?format=xml", headers: { cookie } });
    expect(invalid.statusCode).toBe(400);
    expect((await current.app.inject({ url: "/api/v1/user/export/history?userId=other", headers: { cookie } })).statusCode).toBe(400);
    const history = await current.app.inject({ url: "/api/v1/user/export/history", headers: { cookie } });
    expect(history.statusCode).toBe(200);
    expect(history.headers["content-type"]).toContain("text/csv");
    expect(history.headers["content-disposition"]).toMatch(/^attachment; filename="musicdeck-history-.*\.csv"$/);
    expect(history.headers["cache-control"]).toBe("private, no-store");
    expect(history.headers["content-length"]).toBeUndefined();
    current.db.prepare("UPDATE playlists SET owner_user_id=NULL,sharing_mode='PUBLIC_SERVER' WHERE id='list'").run();
    const shared = await current.app.inject({ url: "/api/v1/user/export/playlists/list", headers: { cookie: listenerCookie } });
    expect(shared.statusCode).toBe(200);
    expect(shared.headers["content-type"]).toContain("audio/x-mpegurl");
    expect((await current.app.inject({ url: "/api/v1/user/export/summary", headers: { cookie: listenerCookie } })).json().counts.playlists).toBe(1);
  });
  test("large history uses 500-row pages with bounded memory under backpressure", async () => {
    seedHistory(50_000);
    const original = current.db.prepare.bind(current.db);
    const pageLengths: number[] = [];
    const spy = vi.spyOn(current.db, "prepare").mockImplementation((sql) => {
      const statement = original(sql);
      if (sql.includes("FROM listening_events t") && sql.includes(`LIMIT ${EXPORT_PAGE_SIZE}`)) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args) => {
          const rows = all(...args); pageLengths.push(rows.length); return rows;
        });
      }
      return statement;
    });
    const before = process.memoryUsage().heapUsed;
    let peak = before, bytes = 0, lines = 0, chunks = 0;
    const output = new Writable({
      highWaterMark: 1024,
      write(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        lines += chunk.toString().split("\r\n").length - 1;
        peak = Math.max(peak, process.memoryUsage().heapUsed);
        // Exercise a real slow writable at regular intervals without collecting content.
        if (++chunks % 500 === 0) void sleep(1).then(() => callback());
        else callback();
      },
    });
    await pipeline(service.stream(adminId, "history", "csv"), output);
    spy.mockRestore();
    expect(Math.max(...pageLengths)).toBe(500);
    expect(pageLengths).toHaveLength(100);
    expect(lines).toBe(50_002); // header + 50k rows + embedded CRLF in the first title
    expect(bytes).toBeGreaterThan(4_000_000);
    const growthMb = (peak - before) / 1024 / 1024;
    console.info(`50,000 history events: ${pageLengths.length} x 500-row pages; heap growth ${growthMb.toFixed(1)} MiB; streamed ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
    expect(growthMb).toBeLessThan(64);
    const zipBefore = process.memoryUsage().heapUsed;
    let zipPeak = zipBefore, zipBytes = 0;
    await pipeline(service.stream(adminId, "bundle", "zip"), new Writable({
      highWaterMark: 1024,
      write(chunk: Buffer, _encoding, callback) {
        zipBytes += chunk.length;
        zipPeak = Math.max(zipPeak, process.memoryUsage().heapUsed);
        setImmediate(callback);
      },
    }));
    expect(zipBytes).toBeGreaterThan(100_000);
    expect((zipPeak - zipBefore) / 1024 / 1024).toBeLessThan(64);
    console.info(`50,000-event compressed bundle: heap growth ${((zipPeak - zipBefore) / 1024 / 1024).toFixed(1)} MiB; streamed ${(zipBytes / 1024 / 1024).toFixed(1)} MiB ZIP`);
  }, 60_000);
  test("aborting an export stops page enumeration and ZIP generation", async () => {
    seedHistory(1500);
    const controller = new AbortController();
    const stream = service.stream(adminId, "history", "csv", undefined, controller.signal);
    let chunks = 0;
    await expect((async () => {
      for await (const _chunk of stream) {
        if (++chunks === 2) controller.abort();
      }
    })()).rejects.toThrow();
    expect(chunks).toBeLessThan(10);
    const zip = service.stream(adminId, "bundle", "zip");
    zip.on("error", () => {});
    zip.resume();
    await new Promise<void>((resolve) => zip.once("data", () => { zip.destroy(); resolve(); }));
    await sleep(30);
    expect(zip.destroyed).toBe(true);
  });
  test("real HTTP exports enforce concurrency limits and release slots when clients disconnect", async () => {
    seedPlaylist();
    const held: (() => void)[] = [];
    const getTrack = vi.spyOn(current.catalog, "getTrack").mockImplementation(() => new Promise((resolve) => held.push(() => resolve(null))));
    const origin = await current.app.listen({ host: "127.0.0.1", port: 0 });
    const one = new AbortController(), two = new AbortController();
    try {
      const url = `${origin}/api/v1/user/export/playlists/list`;
      const first = await fetch(url, { headers: { cookie, connection: "close" }, signal: one.signal });
      const second = await fetch(url, { headers: { cookie, connection: "close" }, signal: two.signal });
      await vi.waitFor(() => expect(held).toHaveLength(2));
      const third = await fetch(url, { headers: { cookie, connection: "close" } });
      expect(third.status).toBe(429);
      expect(third.headers.get("retry-after")).toBe("10");
      await third.text();
      one.abort(); two.abort();
      await Promise.allSettled([first.body?.cancel(), second.body?.cancel()]);
      for (const release of held) release();
      getTrack.mockRestore();
      await sleep(50);
      const retry = await fetch(url, { headers: { cookie, connection: "close" } });
      expect(retry.status).toBe(200);
      expect(await retry.text()).toContain("#EXTM3U");
    } finally {
      one.abort(); two.abort();
      for (const release of held) release();
      getTrack.mockRestore();
    }
  });
});
