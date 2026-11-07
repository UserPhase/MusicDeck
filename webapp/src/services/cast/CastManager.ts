import type { PlayableTrack, LoadOptions, EngineState } from "../audio/types";
import type { RemoteAudioOutput, RemoteAudioSnapshot } from "../audio/remoteOutput";
import { assertBrowserIntegrationAllowed } from "../privacyPolicy";

export interface CastMedia {
  media: { contentId: string; duration?: number };
  playerState: string;
  idleReason?: string;
  getEstimatedTime(): number;
  play(request: null, success: () => void, failure: (error: unknown) => void): void;
  pause(request: null, success: () => void, failure: (error: unknown) => void): void;
  seek(request: { currentTime: number }, success: () => void, failure: (error: unknown) => void): void;
}
export interface CastSession {
  getCastDevice(): { friendlyName: string };
  getMediaSession(): CastMedia | null;
  getVolume(): number;
  loadMedia(request: object): Promise<unknown>;
  setVolume(volume: number): Promise<void>;
}
export interface CastContext {
  setOptions(options: object): void;
  requestSession(): Promise<void>;
  getCurrentSession(): CastSession | null;
  getCastState(): string;
  endCurrentSession(stop: boolean): void;
  addEventListener(event: string, listener: () => void): void;
  removeEventListener(event: string, listener: () => void): void;
}
export interface CastSdk {
  framework: {
    CastContext: { getInstance(): CastContext };
    CastContextEventType: { CAST_STATE_CHANGED: string; SESSION_STATE_CHANGED: string };
  };
  chrome: {
    AutoJoinPolicy: { ORIGIN_SCOPED: string };
    media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: string;
      MediaInfo: new (url: string, contentType: string) => { metadata?: object; streamType?: string; duration?: number };
      MusicTrackMediaMetadata: new () => { title?: string; artist?: string; albumName?: string };
      LoadRequest: new (info: object) => { autoplay: boolean; currentTime: number };
      SeekRequest: new () => { currentTime: number };
      StreamType: { BUFFERED: string };
    };
  };
}
type CastWindow = Window & { cast?: { framework?: CastSdk["framework"] }; chrome?: { cast?: CastSdk["chrome"] };
  __onGCastApiAvailable?: (available: boolean) => void };
export interface CastState { available: boolean; connected: boolean; device: string; loading: boolean; error: string; volume: number | null; }
interface Ticket { token: string; url: string; expiresAt: string; contentType: string; }
export interface CastApi {
  issue(trackId: string, maxBitRate?: number): Promise<Ticket>;
  revoke(token: string): Promise<void>;
}
const api: CastApi = {
  async issue(trackId, maxBitRate) {
    const response = await fetch("/api/v1/cast/ticket", { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackId, maxBitRate }),
      signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      const payload = await response.json();
      throw new Error(typeof payload?.error?.message === "string" ? payload.error.message : "Could not authorize the Cast stream. Sign in again and retry.");
    }
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("token" in value) || typeof value.token !== "string" ||
        !("url" in value) || typeof value.url !== "string" || !("expiresAt" in value) || typeof value.expiresAt !== "string" ||
        !("contentType" in value) || typeof value.contentType !== "string" || !/^audio\/[a-z0-9.+-]+$/.test(value.contentType)) {
      throw new Error("MusicDeck returned an invalid Cast stream ticket");
    }
    const url = new URL(value.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid Cast stream URL");
    return { token: value.token, url: value.url, expiresAt: value.expiresAt, contentType: value.contentType };
  },
  async revoke(token) {
    const response = await fetch("/api/v1/cast/ticket", { method: "DELETE", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }), keepalive: true,
      signal: AbortSignal.timeout(15000) });
    if (!response.ok && response.status !== 401) throw new Error("Could not revoke the Cast stream ticket");
  },
};
let sdkPromise: Promise<CastSdk> | null = null;
function installedSdk(): CastSdk | null {
  const host = window as CastWindow;
  return host.cast?.framework && host.chrome?.cast ? { framework: host.cast.framework, chrome: host.chrome.cast } : null;
}
export function supportsCast(): boolean {
  return Boolean(installedSdk()) || (window.isSecureContext === true && /Chrome|Chromium|Edg\//.test(navigator.userAgent) &&
    !/iPhone|iPad|iPod/.test(navigator.userAgent));
}
/** Lazy and explicitly user-initiated: no Google connection during ordinary playback. */
export function loadCastSdk(): Promise<CastSdk> {
  try { assertBrowserIntegrationAllowed("external"); }
  catch (error) { return Promise.reject(error); }
  const existing = installedSdk();
  if (existing) return Promise.resolve(existing);
  if (!supportsCast()) return Promise.reject(new Error("Google Cast requires a supported Chromium browser in a secure context."));
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<CastSdk>((resolve, reject) => {
    const host = window as CastWindow;
    const previous = host.__onGCastApiAvailable;
    const script = document.createElement("script");
    const cleanup = () => { window.clearTimeout(timeout); script.onerror = null; host.__onGCastApiAvailable = previous; };
    const fail = () => { cleanup(); script.remove(); sdkPromise = null; reject(new Error("Google Cast could not load. Check privacy policy, network access and browser support.")); };
    const timeout = window.setTimeout(fail, 15000);
    host.__onGCastApiAvailable = (available) => {
      previous?.(available);
      const sdk = installedSdk();
      if (!available || !sdk) { fail(); return; }
      cleanup(); resolve(sdk);
    };
    script.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
    script.async = true; script.onerror = fail;
    document.head.appendChild(script);
  });
  return sdkPromise;
}

