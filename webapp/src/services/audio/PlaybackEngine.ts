import {
  MAX_STREAM_RECOVERY_ATTEMPTS,
  RECOVERY_LOAD_TIMEOUT_MS,
  STALL_RECOVERY_DELAY_MS,
  streamRecoveryBackoffMs,
} from "../../utils/streamRecovery";
import {
  CrossfadeTransition,
  DEFAULT_CROSSFADE_SECONDS,
  clampCrossfadeSeconds,
} from "./crossfadeTransition";
import { GaplessTransition } from "./gaplessTransition";
import { offlineDownloadEngine } from "../storage/OfflineDownloadEngine";
import { MediaStallRecovery } from "./mediaStallRecovery";
import {
  AudioGraph,
  BufferVoice,
  ElementVolumeGain,
  MediaDeck,
  clamp,
  createDefaultAudioContext,
  playableEnd,
} from "./outputs";
import type { PlaybackOutput } from "./outputs";
import type { FetchLike } from "./resumableFetch";
import type { TransitionHost, TransitionTicket } from "./transitionHost";
import type { RemoteAudioOutput } from "./remoteOutput";
import { normalizeEqualizerSettings, readEqualizerSettings, saveEqualizerSettings, type EqualizerSettings } from "./EqualizerEngine";
import { SleepTimerService, type SleepMinutes } from "./SleepTimerService";
import type {
  CrossfadeCurve,
  EngineState,
  LoadOptions,
  PlayableTrack,
  PlaybackEngineEvent,
  PlaybackEngineEventMap,
  PlaybackEngineListener,
  PlaybackSnapshot,
  TrackAudioSettings,
  TransitionKind,
  TransitionMode,
} from "./types";

export {
  CROSSFADE_MAX_SECONDS,
  CROSSFADE_MIN_SECONDS,
  clampCrossfadeSeconds,
} from "./crossfadeTransition";
export type {
  CrossfadeCurve,
  EngineState,
  LoadOptions,
  PlayableTrack,
  PlaybackEngineEvent,
  PlaybackEngineEventMap,
  PlaybackEngineListener,
  PlaybackSnapshot,
  TrackAudioSettings,
  TransitionKind,
  TransitionMode,
} from "./types";

export interface PlaybackEngineOptions {
  transitionMode?: TransitionMode;
  albumAware?: boolean;
  /** Clamped to 1–10 s. */
  crossfadeSeconds?: number;
  crossfadeCurve?: CrossfadeCurve;
  volume?: number;
  gaplessPrefetchRatio?: number;
  maxGaplessDecodeSeconds?: number;
  maxGaplessFetchBytes?: number;
  stallTimeoutMs?: number;
  recoveryLoadTimeoutMs?: number;
  maxRecoveryAttempts?: number;
  fetchImpl?: FetchLike;
  fetchInit?: Omit<RequestInit, "headers" | "signal">;
  fetchHeaders?: Record<string, string>;
  /**
   * `undefined` creates (and owns) an AudioContext when the browser supports one.
   * Pass `null` to force the HTMLAudioElement-only fallback, or an existing
   * context to share it (the engine will not close a shared context).
   */
  audioContext?: AudioContext | null;
  createAudioElement?: () => HTMLAudioElement;
  /** Required for Web Audio routing when streams are served from another origin. */
  crossOrigin?: "anonymous" | "use-credentials" | null;
}

/** The subset the queue store depends on; lets tests substitute a fake engine. */
export interface QueuePlaybackEngine {
  load(track: PlayableTrack, options?: LoadOptions): Promise<void>;
  setUpcoming(track: PlayableTrack | null): void;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  getPosition(): number;
  on<K extends PlaybackEngineEvent>(event: K, listener: PlaybackEngineListener<K>): () => void;
}

const PROGRESS_TICK_MS = 250;
/** Emitted with `error` when autoplay policy rejects `play()`; a user gesture can retry. */
export const PLAYBACK_BLOCKED_MESSAGE = "The browser blocked playback. Press play to start.";
const DEFAULT_PREFETCH_RATIO = 0.9;
const DEFAULT_MAX_DECODE_SECONDS = 20 * 60;
const DEFAULT_MAX_FETCH_BYTES = 150 * 1024 * 1024;
const GAPLESS_SCHEDULE_LEAD_SECONDS = 1.5;
const CROSSFADE_PRELOAD_LEAD_SECONDS = 8;
const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_DECODE = 3;
const HAVE_METADATA = 1;

type AnyListener = (payload: unknown) => void;

function errorName(error: unknown): string {
  return error && typeof error === "object" && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
}

function mediaErrorMessage(code: number | undefined): string {
  if (code === MEDIA_ERR_DECODE) return "This track could not be decoded.";
  if (code === MEDIA_ERR_ABORTED) return "Loading this track was interrupted.";
  return "This track could not be played.";
}

/**
 * Owns all audio output for MusicDeck: two HTMLAudioElement decks (streaming,
 * crossfade, stall recovery) plus decoded Web Audio voices (gapless).
 *
 * Exactly one transition path runs per track change. `beginTransition` only
 * issues a ticket to the handler matching the current mode and only while no
 * other ticket exists; mode changes requested mid-transition are staged until
 * it commits or is cancelled.
 */
