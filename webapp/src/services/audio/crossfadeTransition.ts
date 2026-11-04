import { playableEnd } from "./outputs";
import type { MediaDeck, PlaybackOutput } from "./outputs";
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
  /** Begin buffering the incoming track this long before the fade window opens. */
  preloadLeadSeconds: number;
}

interface Running {
  readonly ticket: TransitionTicket;
  readonly incoming: MediaDeck;
  readonly outgoing: PlaybackOutput;
  readonly window: number;
  started: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const MIN_WINDOW_SECONDS = 0.05;

/**
 * Crossfade path: plays the next track on the idle media deck and ramps both
 * deck gains over the configured 1–10 s window. It never decodes buffers and
 * never schedules on the audio clock, so it cannot interfere with gapless.
 */
export class CrossfadeTransition implements TransitionHandler {
  private prepared: MediaDeck | null = null;
  private running: Running | null = null;

  constructor(private readonly host: TransitionHost, private readonly options: CrossfadeOptions) {}

  isRunning(): boolean {
    return this.running !== null;
  }

  onProgress(): void {
    const output = this.host.activeOutput();
    const next = this.host.upcomingTrack();
    if (!output || !next || this.running || !this.host.wantsPlayback() || !output.isPlaying()) {
      return;
    }
    const end = playableEnd(output);
    if (end === null) return;
    const remaining = end - output.position();
    const window = Math.min(clampCrossfadeSeconds(this.options.seconds()), end / 2);

    if (remaining <= window + this.options.preloadLeadSeconds) this.prepare(next);
    if (remaining <= window) this.start(output, next, Math.max(MIN_WINDOW_SECONDS, remaining));
  }

  onActiveEnded(): boolean {
    const running = this.running;
    if (!running) return false;
    if (running.started) {
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
      this.host.cancelTransition(running.ticket, "incoming-error");
      return;
    }
    if (this.prepared === deck) {
      this.prepared = null;
      deck.release();
    }
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

  private start(outgoing: PlaybackOutput, next: PlayableTrack, remaining: number): void {
    const configured = clampCrossfadeSeconds(this.options.seconds());
    const duration = playableEnd(outgoing) ?? configured * 2;
    const window = Math.max(MIN_WINDOW_SECONDS, Math.min(configured, duration / 2, remaining));
    if (this.prepared?.key !== next.key) this.prepare(next);
    const incoming = this.prepared;
    if (!incoming) return;

    const ticket = this.host.beginTransition("crossfade", next.key);
    if (!ticket) return;
    this.prepared = null;
    const running: Running = { ticket, incoming, outgoing, window, started: false, timer: null };
    this.running = running;
    incoming.gain.set(0);

    incoming.play().then(
      () => {
        if (this.running !== running || !this.host.isCurrentTicket(ticket)) return;
        running.started = true;
        const curve = this.options.curve();
        outgoing.gain.ramp(1, 0, window, curve);
        incoming.gain.ramp(0, 1, window, curve);
        running.timer = setTimeout(() => this.finish(running), window * 1000);
      },
      () => {
        if (this.running !== running) return;
        this.host.cancelTransition(ticket, "incoming-failed");
      }
    );
  }

  private finish(running: Running): void {
    if (this.running !== running) return;
    this.running = null;
    if (running.timer !== null) clearTimeout(running.timer);
    if (!this.host.isCurrentTicket(running.ticket)) {
      running.incoming.release();
      return;
    }
    this.host.commitTransition(running.ticket, running.incoming);
  }
}
