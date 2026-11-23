import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { MockBackend } from "./mockBackends.js";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(path.join(root, "webapp/package.json"));
const esbuild: typeof import("../../../webapp/node_modules/esbuild/lib/main.js") = require("esbuild");

/** Build current source, never a possibly stale webapp/build directory. */
export async function buildAcceptanceBrowser(directory: string) {
  await fs.mkdir(directory, { recursive: true });
  const probe = path.join(root, "tests/acceptance/helpers/browserProbe.tsx");
  await esbuild.build({
    entryPoints: [path.join(root, "webapp/src/index.js")],
    outfile: path.join(directory, "app.js"), bundle: true, platform: "browser",
    jsx: "automatic", loader: { ".js": "jsx", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".woff2": "dataurl" },
    nodePaths: [path.join(root, "webapp/node_modules")],
    define: { "process.env.NODE_ENV": '"production"', "process.env.PUBLIC_URL": '""', "process.env": "{}" },
    plugins: [{ name: "acceptance-observation", setup(build) {
      build.onLoad({ filter: /[\\/]App\.js$/ }, async args => ({ loader: "jsx", resolveDir: path.dirname(args.path),
        contents: `import { AcceptanceProbeComponent } from ${JSON.stringify(probe)};\n` +
          (await fs.readFile(args.path, "utf8")).replace("<AppContent />", "<AcceptanceProbeComponent /><AppContent />") }));
      build.onLoad({ filter: /[\\/]PlayerContext\.tsx$/ }, async args => ({ loader: "tsx", resolveDir: path.dirname(args.path),
        contents: (await fs.readFile(args.path, "utf8")).replace("engineRef.current = engine;", "engineRef.current = engine; if (window.__acceptance) window.__acceptance.engine = engine;") }));
    } }],
  });
  await esbuild.build({ entryPoints: [path.join(root, "webapp/src/service-worker.ts")], outfile: path.join(directory, "service-worker.js"), bundle: true, platform: "browser", define: { "process.env.PUBLIC_URL": '""', "self.__WB_MANIFEST": JSON.stringify(["index.html", "app.js", "app.css"].map(url => ({ url, revision: "acceptance" }))) } });
  await fs.writeFile(path.join(directory, "index.html"), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MusicDeck Acceptance</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script defer src="/app.js"></script></body></html>');
  await fs.writeFile(path.join(directory, "asset-manifest.json"), JSON.stringify({ files: { main: "/app.js", css: "/app.css" }, entrypoints: ["app.js", "app.css"] }));
}

export type Db = DatabaseSync;

export function transaction(db: Db, work: () => void) {
  db.exec("BEGIN");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function fixtureConfig(directory: string, nav: MockBackend, jelly: MockBackend, localOnlyMode: boolean) {
  return {
    directory, nav, jelly, localOnlyMode,
    databasePath: path.join(directory, "data", "musicdeck.sqlite"),
    musicRoot: path.join(directory, "music"),
    acquisitionTmpDir: path.join(directory, "staging"),
  };
}

type FixtureConfig = ReturnType<typeof fixtureConfig>;
const binaryDirectory = path.resolve(process.env.CARGO_TARGET_DIR || path.join(root, "server-rust", "target"), "debug");
const binary = (name: string) => path.join(binaryDirectory, process.platform === "win32" ? `${name}.exe` : name);

function fixtureEnv(config: FixtureConfig, publicUrl = "http://127.0.0.1", port = 4534) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(MUSICDECK_|NAVIDROME_|JELLYFIN_|SPOTDL_|LOCAL_ONLY_MODE$)/i.test(key)
  ));
  return {
    ...env,
    MUSICDECK_ENV: "development",
    MUSICDECK_BIND_ADDR: `127.0.0.1:${port}`,
    MUSICDECK_PUBLIC_URL: publicUrl,
    MUSICDECK_CORS_ORIGIN: publicUrl,
    MUSICDECK_SECURE_COOKIES: "false",
    MUSICDECK_DB_PATH: config.databasePath,
    MUSICDECK_MUSIC_ROOT: config.musicRoot,
    MUSICDECK_ACQUISITION_TMP_DIR: config.acquisitionTmpDir,
    MUSICDECK_EXTENSIONS_DIR: path.join(config.directory, "extensions"),
    MUSICDECK_SESSION_SECRET: "acceptance-session-secret-at-least-32-characters",
    MUSICDECK_ADMIN_USERNAME: "admin",
    MUSICDECK_ADMIN_PASSWORD: "acceptance-admin-password",
    MUSIC_BACKEND: "navidrome",
    NAVIDROME_URL: config.nav.url,
    NAVIDROME_USERNAME: config.nav.credentials.username,
    NAVIDROME_PASSWORD: config.nav.credentials.password,
    JELLYFIN_URL: config.jelly.url,
    JELLYFIN_API_KEY: config.jelly.credentials.apiKey,
    LOCAL_ONLY_MODE: String(config.localOnlyMode),
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
  return address.port;
}