export class PlaybackEngine implements QueuePlaybackEngine {
  readonly sleepTimer: SleepTimerService;
  private equalizerSettings = readEqualizerSettings();
  private sleepStoppedKey: string | null = null;
  private fallbackFade: { start: number; end: number; from: number; to: number } | null = null;
  private fallbackFadeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly graph: AudioGraph | null;
  private readonly decks: readonly [MediaDeck, MediaDeck];
  private readonly detachers: Array<() => void> = [];
  private readonly listeners = new Map<PlaybackEngineEvent, Set<AnyListener>>();
  private readonly recovery: MediaStallRecovery;
  private readonly gapless: GaplessTransition;
  private readonly crossfade: CrossfadeTransition;
  private active: PlaybackOutput | null = null;
  private upcoming: PlayableTrack | null = null;
  private mode: TransitionMode;
  private albumAware: boolean;
  private activeSourceTrack: PlayableTrack | null = null;
  private upcomingSourceTrack: PlayableTrack | null = null;
  private stagedMode: TransitionMode | null = null;
  private crossfadeSeconds: number;
  private crossfadeCurve: CrossfadeCurve;
  private volume: number;
  private wantsPlayback = false;
  private state: EngineState = "idle";
  private transition: TransitionTicket | null = null;
  private ticketSequence = 0;
  private pendingStartAt: { deck: MediaDeck; seconds: number } | null = null;
  /** The streamed output whose trimmed end already ended it, so it ends only once. */
  private trimEndedOutput: PlaybackOutput | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private remoteOutput: RemoteAudioOutput | null = null;
  private detachRemote: (() => void) | null = null;
  private remoteGeneration = 0;

  constructor(options: PlaybackEngineOptions = {}) {
    this.mode = options.transitionMode ?? "off";
    this.albumAware = options.albumAware ?? false;
    this.crossfadeSeconds = clampCrossfadeSeconds(
      options.crossfadeSeconds ?? DEFAULT_CROSSFADE_SECONDS
    );
    this.crossfadeCurve = options.crossfadeCurve ?? "equal-power";
    this.volume = clamp(options.volume ?? 1, 0, 1);

    const ownsContext = options.audioContext === undefined;
    const ctx = ownsContext ? createDefaultAudioContext() : options.audioContext ?? null;
    this.graph = ctx ? new AudioGraph(ctx, ownsContext) : null;
    this.graph?.setVolume(this.volume);

    const createElement = options.createAudioElement ?? (() => new Audio());
    const masterVolume = () => this.volume * this.fallbackSleepLevel();
    const makeDeck = () => {
      const element = createElement();
      if (options.crossOrigin) element.crossOrigin = options.crossOrigin;
      const deck = new MediaDeck(element, this.graph, masterVolume);
      deck.gain.reset();
      return deck;
    };
    this.decks = [makeDeck(), makeDeck()];
    this.decks.forEach((deck) => this.attachDeck(deck));

    this.recovery = new MediaStallRecovery(
      {
        wantsPlayback: () => this.wantsPlayback,
        recoverySource: (key) => {
          const track = this.activeSourceTrack;
          if (!track?.offlineTrackId || track.key !== key ||
            !offlineDownloadEngine.getSnapshot().tracks.some(item => item.track_id === track.offlineTrackId && item.status === "verified")) return null;
          return offlineDownloadEngine.localPlaybackUrl(track.offlineTrackId);
        },
        onStall: (info) => {
          this.cancelTransition("stall");
          this.setState("stalled");
          this.emit("bufferStall", info);
        },
        onRecovered: (info) => {
          this.emit("streamRecovered", info);
          this.setState(this.wantsPlayback ? "playing" : "paused");
          this.emitTime();
        },
        onFailed: (info) => {
          this.wantsPlayback = false;
          this.setState("error");
          this.emit("recoveryFailed", info);
          this.emit("error", {
            key: info.key,
            message: "Lost connection to the server. Press play to try again.",
          });
        },
      },
      {
        stallTimeoutMs: options.stallTimeoutMs ?? STALL_RECOVERY_DELAY_MS,
        loadTimeoutMs: options.recoveryLoadTimeoutMs ?? RECOVERY_LOAD_TIMEOUT_MS,
        maxAttempts: options.maxRecoveryAttempts ?? MAX_STREAM_RECOVERY_ATTEMPTS,
        backoffMs: streamRecoveryBackoffMs,
      }
    );

    const host = this.createTransitionHost();
    this.gapless = new GaplessTransition(host, {
      prefetchRatio: options.gaplessPrefetchRatio ?? DEFAULT_PREFETCH_RATIO,
      maxDecodeSeconds: options.maxGaplessDecodeSeconds ?? DEFAULT_MAX_DECODE_SECONDS,
      maxFetchBytes: options.maxGaplessFetchBytes ?? DEFAULT_MAX_FETCH_BYTES,
      scheduleLeadSeconds: GAPLESS_SCHEDULE_LEAD_SECONDS,
      maxFetchRetries: options.maxRecoveryAttempts ?? MAX_STREAM_RECOVERY_ATTEMPTS,
      backoffMs: streamRecoveryBackoffMs,
      fetchImpl: options.fetchImpl,
      fetchInit: options.fetchInit ?? { credentials: "same-origin" },
      fetchHeaders: options.fetchHeaders,
    });
    this.crossfade = new CrossfadeTransition(host, {
      seconds: () => this.crossfadeSeconds,
      curve: () => this.crossfadeCurve,
      preloadLeadSeconds: CROSSFADE_PRELOAD_LEAD_SECONDS,
    });
    this.graph?.equalizer?.setSettings(this.equalizerSettings);
    this.sleepTimer = new SleepTimerService({
      fade: (delay, duration) => this.setSleepEnvelope(0, delay, duration),
      restore: () => this.setSleepEnvelope(1, 0, 0.08),
      stop: () => {
        this.sleepStoppedKey = this.activeSourceTrack?.key ?? this.active?.key ?? null;
        this.pause();
        this.stopTicker();
        this.emit("sleepStop", { key: this.sleepStoppedKey });
      },
    });
    const realign = () => {
      this.sleepTimer.realignClock();
      this.sleepTimer.resetBoundaryFade();
      this.updateSleepBoundary();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", realign);
      this.detachers.push(() => document.removeEventListener("visibilitychange", realign));
    }
    ctx?.addEventListener?.("statechange", realign);
    if (ctx) this.detachers.push(() => ctx.removeEventListener?.("statechange", realign));
  }

