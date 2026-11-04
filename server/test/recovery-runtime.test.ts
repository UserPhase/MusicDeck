import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";

test("first-run setup, configuration restart and backup restore work through the real HTTP runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-runtime-recovery-"));
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = (listener.address() as net.AddressInfo).port; await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`; fs.mkdirSync(path.join(root, "music")); fs.mkdirSync(path.join(root, "staging"));
  let child: ChildProcess | undefined, logs = "";
  const request = (url: string, init?: RequestInit) => fetch(base + url, { ...init, signal: AbortSignal.timeout(30_000) });
  async function waitForServer() {
    let last = "No response";
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child?.exitCode !== null) throw new Error(`Runtime exited: ${logs}`);
      try { const response = await request("/api/health"); if (response.ok) return; last = `HTTP ${response.status}: ${await response.text()}`; } catch (error) { last = String(error); }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Runtime did not start (${base}; ${last}): ${logs}`);
  }
  try {
    child = spawn(process.execPath, ["dist/main.js"], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, NODE_ENV: "test", MUSICDECK_HOST: "127.0.0.1", MUSICDECK_PORT: String(port), MUSICDECK_PUBLIC_URL: base, MUSICDECK_CORS_ORIGIN: base,
      MUSICDECK_DB_PATH: path.join(root, "musicdeck.sqlite"), MUSICDECK_MUSIC_ROOT: path.join(root, "music"), MUSICDECK_ACQUISITION_TMP_DIR: path.join(root, "staging"), MUSICDECK_EXTENSIONS_DIR: path.join(root, "extensions"),
      MUSICDECK_SESSION_SECRET: "runtime-recovery-test-secret", MUSICDECK_ADMIN_USERNAME: "admin", MUSICDECK_ADMIN_PASSWORD: "runtime-recovery-test-password", MUSIC_BACKEND: "navidrome", NAVIDROME_URL: "http://127.0.0.1:9", NAVIDROME_USERNAME: "", NAVIDROME_PASSWORD: "", LOCAL_ONLY_MODE: "true", LOG_LEVEL: "error",
    } });
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { logs = (logs + chunk.toString()).slice(-16000); });
    await waitForServer();
    const login = async () => {
      const response = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "runtime-recovery-test-password" }) });
      expect(response.status, logs).toBe(200); return response.headers.get("set-cookie")!.split(";")[0];
    };
    let cookie = await login();
    const status = await (await request("/api/v1/admin/system/status", { headers: { cookie } })).json();
    expect(status.firstRun).toBe(true); expect(status.configuration.navidrome.passwordSet).toBe(false);
    const configuration = { version: 1, backend: "navidrome", navidrome: { url: "http://127.0.0.1:9", username: "configured-user", password: "configured-password" }, jellyfin: { url: "http://127.0.0.1:9", apiKey: "" }, musicRoot: path.join(root, "music"), acquisitionTmpDir: path.join(root, "staging") };
    const saved = await request("/api/v1/admin/system/configuration", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(configuration) });
    expect(saved.status, logs).toBe(202);
    for (let attempt = 0; attempt < 200; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { const response = await request("/api/v1/admin/system/status", { headers: { cookie } }); if (response.ok && (await response.json()).operation.state === "complete") break; } catch { /* Controlled restart. */ }
      if (attempt === 199) throw new Error(`Configuration restart failed: ${logs}`);
    }
    const active = await (await request("/api/v1/admin/system/status", { headers: { cookie } })).json();
    expect(active.configuration.navidrome.username).toBe("configured-user");
    const backupResponse = await request("/api/v1/admin/system/backups", { method: "POST", headers: { cookie } });
    expect(backupResponse.status, logs).toBe(201); const { backup } = await backupResponse.json();
    const archive = await (await request(`/api/v1/admin/system/backups/${backup.id}`, { headers: { cookie } })).arrayBuffer();
    const changed = await request("/api/admin/config", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ appName: "Changed after backup" }) }); expect(changed.status).toBe(200);
    const restored = await request("/api/v1/admin/system/restore", { method: "POST", headers: { cookie, "content-type": "application/gzip", "x-musicdeck-confirm-restore": "replace-system-data" }, body: archive });
    expect(restored.status, logs).toBe(202);
    for (let attempt = 0; attempt < 200; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { if ((await request("/api/v1/admin/system/status", { headers: { cookie } })).status === 401) break; } catch { /* Controlled restart. */ }
      if (attempt === 199) throw new Error(`Restore restart failed: ${logs}`);
    }
    await waitForServer(); cookie = await login();
    const final = await (await request("/api/v1/admin/system/status", { headers: { cookie } })).json();
    expect(final.operation.state).toBe("complete"); expect(final.backups.some((file: { kind: string }) => file.kind === "safety")).toBe(true);
    expect((await (await request("/api/public/config")).json()).appName).not.toBe("Changed after backup");
  } finally {
    if (child && child.exitCode === null) { const closed = once(child, "exit"); child.kill(); await closed; }
    const absolute = path.resolve(root); if (!absolute.startsWith(path.join(os.tmpdir(), "musicdeck-runtime-recovery-"))) throw new Error("Invalid runtime fixture cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
