import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "../db/database.js";
import type { AppConfig } from "../config.js";

export type PrivacyCategory = "metadata" | "imports" | "artwork" | "external";
export interface PrivacySettings {
  localOnly: boolean;
  allowMetadata: boolean;
  allowImports: boolean;
  allowArtwork: boolean;
}
export interface PrivacySnapshot extends PrivacySettings {
  enforcedByEnvironment: boolean;
  effective: Record<PrivacyCategory, boolean>;
}
export class PrivacyBlockedError extends Error {
  readonly statusCode = 403;
  constructor(readonly code: "LOCAL_ONLY_MODE_ACTIVE" | "EXTERNAL_INTEGRATION_DISABLED") {
    super(code === "LOCAL_ONLY_MODE_ACTIVE" ? "Local Only Mode Active" : "External integration disabled by server privacy policy");
    this.name = "PrivacyBlockedError";
  }
}
const DEFAULTS: PrivacySettings = { localOnly: false, allowMetadata: true, allowImports: true, allowArtwork: true };
const scope = new AsyncLocalStorage<PrivacyManager>();
const gatedTransports = new WeakMap<typeof fetch, { transport: typeof fetch; category?: PrivacyCategory }>();
let runtime: PrivacyManager | undefined;

/** Production installs before constructing providers/plugins; request scope isolates server instances in tests. */
export function setRuntimePrivacyManager(manager: PrivacyManager): void { runtime = manager; }
export function currentPrivacyManager(): PrivacyManager | undefined { return scope.getStore() ?? runtime; }
export const privacyFetch: typeof fetch = (input, init) =>
  currentPrivacyManager()?.fetch(input, init) ?? globalThis.fetch(input, init);
export const privacyArtworkFetch: typeof fetch = (input, init) =>
  currentPrivacyManager()?.fetch(input, init, globalThis.fetch, "artwork") ?? globalThis.fetch(input, init);
export function gateFetch(transport: typeof fetch = privacyFetch, category?: PrivacyCategory): typeof fetch {
  const existing = gatedTransports.get(transport);
  if (existing && (category === undefined || category === existing.category)) return transport;
  const underlying = existing?.transport ?? transport;
  const classification = category ?? existing?.category ?? (transport === privacyArtworkFetch ? "artwork" : undefined);
  const gated: typeof fetch = (input, init) => {
    const manager = currentPrivacyManager();
    const native = underlying === privacyFetch || underlying === privacyArtworkFetch ? globalThis.fetch : underlying;
    return manager ? manager.fetch(input, init, native, classification) : native(input, init);
  };
  gatedTransports.set(gated, { transport: underlying, category: classification });
  return gated;
}

export function createPrivacyManager(db: Db, config: AppConfig): PrivacyManager {
  const rows = db.prepare("SELECT type, config_json FROM backend_connections WHERE enabled = 1")
    .all() as { type: string; config_json: string }[];
  const urls = rows.map((row) => {
    const stored: unknown = JSON.parse(row.config_json);
    const url = stored && typeof stored === "object" && "url" in stored && typeof stored.url === "string" ? stored.url : "";
    return row.type === "navidrome" ? config.navidrome.url || url : row.type === "jellyfin" ? config.jellyfin.url || url : "";
  });
  if (!rows.length) urls.push(config[config.backend].url);
  return new PrivacyManager(db, config.localOnlyMode, urls);
}

function categoryFor(url: URL): PrivacyCategory {
  const host = url.hostname.toLowerCase();
  if (/(^|\.)(scdn\.co|mzstatic\.com|deezercover\.com|coverartarchive\.org|fanart\.tv|wikimedia\.org|discogs\.com)$/.test(host) ||
      host === "e-cdns-images.dzcdn.net" || /\.(jpe?g|png|webp|gif|avif)(\/|$)/i.test(url.pathname)) return "artwork";
  if (/(^|\.)(spotify\.com|spotifycdn\.com)$/.test(host)) return "imports";
  if (/(^|\.)(last\.fm|audioscrobbler\.com|listenbrainz\.org)$/.test(host)) return "external";
  return "metadata";
}