  get equalizerAvailable(): boolean {
    return Boolean(this.graph?.equalizer && !this.remoteOutput && !(this.active?.gain instanceof ElementVolumeGain));
  }

  getEqualizerSettings(): EqualizerSettings {
    return this.equalizerSettings;
  }

  getEqualizerAnalyser(): AnalyserNode | null {
    return this.equalizerAvailable ? this.graph?.equalizer?.getAnalyser() ?? null : null;
  }

  setEqualizerSettings(settings: EqualizerSettings): boolean {
    this.equalizerSettings = normalizeEqualizerSettings(settings);
    this.graph?.equalizer?.setSettings(this.equalizerSettings);
    return saveEqualizerSettings(this.equalizerSettings);
  }

  startSleepTimer(choice: SleepMinutes | "track" | "album", albumKeys: readonly string[] = []): void {
    if (this.destroyed || this.remoteOutput) throw new Error("Sleep timer needs a local player.");
    if (typeof choice === "number") {
      this.sleepTimer.armDuration(choice);
      return;
    }
    const key = this.active?.key;
    if (!key) throw new Error("Start playback to select a track or album boundary.");
    const keys = choice === "track" ? [key] : albumKeys;
    if (keys[0] !== key) throw new Error("The active album changed. Try again.");
    this.sleepTimer.armBoundary(choice, keys);
    if (this.sleepTimer.blocksTransition(key)) {
      this.cancelTransition("sleep-boundary");
      this.gapless.discardPrepared();
      this.crossfade.discardPrepared();
    }
    this.updateSleepBoundary();
  }

  private fallbackSleepLevel(): number {
    const fade = this.fallbackFade;
    if (!fade) return 1;
    const now = Date.now();
    if (now < fade.start) return fade.from;
    if (now >= fade.end) return fade.to;
    return fade.from + (fade.to - fade.from) * (now - fade.start) / (fade.end - fade.start);
  }

  private setSleepEnvelope(to: number, delay: number, duration: number): void {
    this.graph?.setSleepGain(to, delay, duration);
    clearTimeout(this.fallbackFadeTimer);
    const decks = this.decks.filter(deck => deck.gain instanceof ElementVolumeGain);
    if (!decks.length) return;
    const start = Date.now() + delay * 1000;
    this.fallbackFade = { start, end: start + duration * 1000, from: delay > 0 ? 1 : this.fallbackSleepLevel(), to };
    const tick = () => {
      for (const deck of decks) (deck.gain as ElementVolumeGain).refresh();
      if (Date.now() < start + duration * 1000) this.fallbackFadeTimer = setTimeout(tick, 40);
    };
    if (delay > 0) {
      for (const deck of decks) (deck.gain as ElementVolumeGain).refresh();
      this.fallbackFadeTimer = setTimeout(tick, delay * 1000);
    }
    else tick();
  }

  get usesWebAudio(): boolean {
    return this.graph !== null;
  }

  // ---------------------------------------------------------------- events

  on<K extends PlaybackEngineEvent>(event: K, listener: PlaybackEngineListener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const stored = listener as AnyListener;
    set.add(stored);
    return () => {
      set?.delete(stored);
    };
  }

  onTrackEnd(listener: PlaybackEngineListener<"trackEnd">): () => void {
    return this.on("trackEnd", listener);
  }

  onBufferStall(listener: PlaybackEngineListener<"bufferStall">): () => void {
    return this.on("bufferStall", listener);
  }

  onStreamRecovered(listener: PlaybackEngineListener<"streamRecovered">): () => void {
    return this.on("streamRecovered", listener);
  }

  // ---------------------------------------------------------------- commands

  get isRemoteOutput(): boolean { return this.remoteOutput !== null; }

