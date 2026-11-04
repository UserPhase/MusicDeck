import { useSyncExternalStore } from "react";
import { request } from "../api/musicdeck";
import { readLocalQueue, markQueueSynced, QUEUE_LOCAL_CHANGED, decodeQueueContent, validateCheckpoint,
  type QueueCheckpoint, type QueueHead, type LocalQueue, type QueueContent } from "./storage/QueueDatabase";
export interface QueueSessionSummary { deviceId: string; deviceName: string; contentId: string; checkpoint: QueueCheckpoint; sequence: number; updatedAt: number; trackCount: number }
export interface NamedQueueSummary { id: string; name: string; contentId: string; checkpoint: QueueCheckpoint; revision: number; updatedAt: number; trackCount: number }
interface Snapshot { owner: string | null; sessions: QueueSessionSummary[]; named: NamedQueueSummary[]; error: string; syncing: boolean }
const BASE = "/api/v1/user/queue-session";
let fallbackDevice = "";
export function queueDeviceId(): string {
  try { const old = localStorage.getItem("musicdeck:queue-device:v1"); if (old) return old;
    const id = newQueueOperationId(); localStorage.setItem("musicdeck:queue-device:v1", id); return id;
  } catch { return fallbackDevice || (fallbackDevice = newQueueOperationId()); }
}
export function newQueueOperationId(): string {
  return typeof globalThis.crypto?.randomUUID === "function" ? crypto.randomUUID() : `queue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
export function queueDeviceName(): string { return /iPad|Tablet/i.test(navigator.userAgent) ? "Tablet" : /Mobi|iPhone|Android/i.test(navigator.userAgent) ? "Phone" : "Desktop"; }
export class QueueSyncClient {
  private state: Snapshot = { owner: null, sessions: [], named: [], error: "", syncing: false };
  private listeners = new Set<() => void>(); private epoch = 0; private controllers = new Set<AbortController>();
  private syncFlight: Promise<void> | null = null; private latestSynced: QueueHead | null = null;
  private syncAgain = false;
  private timer: ReturnType<typeof setTimeout> | null = null; private retry = 0;
  private flushLocal: (() => Promise<QueueHead | null>) | null = null;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<Snapshot>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  activate(owner: string | null) {
    if (this.state.owner === owner) return;
    this.epoch++; this.controllers.forEach(c => c.abort()); this.controllers.clear(); this.syncFlight = null; this.latestSynced = null; this.retry = 0; this.syncAgain = false;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    window.removeEventListener(QUEUE_LOCAL_CHANGED, this.changed); window.removeEventListener("online", this.online);
    this.publish({ owner, sessions: [], named: [], error: "", syncing: false });
    if (owner) { window.addEventListener(QUEUE_LOCAL_CHANGED, this.changed); window.addEventListener("online", this.online); void this.refresh(); }
  }
  bind(flush: (() => Promise<QueueHead | null>) | null) { this.flushLocal = flush; }
  private changed = (event: Event) => { const detail = (event as CustomEvent<{ owner: string }>).detail; if (detail?.owner === this.state.owner) this.scheduleSync(); };
  private online = () => { this.retry = 0; this.scheduleSync(); void this.refresh(); };
  private scheduleSync() { if (this.syncFlight) { this.syncAgain = true; return; } if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => { this.timer = null; void this.sync().catch(() => undefined); }, Math.min(60_000, 400 * 2 ** this.retry)); }
  private async call<T>(path: string, options: RequestInit = {}): Promise<T> {
    const owner = this.state.owner, version = this.epoch;
    if (!owner) throw new Error("Sign in to manage saved queues.");
    const controller = new AbortController(); this.controllers.add(controller); const timer = setTimeout(() => controller.abort(), 30_000);
    try { const value = await request(`${BASE}${path}`, { ...options, signal: controller.signal });
      if (version !== this.epoch || owner !== this.state.owner) throw new Error("Your signed-in account changed."); return value as T;
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  async refresh() {
    const version = this.epoch;
    try { const data = await this.call<{ sessions: QueueSessionSummary[]; namedQueues: NamedQueueSummary[] }>("");
      if (version === this.epoch) this.publish({ sessions: data.sessions, named: data.namedQueues });
    } catch (error) { if (version === this.epoch) this.publish({ error: error instanceof Error ? error.message : "Could not load saved queues." }); }
  }
  private async upload(local: LocalQueue): Promise<string> {
    if (local.head.serverContentId) return local.head.serverContentId;
    const result = await this.call<{ contentId: string }>(`/content?ownerId=${encodeURIComponent(local.head.owner)}`, { method: "POST", body: JSON.stringify(local.content) });
    await markQueueSynced(local.head.owner, local.head.contentKey, result.contentId); return result.contentId;
  }
  private async referencing<T>(local: LocalQueue, send: () => Promise<T>): Promise<T> {
    try { return await send(); }
    catch (error) {
      if ((error as { status?: number })?.status === 404 && local.head.owner === this.state.owner) {
        await markQueueSynced(local.head.owner, local.head.contentKey, undefined); this.latestSynced = null;
        throw Object.assign(new Error("The server queue snapshot expired. Retry to upload this device’s complete queue again."), { status: 503 });
      }
      throw error;
    }
  }
  async sync(): Promise<void> {
    if (this.syncFlight) return this.syncFlight;
    const owner = this.state.owner, version = this.epoch;
    if (!owner) return;
    const operation = (async () => {
      this.publish({ syncing: true });
      try {
        await this.flushLocal?.(); const local = await readLocalQueue(owner); if (!local || version !== this.epoch) return;
        const contentId = await this.upload(local); if (version !== this.epoch) return;
        const sequence = Math.max(local.head.sequence, (this.state.sessions.find(row => row.deviceId === queueDeviceId())?.sequence ?? 0) + 1, (this.latestSynced?.sequence ?? 0) + 1);
        const result = await this.referencing(local, () => this.call<{ saved: boolean; sequence: number }>("", { method: "PUT", body: JSON.stringify({ ownerId: owner, deviceId: queueDeviceId(), deviceName: queueDeviceName(), contentId,
          checkpoint: local.head.checkpoint, sequence }) }));
        if (!result.saved) {
          await this.refresh();
          throw Object.assign(new Error("A newer checkpoint exists for this browser. Retry sync to send the current queue."), { status: 409 });
        }
        this.latestSynced = { ...local.head, sequence, serverContentId: contentId }; this.retry = 0; this.publish({ error: "" });
      } catch (error) {
        if (version === this.epoch) {
          this.retry = Math.min(this.retry + 1, 8); this.publish({ error: error instanceof Error ? error.message : "Queue sync failed. Your local queue remains available." });
          const status = (error as { status?: number })?.status;
          if (!status || status >= 500 || status === 429) this.scheduleSync();
        }
        throw error;
      } finally { if (version === this.epoch) this.publish({ syncing: false }); }
    })();
    this.syncFlight = operation;
    void operation.finally(() => { if (this.syncFlight === operation) { this.syncFlight = null; if (this.syncAgain) { this.syncAgain = false; this.scheduleSync(); } } }).catch(() => undefined);
    return operation;
  }
  /** Exit requests contain only an already-uploaded content reference and a small checkpoint. */
  exitCheckpoint(checkpoint: QueueCheckpoint, currentHead: QueueHead | null) {
    const synced = this.latestSynced, owner = this.state.owner;
    if (!owner || !synced?.serverContentId || !currentHead || synced.contentKey !== currentHead.contentKey || synced.owner !== owner) return;
    void fetch(BASE, { method: "PUT", credentials: "include", keepalive: true, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId: owner, deviceId: queueDeviceId(), deviceName: queueDeviceName(), contentId: synced.serverContentId, checkpoint,
        sequence: Math.max(synced.sequence, currentHead.sequence) + 1 }) }).catch(() => undefined);
  }
  private async current() {
    const owner = this.state.owner; if (!owner) throw new Error("Sign in to save this queue.");
    await this.flushLocal?.(); const local = await readLocalQueue(owner);
    if (owner !== this.state.owner) throw new Error("Your signed-in account changed.");
    if (!local?.content.entries.length) throw new Error("Add tracks to your queue before saving it.");
    return { local, contentId: await this.upload(local) };
  }
  async saveNamed(name: string, operationId: string) {
    const { local, contentId } = await this.current();
    const result = await this.referencing(local, () => this.call<{ id: string }>("/named", { method: "POST", body: JSON.stringify({ ownerId: local.head.owner, name, contentId, checkpoint: local.head.checkpoint, operationId }) }));
    await this.refresh(); return result;
  }
  async savePlaylist(name: string, operationId: string) {
    const { local, contentId } = await this.current();
    return this.referencing(local, () => this.call<{ playlistId: string }>("/playlist", { method: "POST", body: JSON.stringify({ ownerId: local.head.owner, name, contentId, operationId }) }));
  }
  async load(contentId: string, checkpoint: QueueCheckpoint): Promise<{ content: QueueContent; checkpoint: QueueCheckpoint }> {
    const raw = await this.call<QueueContent>(`/content/${encodeURIComponent(contentId)}`), content = decodeQueueContent(JSON.stringify(raw));
    return { content, checkpoint: validateCheckpoint(checkpoint, content.entries.length) };
  }
  async removeNamed(row: NamedQueueSummary) { await this.call(`/named/${encodeURIComponent(row.id)}`, { method: "DELETE", body: JSON.stringify({ ownerId: this.state.owner, revision: row.revision }) }); await this.refresh(); }
  async removeDevice(deviceId: string) { await this.call("", { method: "DELETE", body: JSON.stringify({ ownerId: this.state.owner, deviceId }) }); await this.refresh(); }
}
export const queueSyncClient = new QueueSyncClient();
export const useQueueSync = () => useSyncExternalStore(queueSyncClient.subscribe, queueSyncClient.getSnapshot);
