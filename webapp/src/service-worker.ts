/// <reference lib="webworker" />
import { offlineDownloadEngine, permitsAutomaticDownload } from "./services/storage/OfflineDownloadEngine";
import { autoDownloadPolicies } from "./services/storage/AutoDownloadPolicyManager";

import {
  ARTWORK_CACHE_PREFIX, ARTWORK_MAX_AGE_MS, ARTWORK_MAX_ITEMS, CATALOG_CACHE_PREFIX,
  METADATA_CACHE, SHELL_CACHE as SHELL_PREFIX, STATIC_CACHE as STATIC_PREFIX, isAudioRequest, isArtworkCache,
  isArtworkPath, isStaleWebCache, isCatalogPath, isCatalogCache, isPurgeableWebCache,
} from "./services/storage/cachePolicy";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string | null; precache?: boolean }>;
};

// Deliberate downloads live in IndexedDB, never in a generic stream cache.
// Keep this worker self-contained: offline wakeups cannot depend on fetching a new script chunk.
type DownloadSyncEvent = ExtendableEvent & { tag: string };
self.addEventListener("sync", ((event: DownloadSyncEvent) => {
  if (event.tag !== "musicdeck-auto-downloads") return;
  event.waitUntil((async () => {
    const response = await fetch("/api/auth/session", { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Could not authenticate background downloads (${response.status}).`);
    const session = await response.json();
    if (!session.authenticated || !session.user?.id) return;
    // The browser exposes no reliable cost signal in many workers. The shared
    // policy gate pauses unless the user explicitly allowed unknown cost.
    await offlineDownloadEngine.activate(String(session.user.id), false);
    const allowUnknown = await autoDownloadPolicies.allowsUnknownNetwork();
    if (!permitsAutomaticDownload(allowUnknown)) return;
    offlineDownloadEngine.setAutomaticGate(() => permitsAutomaticDownload(allowUnknown));
    await offlineDownloadEngine.activate(String(session.user.id), true);
    await autoDownloadPolicies.reconcile();
    await offlineDownloadEngine.drain();
    if (offlineDownloadEngine.getSnapshot().jobs.some((job) => job.state !== "failed")) throw new Error("Downloads remain queued; retry background sync later.");
    for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "MUSICDECK_DOWNLOAD_SYNC_COMPLETE" });
  })());
}) as EventListener);

const manifest = self.__WB_MANIFEST;
// Isolate installing/waiting builds so they cannot replace an active tab's shell.
const fingerprint = JSON.stringify(manifest).split("").reduce((hash, character) =>
  Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(16);
const SHELL_CACHE = `${SHELL_PREFIX}-${fingerprint}`;
const STATIC_CACHE = `${STATIC_PREFIX}-${fingerprint}`;
const scope = new URL(self.registration.scope);
const shellUrl = new URL("index.html", scope).href;
const staticUrls = new Set(manifest.map((entry) => new URL(entry.url, scope).href));
const TIMESTAMP_HEADER = "x-musicdeck-cached-at";
let owner: string | null = null;
let externalArtwork = false;
let metadataMode: boolean | null = null;
let generation = 0;
let writes: Promise<void> = Promise.resolve();

function report(error: unknown): void { console.error("MusicDeck offline cache:", error); }
function publicAsset(url: URL): boolean {
  return url.origin === scope.origin && staticUrls.has(url.href) && url.href !== shellUrl;
}
function acceptable(response: Response): boolean {
  return response.status === 200 && response.type !== "opaque" && !response.headers.has("content-range");
}
function serialize(operation: () => Promise<void>): Promise<void> {
  const next = writes.then(operation);
  writes = next.catch(report);
  return next;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    const assets = await caches.open(STATIC_CACHE);
    await Promise.all(manifest.filter(({ precache }) => precache !== false).map(async ({ url, revision }) => {
      const target = new URL(url, scope).href;
      const response = await fetch(new Request(target, {
        cache: revision === null ? "default" : "reload", credentials: "same-origin",
      }));
      if (!acceptable(response) || (target !== shellUrl && isHtml(response))) {
        throw new Error(`Could not prepare offline asset (${response.status})`);
      }
      await (target === shellUrl ? shell : assets).put(target, response);
    }));
    // Updates wait for existing tabs to close; never reload a playing session.
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter(isStaleWebCache).map((name) => caches.delete(name)));
    await caches.delete(METADATA_CACHE);
    for (const name of await caches.keys()) {
      if (((name === SHELL_PREFIX || name.startsWith(`${SHELL_PREFIX}-`)) && name !== SHELL_CACHE) ||
          ((name === STATIC_PREFIX || name.startsWith(`${STATIC_PREFIX}-`)) && name !== STATIC_CACHE)) await caches.delete(name);
    }
    const assets = await caches.open(STATIC_CACHE);
    for (const request of await assets.keys()) if (!staticUrls.has(request.url)) await assets.delete(request);
    await self.clients.claim();
    for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "MUSICDECK_REQUEST_CACHE_POLICY" });
  })());
});

async function accountCache(request: Request, event: FetchEvent, kind: "artwork" | "catalog"): Promise<Response> {
  if (request.cache === "no-store" || request.cache === "reload") return fetch(request);
  await writes;
  const epoch = generation;
  const account = owner;
  if (!account) return fetch(request);
  const name = kind === "artwork" ? `${ARTWORK_CACHE_PREFIX}${encodeURIComponent(account)}`
    : `${CATALOG_CACHE_PREFIX}${encodeURIComponent(account)}-${metadataMode ? "enriched" : "local"}`;
  const cache = await caches.open(name);
  const cached = await cache.match(request);
  if (epoch !== generation || account !== owner) return fetch(request);
  if (cached) {
    const timestamp = Number(cached.headers.get(TIMESTAMP_HEADER));
    if (timestamp > 0 && Date.now() - timestamp < ARTWORK_MAX_AGE_MS) return cached;
    await cache.delete(request);
  }
  const response = await fetch(request, { cache: "no-store" });
  const contentType = response.headers.get("content-type") || "";
  if (acceptable(response) && (kind === "artwork" ? contentType.startsWith("image/") : contentType.includes("application/json")) &&
      (kind === "artwork" || !/\bno-store\b/i.test(response.headers.get("cache-control") || ""))) {
    const copy = response.clone();
    event.waitUntil(serialize(async () => {
      if (epoch !== generation || account !== owner) return;
      const headers = new Headers(copy.headers);
      headers.set(TIMESTAMP_HEADER, String(Date.now()));
      await cache.put(request, new Response(copy.body, { status: copy.status, statusText: copy.statusText, headers }));
      const keys = await cache.keys();
      for (const key of keys.slice(0, Math.max(0, keys.length - ARTWORK_MAX_ITEMS))) await cache.delete(key);
    }));
  }
  return response;
}
function isHtml(response: Response): boolean {
  return response.headers.get("content-type")?.includes("text/html") ?? false;
}
async function cacheFirstAsset(request: Request, event: FetchEvent): Promise<Response> {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (acceptable(response) && !isHtml(response)) {
    event.waitUntil(cache.put(request, response.clone()).catch(report));
  }
  return response;
}
async function navigate(request: Request): Promise<Response> {
  try { return await fetch(request); }
  catch (error) {
    const shell = await (await caches.open(SHELL_CACHE)).match(shellUrl);
    if (shell) return shell;
    report(error);
    return new Response("MusicDeck is offline. Reconnect once to prepare this device.", {
      status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Never intercept audio, Range requests, third-party URLs or mutations.
  if (url.origin !== scope.origin || isAudioRequest(request)) return;
  if (request.method !== "GET") {
    if (url.pathname.startsWith("/api/")) {
      generation++;
      event.waitUntil(serialize(async () => {
        for (const name of (await caches.keys()).filter(isCatalogCache)) await caches.delete(name);
      }));
    }
    return;
  }
  if (request.mode === "navigate" && !url.pathname.startsWith("/api/")) {
    event.respondWith(navigate(request));
  } else if (isArtworkPath(url.pathname)) {
    const external = url.pathname.startsWith("/api/artwork/external/");
    if (!owner && event.clientId) event.waitUntil(self.clients.get(event.clientId).then((client) => {
      client?.postMessage({ type: "MUSICDECK_REQUEST_CACHE_POLICY" });
    }));
    if (owner && (!external || externalArtwork)) event.respondWith(accountCache(request, event, "artwork"));
  } else if (isCatalogPath(url.pathname)) {
    if (!owner && event.clientId) event.waitUntil(self.clients.get(event.clientId).then((client) => {
      client?.postMessage({ type: "MUSICDECK_REQUEST_CACHE_POLICY" });
    }));
    if (owner && metadataMode !== null) event.respondWith(accountCache(request, event, "catalog"));
  } else if (publicAsset(url)) {
    event.respondWith(cacheFirstAsset(request, event));
  }
  // Search, external entities, privacy, settings and session APIs stay network-only.
});
self.addEventListener("message", (event) => {
  const message: unknown = event.data;
  if (!message || typeof message !== "object" || !("type" in message)) return;
  if (message.type === "MUSICDECK_CACHE_POLICY" && "owner" in message && "externalArtwork" in message &&
      (message.owner === null || typeof message.owner === "string") && typeof message.externalArtwork === "boolean") {
    const previous = owner;
    const previousMetadata = metadataMode;
    owner = message.owner;
    externalArtwork = message.externalArtwork;
    metadataMode = "metadata" in message && typeof message.metadata === "boolean" ? message.metadata : null;
    generation++;
    event.waitUntil(serialize(async () => {
      if (previous !== owner || previousMetadata !== metadataMode) {
        for (const name of (await caches.keys()).filter(isCatalogCache)) await caches.delete(name);
      }
      if (previous !== owner || !externalArtwork) {
        for (const name of (await caches.keys()).filter(isArtworkCache)) {
          if (previous !== owner) await caches.delete(name);
          else {
            const cache = await caches.open(name);
            for (const key of await cache.keys()) {
              if (new URL(key.url).pathname.startsWith("/api/artwork/external/")) await cache.delete(key);
            }
          }
        }
      }
    }));
  } else if (message.type === "MUSICDECK_CLEAR_IMAGES" || message.type === "MUSICDECK_PURGE_STALE") {
    generation++;
    const command = message.type;
    event.waitUntil(serialize(async () => {
      const names = (await caches.keys()).filter(command === "MUSICDECK_CLEAR_IMAGES" ? isArtworkCache : isPurgeableWebCache);
      let removed = 0;
      for (const name of names) if (await caches.delete(name)) removed++;
      event.ports[0]?.postMessage({ removed });
    }).catch((error: unknown) => {
      report(error);
      event.ports[0]?.postMessage({ error: error instanceof Error ? error.message : "Cache cleanup failed" });
    }));
  }
});

export {};
