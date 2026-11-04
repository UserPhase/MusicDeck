import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chromium, type Browser } from "@playwright/test";

/** Own a headless Chromium profile without Playwright's forced-focus override.
 * Focus emulation belongs to its originating CDP session, so a second session
 * cannot disable the override installed by the standard browser fixture.
 */
export async function launchLifecycleBrowser(directory: string) {
  const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  const executable = process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
    (process.platform === "win32" && (!process.env.PLAYWRIGHT_CHANNEL || process.env.PLAYWRIGHT_CHANNEL === "msedge") && await fs.access(edge).then(() => true, () => false)
      ? edge : chromium.executablePath());
  const profile = path.join(directory, "lifecycle-browser");
  await fs.mkdir(profile, { recursive: true });
  // A closed browser leaves its old port file behind; a restart must wait for the new one.
  await fs.unlink(path.join(profile, "DevToolsActivePort")).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  const child = spawn(executable, ["--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--autoplay-policy=no-user-gesture-required",
    ...(process.platform !== "win32" && process.getuid?.() === 0 ? ["--no-sandbox"] : []), "about:blank"],
  { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let failure: Error | undefined, exited = false, stderr = "", browser: Browser | undefined;
  child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
  child.once("error", error => { failure = error; });
  const exit = new Promise<void>(resolve => child.once("exit", () => { exited = true; resolve(); }));
  const close = async () => {
    if (browser) {
      try { const session = await browser.newBrowserCDPSession(); await session.send("Browser.close"); }
      catch { /* Browser.close can close the transport before its reply. */ }
      await browser.close().catch(() => undefined);
    }
    if (!exited && child.pid) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]); }
      finally { if (timer) clearTimeout(timer); }
      if (!exited) {
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else child.kill("SIGKILL");
        await exit;
      }
    }
  };
  try {
    const deadline = Date.now() + 20_000;
    let endpoint: string | undefined, lastPortError = "";
    while (Date.now() < deadline) {
      if (failure || exited) throw new Error(`Lifecycle browser failed to start: ${failure?.message || stderr}`);
      const active = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(error => {
        const code = (error as NodeJS.ErrnoException).code || "unknown";
        // Chromium briefly holds this file exclusively while publishing it on Windows.
        if (["ENOENT", "EBUSY", "EACCES", "EPERM"].includes(code)) { lastPortError = code; return ""; }
        throw error;
      });
      const [port, websocket] = active.trim().split(/\r?\n/);
      if (/^\d+$/.test(port) && websocket?.startsWith("/devtools/browser/")) { endpoint = `ws://127.0.0.1:${port}${websocket}`; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!endpoint) throw new Error(`Lifecycle browser did not expose its debugging endpoint (${lastPortError}): ${stderr}`);
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 15_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("The lifecycle browser has no default context");
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
    return { browser, context, close };
  } catch (error) { await close(); throw error; }
}