  async setRemoteOutput(output: RemoteAudioOutput | null): Promise<void> {
    if (this.destroyed) return;
    if (this.remoteOutput === output) {
      if (output && this.activeSourceTrack && output.getSnapshot().disconnected) {
        await this.load(this.activeSourceTrack, { startAt: this.getPosition(), autoplay: false });
      }
      return;
    }
    const track = this.activeSourceTrack;
    if (output) this.sleepTimer.cancel();
    const position = this.getPosition();
    const autoplay = this.state === "playing" || this.wantsPlayback;
    const previous = this.remoteOutput;
    if (previous) await previous.pause();
    this.detachRemote?.(); this.detachRemote = null;
    const generation = ++this.remoteGeneration;
    this.cancelTransition("output-changed");
    this.recovery.cancel();
    this.gapless.discardPrepared(); this.crossfade.discardPrepared();
    this.stopTicker();
    this.active?.release(); this.active = null;
    this.decks.forEach((deck) => deck.release());
    this.pendingStartAt = null;
    this.remoteOutput = output;
    this.upcoming = output ? null : this.upcomingSourceTrack ? this.albumTrack(this.upcomingSourceTrack) : null;
    if (output) {
      this.detachRemote = output.subscribe((snapshot) => {
        if (!snapshot.key || this.remoteOutput !== output || snapshot.key !== this.activeSourceTrack?.key) return;
        if (snapshot.disconnected) {
          // Never auto-resume locally after a receiver loss: it may still be audible.
          this.wantsPlayback = false;
          this.setState("paused");
          return;
        }
        this.setState(snapshot.state);
        this.emit("timeUpdate", { key: snapshot.key, position: snapshot.position, duration: snapshot.duration });
        if (snapshot.ended) {
          this.wantsPlayback = false;
          this.emit("trackEnd", { key: snapshot.key });
        }
      });
      await output.setVolume(this.volume);
    }
    if (track && generation === this.remoteGeneration && track.key === this.activeSourceTrack?.key) {
      await this.load(this.activeSourceTrack, { startAt: position, autoplay: output ? autoplay : false });
    }
  }

  /** Called after the receiver has been stopped, or a lost session has been acknowledged. */
  async releaseRemoteOutput(expected?: RemoteAudioOutput): Promise<void> {
    if (!this.remoteOutput || (expected && expected !== this.remoteOutput)) return;
    this.detachRemote?.(); this.detachRemote = null;
    const track = this.activeSourceTrack;
    const position = this.getPosition();
    this.remoteOutput = null; ++this.remoteGeneration;
    this.upcoming = this.upcomingSourceTrack ? this.albumTrack(this.upcomingSourceTrack) : null;
    this.wantsPlayback = false;
    if (track) await this.load(track, { startAt: position, autoplay: false });
  }

  private remoteFailure(error: unknown): void {
    console.error("Remote audio output failed:", error instanceof Error ? error.message : "Receiver operation failed");
    this.wantsPlayback = false;
    this.setState("error");
    this.emit("error", { key: this.activeSourceTrack?.key ?? null,
      message: error instanceof Error ? error.message : "The remote audio operation failed." });
  }

  async load(track: PlayableTrack, options: LoadOptions = {}): Promise<void> {
    if (this.destroyed) return;
    this.sleepStoppedKey = null;
    this.sleepTimer.updateBoundary(track.key, null, false);
    this.activeSourceTrack = track;
    if (this.remoteOutput) {
      const output = this.remoteOutput;
      const generation = ++this.remoteGeneration;
      this.wantsPlayback = options.autoplay ?? true;
      this.setState("loading");
      try { await output.load(track, options); }
      catch (error) { if (generation === this.remoteGeneration) this.remoteFailure(error); }
      return;
    }
    if (track.offlineTrackId && offlineDownloadEngine.getSnapshot().tracks.some((item) => item.track_id === track.offlineTrackId && item.status === "verified")) {
      const requested = track;
      this.wantsPlayback = options.autoplay ?? true;
      try {
        const local = await offlineDownloadEngine.localPlaybackUrl(track.offlineTrackId);
        if (this.destroyed || this.activeSourceTrack !== requested) return;
        options = { ...options, autoplay: this.wantsPlayback };
        if (local) track = { ...track, src: local };
        else if (track.offlineOnly || navigator.onLine === false) throw new Error("This track has no verified offline audio. Download it again when connected.");
      } catch (error) {
        if (this.destroyed || this.activeSourceTrack !== requested) return;
        if (track.offlineOnly || navigator.onLine === false) {
          this.active?.pause(); this.wantsPlayback = false; this.setState("error");
          this.emit("error", { key: track.key, message: error instanceof Error ? error.message : "Could not read offline audio." });
          return;
        }
      }
    } else if (track.offlineOnly || (track.offlineTrackId && navigator.onLine === false)) {
      this.active?.pause(); this.wantsPlayback = false; this.setState("error");
      this.emit("error", { key: track.key, message: "Open Downloads for this device before playing saved audio." }); return;
    }
    track = this.albumTrack(track);
    const startAt = Math.max(0, options.startAt ?? 0);
    const autoplay = options.autoplay ?? true;
    this.cancelTransition("superseded");

    const previous = this.active;
    const recoveryBroken = this.recovery.isRecovering() || this.recovery.hasFailed();
    if (
      previous && previous.key === track.key && previous.src === track.src &&
      !recoveryBroken && previous.isSeekable()
    ) {
      previous.configure(track);
      this.trimEndedOutput = null;
      // Restarting from 0 still skips leading silence.
      previous.seek(startAt > 0 ? startAt : previous.trim().start);
      this.wantsPlayback = autoplay;
      if (autoplay) {
        await this.startOutput(previous);
      } else {
        previous.pause();
        this.setState("paused");
      }
      this.emitTime();
      return;
    }

    this.recovery.cancel();
    const adopted = this.adoptPrepared(track);
    this.gapless.discardPrepared();
    this.crossfade.discardPrepared();
    if (previous && previous !== adopted) previous.release();

    let output: PlaybackOutput;
    if (adopted) {
      // The prepared copy may predate settings that resolved since.
      adopted.configure(track);
      output = adopted;
    } else {
      const deck = previous === this.decks[0] ? this.decks[1] : this.decks[0];
      deck.load(track, "auto");
      output = deck;
    }

    this.setActive(output);
    this.wantsPlayback = autoplay;
    if (startAt > 0) {
      if (output instanceof MediaDeck && output.element.readyState < HAVE_METADATA) {
        this.pendingStartAt = { deck: output, seconds: startAt };
      } else {
        output.seek(startAt);
      }
    }

    if (autoplay) {
      this.setState("loading");
      await this.startOutput(output);
    } else {
      this.setState("paused");
    }
  }

