import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  deleteOfflineTrack,
  describeOfflineRecordProblem,
  readOfflineTrack,
} from "../../utils/downloadManager";

/**
 * - `unchecked`: not audited yet (render as not downloaded).
 * - `absent`: nothing stored and nothing expected.
 * - `verified`: a record exists, its blob matches the stored size and its bytes are readable.
 * - `missing`: the track was stored before but its audio is gone (eviction, cleared site data,
 *   or a legacy metadata-only record).
 * - `corrupt`: a record exists but is truncated, size-mismatched or unreadable.
 * - `unknown`: storage could not be read; the UI must not claim a download.
 */
export type OfflineAuditStatus = "unchecked" | "absent" | "verified" | "missing" | "corrupt" | "unknown";

export interface OfflineAuditResult {
  status: OfflineAuditStatus;
  checkedAt: number;
  size?: number;
  quality?: string;
}

/** Status vocabulary used by the track menu. */
export type OfflineDisplayStatus = "not-downloaded" | "downloading" | "downloaded" | "needs-redownload";

export interface StoredOfflineRecord {
  trackId?: string;
  quality?: string;
  size?: number;
  expectedSize?: number;
  blob?: Blob;
}

export interface OfflineAuditorStorage {
  read(trackId: string): Promise<StoredOfflineRecord | null>;
  remove(trackId: string): Promise<void>;
}

export interface OfflineAuditorOptions {
  storage?: OfflineAuditorStorage;
  /** Verified results are re-checked after this long, because browsers can evict storage mid-session. */
  verifiedTtlMs?: number;
  /** Concurrent IndexedDB audits; virtual lists mount many rows at once. */
  maxConcurrent?: number;
  now?: () => number;
  /** localStorage key remembering which tracks were stored, so loss can be reported as "missing". */
  indexKey?: string | null;
}

export const OFFLINE_DOWNLOAD_EVENT = "musicdeck:offline-download";
const DEFAULT_INDEX_KEY = "musicdeckOfflineIndex";
const HEAD_PROBE_BYTES = 16;
const UNCHECKED: OfflineAuditResult = Object.freeze({ status: "unchecked", checkedAt: 0 });

const defaultStorage: OfflineAuditorStorage = {
  read: (trackId) => readOfflineTrack(trackId),
  remove: (trackId) => deleteOfflineTrack(trackId),
};

/** Reads a few bytes so a blob whose backing file was evicted fails here instead of at playback. */
async function probeReadable(blob: Blob): Promise<void> {
  const head = blob.slice(0, HEAD_PROBE_BYTES);
  if (typeof head.arrayBuffer === "function") {
    await head.arrayBuffer();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read offline audio"));
    reader.readAsArrayBuffer(head);
  });
}

/**
 * Verifies offline audio before the UI calls a track "Downloaded". Audits are
 * per track, deduplicated while in flight, limited in concurrency, and never
 * reject. Damaged records are deleted so they can't be reported again, and the
 * track is reported as `missing`/`corrupt` so the UI can offer a re-download.
 */
export class OfflineAuditor {
  private readonly storage: OfflineAuditorStorage;
  private readonly verifiedTtlMs: number;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private readonly indexKey: string | null;
  private readonly results = new Map<string, OfflineAuditResult>();
  private readonly inflight = new Map<string, Promise<OfflineAuditResult>>();
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly waiting: (() => void)[] = [];
  private readonly known: Set<string>;
  private running = 0;
  private detachWindowListener: (() => void) | null = null;

