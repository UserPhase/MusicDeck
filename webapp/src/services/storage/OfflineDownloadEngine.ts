import { getStreamUrl } from "../../api/musicdeck";
import { downloadKey, downloadTransaction, listDownloads, readDownload } from "./offlineDatabase";

export interface DownloadTrack {
  id: string | number;
  title?: string;
  artist?: string;
  album?: string;
  albumId?: string | null;
  duration?: number | null;
  [key: string]: unknown;
}
export interface OfflineManifest {
  key: string;
  owner: string;
  track_id: string;
  track: DownloadTrack;
  file_size: number;
  bitrate: number | null;
  quality: string;
  downloaded_at: string;
  checksum: string;
  content_type: string;
  status: "verified" | "corrupt" | "missing";
}
interface MediaRecord { key: string; owner: string; blob: Blob }
export interface DownloadJob {
  key: string;
  owner: string;
  track: DownloadTrack;
  quality: string;
  automatic: boolean;
  state: "queued" | "downloading" | "failed";
  received: number;
  total: number | null;
  partial?: Blob;
  validator?: string;
  contentType?: string;
  attempts: number;
  retryAt: number;
  leaseUntil: number;
  token: string;
  error?: string;
}
export interface OfflineCollection {
  key: string; owner: string; id: string; kind: "album" | "playlist" | "favorites";
  name: string; trackIds: string[];
}
export interface DownloadSnapshot { tracks: OfflineManifest[]; jobs: DownloadJob[]; collections: OfflineCollection[]; error: string | null }
export interface StorageBoundary { mode: "web"; usage: number | null; quota: number | null; persistent: boolean }
const EMPTY: DownloadSnapshot = { tracks: [], jobs: [], collections: [], error: null };
const MAX_TRACK_BYTES = 512 * 1024 * 1024;
const LEASE_MS = 90_000;
const CHECKPOINT_BYTES = 4 * 1024 * 1024;
export const DOWNLOADS_CHANGED = "musicdeck:downloads-changed";
export const AUTO_SYNC_TAG = "musicdeck-auto-downloads";
const isOffline = () => navigator.onLine === false;
export const messageOf = (error: unknown): string => {
  if (error instanceof DOMException && error.name === "QuotaExceededError") return "Browser storage is full. Remove downloads or free device space, then retry.";
  return error instanceof Error ? error.message : "Offline storage could not complete the operation.";
};
function qualityOf(value: string): string {
  if (["original", "lossless", "raw"].includes(value)) return "lossless";
  return `${["128", "192", "256", "320"].find((rate) => value.startsWith(rate)) ?? "320"}kbps`;
}
export async function checksumBlob(blob: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Integrity verification requires HTTPS or localhost.");
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
type Connection = EventTarget & { type?: string; saveData?: boolean; metered?: boolean };
export function networkConnection(): Connection | undefined {
  return (navigator as Navigator & { connection?: Connection }).connection;
}
/** effectiveType describes speed, not billing. Unknown cost is never assumed unmetered. */
export function permitsAutomaticDownload(allowUnknown = false): boolean {
  if (navigator.onLine === false) return false;
  const connection = networkConnection();
  if (connection?.saveData || connection?.metered || connection?.type === "cellular") return false;
  return connection?.type === "wifi" || connection?.type === "ethernet" || connection?.metered === false || allowUnknown;
}
export async function storageBoundary(): Promise<StorageBoundary> {
  const [estimateResult, persistentResult] = await Promise.allSettled([
    navigator.storage?.estimate?.() ?? Promise.resolve({} as StorageEstimate),
    navigator.storage?.persisted?.() ?? Promise.resolve(false),
  ]);
  const estimate = estimateResult.status === "fulfilled" ? estimateResult.value : {} as StorageEstimate;
  const persistent = persistentResult.status === "fulfilled" ? persistentResult.value : false;
  return { mode: "web", usage: estimate.usage ?? null, quota: estimate.quota ?? null, persistent };
}

/** Browser implementation. Native builds must supply their own file-store adapter;
 * installing the PWA never changes this implementation's storage guarantees. */
export class OfflineDownloadEngine {
  private owner: string | null = null;
  private networkEnabled = false;
  private epoch = 0;
  private running: Promise<void> | null = null;
  private wakeRequested = false;
  private snapshot = EMPTY;
  private listeners = new Set<() => void>();
  private controllers = new Map<string, AbortController>();
  private urls = new Map<string, { url: string; checksum: string }>();
  private channel: BroadcastChannel | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private automaticAllowed: () => boolean = () => permitsAutomaticDownload();
  private refreshId = 0;
  getOwner = (): string | null => this.owner;
  getSnapshot = (): DownloadSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  async activate(owner: string | null, networkEnabled = true, broadcastIdentity = true): Promise<void> {
    if (this.owner === owner && this.networkEnabled === networkEnabled) return;
    this.epoch++;
    this.controllers.forEach((controller) => controller.abort());
    this.urls.forEach(({ url }) => URL.revokeObjectURL(url)); this.urls.clear();
    this.owner = owner; this.networkEnabled = networkEnabled;
    if (this.timer) clearTimeout(this.timer);
    this.publish(EMPTY);
    if (!this.channel && typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(DOWNLOADS_CHANGED);
      this.channel.onmessage = (event) => {
        if (event.data?.type === "owner-change" && event.data.owner !== this.owner) {
          void this.activate(null, false, false);
          if (typeof window !== "undefined") window.dispatchEvent(new Event("musicdeck:downloads-account-invalidated"));
          return;
        }
        void this.refresh().then(() => this.kick());
      };
    }
    if (broadcastIdentity && (networkEnabled || owner === null)) this.channel?.postMessage({ type: "owner-change", owner });
    await this.refresh();
    if (networkEnabled) this.kick();
  }

  setAutomaticGate(gate: () => boolean): void { this.automaticAllowed = gate; }
  private requireOwner(): string {
    if (!this.owner) throw new Error("Sign in once on this device before saving offline music.");
    return this.owner;
  }
  private publish(snapshot: DownloadSnapshot): void { this.snapshot = snapshot; this.listeners.forEach((listener) => listener()); }
  async refresh(): Promise<void> {
    const owner = this.owner, refresh = ++this.refreshId;
    if (!owner) { this.publish(EMPTY); return; }
    try {
      const [tracks, jobs, collections] = await Promise.all([
        listDownloads<OfflineManifest>("manifest", owner), listDownloads<DownloadJob>("queue", owner),
        listDownloads<OfflineCollection>("collections", owner),
      ]);
      if (owner === this.owner && refresh === this.refreshId) this.publish({ tracks, jobs, collections, error: null });
    } catch (error) { if (owner === this.owner && refresh === this.refreshId) this.publish({ ...this.snapshot, error: messageOf(error) }); }
  }
  private async changed(trackId?: string, purged = false): Promise<void> {
    await this.refresh();
    this.channel?.postMessage({ owner: this.owner });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(purged ? "musicdeck:offline-purged" : "musicdeck:offline-download", { detail: { trackId } }));
      window.dispatchEvent(new Event(DOWNLOADS_CHANGED));
    }
  }

  async enqueueDownload(track: DownloadTrack, quality = "320kbps", automatic = false): Promise<void> {
    return this.enqueueDownloads([track], quality, automatic);
  }

  /** Persist an explicit batch atomically, so navigation cannot leave half the selection unqueued. */
  async enqueueDownloads(tracks: DownloadTrack[], quality = "320kbps", automatic = false): Promise<void> {
    const owner = this.requireOwner();
    if (tracks.some((track) => track.id === undefined || track.id === null || !String(track.id))) throw new Error("A track ID is required.");
    const copies: DownloadTrack[] = [...new Map(tracks.map((track) => [String(track.id), JSON.parse(JSON.stringify(track)) as DownloadTrack])).values()];
    quality = qualityOf(quality);
    const enqueued = await downloadTransaction<boolean>(["queue", "manifest"], "readwrite", (tx, done) => {
      done(false);
      for (const copy of copies) {
        const key = downloadKey(owner, String(copy.id));
        const manifest = tx.objectStore("manifest").get(key);
        manifest.onsuccess = () => {
          if (manifest.result?.status === "verified" && manifest.result.quality === quality) return;
          const queue = tx.objectStore("queue"), existing = queue.get(key);
          existing.onsuccess = () => {
            const job: DownloadJob | undefined = existing.result;
            if (job && job.state !== "failed" && job.quality === quality) {
              if (!automatic && job.automatic) { queue.put({ ...job, automatic: false }); done(true); }
              return;
            }
            queue.put({ key, owner, track: copy, quality, automatic, state: "queued",
              received: 0, total: null, attempts: 0, retryAt: 0, leaseUntil: 0, token: "" } satisfies DownloadJob);
            done(true);
          };
        };
      }
    });
    if (enqueued) await this.changed(); this.kick();
  }

  async enqueueCollection(collection: Omit<OfflineCollection, "key" | "owner">, tracks: DownloadTrack[], quality = "320kbps"): Promise<void> {
    const owner = this.requireOwner(), normalizedQuality = qualityOf(quality);
    const copies: DownloadTrack[] = JSON.parse(JSON.stringify(tracks));
    if (copies.some((track) => track.id === undefined || track.id === null || !String(track.id))) throw new Error("A collection contains a track without an ID.");
    await downloadTransaction<void>(["collections", "queue", "manifest"], "readwrite", (tx) => {
      tx.objectStore("collections").put({ ...collection, owner, key: downloadKey(owner, `${collection.kind}:${collection.id}`) });
      for (const track of copies) {
        const key = downloadKey(owner, String(track.id)), manifest = tx.objectStore("manifest").get(key);
        manifest.onsuccess = () => {
          if (manifest.result?.status === "verified" && manifest.result.quality === normalizedQuality) return;
          const queue = tx.objectStore("queue"), existing = queue.get(key);
          existing.onsuccess = () => {
            const job: DownloadJob | undefined = existing.result;
            if (job && job.state !== "failed" && job.quality === normalizedQuality) { if (job.automatic) queue.put({ ...job, automatic: false }); return; }
            queue.put({ key, owner, track, quality: normalizedQuality, automatic: false, state: "queued", received: 0,
              total: null, attempts: 0, retryAt: 0, leaseUntil: 0, token: "" } satisfies DownloadJob);
          };
        };
      }
    });
    await this.changed(); this.kick();
  }

  /** Cancellation removes the persistent job first. A stale worker cannot commit it. */
  async cancelDownload(trackId: string): Promise<void> {
    const key = downloadKey(this.requireOwner(), trackId);
    this.controllers.get(key)?.abort();
    await downloadTransaction<void>(["queue"], "readwrite", (tx) => { tx.objectStore("queue").delete(key); });
    await this.changed();
  }
  async purgeDownloadedTrack(trackId: string): Promise<void> {
    const key = downloadKey(this.requireOwner(), trackId);
    this.controllers.get(key)?.abort();
    await downloadTransaction<void>(["queue", "media", "manifest"], "readwrite", (tx) => {
      for (const name of ["queue", "media", "manifest"]) tx.objectStore(name).delete(key);
    });
    const url = this.urls.get(key); if (url) URL.revokeObjectURL(url.url); this.urls.delete(key);
    await this.changed(trackId, true);
  }
  async purgeAll(): Promise<number> {
    const owner = this.requireOwner();
    this.controllers.forEach((controller) => controller.abort());
    const count = await downloadTransaction<number>(["queue", "media", "manifest", "collections"], "readwrite", (tx, done) => {
      const removed = { count: 0 };
      for (const name of ["queue", "media", "manifest", "collections"]) {
        const request = tx.objectStore(name).index("owner").openCursor(owner);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { if (name === "manifest") done(removed.count); return; }
          if (name === "manifest") removed.count++;
          cursor.delete(); cursor.continue();
        };
      }
    });
    this.urls.forEach(({ url }) => URL.revokeObjectURL(url)); this.urls.clear();
    await this.changed(undefined, true); return count;
  }
  async saveCollection(collection: Omit<OfflineCollection, "owner" | "key">): Promise<void> {
    const owner = this.requireOwner();
    await downloadTransaction<void>(["collections"], "readwrite", (tx) => {
      tx.objectStore("collections").put({ ...collection, owner, key: downloadKey(owner, `${collection.kind}:${collection.id}`) });
    });
    await this.changed();
  }

  /** Explicit adoption of an older, unscoped local audio file. Existing records win. */
  async importLocalBlob(track: DownloadTrack, blob: Blob, quality: string, downloadedAt?: string): Promise<void> {
    const owner = this.requireOwner(), epoch = this.epoch, key = downloadKey(owner, String(track.id));
    if (!blob.size || blob.size > MAX_TRACK_BYTES) throw new Error("The older audio file is empty or exceeds the browser's 512 MiB limit.");
    const checksum = await checksumBlob(blob);
    if (epoch !== this.epoch) throw new Error("The offline account changed during import.");
    const normalizedQuality = qualityOf(quality);
    await downloadTransaction<void>(["media", "manifest"], "readwrite", (tx) => {
      const store = tx.objectStore("manifest"), request = store.get(key);
      request.onsuccess = () => {
        if (request.result) return;
        tx.objectStore("media").put({ key, owner, blob } satisfies MediaRecord);
        store.put({ key, owner, track_id: String(track.id), track, file_size: blob.size,
          bitrate: normalizedQuality === "lossless" ? null : parseInt(normalizedQuality, 10), quality: normalizedQuality,
          downloaded_at: downloadedAt && Number.isFinite(Date.parse(downloadedAt)) ? downloadedAt : new Date().toISOString(),
          checksum, content_type: blob.type || "audio/mpeg", status: "verified" } satisfies OfflineManifest);
      };
    });
    await this.changed(String(track.id));
  }

  async readVerifiedTrack(trackId: string): Promise<(OfflineManifest & { blob: Blob; trackId: string; size: number }) | null> {
    const owner = this.owner; if (!owner) return null;
    const key = downloadKey(owner, trackId);
    const { manifest, media } = await downloadTransaction<{ manifest?: OfflineManifest; media?: MediaRecord }>(["manifest", "media"], "readonly", (tx, done) => {
      const result: { manifest?: OfflineManifest; media?: MediaRecord } = {};
      const manifest = tx.objectStore("manifest").get(key), media = tx.objectStore("media").get(key);
      manifest.onsuccess = () => { result.manifest = manifest.result; done(result); };
      media.onsuccess = () => { result.media = media.result; done(result); };
    });
    if (!manifest) return null;
    let status: OfflineManifest["status"] = "verified";
    if (!media?.blob) status = "missing";
    else {
      try {
        if (media.blob.size !== manifest.file_size || !media.blob.size || await checksumBlob(media.blob) !== manifest.checksum) status = "corrupt";
      } catch { status = "corrupt"; }
    }
    if (owner !== this.owner) return null;
    const latest = await readDownload<OfflineManifest>("manifest", key);
    if (!latest || latest.checksum !== manifest.checksum || latest.downloaded_at !== manifest.downloaded_at) return null;
    if (status !== manifest.status) {
      await downloadTransaction<void>(["manifest"], "readwrite", (tx) => {
        const store = tx.objectStore("manifest"), request = store.get(key);
        request.onsuccess = () => { if (request.result?.checksum === manifest.checksum) store.put({ ...request.result, status }); };
      });
      await this.changed();
    }
    if (status !== "verified" || !media) return null;
    return { ...manifest, status, blob: media.blob, trackId, size: manifest.file_size };
  }
  async verifyIntegrity(): Promise<{ verified: number; damaged: number }> {
    const owner = this.requireOwner();
    const tracks = await listDownloads<OfflineManifest>("manifest", owner);
    let verified = 0, damaged = 0;
    for (const track of tracks) {
      if (owner !== this.owner) throw new Error("The offline account changed during verification.");
      if (await this.readVerifiedTrack(track.track_id)) verified++; else damaged++;
    }
    await this.changed(); return { verified, damaged };
  }
  async localPlaybackUrl(trackId: string): Promise<string | null> {
    if (!this.owner) return null;
    const key = downloadKey(this.owner, trackId);
    const record = await this.readVerifiedTrack(trackId);
    if (!record) return null;
    let cached = this.urls.get(key);
    if (cached && cached.checksum !== record.checksum) { URL.revokeObjectURL(cached.url); this.urls.delete(key); cached = undefined; }
    if (!cached) { cached = { url: URL.createObjectURL(record.blob), checksum: record.checksum }; this.urls.set(key, cached); }
    return cached.url;
  }
  cachedPlaybackUrl(trackId: string): string | null {
    if (!this.owner) return null;
    const key = downloadKey(this.owner, trackId), cached = this.urls.get(key);
    return cached && this.snapshot.tracks.some((track) => track.key === key && track.status === "verified" && track.checksum === cached.checksum) ? cached.url : null;
  }

  /** One processor per instance; durable leases serialize processors across tabs and workers. */
  kick = (): void => {
    if (this.running) { this.wakeRequested = true; return; }
    if (!this.owner || !this.networkEnabled || navigator.onLine === false) return;
    this.running = this.processQueue().catch((error) => this.publish({ ...this.snapshot, error: messageOf(error) })).finally(() => {
      this.running = null;
      if (this.wakeRequested) { this.wakeRequested = false; this.kick(); }
    });
  };
  async drain(): Promise<void> { this.kick(); while (this.running) await this.running; }
  private async processQueue(): Promise<void> {
    const owner = this.requireOwner(), epoch = this.epoch;
    const jobs = await listDownloads<DownloadJob>("queue", owner);
    let nextWake = Infinity;
    for (const candidate of jobs) {
      if (epoch !== this.epoch || !this.networkEnabled || navigator.onLine === false) break;
      if (candidate.state === "failed" || (candidate.automatic && !this.automaticAllowed())) continue;
      if (Math.max(candidate.retryAt, candidate.leaseUntil) > Date.now()) {
        nextWake = Math.min(nextWake, Math.max(candidate.retryAt, candidate.leaseUntil)); continue;
      }
      const job = await downloadTransaction<DownloadJob | null>(["queue"], "readwrite", (tx, done) => {
        const store = tx.objectStore("queue"), request = store.get(candidate.key);
        done(null);
        request.onsuccess = () => {
          const current: DownloadJob | undefined = request.result;
          if (!current || current.state === "failed" || Math.max(current.retryAt, current.leaseUntil) > Date.now()) return;
          const claimed: DownloadJob = { ...current, state: "downloading", token: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-")}`, leaseUntil: Date.now() + LEASE_MS };
          store.put(claimed); done(claimed);
        };
      });
      if (!job) continue;
      const controller = new AbortController(); this.controllers.set(job.key, controller);
      await this.refresh(); this.channel?.postMessage({ owner });
      try { await this.download(job, controller); }
      catch (error) {
        const cancelled = controller.signal.aborted && epoch !== this.epoch;
        const quotaError = error instanceof Error && ["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED"].includes(error.name);
        if (quotaError) { job.partial = undefined; job.received = 0; job.validator = undefined; }
        const attempts = quotaError ? 4 : job.attempts + (cancelled || isOffline() ? 0 : 1);
        const retryAt = Date.now() + Math.min(60_000, 2000 * 2 ** attempts);
        await this.updateClaim(job, { ...job, attempts, retryAt, leaseUntil: 0,
          state: attempts >= 4 ? "failed" : "queued", error: messageOf(error) });
        if (attempts < 4) nextWake = Math.min(nextWake, retryAt);
      } finally { this.controllers.delete(job.key); await this.changed(String(job.track.id)); }
    }
    if (Number.isFinite(nextWake) && epoch === this.epoch) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(this.kick, Math.max(250, nextWake - Date.now()));
    }
  }
  private updateClaim(job: DownloadJob, updated: DownloadJob): Promise<boolean> {
    return downloadTransaction(["queue"], "readwrite", (tx, done) => {
      const store = tx.objectStore("queue"), request = store.get(job.key); done(false);
      request.onsuccess = () => { if (request.result?.token === job.token) { store.put(updated); done(true); } };
    });
  }
  private async download(job: DownloadJob, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const assertActive = () => {
      if (signal.aborted || job.owner !== this.owner) throw new DOMException("Download cancelled.", "AbortError");
      if (job.automatic && !this.automaticAllowed()) throw new Error("Auto-download paused until an unmetered connection is available.");
    };
    assertActive();
    // Resume only with a strong validator. Unvalidated partial bytes are discarded.
    let blob = job.partial && job.validator ? job.partial : new Blob();
    const headers: Record<string, string> = {};
    if (blob.size) { headers.Range = `bytes=${blob.size}-`; headers["If-Range"] = job.validator!; }
    const resetTimeout = () => { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(), 45_000); };
    let timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const quality = job.quality === "lossless" ? "original" : job.quality.replace("kbps", "");
      const url = getStreamUrl(job.track.id, null, quality);
      if (!url) throw new Error("This track has no downloadable stream.");
      const response = await fetch(url, { headers, signal, credentials: "include", cache: "no-store" });
      assertActive();
      if (response.status !== 200 && response.status !== 206) {
        if ([401, 403, 404].includes(response.status)) job.attempts = 4;
        throw new Error([401, 403].includes(response.status) ? "Sign in again to download this track."
          : response.status === 404 ? "This track is no longer on the server." : `Download failed (HTTP ${response.status}).`);
      }
      const type = (response.headers.get("content-type") || "application/octet-stream").split(";")[0];
      if (!/^(audio\/|video\/(mp4|webm)|application\/(ogg|octet-stream|x-flac))/.test(type)) {
        job.attempts = 4; throw new Error("The server returned a non-audio file.");
      }
      let total: number | null = null;
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") || "");
        if (!range || Number(range[1]) !== blob.size || Number(range[2]) < Number(range[1]) || Number(range[2]) >= Number(range[3]) ||
          (job.validator?.startsWith('"') && response.headers.get("etag") && response.headers.get("etag") !== job.validator)) {
          job.partial = undefined; job.validator = undefined; throw new Error("The server returned an invalid resume range. Retrying from the beginning.");
        }
        total = Number(range[3]);
      } else {
        blob = new Blob();
        const length = Number(response.headers.get("content-length"));
        if (!response.headers.get("content-encoding") && length > 0) total = length;
      }
      if (response.headers.get("content-encoding") && response.status === 206) throw new Error("Encoded byte ranges cannot be resumed safely.");
      if (total !== null && total > MAX_TRACK_BYTES) { job.attempts = 4; throw new Error("This track exceeds the browser download limit of 512 MiB. Use a native client for larger files."); }
      const etag = response.headers.get("etag");
      job.validator = etag && !etag.startsWith("W/") ? etag : response.headers.get("last-modified") || undefined;
      job.contentType = type; job.total = total;
      let chunks: BlobPart[] = [], buffered = 0, lastCheckpoint = Date.now();
      const checkpoint = async (force: boolean) => {
        if (!force && buffered < CHECKPOINT_BYTES && Date.now() - lastCheckpoint < 5000) return;
        blob = new Blob([blob, ...chunks], { type }); chunks = []; buffered = 0;
        Object.assign(job, { partial: blob, received: blob.size, leaseUntil: Date.now() + LEASE_MS });
        assertActive();
        if (!await this.updateClaim(job, job)) throw new DOMException("Download cancelled in another tab.", "AbortError");
        lastCheckpoint = Date.now(); await this.refresh(); this.channel?.postMessage({ owner: job.owner });
      };
      const reader = response.body?.getReader();
      try {
        if (reader) {
          for (;;) {
            assertActive(); resetTimeout();
            const { done, value } = await reader.read();
            if (done) break;
            if (value) { chunks.push(value as Uint8Array<ArrayBuffer>); buffered += value.byteLength; }
            if (blob.size + buffered > MAX_TRACK_BYTES || (total !== null && blob.size + buffered > total)) {
              job.attempts = 4; throw new Error("Audio size exceeded the declared or supported download size.");
            }
            await checkpoint(false);
          }
        } else { const body = await response.blob(); chunks.push(body); buffered += body.size; }
        await checkpoint(true);
      } finally { if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); } }
      if (!blob.size || blob.size > MAX_TRACK_BYTES || (total !== null && blob.size !== total)) throw new Error("Download interrupted before the complete audio file arrived.");
      clearTimeout(timeout);
      const checksum = await checksumBlob(blob);
      assertActive();
      const manifest: OfflineManifest = { key: job.key, owner: job.owner, track_id: String(job.track.id), track: job.track,
        file_size: blob.size, bitrate: job.quality === "lossless" ? null : parseInt(job.quality, 10), quality: job.quality,
        downloaded_at: new Date().toISOString(), checksum, content_type: type, status: "verified" };
      // This is the only publication point: media + manifest + queue removal commit together.
      await downloadTransaction<void>(["queue", "media", "manifest"], "readwrite", (tx) => {
        const queue = tx.objectStore("queue"), request = queue.get(job.key);
        request.onsuccess = () => {
          if (request.result?.token !== job.token || signal.aborted) return;
          tx.objectStore("media").put({ key: job.key, owner: job.owner, blob } satisfies MediaRecord);
          tx.objectStore("manifest").put(manifest); queue.delete(job.key);
        };
      });
    } finally { clearTimeout(timeout); }
  }
}
export const offlineDownloadEngine = new OfflineDownloadEngine();