  async play(): Promise<void> {
    if (this.remoteOutput) {
      this.wantsPlayback = true;
      try { await this.remoteOutput.play(); } catch (error) { this.remoteFailure(error); }
      return;
    }
    const output = this.active;
    if (!output || this.destroyed) return;
    if (this.sleepStoppedKey === output.key) {
      this.sleepStoppedKey = null;
      const end = playableEnd(output);
      if (end !== null && output.position() >= end - 0.05) output.seek(output.trim().start);
    }
    this.wantsPlayback = true;
    this.graph?.resume();
    if (this.recovery.retryNow() || this.recovery.isRecovering()) {
      this.setState("stalled");
      return;
    }

    if (!output.isPlaying()) this.setState(this.transition ? "transitioning" : "loading");
    await this.startOutput(output);
  }

  async unlock(): Promise<void> {
    if (this.graph?.ctx.state === "suspended") await this.graph.ctx.resume();
  }

  isReadyForResume(): boolean {
    if (this.remoteOutput) return false;
    const output = this.active;
    if (!output || this.pendingStartAt) return false;
    return output instanceof BufferVoice || (output instanceof MediaDeck &&
      output.element.readyState >= 3 && !output.element.seeking &&
      Number.isFinite(output.element.duration) && output.element.duration > 0);
  }

  pause(): void {
    this.wantsPlayback = false;
    if (this.remoteOutput) {
      void this.remoteOutput.pause().catch((error) => this.remoteFailure(error));
      return;
    }
    this.cancelTransition("paused");
    if (!this.recovery.isRecovering()) this.active?.pause();
    this.setState(this.active ? "paused" : "idle");
  }

  seek(seconds: number): void {
    if (this.remoteOutput && Number.isFinite(seconds)) {
      void this.remoteOutput.seek(Math.max(0, seconds)).catch((error) => this.remoteFailure(error));
      return;
    }
    const output = this.active;
    if (!output || !Number.isFinite(seconds)) return;
    this.sleepTimer.resetBoundaryFade();
    if (this.recovery.isRecovering() || this.recovery.hasFailed()) {
      this.recovery.updatePosition(seconds);
      return;
    }
    this.cancelTransition("seek");
    this.trimEndedOutput = null;
    if (output instanceof MediaDeck && this.pendingStartAt?.deck === output) {
      this.pendingStartAt = { deck: output, seconds: Math.max(0, seconds) };
      return;
    }
    output.seek(seconds);
    this.emitTime();
  }

  /** Tells the engine which entry follows the active one; `null` at the end of the queue. */
  setUpcoming(track: PlayableTrack | null): void {
    this.upcomingSourceTrack = track;
    if (this.remoteOutput) { this.upcoming = null; return; }
    if (track?.offlineTrackId && offlineDownloadEngine.getSnapshot().tracks.some((item) => item.track_id === track?.offlineTrackId && item.status === "verified")) {
      const requested = track;
      const cached = offlineDownloadEngine.cachedPlaybackUrl(track.offlineTrackId);
      if (cached) { this.installUpcoming({ ...track, src: cached }); return; }
      this.installUpcoming(null);
      void offlineDownloadEngine.localPlaybackUrl(track.offlineTrackId).then((local) => {
        if (this.destroyed || this.upcomingSourceTrack !== requested) return;
        this.installUpcoming(local ? { ...requested, src: local } : requested.offlineOnly || navigator.onLine === false ? null : requested);
      }).catch(() => {
        if (!this.destroyed && this.upcomingSourceTrack === requested && !requested.offlineOnly && navigator.onLine !== false) this.installUpcoming(requested);
      });
      return;
    }
    this.installUpcoming(track);
  }

  private installUpcoming(track: PlayableTrack | null): void {
    if (track) track = this.albumTrack(track);
    const current = this.upcoming;
    if (current?.key === track?.key && current?.src === track?.src) {
      this.upcoming = track;
      return;
    }
    this.upcoming = track;
    if (this.transition && this.transition.toKey !== track?.key) {
      this.cancelTransition("upcoming-changed");
    }
    this.gapless.discardPrepared();
    this.crossfade.discardPrepared();
  }

  setTransitionMode(mode: TransitionMode): void {
    if (this.transition) {
      this.stagedMode = mode === this.mode ? null : mode;
      return;
    }
    this.applyMode(mode);
  }

  setAlbumAware(enabled: boolean): void {
    if (this.albumAware === enabled) return;
    this.albumAware = enabled;
    this.cancelTransition("album-mode-changed");
    this.gapless.discardPrepared();
    this.crossfade.discardPrepared();
    this.upcoming = this.upcomingSourceTrack ? this.albumTrack(this.upcomingSourceTrack) : null;
    if (this.activeSourceTrack) this.active?.configure(this.albumTrack(this.activeSourceTrack));
    this.trimEndedOutput = null;
  }

