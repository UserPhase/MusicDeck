import type { CrossfadeCurve, PlayableTrack, TrackAudioSettings } from "./types";
import { EqualizerEngine } from "./EqualizerEngine";

const CURVE_POINTS = 64;
const LEVEL_CURVE_POINTS = 129;
const FALLBACK_RAMP_INTERVAL_MS = 40;
const MAX_TRACK_LEVEL = 4;
const MIN_LEVEL = 0.000001;
const MIN_LEVEL_TRANSITION_SECONDS = 4;
const MAX_LEVEL_CHANGE_DB_PER_SECOND = 0.75;
const HAVE_METADATA = 1;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface LevelTransition {
  readonly startedAt: number;
  readonly duration: number;
  valueAt(time: number): number;
}

/**
 * A late loudness/ReplayGain correction applied to a track that is already
 * audible. It eases in decibels and changes by at most 0.75 dB/s (never faster
 * than 4 s), so a measurement arriving mid-song is not heard as a jump.
 */
export function levelTransition(from: number, to: number, startedAt: number): LevelTransition {
  const startDb = 20 * Math.log10(Math.max(MIN_LEVEL, from));
  const endDb = 20 * Math.log10(Math.max(MIN_LEVEL, to));
  const duration = Math.max(
    MIN_LEVEL_TRANSITION_SECONDS,
    (1.5 * Math.abs(endDb - startDb)) / MAX_LEVEL_CHANGE_DB_PER_SECOND
  );
  return {
    startedAt,
    duration,
    valueAt(time: number) {
      const p = clamp((time - startedAt) / duration, 0, 1);
      return 10 ** ((startDb + (endDb - startDb) * p * p * (3 - 2 * p)) / 20);
    },
  };
}

export function trackLevel(gain: number | undefined): number {
  return typeof gain === "number" && Number.isFinite(gain) ? clamp(gain, 0, MAX_TRACK_LEVEL) : 1;
}

export interface ReplayGainTags {
  readonly trackGainDb?: number;
  readonly albumGainDb?: number;
  readonly trackPeak?: number;
  readonly albumPeak?: number;
}

/** Album playback never substitutes track gain/peak: that would flatten album dynamics. */
export function replayGainLevel(tags: ReplayGainTags, albumAware = false): number {
  const gainDb = albumAware ? tags.albumGainDb : tags.trackGainDb;
  if (typeof gainDb !== "number" || !Number.isFinite(gainDb)) return 1;
  const peak = albumAware ? tags.albumPeak : tags.trackPeak;
  const safeBoost = typeof peak === "number" && Number.isFinite(peak) && peak > 0 ? 10 ** (-1 / 20) / peak : 1;
  return Math.max(0, Math.min(MAX_TRACK_LEVEL, safeBoost, 10 ** (gainDb / 20)));
}

/** The audible part of a track after silence trimming. */
export interface TrimWindow {
  readonly start: number;
  readonly end: number | null;
}

export const FULL_TRACK: TrimWindow = Object.freeze({ start: 0, end: null });

export function trimWindow(settings: TrackAudioSettings, base: TrimWindow = FULL_TRACK): TrimWindow {
  const rawStart = settings.trimStart === undefined ? base.start : settings.trimStart;
  const rawEnd = settings.trimEnd === undefined ? base.end : settings.trimEnd;
  const start = Number.isFinite(rawStart) && rawStart > 0 ? rawStart : 0;
  const end = typeof rawEnd === "number" && Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : null;
  return { start, end };
}

export function curveValue(
  from: number,
  to: number,
  progress: number,
  curve: CrossfadeCurve
): number {
  const t = clamp(progress, 0, 1);
  if (curve === "linear") return from + (to - from) * t;
  // Quarter-wave sine/cosine keeps summed power constant across the overlap.
  return to >= from
    ? from + (to - from) * Math.sin((t * Math.PI) / 2)
    : to + (from - to) * Math.cos((t * Math.PI) / 2);
}

export function createDefaultAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor({ latencyHint: "playback" });
  } catch {
    return null;
  }
}

export class AudioGraph {
  readonly master: GainNode;
  readonly equalizer: EqualizerEngine | null;
  private readonly sleep: GainNode;
  private sleepEnvelope: { start: number; end: number; from: number; to: number } | null = null;