export class CastManager implements RemoteAudioOutput {
  private sdk: CastSdk | null = null;
  private context: CastContext | null = null;
  private readonly listeners = new Set<(snapshot: RemoteAudioSnapshot) => void>();
  private readonly stateListeners = new Set<() => void>();
  private state: CastState = { available: false, connected: false, device: "", loading: false, error: "", volume: null };
  private snapshot: RemoteAudioSnapshot = { key: null, state: "idle", position: 0, duration: 0 };
  private ticket: Ticket | null = null;
  private generation = 0;
  private loadedGeneration = -1;
  private serial: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private expectedContent = "";
  private endedKey: string | null = null;
  constructor(private readonly transport: CastApi = api, private readonly sdkLoader = loadCastSdk) {}
  get initialized(): boolean { return this.context !== null; }
  getState = (): CastState => this.state;
  getSnapshot(): RemoteAudioSnapshot { return this.snapshot; }
  subscribe(listener: (snapshot: RemoteAudioSnapshot) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  subscribeState = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener); return () => { this.stateListeners.delete(listener); };
  };
  private update(patch: Partial<CastState>): void {
    if (Object.entries(patch).every(([key, value]) => this.state[key as keyof CastState] === value)) return;
    this.state = { ...this.state, ...patch };
    this.stateListeners.forEach((listener) => listener());
  }
  private publish(patch: Partial<RemoteAudioSnapshot>): void {
    this.snapshot = { ...this.snapshot, ended: false, ...patch };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }
  private readonly changed = () => {
    const session = this.context?.getCurrentSession();
    if (session && this.timer === null) this.timer = setInterval(() => this.poll(), 250);
    if (!session && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.update({ available: this.context?.getCastState() !== "NO_DEVICES_AVAILABLE",
      connected: Boolean(session), device: session?.getCastDevice().friendlyName ?? "" });
    if (!session && this.snapshot.key) {
      this.publish({ state: "paused", disconnected: true });
      void this.releaseTicket().catch((error) => this.report(error));
    }
  };
  async connect(): Promise<void> {
    if (this.disposed) throw new Error("Cast controller is closed");
    this.update({ loading: true, error: "" });
    try {
      if (!this.context) {
        this.sdk = await this.sdkLoader();
        if (this.disposed) throw new Error("Cast controller is closed");
        this.context = this.sdk.framework.CastContext.getInstance();
        this.context.setOptions({ receiverApplicationId: this.sdk.chrome.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
          autoJoinPolicy: this.sdk.chrome.AutoJoinPolicy.ORIGIN_SCOPED, resumeSavedSession: false });
        const events = this.sdk.framework.CastContextEventType;
        this.context.addEventListener(events.CAST_STATE_CHANGED, this.changed);
        this.context.addEventListener(events.SESSION_STATE_CHANGED, this.changed);
      }
      await this.context.requestSession();
      if (this.disposed) { this.context.endCurrentSession(true); throw new Error("Cast was cancelled because the controller closed."); }
      if (!this.context.getCurrentSession()) throw new Error("No Cast receiver was selected");
      this.changed();
    } catch (error) { this.report(error); throw error; }
    finally { this.update({ loading: false }); }
  }
  private requireSession(): CastSession {
    const session = this.context?.getCurrentSession();
    if (!session) throw new Error("The Cast receiver disconnected. Select a device again.");
    return session;
  }
  async load(track: PlayableTrack, options: LoadOptions): Promise<void> {
    const generation = ++this.generation;
    this.update({ error: "" });
    this.publish({ key: track.key, state: "loading", position: options.startAt ?? 0,
      duration: track.durationHint ?? 0, disconnected: false });
    const run = this.serial.then(async () => {
      if (generation !== this.generation || this.disposed) return;
      const cast = track.cast;
      if (!cast) throw new Error("Only local library tracks can be cast. Previews and external sources are not supported.");
      const ticket = await this.transport.issue(cast.trackId, cast.maxBitRate);
      if (generation !== this.generation || this.disposed) { await this.transport.revoke(ticket.token); return; }
      const previous = this.ticket;
      this.ticket = ticket;
      this.expectedContent = ticket.url;
      const media = this.sdk!.chrome.media;
      const info = new media.MediaInfo(ticket.url, ticket.contentType);
      const metadata = new media.MusicTrackMediaMetadata();
      metadata.title = cast.title; metadata.artist = cast.artist; metadata.albumName = cast.album;
      info.metadata = metadata; info.streamType = media.StreamType.BUFFERED;
      if (track.durationHint && track.durationHint > 0) info.duration = track.durationHint;
      const request = new media.LoadRequest(info);
      request.autoplay = options.autoplay ?? true; request.currentTime = Math.max(0, options.startAt ?? 0);
      try { await this.requireSession().loadMedia(request); }
      catch (error) {
        if (this.ticket === ticket) { this.ticket = null; this.expectedContent = ""; }
        await this.transport.revoke(ticket.token);
        throw error;
      } finally { if (previous) await this.transport.revoke(previous.token); }
      if (generation === this.generation) { this.loadedGeneration = generation; this.endedKey = null; this.poll(); }
    });
    this.serial = run.catch(() => {});
    try { await run; }
    catch (error) {
      if (generation === this.generation) {
        if (this.context?.getCurrentSession()?.getMediaSession()?.media.contentId === this.expectedContent && this.expectedContent) {
          try { await this.pause(); } catch (pauseError) { this.report(pauseError); }
        }
        try { await this.releaseTicket(); } catch (cleanupError) { this.report(cleanupError); }
        this.publish({ state: "error" }); this.report(error);
      }
      throw error;
    }
  }
  private mediaCommand(action: (media: CastMedia, success: () => void, failure: (error: unknown) => void) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const media = this.requireSession().getMediaSession();
      if (!media || media.media.contentId !== this.expectedContent) { reject(new Error("The receiver is not playing the MusicDeck queue")); return; }
      const timer = setTimeout(() => reject(new Error("The Cast receiver did not acknowledge this command.")), 10000);
      const finish = (error?: unknown) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
      try { action(media, () => finish(), (error) => finish(error || new Error("Receiver command failed"))); }
      catch (error) { finish(error); }
    });
  }
  private command(work: () => Promise<void>): Promise<void> {
    const generation = this.generation;
    const run = this.serial.then(async () => {
      if (generation !== this.generation || this.disposed) return;
      await work();
      this.poll();
    });
    this.serial = run.catch(() => {});
    return run;
  }
  async play(): Promise<void> { await this.command(() => this.mediaCommand((media, ok, fail) => media.play(null, ok, fail))); }
  async pause(): Promise<void> { await this.command(() => this.mediaCommand((media, ok, fail) => media.pause(null, ok, fail))); }
  async seek(seconds: number): Promise<void> {
    const request = new this.sdk!.chrome.media.SeekRequest();
    request.currentTime = Math.max(0, seconds);
    await this.command(() => this.mediaCommand((media, ok, fail) => media.seek(request, ok, fail)));
  }
  async setVolume(volume: number): Promise<void> { await this.requireSession().setVolume(Math.max(0, Math.min(1, volume))); }
  private poll(): void {
    const session = this.context?.getCurrentSession();
    const volume = session?.getVolume();
    if (volume !== undefined && Number.isFinite(volume)) this.update({ volume: Math.max(0, Math.min(1, volume)) });
    const media = session?.getMediaSession();
    if (!media || !this.snapshot.key || this.loadedGeneration !== this.generation || media.media.contentId !== this.expectedContent) return;
    const states: Record<string, EngineState> = { PLAYING: "playing", PAUSED: "paused", BUFFERING: "buffering", IDLE: "paused" };
    const finished = media.playerState === "IDLE" && media.idleReason === "FINISHED" && this.endedKey !== this.snapshot.key;
    if (finished) this.endedKey = this.snapshot.key;
    const position = media.getEstimatedTime();
    const duration = media.media.duration;
    this.publish({ position: Number.isFinite(position) ? Math.max(0, position) : this.snapshot.position,
      duration: duration !== undefined && Number.isFinite(duration) ? Math.max(0, duration) : this.snapshot.duration,
      state: media.idleReason === "ERROR" ? "error" : states[media.playerState] ?? "buffering", ended: finished });
    if (media.idleReason === "ERROR") this.update({ error: "The receiver could not decode or reach this stream. Check receiver network access and stream format." });
  }
  private async releaseTicket(): Promise<void> {
    const ticket = this.ticket;
    if (ticket) {
      await this.transport.revoke(ticket.token);
      if (this.ticket === ticket) this.ticket = null;
    }
  }
  async disconnect(): Promise<void> {
    ++this.generation;
    await this.serial;
    this.context?.endCurrentSession(true);
    await this.releaseTicket();
    this.expectedContent = "";
    this.update({ connected: false, device: "" });
    this.publish({ state: "paused", disconnected: true });
  }
  private report(error: unknown): void {
    console.error("Google Cast operation failed:", error instanceof Error ? error.message : "Receiver operation failed");
    this.update({ error: error instanceof Error ? error.message : "Google Cast operation failed. Check the receiver connection." });
  }
  async destroy(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.context && this.sdk) {
      const events = this.sdk.framework.CastContextEventType;
      this.context.removeEventListener(events.CAST_STATE_CHANGED, this.changed);
      this.context.removeEventListener(events.SESSION_STATE_CHANGED, this.changed);
    }
    try { await this.disconnect(); }
    catch (error) { this.report(error); }
    this.listeners.clear(); this.stateListeners.clear();
  }
}