  private albumTrack(track: PlayableTrack): PlayableTrack {
    return this.albumAware && track.albumPlaybackId ? { ...track, trimStart: 0, trimEnd: null } : track;
  }

  private effectiveMode(): TransitionMode {
    if (this.sleepTimer.blocksTransition(this.active?.key ?? null)) return "off";
    const current = this.activeSourceTrack;
    return this.albumAware && current?.albumPlaybackId && current.albumPlaybackId === this.upcoming?.albumPlaybackId &&
      current.albumTrackIndex !== undefined && this.upcoming?.albumTrackIndex === current.albumTrackIndex + 1
      ? "gapless" : this.mode;
  }

  /**
   * Applies gain/trim values that resolved after a queue entry was handed to
   * the engine (loudness or silence analysis). Reaches the active output, the
   * upcoming entry and anything already prepared for it. A trim change on
   * either side of an in-flight transition cancels it so it is re-planned
   * against the new boundary.
   */
  updateTrack(key: string, settings: TrackAudioSettings): void {
    if (this.destroyed || !key) return;
    if (this.activeSourceTrack?.key === key) this.activeSourceTrack = { ...this.activeSourceTrack, ...settings };
    if (this.upcomingSourceTrack?.key === key) this.upcomingSourceTrack = { ...this.upcomingSourceTrack, ...settings };
    if (this.albumAware && ((this.active?.key === key && this.activeSourceTrack?.albumPlaybackId) ||
      (this.upcoming?.key === key && this.upcoming.albumPlaybackId))) {
      settings = { ...settings, trimStart: undefined, trimEnd: undefined };
    }
    if (this.upcoming?.key === key) this.upcoming = { ...this.upcoming, ...settings };
    const trimChanged = settings.trimStart !== undefined || settings.trimEnd !== undefined;
    const transition = this.transition;
    if (trimChanged && transition && (transition.fromKey === key || transition.toKey === key)) {
      this.cancelTransition("track-updated");
    }
    const outputs = new Set<PlaybackOutput>(this.decks);
    if (this.active) outputs.add(this.active);
    const scheduled = this.gapless.scheduledVoice();
    if (scheduled) outputs.add(scheduled);
    outputs.forEach((output) => {
      if (output.key === key) output.configure(settings);
    });
    if (trimChanged && this.active?.key === key) this.trimEndedOutput = null;
  }

  setCrossfadeSeconds(seconds: number): void {
    this.crossfadeSeconds = clampCrossfadeSeconds(seconds);
  }

  setCrossfadeCurve(curve: CrossfadeCurve): void {
    this.crossfadeCurve = curve;
  }

  setVolume(volume: number): void {
    this.volume = clamp(Number.isFinite(volume) ? volume : 1, 0, 1);
    if (this.remoteOutput) {
      void this.remoteOutput.setVolume(this.volume).catch((error) => this.remoteFailure(error));
    }
    this.graph?.setVolume(this.volume);
    for (const deck of this.decks) {
      if (deck.gain instanceof ElementVolumeGain) deck.gain.refresh();
    }
  }

  getPosition(): number {
    if (this.remoteOutput) return this.remoteOutput.getSnapshot().position;
    const saved = this.recovery.savedPosition();
    if (saved !== null) return saved;
    return this.active?.position() ?? 0;
  }

  getSnapshot(): PlaybackSnapshot {
    if (this.remoteOutput) {
      const remote = this.remoteOutput.getSnapshot();
      return { key: this.activeSourceTrack?.key ?? null, state: this.state,
        position: remote.position, duration: remote.duration, mode: "off", transition: null };
    }
    const duration = this.active?.duration() ?? Number.NaN;
    return {
      key: this.active?.key ?? null,
      state: this.state,
      position: this.getPosition(),
      duration: Number.isFinite(duration) ? duration : 0,
      mode: this.stagedMode ?? this.mode,
      transition: this.transition?.kind ?? null,
    };
  }