  constructor(readonly ctx: AudioContext, private readonly ownsContext: boolean) {
    this.master = ctx.createGain();
    this.sleep = ctx.createGain();
    this.sleep.connect(ctx.destination);
    try {
      this.equalizer = typeof ctx.createBiquadFilter === "function" && typeof ctx.createWaveShaper === "function"
        ? new EqualizerEngine(ctx, this.sleep) : null;
    } catch {
      this.equalizer = null;
    }
    this.master.connect(this.equalizer?.input ?? this.sleep);
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** Must be reached from a user gesture at least once to satisfy autoplay policies. */
  resume(): void {
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => undefined);
    }
  }

  setVolume(volume: number): void {
    this.master.gain.setValueAtTime(clamp(volume, 0, 1), this.ctx.currentTime);
  }

  setSleepGain(to: number, delay: number, duration: number): void {
    const now = this.ctx.currentTime;
    const previous = this.sleepEnvelope;
    const from = previous && delay === 0
      ? curveValue(previous.from, previous.to, previous.end === previous.start ? Number(now >= previous.start)
        : (now - previous.start) / (previous.end - previous.start), "linear") : 1;
    const start = now + delay;
    const end = start + duration;
    const param = this.sleep.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(from, now);
    if (duration > 0) {
      param.setValueAtTime(from, start);
      param.linearRampToValueAtTime(to, end);
    } else {
      param.setValueAtTime(to, start);
    }
    this.sleepEnvelope = { start, end, from, to };
  }

  dispose(): void {
    this.master.disconnect();
    this.equalizer?.dispose();
    this.sleep.disconnect();
    if (this.ownsContext && this.ctx.state !== "closed") {
      this.ctx.close().catch(() => undefined);
    }
  }
}

export interface GainControl {
  getLevel(): number;
  set(value: number): void;
  ramp(from: number, to: number, seconds: number, curve: CrossfadeCurve): void;
  /** Sample-accurate step at an AudioContext time; immediate without Web Audio. */
  cutAt(value: number, contextTime: number): void;
  /** Cancels transition automation and restores unity gain; the track level is kept. */
  reset(): void;
  /**
   * Per-track level (ReplayGain/normalization). It is a separate stage from
   * the transition envelope above, so fades and gapless cuts never overwrite it.
   */
  setLevel(value: number, smooth?: boolean): void;
  dispose(): void;
}

/** source → `input` (track level) → `node` (transition envelope) → destination. */
export class WebAudioGain implements GainControl {
  readonly input: GainNode;
  readonly node: GainNode;
  private level = 1;
  private levelChange: LevelTransition | null = null;

  constructor(private readonly ctx: BaseAudioContext, destination: AudioNode) {
    this.node = ctx.createGain();
    this.node.connect(destination);
    this.input = ctx.createGain();
    this.input.connect(this.node);
  }

  getLevel(): number {
    return this.levelChange?.valueAt(this.ctx.currentTime) ?? this.level;
  }

  setLevel(value: number, smooth = false): void {
    const level = trackLevel(value);
    if (level === this.level) return;
    const now = this.ctx.currentTime;
    const current = this.levelChange?.valueAt(now) ?? this.level;
    this.level = level;
    const param = this.input.gain;
    param.cancelScheduledValues(now);
    if (!smooth) {
      this.levelChange = null;
      param.setValueAtTime(level, now);
      return;
    }
    const transition = levelTransition(current, level, now);
    this.levelChange = transition;
    param.setValueAtTime(current, now);
    const curve = new Float32Array(LEVEL_CURVE_POINTS);
    for (let index = 0; index < LEVEL_CURVE_POINTS; index += 1) {
      curve[index] = transition.valueAt(now + (transition.duration * index) / (LEVEL_CURVE_POINTS - 1));
    }
    try {
      param.setValueCurveAtTime(curve, now, transition.duration);
    } catch {
      param.linearRampToValueAtTime(level, now + transition.duration);
    }
  }

  set(value: number): void {
    const now = this.ctx.currentTime;
    this.node.gain.cancelScheduledValues(now);
    this.node.gain.setValueAtTime(value, now);
  }

  ramp(from: number, to: number, seconds: number, curve: CrossfadeCurve): void {
    const now = this.ctx.currentTime;
    const param = this.node.gain;
    param.cancelScheduledValues(now);
    if (seconds <= 0) {
      param.setValueAtTime(to, now);
      return;
    }
    if (curve === "linear") {
      param.setValueAtTime(from, now);
      param.linearRampToValueAtTime(to, now + seconds);
      return;
    }
    const values = new Float32Array(CURVE_POINTS);
    for (let index = 0; index < CURVE_POINTS; index += 1) {
      values[index] = curveValue(from, to, index / (CURVE_POINTS - 1), curve);
    }
    try {
      param.setValueCurveAtTime(values, now, seconds);
    } catch {
      param.setValueAtTime(from, now);
      param.linearRampToValueAtTime(to, now + seconds);
    }
  }