async function reservePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

export async function startApplication(config: FixtureConfig, browserDirectory: string, options: {
  dual?: boolean; initialize?: (db: Db) => void;
} = {}) {
  // Keep dotenv from searching parent directories for the developer's settings.
  await fs.writeFile(path.join(config.directory, ".env"), "");
  await fs.mkdir(config.musicRoot, { recursive: true });
  await fs.mkdir(config.acquisitionTmpDir, { recursive: true });
  const port = await reservePort();
  const backend = { hostname: "127.0.0.1", port };
  const sockets = new Set<Socket>();
  const trackSocket = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const types: Record<string, string> = {
    "/app.js": "application/javascript", "/app.css": "text/css",
    "/service-worker.js": "application/javascript", "/asset-manifest.json": "application/json",
  };
  const gateway = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname.startsWith("/api/")) {
      const upstream = request({ ...backend, path: req.url, method: req.method, headers: req.headers }, incoming => {
        res.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.on("error", () => res.destroy());
        res.on("close", () => incoming.destroy());
        incoming.pipe(res);
      });
      upstream.on("error", () => {
        if (res.headersSent) res.destroy();
        else res.writeHead(502).end();
      });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    const filename = types[pathname] ? pathname.slice(1) : "index.html";
    void fs.readFile(path.join(browserDirectory, filename)).then(data => {
      res.writeHead(200, { "content-type": types[pathname] ?? "text/html", "cache-control": "no-cache" }).end(data);
    }, () => res.writeHead(404).end());
  });
  gateway.on("connection", trackSocket);
  gateway.on("upgrade", (req, socket, head) => {
    const upstream = connect({ host: backend.hostname, port }, () => {
      const headers = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    trackSocket(upstream);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  const url = `http://127.0.0.1:${await listen(gateway)}`;
  const env = fixtureEnv(config, url, port);
  let db: Db | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let terminated: Promise<void> | undefined;
  const close = async () => {
    const gatewayClosed = new Promise<void>(resolve => gateway.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    if (db?.isOpen) db.close();
    if (child && terminated && child.exitCode === null && child.signalCode === null) {
      child.kill();
      const deadline = new AbortController();
      try {
        const exited = await Promise.race([terminated.then(() => true), delay(5000, false, { signal: deadline.signal })]);
        if (!exited) child.kill("SIGKILL");
      } finally {
        deadline.abort();
      }
    }
    await terminated;
    await gatewayClosed;
  };
  try {
    await promisify(execFile)(binary("init_db"), options.initialize ? ["--target-version", "38"] : [],
      { cwd: config.directory, env, windowsHide: true, timeout: 20_000 });
    db = new DatabaseSync(config.databasePath);
    db.exec("PRAGMA busy_timeout = 5000");
    const insert = db.prepare("INSERT OR REPLACE INTO backend_connections(id,type,name,config_json,enabled,created_at,updated_at) VALUES(?,?,?,?,1,?,?)");
    transaction(db, () => {
      db!.exec("UPDATE backend_connections SET enabled=0");
      insert.run("acceptance-nav", "navidrome", "Acceptance Navidrome", JSON.stringify({ url: config.nav.url }), "2024-01-01", "2024-01-01");
      if (options.dual) insert.run("acceptance-jelly", "jellyfin", "Acceptance Jellyfin", JSON.stringify({ url: config.jelly.url }), "2024-01-01", "2024-01-01");
      options.initialize?.(db!);
    });
    child = spawn(binary("musicdeck-server"), [], { cwd: config.directory, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "", startupError: Error | undefined;
    const remember = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-16000); };
    child.stdout?.on("data", remember);
    child.stderr?.on("data", remember);
    child.once("error", error => { startupError = error; });
    terminated = new Promise<void>(resolve => child!.once("close", () => resolve()));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !startupError && child.exitCode === null) {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
      if (response?.ok) return { url, db, config, close };
      await delay(100);
    }
    throw new Error(`Rust acceptance server did not start: ${startupError?.message ?? logs}`);
  } catch (error) {
    await close();
    throw error;
  }
}

export type Application = Awaited<ReturnType<typeof startApplication>>;