  getAudioDiagnostics() {
    const graph = this.graph && this.active && !(this.active.gain instanceof ElementVolumeGain) ? this.graph : null;
    const level = this.active?.gain.getLevel() ?? 1;
    return {
      path: graph ? "Web Audio" as const : "HTML Audio" as const,
      sampleRateHz: graph ? graph.ctx.sampleRate : null,
      outputChannels: graph ? graph.ctx.destination.channelCount : null,
      outputDeviceType: "Not exposed by browser",
      gainDb: level > 0 ? 20 * Math.log10(level) : null,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.cancelTransition("destroyed");
    this.detachRemote?.(); this.detachRemote = null;
    this.remoteOutput = null; ++this.remoteGeneration;
    this.destroyed = true;
    this.wantsPlayback = false;
    this.sleepTimer.dispose();
    clearTimeout(this.fallbackFadeTimer);
    this.stopTicker();
    this.recovery.dispose();
    this.gapless.dispose();
    this.crossfade.dispose();
    if (this.active instanceof BufferVoice) this.active.release();
    this.active = null;
    this.upcoming = null;
    this.activeSourceTrack = null;
    this.upcomingSourceTrack = null;
    this.detachers.splice(0).forEach((detach) => detach());
    this.decks.forEach((deck) => deck.dispose());
    this.graph?.dispose();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- internals

  private emit<K extends PlaybackEngineEvent>(event: K, payload: PlaybackEngineEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of Array.from(set)) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`PlaybackEngine "${event}" listener failed:`, error);
      }
    }
  }

  private setState(state: EngineState): void {
    if (this.state === state || this.destroyed) return;
    this.state = state;
    this.updateSleepBoundary();
    this.emit("stateChange", { key: this.remoteOutput ? this.activeSourceTrack?.key ?? null : this.active?.key ?? null, state });
  }

  private emitTime(): void {
    const output = this.active;
    if (!output) return;
    this.updateSleepBoundary();
    const duration = output.duration();
    this.emit("timeUpdate", {
      key: output.key,
      position: this.getPosition(),
      duration: Number.isFinite(duration) ? duration : 0,
    });
  }

  private applyMode(mode: TransitionMode): void {
    this.stagedMode = null;
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== "gapless") this.gapless.discardPrepared();
    if (mode !== "crossfade") this.crossfade.discardPrepared();
  }

  private adoptPrepared(track: PlayableTrack): PlaybackOutput | null {
    // Preparation always targets `upcoming`; a different URL for the same entry
    // (e.g. a normalized stream that became ready) makes it stale.
    if (this.upcoming?.key === track.key && this.upcoming.src !== track.src) return null;
    const gapless = this.gapless.takePrepared(track.key);
    if (gapless && "buffer" in gapless) {
      return this.graph ? new BufferVoice(this.graph, track, gapless.buffer) : null;
    }
    if (gapless) return gapless.deck;
    return this.crossfade.takePrepared(track.key);
  }

  private setActive(output: PlaybackOutput): void {
    const previous = this.active;
    if (previous instanceof BufferVoice && previous !== output) previous.onEnded = null;
    this.active = output;
    this.sleepTimer.updateBoundary(output.key, null, false);
    this.pendingStartAt = null;
    this.trimEndedOutput = null;
    if (output instanceof BufferVoice) {
      output.onEnded = (voice) => this.handleOutputEnded(voice);
    }
    this.recovery.watch(output instanceof MediaDeck ? output : null);
    this.stopTicker();
    if (output instanceof BufferVoice) this.startTicker();
  }

  private async startOutput(output: PlaybackOutput): Promise<void> {
    this.graph?.resume();
    try {
      await output.play();
      if (this.sleepStoppedKey === output.key && !this.wantsPlayback) output.pause();
    } catch (error) {
      if (output !== this.active || this.destroyed) return;
      const name = errorName(error);
      if (name === "AbortError") return;
      this.wantsPlayback = false;
      this.setState("paused");
      this.emit("error", {
        key: output.key,
        message: name === "NotAllowedError"
          ? PLAYBACK_BLOCKED_MESSAGE
          : "This track could not be played.",
      });
      return;
    }
    if (output !== this.active || !this.wantsPlayback || this.recovery.isRecovering()) return;
    if (output instanceof BufferVoice) this.startTicker();
    if (output.isPlaying()) this.setState(this.transition ? "transitioning" : "playing");
  }

  private handleProgress(output: PlaybackOutput): void {
    if (output !== this.active) return;
    this.emitTime();
    if (!this.upcoming || !this.wantsPlayback) return;
    if (this.recovery.isRecovering() || this.recovery.hasFailed()) return;
    if (this.effectiveMode() === "gapless") this.gapless.onProgress();
    else if (this.effectiveMode() === "crossfade") this.crossfade.onProgress();
  }

  private handleOutputEnded(output: PlaybackOutput): void {
    if (output !== this.active || this.destroyed) return;
    if (this.sleepStoppedKey === output.key || this.sleepTimer.endBoundary(output.key)) return;
    if (this.transition?.kind === "crossfade" && this.crossfade.onActiveEnded()) return;
    if (this.effectiveMode() === "gapless" && this.gapless.onActiveEnded()) return;
    this.stopTicker();
    this.wantsPlayback = false;
    this.emit("trackEnd", { key: output.key });
    if (this.active === output) this.setState("paused");
  }

  private updateSleepBoundary(): void {
    const { mode } = this.sleepTimer.getSnapshot();
    if (mode !== "track" && mode !== "album") return;
    const output = this.active;
    if (!output) return;
    const end = playableEnd(output);
    const playing = this.wantsPlayback && (this.state === "playing" || this.state === "transitioning")
      && !(output instanceof MediaDeck && output.element.seeking);
    this.sleepTimer.updateBoundary(output.key, end === null ? null : Math.max(0, end - output.position()), playing);
  }

  /**
   * Streamed decks have no clock-scheduled stop, so a trimmed end is detected
   * from `timeupdate` and treated exactly like the element's `ended` event.
   */
  private endAtTrim(deck: MediaDeck): void {
    const end = deck.trim().end;
    if (end === null || this.trimEndedOutput === deck || deck.position() < end) return;
    if (!deck.isPlaying() || !this.wantsPlayback) return;
    this.trimEndedOutput = deck;
    this.handleOutputEnded(deck);
    // No transition took over: silence the trailing audio instead of playing it.
    if (this.active === deck && !this.wantsPlayback) deck.pause();
  }

  private startTicker(): void {
    if (this.ticker !== null) return;
    this.ticker = setInterval(() => {
      const output = this.active;
      if (output instanceof BufferVoice && output.isPlaying()) this.handleProgress(output);
    }, PROGRESS_TICK_MS);
  }

  private stopTicker(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
  }

  private cancelTransition(reason: string, ticket: TransitionTicket | null = this.transition): void {
    if (!ticket || ticket !== this.transition) return;
    this.transition = null;
    if (ticket.kind === "gapless") this.gapless.abort();
    else this.crossfade.abort();
    this.emit("transitionCancel", {
      kind: ticket.kind,
      fromKey: ticket.fromKey,
      toKey: ticket.toKey,
      reason,
    });
    if (this.stagedMode !== null) this.applyMode(this.stagedMode);
    if (this.state === "transitioning") this.setState(this.wantsPlayback ? "playing" : "paused");
  }

  private createTransitionHost(): TransitionHost {
    return {
      graph: this.graph,
      activeOutput: () => this.active,
      upcomingTrack: () => this.upcoming,
      idleDeck: () => (this.active === this.decks[0] ? this.decks[1] : this.decks[0]),
      wantsPlayback: () => this.wantsPlayback,
      beginTransition: (kind, toKey) => this.beginTransition(kind, toKey),
      isCurrentTicket: (ticket) => ticket === this.transition,
      commitTransition: (ticket, incoming, options) =>
        this.commitTransition(ticket, incoming, options?.start === true),
      cancelTransition: (ticket, reason) => this.cancelTransition(reason, ticket),
    };
  }

  private beginTransition(kind: TransitionKind, toKey: string): TransitionTicket | null {
    const from = this.active;
    if (!from || this.destroyed || this.transition || kind !== this.effectiveMode()) return null;
    if (this.upcoming?.key !== toKey) return null;
    const ticket: TransitionTicket = {
      id: ++this.ticketSequence,
      kind,
      fromKey: from.key,
      toKey,
    };
    this.transition = ticket;
    this.emit("transitionStart", { kind, fromKey: ticket.fromKey, toKey });
    this.setState("transitioning");
    return ticket;
  }

  private commitTransition(
    ticket: TransitionTicket,
    incoming: PlaybackOutput,
    start: boolean
  ): void {
    if (ticket !== this.transition) {
      if (incoming !== this.active) incoming.release();
      return;
    }
    const outgoing = this.active;
    this.transition = null;
    this.activeSourceTrack = this.upcomingSourceTrack?.key === ticket.toKey ? this.upcomingSourceTrack : null;
    this.setActive(incoming);
    if (outgoing && outgoing !== incoming) outgoing.release();
    if (this.upcoming?.key === ticket.toKey) {
      this.upcoming = null;
      this.upcomingSourceTrack = null;
    }
    this.emit("transitionCommit", { kind: ticket.kind, fromKey: ticket.fromKey, toKey: ticket.toKey });
    if (this.stagedMode !== null) this.applyMode(this.stagedMode);
    if (start) {
      this.setState("loading");
      void this.startOutput(incoming);
    } else {
      this.setState(this.wantsPlayback ? "playing" : "paused");
    }
    this.emitTime();
  }

  private attachDeck(deck: MediaDeck): void {
    const element = deck.element;
    const listen = (type: string, handler: () => void) => {
      element.addEventListener(type, handler);
      this.detachers.push(() => element.removeEventListener(type, handler));
    };

    listen("timeupdate", () => {
      if (deck !== this.active) return;
      this.recovery.notifyProgress();
      if (this.recovery.isRecovering()) return;
      this.handleProgress(deck);
      this.endAtTrim(deck);
    });
    listen("seeking", () => { if (deck === this.active) this.sleepTimer.resetBoundaryFade(); });
    listen("seeked", () => { if (deck === this.active) this.updateSleepBoundary(); });
    listen("loadedmetadata", () => {
      const pending = this.pendingStartAt;
      if (deck !== this.active || pending?.deck !== deck || this.recovery.isRecovering()) return;
      this.pendingStartAt = null;
      deck.seek(pending.seconds);
      this.emitTime();
    });
    listen("playing", () => {
      if (deck !== this.active || this.recovery.isRecovering() || !this.wantsPlayback) return;
      this.setState(this.transition ? "transitioning" : "playing");
    });
    listen("waiting", () => {
      if (deck !== this.active || this.recovery.isRecovering() || !this.wantsPlayback) return;
      // A scheduled gapless start would cut into audio the element has not played yet.
      if (this.transition?.kind === "gapless") this.cancelTransition("buffering");
      if (this.state !== "loading") this.setState("buffering");
      this.recovery.notifyWaiting();
    });
    listen("stalled", () => {
      // `stalled` only means the fetch is idle; playback may continue from buffer.
      if (deck !== this.active || this.recovery.isRecovering()) return;
      this.recovery.notifyWaiting();
    });
    listen("pause", () => {
      // External pauses (OS media keys, headphones unplugged) keep engine intent in sync.
      if (deck !== this.active || this.recovery.isRecovering() || this.recovery.hasFailed()) return;
      if (!this.wantsPlayback || element.ended || !deck.isLoaded()) return;
      this.wantsPlayback = false;
      this.cancelTransition("paused");
      this.setState("paused");
    });
    listen("ended", () => this.handleOutputEnded(deck));
    listen("error", () => {
      if (deck !== this.active) {
        this.gapless.onPreparedDeckError(deck);
        this.crossfade.onDeckError(deck);
        return;
      }
      if (!deck.isLoaded() || this.recovery.isRecovering()) return;
      if (this.recovery.notifyError()) return;
      this.cancelTransition("error");
      this.wantsPlayback = false;
      this.setState("error");
      this.emit("error", { key: deck.key, message: mediaErrorMessage(element.error?.code) });
    });
  }
}
