export type PlaylistEdit = { kind: "reorder"; itemIds: string[]; expectedItemIds: string[] }
  | { kind: "remove"; itemIds: string[]; expectedItemIds?: string[] } | { kind: "add"; trackIds: string[] }
  | { kind: "details"; name?: string; description?: string | null } | { kind: "trash" } | { kind: "restore" };
export interface PlaylistCommand { id: string; playlistId: string; label: string }
export interface CommandResponse { command: PlaylistCommand | null; revision: number; deletedAt: string | null; playlist: any }
export interface UndoSnapshot { owner: string | null; busy: boolean; undo: readonly PlaylistCommand[]; redo: readonly PlaylistCommand[]; message: string; error: string | null }
export class PlaylistCommandRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
type Notice = (response: CommandResponse, playlistId: string) => void;
let notifier: Notice = () => { window.dispatchEvent(new Event("playlistsChanged")); };
export function setPlaylistCommandNotifier(callback: Notice): void { notifier = callback; }

/** Command IDs refer to server-owned inverse deltas, never client-supplied restoration data. */
class PlaylistCommandStore {
  private snapshot: UndoSnapshot = { owner: null, busy: false, undo: [], redo: [], message: "", error: null };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private revisions = new Map<string, number>();
  private controllers = new Set<AbortController>();
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<UndoSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; this.listeners.forEach(listener => listener()); }
  activate(owner: string | null) {
    if (this.snapshot.owner === owner) return;
    this.epoch++; this.controllers.forEach(controller => controller.abort()); this.controllers.clear();
    this.tail = Promise.resolve(); this.revisions.clear();
    this.publish({ owner, busy: false, undo: [], redo: [], message: "", error: null });
  }
  dismiss = () => this.publish({ message: "", error: null });
  private forget(playlistId: string) {
    this.revisions.delete(playlistId);
    this.publish({ undo: this.snapshot.undo.filter(command => command.playlistId !== playlistId), redo: this.snapshot.redo.filter(command => command.playlistId !== playlistId) });
  }
  private async request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
    let response: Response;
    try { response = await fetch(path, { credentials: "include", signal, ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }); }
    catch (error) {
      if (signal.aborted) throw new PlaylistCommandRequestError("The playlist request was interrupted. Reload to check whether it was saved before retrying.", 0);
      throw new PlaylistCommandRequestError("Connection lost. Reload the playlist to check whether the edit was saved before retrying.", 0);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new PlaylistCommandRequestError(data?.error?.message || `Playlist request failed (${response.status}).`, response.status);
    if (!data) throw new PlaylistCommandRequestError("The server returned an invalid playlist response. Reload before retrying.", 0);
    return data;
  }
  private run<T>(playlistId: string, work: (owner: string, signal: AbortSignal, epoch: number) => Promise<T>): Promise<T> {
    const owner = this.snapshot.owner, epoch = this.epoch;
    if (!owner) return Promise.reject(new Error("Sign in to edit playlists."));
    const task = this.tail.then(async () => {
      if (epoch !== this.epoch) throw new Error("The signed-in account changed.");
      const controller = new AbortController(); this.controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 90_000);
      this.publish({ busy: true, error: null });
      try { return await work(owner, controller.signal, epoch); }
      catch (error) {
        if (epoch === this.epoch) {
          if (error instanceof PlaylistCommandRequestError && [0, 401, 403, 404, 409, 410].includes(error.status)) this.forget(playlistId);
          this.publish({ error: error instanceof Error ? error.message : "The playlist edit failed.", message: "" });
        }
        throw error;
      } finally {
        clearTimeout(timeout); this.controllers.delete(controller);
        if (epoch === this.epoch) this.publish({ busy: false });
      }
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
  execute = (playlistId: string, edit: PlaylistEdit): Promise<CommandResponse> => this.run(playlistId, async (ownerId, signal, epoch) => {
    const state = await this.request<{ revision: number; itemIds: string[] }>(`/api/v1/playlists/${encodeURIComponent(playlistId)}/edit-state`, signal);
    if (epoch !== this.epoch) throw new Error("The signed-in account changed.");
    const previous = this.revisions.get(playlistId);
    if (previous !== undefined && previous !== state.revision) this.forget(playlistId);
    const result = await this.request<CommandResponse>(`/api/v1/playlists/${encodeURIComponent(playlistId)}/commands`, signal, { ownerId, revision: state.revision, edit });
    if (epoch !== this.epoch) throw new Error("The signed-in account changed.");
    this.revisions.set(playlistId, result.revision);
    if (result.command) this.publish({ undo: [...this.snapshot.undo, result.command].slice(-50), redo: [], message: result.command.label });
    notifier(result, playlistId);
    return result;
  });
  private reverse(direction: "undo" | "redo"): Promise<void> {
    const candidate = this.snapshot[direction].at(-1);
    if (!candidate) return Promise.resolve();
    return this.run(candidate.playlistId, async (ownerId, signal, epoch) => {
      const command = this.snapshot[direction].at(-1);
      if (!command) return;
      const revision = this.revisions.get(command.playlistId);
      if (revision === undefined) throw new Error("This history step is no longer available. Reload the playlist.");
      const result = await this.request<CommandResponse>(`/api/v1/playlist-commands/${encodeURIComponent(command.id)}/${direction}`, signal, { ownerId, revision });
      if (epoch !== this.epoch) return;
      this.revisions.set(command.playlistId, result.revision);
      const other = direction === "undo" ? "redo" : "undo";
      this.publish({ [direction]: this.snapshot[direction].slice(0, -1), [other]: [...this.snapshot[other], command], message: `${direction === "undo" ? "Undone" : "Redone"}: ${command.label}` });
      notifier(result, command.playlistId);
    });
  }
  undo = () => this.reverse("undo");
  redo = () => this.reverse("redo");
}
export const playlistCommands = new PlaylistCommandStore();
