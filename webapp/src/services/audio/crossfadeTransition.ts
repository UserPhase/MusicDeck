import { MediaDeck, playableEnd } from "./outputs";
import type { PlaybackOutput } from "./outputs";
import type { TransitionHandler, TransitionHost, TransitionTicket } from "./transitionHost";
import type { CrossfadeCurve, PlayableTrack } from "./types";

export const CROSSFADE_MIN_SECONDS = 1;
export const CROSSFADE_MAX_SECONDS = 10;
export const DEFAULT_CROSSFADE_SECONDS = 5;

export function clampCrossfadeSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_CROSSFADE_SECONDS;
  return Math.min(CROSSFADE_MAX_SECONDS, Math.max(CROSSFADE_MIN_SECONDS, seconds));
}

export interface CrossfadeOptions {
  seconds: () => number;
  curve: () => CrossfadeCurve;
  canPlan: () => boolean;
  /** Begin buffering the incoming track this long before the fade window opens. */
  preloadLeadSeconds: number;
}

interface Running {
  readonly ticket: TransitionTicket;
  readonly incoming: MediaDeck;
  readonly outgoing: PlaybackOutput;
  started: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const MIN_WINDOW_SECONDS = 0.05;
const MAX_TIMER_MS = 2_147_483_647;

function fadeTiming(output: PlaybackOutput, configured: number) {
  // A live media element has no known end even if the catalog has a duration hint.
  if (output instanceof MediaDeck && output.element.duration === Infinity && output.trim().end === null) return null;
  const end = playableEnd(output);
  if (end === null) return null;
  const rate = output instanceof MediaDeck ? output.element.playbackRate : 1;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return {
    remaining: (end - output.position()) / rate,
    window: Math.min(clampCrossfadeSeconds(configured), (end - output.trim().start) / (2 * rate)),
  };
}

/**
 * Crossfade path: plays the next track on the idle media deck and ramps both
 * deck gains over the remaining playback window. Deadline checks read the
 * outgoing media clock so sparse timeupdate events cannot miss the fade.
 */
export class CrossfadeTransition implements TransitionHandler {
  private prepared: MediaDeck | null = null;
  private running: Running | null = null;
  private failedIncomingKey: string | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: TransitionHost, private readonly options: CrossfadeOptions) {}

  isRunning(): boolean {
    return this.running !== null;
  }

  onProgress(): void {
    this.clearWake();
    const output = this.host.activeOutput();
    const next = this.host.upcomingTrack();
    if (!this.options.canPlan() || !output || !next || next.key === this.failedIncomingKey || this.running ||
      !this.host.wantsPlayback() || !output.isPlaying()) {
      return;
    }
    const timing = fadeTiming(output, this.options.seconds());
    if (!timing || timing.remaining < MIN_WINDOW_SECONDS || timing.window < MIN_WINDOW_SECONDS) return;
    const { remaining, window } = timing;
    const preloadAt = window + this.options.preloadLeadSeconds;
    if (remaining > preloadAt) {
      this.scheduleWake(remaining - preloadAt);
      return;
    }
    this.prepare(next);
    const incomingWindow = this.prepared && fadeTiming(this.prepared, this.options.seconds())?.window;
    const overlap = Math.min(window, incomingWindow ?? window);
    if (overlap < MIN_WINDOW_SECONDS) return;
    if (remaining > overlap) this.scheduleWake(remaining - overlap);
    else this.start(output, next);
  }

  /** Recheck after an engine or media state change has settled. */
  replan(): void {
    this.clearWake();
    if (this.options.canPlan() && !this.running) this.scheduleWake(0);
  }

  private scheduleWake(seconds: number): void {
    const delay = seconds === 0 ? 0 : Math.min(MAX_TIMER_MS, Math.max(50, Math.ceil(seconds * 1000)));
    this.wakeTimer = setTimeout(() => this.onProgress(), delay);
  }