  constructor(options: OfflineAuditorOptions = {}) {
    this.storage = options.storage ?? defaultStorage;
    this.verifiedTtlMs = options.verifiedTtlMs ?? 60_000;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 4);
    this.now = options.now ?? Date.now;
    this.indexKey = options.indexKey === undefined ? DEFAULT_INDEX_KEY : options.indexKey;
    this.known = this.loadIndex();
  }

  getSnapshot(trackId: string | number): OfflineAuditResult {
    return this.results.get(String(trackId)) ?? UNCHECKED;
  }

  subscribe(trackId: string | number, listener: () => void): () => void {
    const key = String(trackId);
    const set = this.listeners.get(key) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(key, set);
    this.attachWindowListener();
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(key);
    };
  }

  /** Returns the cached result while fresh; otherwise verifies storage. Never rejects. */
  audit(trackId: string | number, { force = false }: { force?: boolean } = {}): Promise<OfflineAuditResult> {
    const key = String(trackId);
    if (!key) return Promise.resolve(UNCHECKED);
    const pending = this.inflight.get(key);
    if (pending && !force) return pending;
    const cached = this.results.get(key);
    if (!force && cached && this.isFresh(cached)) return Promise.resolve(cached);

    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    const job = this.withSlot(() => this.verify(key, generation))
      .catch((error: unknown): OfflineAuditResult => {
        console.error("Could not verify offline download:", error);
        return { status: "unknown", checkedAt: this.now() };
      })
      .then((result) => {
        // A newer audit (e.g. after a fresh download) owns the published result.
        if (this.generations.get(key) === generation) {
          this.inflight.delete(key);
          this.publish(key, result);
        }
        return result;
      });
    this.inflight.set(key, job);
    return job;
  }

  /** Marks a stored track as expected, then re-verifies it. */
  recordDownloaded(trackId: string | number): Promise<OfflineAuditResult> {
    this.remember(String(trackId), true);
    return this.audit(trackId, { force: true });
  }

  /** Forgets a track entirely, e.g. after the user removes its offline copy. */
  forget(trackId: string | number): void {
    const key = String(trackId);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.inflight.delete(key);
    this.remember(key, false);
    this.publish(key, { status: "absent", checkedAt: this.now() });
  }

  dispose(): void {
    this.detachWindowListener?.();
    this.detachWindowListener = null;
    this.listeners.clear();
  }

  reset(): void {
    const keys = new Set([...this.results.keys(), ...this.inflight.keys(), ...this.listeners.keys(), ...this.known]);
    this.known.clear();
    for (const key of keys) this.forget(key);
  }

  private isFresh(result: OfflineAuditResult): boolean {
    if (result.status === "unknown") return false;
    if (result.status !== "verified") return true;
    return this.now() - result.checkedAt < this.verifiedTtlMs;
  }

  private async verify(key: string, generation: number): Promise<OfflineAuditResult> {
    const record = await this.storage.read(key);
    const checkedAt = this.now();
    const stale = () => this.generations.get(key) !== generation;
    if (stale()) return { status: "absent", checkedAt };

    if (!record) {
      return { status: this.known.has(key) ? "missing" : "absent", checkedAt };
    }

    let problem = describeOfflineRecordProblem(record) as "missing" | "corrupt" | null;
    if (!problem && record.blob) {
      try {
        await probeReadable(record.blob);
      } catch {
        problem = "corrupt";
      }
    }
    if (stale()) return { status: "absent", checkedAt };

    if (problem) {
      // Delete the bad record so it can't be reported as downloaded again.
      try {
        await this.storage.remove(key);
      } catch (error) {
        console.error("Could not remove damaged offline download:", error);
      }
      if (!stale()) this.remember(key, true);
      return { status: problem, checkedAt, quality: record.quality };
    }

    this.remember(key, true);
    return { status: "verified", checkedAt, size: record.blob?.size, quality: record.quality };
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running += 1;
    try {
      return await task();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }

  private publish(key: string, result: OfflineAuditResult): void {
    const previous = this.results.get(key);
    this.results.set(key, result);
    if (previous && previous.status === result.status && previous.size === result.size &&
        previous.quality === result.quality) {
      return;
    }
    this.listeners.get(key)?.forEach((listener) => listener());
  }

  private attachWindowListener(): void {
    if (this.detachWindowListener || typeof window === "undefined") return;
    const onDownloaded = (event: Event) => {
      const trackId = (event as CustomEvent<{ trackId?: string }>).detail?.trackId;
      if (trackId) void this.recordDownloaded(trackId);
    };
    window.addEventListener(OFFLINE_DOWNLOAD_EVENT, onDownloaded);
    const onPurged = () => this.reset();
    window.addEventListener("musicdeck:offline-purged", onPurged);
    this.detachWindowListener = () => {
      window.removeEventListener(OFFLINE_DOWNLOAD_EVENT, onDownloaded);
      window.removeEventListener("musicdeck:offline-purged", onPurged);
    };
  }

  private loadIndex(): Set<string> {
    if (!this.indexKey || typeof window === "undefined") return new Set();
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(this.indexKey) || "[]");
      return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      return new Set();
    }
  }

  private remember(key: string, stored: boolean): void {
    if (stored === this.known.has(key)) return;
    if (stored) this.known.add(key);
    else this.known.delete(key);
    if (!this.indexKey || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(this.indexKey, JSON.stringify(Array.from(this.known)));
    } catch {
      // The index only improves "missing" reporting; a full quota must not break auditing.
    }
  }
}

export const offlineAuditor = new OfflineAuditor();

export function offlineDisplayStatus(result: OfflineAuditResult, isDownloading: boolean): OfflineDisplayStatus {
  if (isDownloading) return "downloading";
  if (result.status === "verified") return "downloaded";
  if (result.status === "missing" || result.status === "corrupt") return "needs-redownload";
  return "not-downloaded";
}

/** Subscribes a component to one track's audit and triggers verification on mount. */
export function useOfflineAudit(trackId: string | number | null | undefined, auditor: OfflineAuditor = offlineAuditor) {
  const key = trackId === null || trackId === undefined ? "" : String(trackId);
  const subscribe = useCallback(
    (listener: () => void) => (key ? auditor.subscribe(key, listener) : () => undefined),
    [auditor, key]
  );
  const getSnapshot = useCallback(() => (key ? auditor.getSnapshot(key) : UNCHECKED), [auditor, key]);
  const result = useSyncExternalStore(subscribe, getSnapshot, () => UNCHECKED);

  useEffect(() => {
    if (key) void auditor.audit(key);
  }, [auditor, key]);

  return result;
}