  cutAt(value: number, contextTime: number): void {
    this.node.gain.setValueAtTime(value, Math.max(contextTime, this.ctx.currentTime));
  }

  reset(): void {
    this.node.gain.cancelScheduledValues(0);
    this.node.gain.setValueAtTime(1, this.ctx.currentTime);
  }

  dispose(): void {
    this.input.disconnect();
    this.node.disconnect();
  }
}

/** Gain fallback for browsers without Web Audio: drives `element.volume` on a timer. */
export class ElementVolumeGain implements GainControl {
  private factor = 1;
  private level = 1;
  private levelTarget = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private levelChange: LevelTransition | null = null;

  constructor(
    private readonly element: HTMLMediaElement,
    private readonly masterVolume: () => number
  ) {}

  get value(): number {
    return this.factor;
  }

  getLevel(): number {
    return this.level;
  }

  /** `element.volume` cannot exceed 1, so positive ReplayGain is limited to unity here. */
  refresh(): void {
    this.element.volume = clamp(this.masterVolume() * this.factor * this.level, 0, 1);
  }

  setLevel(value: number, smooth = false): void {
    const target = trackLevel(value);
    if (smooth && this.levelChange && this.levelTarget === target) return;
    this.stopLevelChange();
    this.levelTarget = target;
    if (!smooth || target === this.level) {
      this.level = target;
      this.refresh();
      return;
    }
    const transition = levelTransition(this.level, target, Date.now() / 1000);
    this.levelChange = transition;
    this.levelTimer = setInterval(() => {
      const now = Date.now() / 1000;
      const done = now >= transition.startedAt + transition.duration;
      this.level = done ? target : transition.valueAt(now);
      this.refresh();
      if (done) this.stopLevelChange();
    }, FALLBACK_RAMP_INTERVAL_MS);
  }

  set(value: number): void {
    this.stopRamp();
    this.factor = value;
    this.refresh();
  }

  ramp(from: number, to: number, seconds: number, curve: CrossfadeCurve): void {
    this.stopRamp();
    if (seconds <= 0) {
      this.set(to);
      return;
    }
    this.factor = from;
    this.refresh();
    const startedAt = Date.now();
    this.timer = setInterval(() => {
      const progress = (Date.now() - startedAt) / (seconds * 1000);
      this.factor = curveValue(from, to, progress, curve);
      this.refresh();
      if (progress >= 1) this.stopRamp();
    }, FALLBACK_RAMP_INTERVAL_MS);
  }

  cutAt(value: number): void {
    this.set(value);
  }

  reset(): void {
    this.set(1);
  }

  dispose(): void {
    this.stopRamp();
    this.stopLevelChange();
  }