  private clearWake(): void {
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  onActiveEnded(): boolean {
    const running = this.running;
    if (!running) return false;
    if (running.started && running.incoming.isPlaying()) {
      this.finish(running);
      return true;
    }
    // The outgoing track ended before the incoming one could start; let the queue advance normally.
    this.host.cancelTransition(running.ticket, "outgoing-ended");
    return false;
  }

  takePrepared(key: string): MediaDeck | null {
    const deck = this.prepared;
    if (!deck || deck.key !== key || this.running) return null;
    this.prepared = null;
    deck.gain.reset();
    return deck;
  }

  abort(): void {
    this.clearWake();
    const running = this.running;
    if (!running) return;
    this.running = null;
    if (running.timer !== null) clearTimeout(running.timer);
    running.incoming.release();
    if (this.host.activeOutput() === running.outgoing) running.outgoing.gain.reset();
  }

  discardPrepared(): void {
    if (this.running) this.host.cancelTransition(this.running.ticket, "discarded");
    this.abort();
    this.failedIncomingKey = null;
    const deck = this.prepared;
    this.prepared = null;
    if (deck && deck !== this.host.activeOutput()) deck.release();
  }

  ownsDeck(deck: MediaDeck): boolean {
    return this.prepared === deck || this.running?.incoming === deck;
  }

  /** The incoming element failed; cancel the fade and keep the current track playing. */
  onDeckError(deck: MediaDeck): void {
    const running = this.running;
    if (running?.incoming === deck) {
      this.cancelFailedFade(running, "incoming-error");
      return;
    }
    if (this.prepared === deck) {
      this.prepared = null;
      deck.release();
    }
  }

  onDeckEnded(deck: MediaDeck): void {
    const running = this.running;
    if (running?.incoming === deck) this.cancelFailedFade(running, "incoming-ended");
  }

  private cancelFailedFade(running: Running, reason: string): void {
    this.failedIncomingKey = running.ticket.toKey;
    this.host.cancelTransition(running.ticket, reason);
  }

  dispose(): void {
    this.discardPrepared();
  }

  private prepare(next: PlayableTrack): void {
    if (this.prepared?.key === next.key) return;
    if (this.prepared && this.prepared !== this.host.activeOutput()) this.prepared.release();
    const deck = this.host.idleDeck();
    deck.load(next, "auto");
    deck.gain.set(0);
    this.prepared = deck;
  }

  private start(outgoing: PlaybackOutput, next: PlayableTrack): void {
    const incoming = this.prepared;
    if (!incoming) return;

    const ticket = this.host.beginTransition("crossfade", next.key);
    if (!ticket) return;
    this.prepared = null;
    const running: Running = { ticket, incoming, outgoing, started: false, timer: null };
    this.running = running;
    incoming.gain.set(0);

    incoming.play().then(
      () => {
        if (this.running !== running || !this.host.isCurrentTicket(ticket)) return;
        // play() can wait for network data or permission while the outgoing clock advances.
        const timing = fadeTiming(outgoing, this.options.seconds());
        const incomingWindow = fadeTiming(incoming, this.options.seconds())?.window;
        if (timing && incomingWindow !== undefined && incomingWindow < timing.window && timing.remaining > incomingWindow) {
          this.cancelFailedFade(running, "incoming-too-short");
          return;
        }
        const window = timing ? Math.min(timing.remaining, timing.window, incomingWindow ?? timing.window) : 0;
        if (window < MIN_WINDOW_SECONDS || !outgoing.isPlaying() || incoming.element.ended) {
          this.cancelFailedFade(running, "incoming-too-late");
          return;
        }
        running.started = true;
        const curve = this.options.curve();
        outgoing.gain.ramp(1, 0, window, curve);
        incoming.gain.ramp(0, 1, window, curve);
        running.timer = setTimeout(() => this.finish(running), window * 1000);
      },
      () => {
        if (this.running !== running) return;
        this.cancelFailedFade(running, "incoming-failed");
      }
    );
  }

  private finish(running: Running): void {
    if (this.running !== running) return;
    if (!running.incoming.isPlaying()) {
      this.cancelFailedFade(running, "incoming-ended");
      return;
    }
    this.running = null;
    if (running.timer !== null) clearTimeout(running.timer);
    if (!this.host.isCurrentTicket(running.ticket)) {
      running.incoming.release();
      return;
    }
    this.host.commitTransition(running.ticket, running.incoming);
  }
}