export class PrivacyManager {
  private settings: PrivacySettings;
  private readonly active = new Set<{ allowed(): boolean; cancel(): void | Promise<void> }>();
  private readonly libraries: URL[];
  constructor(private readonly db: Db, private readonly environmentLock = false, libraryUrls: string[] = []) {
    this.libraries = libraryUrls.filter(Boolean).map((value) => new URL(value));
    const row = db.prepare("SELECT value FROM server_settings WHERE key = 'privacy.policy'").get() as { value: string } | undefined;
    if (!row) this.settings = { ...DEFAULTS };
    else {
      const parsed: unknown = JSON.parse(row.value);
      if (!parsed || typeof parsed !== "object" || Object.keys(DEFAULTS).some((key) =>
        typeof (parsed as Record<string, unknown>)[key] !== "boolean")) throw new Error("Invalid stored privacy policy; refusing to start");
      this.settings = parsed as PrivacySettings;
    }
  }
  run<T>(operation: () => T): T { return scope.run(this, operation); }
  isExternalAllowed(category: PrivacyCategory = "external"): boolean {
    if (this.environmentLock || this.settings.localOnly) return false;
    return category === "metadata" ? this.settings.allowMetadata : category === "imports"
      ? this.settings.allowImports && this.settings.allowMetadata && this.settings.allowArtwork
      : category === "artwork" ? this.settings.allowArtwork
        : this.settings.allowMetadata && this.settings.allowImports && this.settings.allowArtwork;
  }
  assertExternalAllowed(category: PrivacyCategory = "external"): void {
    if (!this.isExternalAllowed(category)) throw new PrivacyBlockedError(
      this.environmentLock || this.settings.localOnly ? "LOCAL_ONLY_MODE_ACTIVE" : "EXTERNAL_INTEGRATION_DISABLED");
  }
  snapshot(): PrivacySnapshot {
    return { ...this.settings, enforcedByEnvironment: this.environmentLock,
      effective: { metadata: this.isExternalAllowed("metadata"), imports: this.isExternalAllowed("imports"),
        artwork: this.isExternalAllowed("artwork"), external: this.isExternalAllowed() } };
  }
  async update(settings: PrivacySettings): Promise<PrivacySnapshot> {
    if (Object.keys(DEFAULTS).some((key) => typeof settings[key as keyof PrivacySettings] !== "boolean") ||
      Object.keys(settings).some((key) => !(key in DEFAULTS))) throw new Error("Invalid privacy policy");
    this.db.prepare(`INSERT INTO server_settings (key,value,updated_at) VALUES ('privacy.policy',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(JSON.stringify(settings), new Date().toISOString());
    this.settings = { ...settings };
    const cancellations: (void | Promise<void>)[] = [];
    for (const operation of this.active) if (!operation.allowed()) cancellations.push(operation.cancel());
    await Promise.all(cancellations);
    return this.snapshot();
  }
  private isLibrary(url: URL): boolean {
    return this.libraries.some((base) => url.origin === base.origin &&
      (url.pathname === base.pathname.replace(/\/$/, "") || url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)));
  }
  assertUrlAllowed(input: string | URL, category?: PrivacyCategory): void {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported outbound protocol");
    if (!this.isLibrary(url)) this.assertExternalAllowed(category ?? categoryFor(url));
  }
  track(category: PrivacyCategory, cancel: () => void | Promise<void>): () => void {
    this.assertExternalAllowed(category);
    const operation = { allowed: () => this.isExternalAllowed(category), cancel };
    this.active.add(operation);
    return () => { this.active.delete(operation); };
  }
  async fetch(input: Parameters<typeof fetch>[0], init?: RequestInit, transport: typeof fetch = globalThis.fetch, category?: PrivacyCategory): Promise<Response> {
    let request = input instanceof Request
      ? new Request(input.url, { method: input.method, headers: input.headers, signal: input.signal,
        redirect: input.redirect, ...init, body: undefined })
      : new Request(input, { ...init, body: undefined });
    const controller = new AbortController();
    const allowed = () => {
      try { this.assertUrlAllowed(request.url, category); return true; }
      catch (error) { if (error instanceof PrivacyBlockedError) return false; throw error; }
    };
    this.assertUrlAllowed(request.url, category);
    const operation = { allowed, cancel: () => controller.abort(new PrivacyBlockedError(
      this.environmentLock || this.settings.localOnly ? "LOCAL_ONLY_MODE_ACTIVE" : "EXTERNAL_INTEGRATION_DISABLED")) };
    this.active.add(operation);
    const release = () => this.active.delete(operation);
    try {
      for (let redirects = 0; redirects <= 10; redirects++) {
        this.assertUrlAllowed(request.url, category);
        const response = await transport(redirects === 0 ? input : request.url, {
          ...(redirects === 0 ? init : { method: request.method, headers: request.headers }),
          redirect: "manual", signal: AbortSignal.any([request.signal, controller.signal]),
        });
        if (controller.signal.aborted) {
          await response.body?.cancel();
          controller.signal.throwIfAborted();
        }
        if ([301, 302, 303, 307, 308].includes(response.status) && request.redirect !== "manual") {
          if (request.redirect === "error") { await response.body?.cancel(); throw new Error("Outbound redirect disallowed"); }
          const location = response.headers.get("location");
          if (!location) { release(); return response; }
          const target = new URL(location, request.url);
          await response.body?.cancel();
          this.assertUrlAllowed(target, category);
          const method = response.status === 303 && request.method !== "HEAD" ||
            [301, 302].includes(response.status) && request.method === "POST" ? "GET" : request.method;
          if (!["GET", "HEAD"].includes(method)) throw new Error("Cannot safely replay outbound request body across a redirect");
          const headers = new Headers(request.headers);
          if (target.origin !== new URL(request.url).origin) {
            for (const key of ["authorization", "cookie", "proxy-authorization", "x-emby-token", "x-mediabrowser-token"]) headers.delete(key);
          }
          for (const key of ["content-type", "content-length"]) headers.delete(key);
          request = new Request(target, { method, headers, signal: request.signal, redirect: request.redirect });
          continue;
        }
        if (!response.body) { release(); return response; }
        const reader = response.body.getReader();
        let cancelled = false;
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          release(); controller.signal.removeEventListener("abort", cancel); reader.releaseLock();
        };
        const cancel = () => {
          void reader.cancel(controller.signal.reason).then(cleanup, (error: unknown) => {
            cleanup(); console.warn("Could not cancel privacy-blocked response", error);
          });
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
        if (controller.signal.aborted) cancel();
        return new Response(new ReadableStream<Uint8Array>({
          async pull(destination) {
            try {
              controller.signal.throwIfAborted();
              const next = await reader.read();
              if (cancelled) return;
              controller.signal.throwIfAborted();
              if (next.done) { cleanup(); destination.close(); }
              else destination.enqueue(next.value);
            } catch (error) { if (!cancelled) { cleanup(); destination.error(error); } }
          },
          async cancel(reason) { cancelled = true; try { await reader.cancel(reason); } finally { cleanup(); } },
        }), { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      throw new Error("Too many outbound redirects");
    } catch (error) { release(); throw error; }
  }
}