  private stopRamp(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private stopLevelChange(): void {
    if (this.levelTimer !== null) clearInterval(this.levelTimer);
    this.levelTimer = null;
    this.levelChange = null;
  }
}

export interface PlaybackOutput {
  readonly kind: "media" | "buffer";
  readonly key: string;
  /** The URL this output was loaded from; a load with another URL never reuses it. */
  readonly src: string | null;
  readonly gain: GainControl;
  position(): number;
  /** NaN when unknown. */
  duration(): number;
  isSeekable(): boolean;
  isPlaying(): boolean;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  release(): void;
  trim(): TrimWindow;
  /** Applies settings that resolved after loading; `undefined` fields are unchanged. */
  configure(settings: TrackAudioSettings): void;
}

export function finiteDuration(output: PlaybackOutput): number | null {
  const duration = output.duration();
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

/** Where the audible part ends: the trim end when set, otherwise the duration. */
export function playableEnd(output: PlaybackOutput): number | null {
  const duration = finiteDuration(output);
  const end = output.trim().end;
  if (end !== null && (duration === null || end < duration)) return end;
  return duration;
}

/** One HTMLAudioElement, optionally routed through its own GainNode into the master bus. */
export class MediaDeck implements PlaybackOutput {
  readonly kind = "media" as const;
  readonly gain: GainControl;
  private trackKey: string | null = null;
  private source: string | null = null;
  private hint: number | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private window: TrimWindow = FULL_TRACK;
  private seekedSinceLoad = false;
  private readonly onMetadata = () => this.skipLeadingSilence();

  constructor(
    readonly element: HTMLAudioElement,
    graph: AudioGraph | null,
    masterVolume: () => number
  ) {
    element.preload = "auto";
    let gain: GainControl | null = null;
    if (graph) {
      try {
        this.sourceNode = graph.ctx.createMediaElementSource(element);
        const webGain = new WebAudioGain(graph.ctx, graph.master);
        this.sourceNode.connect(webGain.input);
        element.volume = 1;
        gain = webGain;
      } catch {
        this.sourceNode = null;
      }
    }
    this.gain = gain ?? new ElementVolumeGain(element, masterVolume);
    // Registered before the engine's listeners so explicit resume positions win.
    element.addEventListener("loadedmetadata", this.onMetadata);
  }

  get key(): string {
    return this.trackKey ?? "";
  }

  get src(): string | null {
    return this.source;
  }

  get routedThroughWebAudio(): boolean {
    return this.sourceNode !== null;
  }

  isLoaded(): boolean {
    return this.trackKey !== null;
  }

  load(track: PlayableTrack, preload: "auto" | "metadata" = "auto"): void {
    this.trackKey = track.key;
    this.source = track.src;
    this.hint = typeof track.durationHint === "number" && track.durationHint > 0
      ? track.durationHint
      : null;
    this.window = trimWindow(track);
    this.seekedSinceLoad = false;
    this.gain.reset();
    this.gain.setLevel(trackLevel(track.gain));
    if (
      this.routedThroughWebAudio &&
      typeof window !== "undefined" &&
      /^https?:\/\//i.test(track.src)
    ) {
      try {
        if (new URL(track.src, window.location.origin).origin !== window.location.origin) {
          this.element.crossOrigin = "anonymous";
        }
      } catch {
        // Leave existing crossOrigin configuration unchanged.
      }
    }
    this.element.preload = preload;
    this.element.src = track.src;
    this.element.load();
  }

  trim(): TrimWindow {
    return this.window;
  }

  configure(settings: TrackAudioSettings): void {
    if (!this.trackKey) return;
    if (settings.gain !== undefined) this.gain.setLevel(trackLevel(settings.gain), true);
    this.window = trimWindow(settings, this.window);
    if (this.element.readyState >= HAVE_METADATA) this.skipLeadingSilence();
  }

  /** Reload the stream or a verified local replacement without changing queue identity. */
  reloadSource(replacement?: string): void {
    if (replacement) this.source = replacement;
    if (!this.source) return;
    this.element.src = this.source;
    this.element.load();
  }

  position(): number {
    const time = this.element.currentTime;
    return Number.isFinite(time) ? time : 0;
  }

  duration(): number {
    const duration = this.element.duration;
    if (Number.isFinite(duration) && duration > 0) return duration;
    return this.hint ?? Number.NaN;
  }

  isSeekable(): boolean {
    if (!Number.isFinite(this.element.duration)) return false;
    const ranges = this.element.seekable;
    return Boolean(ranges) && ranges.length > 0 && ranges.end(ranges.length - 1) > 0;
  }

  isPlaying(): boolean {
    return !this.element.paused && !this.element.ended;
  }

  play(): Promise<void> {
    try {
      return Promise.resolve(this.element.play());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  pause(): void {
    this.element.pause();
  }

  seek(seconds: number): void {
    this.seekedSinceLoad = true;
    const duration = this.duration();
    const target = Number.isFinite(duration)
      ? clamp(seconds, 0, Math.max(0, duration - 0.05))
      : Math.max(0, seconds);
    try {
      this.element.currentTime = target;
    } catch {
      // Unseekable live transcodes reject seeks; playback continues where it is.
    }
  }

  release(): void {
    this.trackKey = null;
    this.source = null;
    this.hint = null;
    this.window = FULL_TRACK;
    this.seekedSinceLoad = false;
    this.element.pause();
    this.gain.reset();
    this.gain.setLevel(1);
    this.element.removeAttribute("src");
    try {
      // Detaching the source and calling load() aborts the pending network fetch.
      this.element.load();
    } catch {
      // Ignored: the element is already detached.
    }
  }

  dispose(): void {
    this.release();
    this.element.removeEventListener("loadedmetadata", this.onMetadata);
    this.gain.dispose();
    this.sourceNode?.disconnect();
    this.sourceNode = null;
  }

  /** Starts after leading silence unless something already chose a position. */
  private skipLeadingSilence(): void {
    if (!this.trackKey || this.seekedSinceLoad) return;
    const start = this.window.start;
    if (start <= 0 || this.position() >= start) return;
    try {
      this.element.currentTime = start;
    } catch {
      // Unseekable live transcodes play their leading silence.
    }
  }
}

/** A fully decoded track played from memory; enables sample-accurate gapless stitching. */
export class BufferVoice implements PlaybackOutput {
  readonly kind = "buffer" as const;
  readonly key: string;
  readonly src: string;
  readonly gain: WebAudioGain;
  onEnded: ((voice: BufferVoice) => void) | null = null;
  private node: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null;
  private window: TrimWindow;
  private startContextTime = 0;
  private offset: number;
  private running = false;
  private generation = 0;

  constructor(private readonly graph: AudioGraph, track: PlayableTrack, buffer: AudioBuffer) {
    this.key = track.key;
    this.src = track.src;
    this.buffer = buffer;
    this.window = trimWindow(track);
    this.offset = this.startPoint();
    this.gain = new WebAudioGain(graph.ctx, graph.master);
    this.gain.setLevel(trackLevel(track.gain));
  }

  /** Context time at which this voice reaches the end of its audible window. */
  endContextTime(): number {
    return this.startContextTime + (this.endPoint() - this.offset);
  }

  startContextTimeValue(): number {
    return this.startContextTime;
  }

  /** Where playback begins by default: after any leading silence. */
  startPoint(): number {
    return clamp(this.window.start, 0, this.endPoint());
  }

  start(when: number, offset = this.startPoint()): void {
    const buffer = this.buffer;
    if (!buffer) return;
    this.stopNode();
    const node = this.graph.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain.input);
    const generation = ++this.generation;
    node.onended = () => {
      if (generation !== this.generation || !this.running) return;
      this.running = false;
      this.offset = this.endPoint();
      this.onEnded?.(this);
    };
    const end = this.endPoint();
    const safeOffset = clamp(offset, 0, end);
    const safeWhen = Math.max(when, this.graph.now);
    node.start(safeWhen, safeOffset);
    // Stopping on the context clock ends a trimmed track sample-accurately.
    if (end < buffer.duration) node.stop(safeWhen + (end - safeOffset));
    this.node = node;
    this.startContextTime = safeWhen;
    this.offset = safeOffset;
    this.running = true;
  }

  position(): number {
    if (!this.running) return this.offset;
    const elapsed = Math.max(0, this.graph.now - this.startContextTime);
    return clamp(this.offset + elapsed, 0, this.endPoint());
  }

  duration(): number {
    return this.buffer?.duration ?? Number.NaN;
  }

  trim(): TrimWindow {
    return this.window;
  }

  configure(settings: TrackAudioSettings): void {
    if (!this.buffer) return;
    if (settings.gain !== undefined) this.gain.setLevel(trackLevel(settings.gain), true);
    const previousEnd = this.endPoint();
    this.window = trimWindow(settings, this.window);
    if (!this.running || this.endPoint() === previousEnd) return;
    const position = this.position();
    // Restart from the same sample so the new end is scheduled on the context clock.
    this.start(this.graph.now, position);
  }

  isSeekable(): boolean {
    return this.buffer !== null;
  }

  isPlaying(): boolean {
    return this.running;
  }

  play(): Promise<void> {
    if (!this.running && this.buffer) {
      const atEnd = this.offset >= this.endPoint() - 0.01;
      this.start(this.graph.now, atEnd ? this.startPoint() : this.offset);
    }
    return Promise.resolve();
  }

  pause(): void {
    if (!this.running) return;
    this.offset = this.position();
    this.running = false;
    this.stopNode();
  }

  seek(seconds: number): void {
    const wasRunning = this.running;
    const target = clamp(seconds, 0, this.endPoint());
    this.running = false;
    this.stopNode();
    this.offset = target;
    if (wasRunning) this.start(this.graph.now, target);
  }

  release(): void {
    this.running = false;
    this.stopNode();
    this.buffer = null;
    this.onEnded = null;
    this.gain.dispose();
  }

  private endPoint(): number {
    const duration = this.buffer?.duration ?? 0;
    const end = this.window.end;
    return end !== null && end < duration ? end : duration;
  }

  private stopNode(): void {
    this.generation += 1;
    const node = this.node;
    this.node = null;
    if (!node) return;
    node.onended = null;
    try {
      node.stop();
    } catch {
      // A node that has not started yet or already stopped may throw.
    }
    node.disconnect();
  }
}
