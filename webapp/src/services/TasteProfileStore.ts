export const TASTE_CHANGED = "musicdeck:taste-profile-changed";
export interface TastePreferences { privateListening: boolean; revision: number; resetBefore: string | null; providerHistoryDisabled: boolean; excludedPlaylistIds?: string[]; excludedTrackIds?: string[] }
export interface TasteSnapshot extends TastePreferences { owner: string | null; loaded: boolean; pending: boolean; busy: boolean; error: string }
class TasteProfileStore {
  private snapshot: TasteSnapshot = { owner: null, loaded: false, pending: false, busy: false, error: "", privateListening: false, revision: 0, resetBefore: null, providerHistoryDisabled: false };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private desired: boolean | null = null;
  private requests = new Set<AbortController>();
  private refreshing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<TasteSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; this.listeners.forEach(listener => listener()); }
  private persist() {
    if (!this.snapshot.owner) return;
    try { localStorage.setItem(`musicdeck:taste:${this.snapshot.owner}`, JSON.stringify({ ...this.snapshot, desired: this.desired })); } catch { /* Session flags are also carried in the durable listening outbox. */ }
  }
  private changed() { if (typeof window !== "undefined") window.dispatchEvent(new Event(TASTE_CHANGED)); }
  activate(owner: string | null) {
    if (this.snapshot.owner === owner) return;
    this.epoch++; this.requests.forEach(request => request.abort()); this.requests.clear(); this.refreshing = false;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    if (typeof window !== "undefined") { window.removeEventListener("online", this.refresh); window.removeEventListener("focus", this.refresh); window.removeEventListener("storage", this.storageChanged); }
    this.desired = null;
    let cached: Partial<TasteSnapshot> & { desired?: boolean | null } = {};
    if (owner) try { cached = JSON.parse(localStorage.getItem(`musicdeck:taste:${owner}`) || "{}"); } catch { cached = {}; }
    if (typeof cached.desired === "boolean") this.desired = cached.desired;
    this.publish({ owner, loaded: Boolean(cached.loaded), pending: this.desired !== null, busy: false, error: "",
      privateListening: owner ? this.desired === true || cached.privateListening !== false : false,
      revision: Number.isSafeInteger(cached.revision) ? cached.revision! : 0, resetBefore: cached.resetBefore ?? null,
      providerHistoryDisabled: Boolean(cached.providerHistoryDisabled),
      excludedPlaylistIds: Array.isArray(cached.excludedPlaylistIds) ? cached.excludedPlaylistIds.filter(id => typeof id === "string") : [],
      excludedTrackIds: Array.isArray(cached.excludedTrackIds) ? cached.excludedTrackIds.filter(id => typeof id === "string") : [] });
    if (owner && typeof window !== "undefined") {
      window.addEventListener("online", this.refresh); window.addEventListener("focus", this.refresh); window.addEventListener("storage", this.storageChanged);
      this.timer = setInterval(this.refresh, 15_000); void this.refresh();
    }
  }
  private storageChanged = (event: StorageEvent) => { if (event.key === `musicdeck:taste:${this.snapshot.owner}`) {
    try { const value = JSON.parse(event.newValue || "{}"); if (value.privateListening === true) this.publish({ privateListening: true }); if (typeof value.desired === "boolean") this.desired = value.desired; } catch { /* Ignore invalid preferences. */ }
    void this.refresh();
  } };
  private async fetch<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController(), epoch = this.epoch; this.requests.add(controller); const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`/api/v1/taste-profile${path}`, { credentials: "include", signal: controller.signal,
        ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
      const data = await response.json().catch(() => null);
      if (epoch !== this.epoch) throw new Error("The signed-in account changed.");
      if (!response.ok || !data) throw new Error(data?.error?.message || `Taste preferences could not be loaded (${response.status}).`);
      if (typeof data.privateListening !== "boolean" || !Number.isSafeInteger(data.revision)) throw new Error("The server returned invalid taste preferences. Listening influence stays paused until they can be checked.");
      return data;
    } finally { clearTimeout(timer); this.requests.delete(controller); }
  }
  refresh = async () => {
    if (!this.snapshot.owner || this.refreshing || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
    const epoch = this.epoch, owner = this.snapshot.owner; this.refreshing = true;
    try {
      let state = await this.fetch<TastePreferences>("/state");
      if (epoch !== this.epoch) return;
      if (this.desired !== null) {
        const desired = this.desired;
        await this.fetch("/private", { ownerId: owner, enabled: desired, revision: state.revision });
        if (epoch !== this.epoch) return;
        if (this.desired === desired) this.desired = null;
        state = await this.fetch<TastePreferences>("/state");
      }
      if (epoch !== this.epoch) return;
      if (state.revision < this.snapshot.revision) return;
      const changed = state.revision !== this.snapshot.revision || !this.snapshot.loaded;
      this.publish({ ...state, privateListening: this.desired === true || state.privateListening, loaded: true, pending: this.desired !== null, error: "" }); this.persist(); if (changed) this.changed();
    } catch (error) { if (epoch === this.epoch) this.publish({ error: error instanceof Error ? error.message : "Could not sync taste preferences. Private listening remains protected." }); }
    finally { if (epoch === this.epoch) this.refreshing = false; }
  };
  setPrivate = async (enabled: boolean) => {
    if (!this.snapshot.owner) throw new Error("Sign in to change private listening.");
    this.desired = enabled;
    // Starting privacy is immediate. Ending it requires a server acknowledgement.
    this.publish({ privateListening: enabled || this.snapshot.privateListening, pending: true, error: "" }); this.persist(); this.changed();
    await this.refresh();
  };
  request = async <T>(path: string, body?: Record<string, unknown>): Promise<T> => {
    const owner = this.snapshot.owner, epoch = this.epoch;
    if (!owner) throw new Error("Sign in to manage your taste profile.");
    const result = await this.fetch<T>(path, body === undefined ? undefined : { ...body, ownerId: owner });
    if (epoch === this.epoch && body !== undefined) {
      const state = await this.fetch<TastePreferences>("/state");
      if (epoch === this.epoch && state.revision >= this.snapshot.revision) { this.publish({ ...state, loaded: true, privateListening: this.desired === true || state.privateListening }); this.persist(); this.changed(); }
    }
    return result;
  };
  excludes(song: { id?: unknown; tastePlaylistId?: unknown; excludeFromTaste?: unknown } | null | undefined) {
    return Boolean(song && ((this.snapshot.excludedTrackIds ?? []).includes(String(song.id)) || (this.snapshot.excludedPlaylistIds ?? []).includes(String(song.tastePlaylistId)) || (!this.snapshot.loaded && song.excludeFromTaste)));
  }
}
export const tasteProfileStore = new TasteProfileStore();
