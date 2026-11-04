import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export type ProviderKind = "navidrome" | "jellyfin";
export type StreamMode = "normal" | "stall" | "disconnect";
export interface MockTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  recordingId?: string;
}
export interface MockRequest {
  method: string;
  path: string;
  endpoint: string;
  range?: string;
  status: number;
}
export interface MockBackendOptions {
  kind: ProviderKind;
  tracks?: MockTrack[];
  username?: string;
  password?: string;
  apiKey?: string;
  onScan?: () => void | Promise<void>;
}

/** Small, valid PCM audio: no copyrighted media, codecs or external services. */
export function createWav(seconds = 90): Buffer {
  const rate = 8000;
  const length = Math.round(rate * seconds) * 2;
  const audio = Buffer.alloc(44 + length);
  audio.write("RIFF", 0); audio.writeUInt32LE(36 + length, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(rate, 24); audio.writeUInt32LE(rate * 2, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write("data", 36); audio.writeUInt32LE(length, 40);
  for (let sample = 0; sample < length / 2; sample++) {
    audio.writeInt16LE(Math.round(Math.sin(sample * 2 * Math.PI * 220 / rate) * 1500), 44 + sample * 2);
  }
  return audio;
}

export function catalogTracks(kind: ProviderKind, count = 80): MockTrack[] {
  return Array.from({ length: count }, (_, i) => ({
    // Deliberately collide provider-native IDs; MusicDeck must scope them.
    id: `track-${i + 1}`,
    title: i === 0 ? "Shared Song" : `${kind === "navidrome" ? "Navidrome" : "Jellyfin"} Song ${String(i + 1).padStart(4, "0")}`,
    artist: "Acceptance Artist", album: "Acceptance Album", duration: 90,
    recordingId: i === 0 ? "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" : undefined,
  }));
}

/** Actual loopback REST provider. Controls affect the upstream, never MusicDeck routes. */
export async function startMockBackend(options: MockBackendOptions) {
  const { kind } = options;
  const credentials = { username: options.username ?? "acceptance", password: options.password ?? "acceptance-password", apiKey: options.apiKey ?? "acceptance-jellyfin-token" };
  let tracks = options.tracks ?? catalogTracks(kind);
  let unavailable = false;
  let streamMode: StreamMode = "normal";
  const requests: MockRequest[] = [];
  const unexpected: string[] = [];
  const sockets = new Set<Socket>();
  const streams = new Set<ServerResponse>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const favorites = new Set<string>();
  const playlists = new Map<string, { id: string; name: string; ids: string[] }>();
  const audio = createWav();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQWQAAAAASUVORK5CYII=", "base64");
  const subTrack = (t: MockTrack) => ({ id: t.id, title: t.title, artist: t.artist, album: t.album, artistId: "artist-1", albumId: "album-1", duration: t.duration, suffix: "wav", contentType: "audio/wav", bitRate: 128, size: audio.length, track: Number(t.id.replace(/\D/g, "")) || 1, genre: "Rock", genres: [{ name: "Rock" }, { name: "Ambient" }], musicBrainzId: t.recordingId, isDir: false });
  const jfTrack = (t: MockTrack) => ({ Id: t.id, Name: t.title, Type: "Audio", Artists: [t.artist], ArtistItems: [{ Id: "artist-1", Name: t.artist }], AlbumArtists: [{ Id: "artist-1", Name: t.artist }], AlbumId: "album-1", Album: t.album, RunTimeTicks: t.duration * 10_000_000, Container: "wav", Genres: ["Rock", "Ambient"], IndexNumber: Number(t.id.replace(/\D/g, "")) || 1, ProviderIds: { MusicBrainzTrack: t.recordingId }, MediaStreams: [{ Type: "Audio", Codec: "pcm_s16le", BitRate: 128000, SampleRate: 8000, Channels: 1 }] });
  const album = () => ({ id: "album-1", name: "Acceptance Album", artist: "Acceptance Artist", artistId: "artist-1", songCount: tracks.length, duration: tracks.length * 90 });
  const artist = () => ({ id: "artist-1", name: "Acceptance Artist", albumCount: 1 });
  function json(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data));
  }
  function stream(req: IncomingMessage, res: ServerResponse) {
    const range = req.headers.range;
    let start = 0, end = audio.length - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { "content-range": `bytes */${audio.length}` }); res.end(); return; }
      start = match[1] ? Number(match[1]) : Math.max(0, audio.length - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end || start >= audio.length) { res.writeHead(416, { "content-range": `bytes */${audio.length}` }); res.end(); return; }
    }
    res.writeHead(range ? 206 : 200, { "content-type": "audio/wav", "accept-ranges": "bytes", "content-length": end - start + 1, ...(range ? { "content-range": `bytes ${start}-${end}/${audio.length}` } : {}) });
    streams.add(res); res.once("close", () => streams.delete(res));
    if (req.method === "HEAD") { res.end(); return; }
    if (streamMode === "normal") { res.end(audio.subarray(start, end + 1)); return; }
    // A real partial response with declared full length lets the browser detect a stall.
    res.write(audio.subarray(start, Math.min(end + 1, start + 160_044)));
    if (streamMode === "disconnect") {
      const timer = setTimeout(() => { timers.delete(timer); res.destroy(); }, 100);
      timers.add(timer);
    }
  }
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const endpoint = kind === "navidrome" ? url.pathname.replace(/^\/rest\//, "").replace(/\.view$/, "") : url.pathname;
      const record: MockRequest = { method: req.method ?? "GET", path: url.pathname, endpoint, range: req.headers.range, status: 0 };
      requests.push(record);
      const capture = () => { record.status = res.statusCode; };
      res.once("finish", capture); res.once("close", capture);
      if (unavailable) { json(res, 503, { error: "Acceptance upstream unavailable" }); return; }
      const q = url.searchParams;
      if (kind === "navidrome") {
        const valid = q.get("u") === credentials.username && q.get("t") === createHash("md5").update(credentials.password + (q.get("s") ?? "")).digest("hex");
        if (!valid) { json(res, 200, { "subsonic-response": { status: "failed", error: { code: 40, message: "Wrong username or password" } } }); return; }
        const ok = (data: object = {}) => json(res, 200, { "subsonic-response": { status: "ok", version: "1.16.1", ...data } });
        const page = <T,>(items: T[], limit: string, offset: string) => items.slice(Number(q.get(offset) ?? 0), Number(q.get(offset) ?? 0) + Number(q.get(limit) ?? items.length));
        const query = (q.get("query") ?? "").toLowerCase();
        switch (endpoint) {
          case "ping": case "scrobble": case "updatePlaylist": ok(); return;
          case "getAlbumList2": ok({ albumList2: { album: page([album()], "size", "offset") } }); return;
          case "getAlbum": ok({ album: { ...album(), song: tracks.map(subTrack) } }); return;
          case "getArtists": ok({ artists: { index: [{ name: "A", artist: [artist()] }] } }); return;
          case "getArtist": ok({ artist: { ...artist(), album: [album()] } }); return;
          case "getArtistInfo2": ok({ artistInfo2: {} }); return;
          case "getSong": ok({ song: tracks.find(t => t.id === q.get("id")) ? subTrack(tracks.find(t => t.id === q.get("id"))!) : undefined }); return;
          case "search3": ok({ searchResult3: {
            song: q.get("songCount") === "0" ? [] : page(tracks.filter(t => `${t.title} ${t.artist}`.toLowerCase().includes(query)).map(subTrack), "songCount", "songOffset"),
            album: q.get("albumCount") === "0" || !album().name.toLowerCase().includes(query) ? [] : [album()],
            artist: q.get("artistCount") === "0" || !artist().name.toLowerCase().includes(query) ? [] : [artist()],
          } }); return;
          case "getRandomSongs": case "getTopSongs": ok({ [endpoint === "getTopSongs" ? "topSongs" : "randomSongs"]: { song: tracks.slice(0, Number(q.get("size") ?? q.get("count") ?? 10)).map(subTrack) } }); return;
          case "getStarred2": ok({ starred2: { song: tracks.filter(t => favorites.has(t.id)).map(subTrack), album: [], artist: [] } }); return;
          case "star": favorites.add(q.get("id") ?? ""); ok(); return;
          case "unstar": favorites.delete(q.get("id") ?? ""); ok(); return;
          case "getPlaylists": ok({ playlists: { playlist: [...playlists.values()].map(p => ({ ...p, songCount: p.ids.length })) } }); return;
          case "createPlaylist": {
            const id = q.get("playlistId") ?? `playlist-${playlists.size + 1}`;
            const p = { id, name: q.get("name") ?? "Acceptance Playlist", ids: q.getAll("songId") };
            playlists.set(id, p); ok({ playlist: { ...p, entry: p.ids.flatMap(id => tracks.filter(t => t.id === id).map(subTrack)) } }); return;
          }
          case "getPlaylist": { const p = playlists.get(q.get("id") ?? ""); ok({ playlist: p ? { ...p, entry: p.ids.flatMap(id => tracks.filter(t => t.id === id).map(subTrack)) } : undefined }); return; }
          case "startScan": await options.onScan?.(); ok({ scanStatus: { scanning: false, count: tracks.length } }); return;
          case "getScanStatus": ok({ scanStatus: { scanning: false, count: tracks.length } }); return;
          case "getLyricsBySongId": case "getLyrics": ok({ lyricsList: {} }); return;
          case "stream": stream(req, res); return;
          case "getCoverArt": res.writeHead(200, { "content-type": "image/png" }); res.end(png); return;
        }
      } else {
        if (req.headers["x-emby-token"] !== credentials.apiKey) { json(res, 401, { error: "Invalid API key" }); return; }
        if (url.pathname === "/System/Info") { json(res, 200, { Id: "acceptance-jellyfin", ServerName: "Acceptance Jellyfin", Version: "10.10.0" }); return; }
        if (url.pathname === "/Library/Refresh") { await options.onScan?.(); json(res, 204, null); return; }
        if (/^\/Audio\/[^/]+\/stream$/.test(url.pathname)) { stream(req, res); return; }
        if (/\/Images\/Primary$/.test(url.pathname)) { res.writeHead(200, { "content-type": "image/png" }); res.end(png); return; }
        if (/\/Lyrics$/.test(url.pathname)) { json(res, 200, { Lyrics: [] }); return; }
        if (url.pathname === "/Artists") { json(res, 200, { Items: [{ Id: "artist-1", Name: "Acceptance Artist", Type: "MusicArtist" }], TotalRecordCount: 1 }); return; }
        if (url.pathname === "/Items") {
          const types = q.get("IncludeItemTypes") ?? "Audio";
          let items: Record<string, unknown>[] = [];
          if (types.includes("Audio")) items.push(...tracks.map(jfTrack));
          if (types.includes("MusicAlbum")) items.push({ Id: "album-1", Name: "Acceptance Album", Type: "MusicAlbum", AlbumArtists: [{ Id: "artist-1", Name: "Acceptance Artist" }], ChildCount: tracks.length });
          if (types.includes("MusicArtist")) items.push({ Id: "artist-1", Name: "Acceptance Artist", Type: "MusicArtist" });
          if (q.has("Ids")) items = items.filter(t => q.get("Ids")!.split(",").includes(String(t.Id)));
          if (q.has("searchTerm")) items = items.filter(t => `${t.Name} ${JSON.stringify(t.Artists ?? [])}`.toLowerCase().includes(q.get("searchTerm")!.toLowerCase()));
          const offset = Number(q.get("StartIndex") ?? 0), limit = Number(q.get("Limit") ?? items.length);
          json(res, 200, { Items: items.slice(offset, offset + limit), TotalRecordCount: items.length }); return;
        }
      }
      unexpected.push(`${req.method} ${url.pathname}`);
      json(res, 404, { error: `Unimplemented mock endpoint: ${url.pathname}` });
    })().catch(error => {
      unexpected.push(error instanceof Error ? error.message : String(error));
      if (res.headersSent) res.destroy(); else json(res, 500, { error: "Mock backend failure" });
    });
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind a TCP port");
  let closed = false;
  return {
    kind, url: `http://127.0.0.1:${address.port}`, credentials, requests, unexpected, audio,
    setUnavailable(value: boolean) { unavailable = value; },
    setStreamMode(value: StreamMode) { streamMode = value; },
    setTracks(value: MockTrack[]) { tracks = value; },
    getTracks() { return tracks; },
    disconnectStreams() { for (const response of streams) response.destroy(); },
    get activeConnections() { return sockets.size; },
    async close() {
      if (closed) return; closed = true;
      for (const timer of timers) clearTimeout(timer); timers.clear();
      const done = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await done;
    },
  };
}

export type MockBackend = Awaited<ReturnType<typeof startMockBackend>>;
