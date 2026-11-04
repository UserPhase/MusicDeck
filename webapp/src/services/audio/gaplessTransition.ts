import { BufferVoice, MediaDeck, playableEnd } from "./outputs";
import type { PlaybackOutput } from "./outputs";
import { FetchAbortedError, fetchWithRangeResume } from "./resumableFetch";
import type { FetchLike } from "./resumableFetch";
import type { TransitionHandler, TransitionHost, TransitionTicket } from "./transitionHost";
import type { PlayableTrack } from "./types";

export interface GaplessOptions {
  /** Start fetching/decoding the next track at this fraction of the current one. */
  prefetchRatio: number;
  /** Longer tracks are not decoded (≈ 21 MB per minute of stereo 44.1 kHz float PCM). */
  maxDecodeSeconds: number;
  maxFetchBytes: number;
  /** When the active track is streamed, the next buffer is scheduled this close to the end. */
  scheduleLeadSeconds: number;
  maxFetchRetries: number;
  backoffMs: (attempt: number) => number;
  fetchImpl?: FetchLike;
  fetchInit?: Omit<RequestInit, "headers" | "signal">;
  fetchHeaders?: Record<string, string>;
}

type Prepared =
  | { readonly strategy: "decoded"; readonly key: string; readonly buffer: AudioBuffer }
  | { readonly strategy: "element"; readonly key: string; readonly deck: MediaDeck };

interface Scheduled {
  readonly ticket: TransitionTicket;
  readonly voice: BufferVoice;
  readonly outgoing: PlaybackOutput;
  readonly when: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const COMMIT_TOLERANCE_SECONDS = 0.002;
const MAX_REMEMBERED_FAILURES = 100;

function decode(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    // Older Safari only supports the callback form; newer browsers return a promise too.
    const result = ctx.decodeAudioData(bytes, resolve, reject) as Promise<AudioBuffer> | undefined;
    if (result && typeof result.then === "function") result.then(resolve, reject);
  });
}

export type PreparedHandoff = { buffer: AudioBuffer } | { deck: MediaDeck };

/**
 * Gapless path: decodes the next track into memory and schedules it on the
 * AudioContext clock to start exactly where the current track ends. It never
 * ramps gains; its only gain write is a hard step to 0 on the outgoing track at
 * the boundary so a late stream tail cannot overlap the next track.
 *
 * Buffer→buffer boundaries are sample-accurate. A streamed→buffer boundary is
 * anchored from the element clock and is accurate to a few milliseconds.
 * Without Web Audio, or for tracks too long to decode, it preloads the next
 * track on the idle element and switches on `ended`.
 */
export class GaplessTransition implements TransitionHandler {
  private prepared: Prepared | null = null;
  private inflight: { key: string; controller: AbortController } | null = null;
  private scheduled: Scheduled | null = null;
  private readonly undecodable = new Set<string>();

  constructor(private readonly host: TransitionHost, private readonly options: GaplessOptions) {}

  isScheduled(): boolean {
    return this.scheduled !== null;
  }

  /** The decoded voice already scheduled to follow the active track, if any. */
  scheduledVoice(): BufferVoice | null {
    return this.scheduled?.voice ?? null;
  }

  preparedKey(): string | null {
    return this.prepared?.key ?? null;
  }

  onProgress(): void {
    const output = this.host.activeOutput();
    const next = this.host.upcomingTrack();
    if (!output || !next || this.scheduled || !this.host.wantsPlayback() || !output.isPlaying()) {
      return;
    }
    const end = playableEnd(output);
    if (end === null) return;
    const position = output.position();
    if (position < end * this.options.prefetchRatio) return;

    this.prepare(next);
    const prepared = this.prepared;
    if (
      prepared?.strategy === "decoded" &&
      prepared.key === next.key &&
      end - position <= this.options.scheduleLeadSeconds
    ) {
      this.schedule(output, prepared.buffer, next, end);
    }
  }

  onActiveEnded(): boolean {
    const scheduled = this.scheduled;
    const graph = this.host.graph;
    if (scheduled) {
      // The stream ended earlier than its reported duration: start the next track now.
      if (graph && graph.now < scheduled.when - COMMIT_TOLERANCE_SECONDS) {
        scheduled.voice.start(graph.now);
      }
      this.commit(scheduled);
      return true;
    }

    const next = this.host.upcomingTrack();
    const prepared = this.prepared;
    if (!next || !prepared || prepared.key !== next.key) return false;
    const ticket = this.host.beginTransition("gapless", next.key);
    if (!ticket) return false;
    this.prepared = null;

    if (prepared.strategy === "decoded" && graph) {
      const voice = new BufferVoice(graph, next, prepared.buffer);
      this.host.commitTransition(ticket, voice, { start: true });
      return true;
    }
    if (prepared.strategy === "element") {
      prepared.deck.gain.reset();
      this.host.commitTransition(ticket, prepared.deck, { start: true });
      return true;
    }
    this.host.cancelTransition(ticket, "unavailable");
    return false;
  }

  /** Lets the engine start a prepared track instantly when the user skips to it. */
  takePrepared(key: string): PreparedHandoff | null {
    const prepared = this.prepared;
    if (!prepared || prepared.key !== key || this.scheduled) return null;
    this.prepared = null;
    return prepared.strategy === "decoded" ? { buffer: prepared.buffer } : { deck: prepared.deck };
  }

  abort(): void {
    const scheduled = this.scheduled;
    if (!scheduled) return;
    this.scheduled = null;
    if (scheduled.timer !== null) clearTimeout(scheduled.timer);
    scheduled.voice.release();
    // Undo the boundary cut; the decoded buffer stays prepared for a reschedule.
    if (this.host.activeOutput() === scheduled.outgoing) scheduled.outgoing.gain.reset();
  }

  discardPrepared(): void {
    if (this.scheduled) this.host.cancelTransition(this.scheduled.ticket, "discarded");
    this.abort();
    if (this.inflight) {
      this.inflight.controller.abort();
      this.inflight = null;
    }
    const prepared = this.prepared;
    this.prepared = null;
    if (prepared?.strategy === "element" && prepared.deck !== this.host.activeOutput()) {
      prepared.deck.release();
    }
  }

  ownsDeck(deck: MediaDeck): boolean {
    return this.prepared?.strategy === "element" && this.prepared.deck === deck;
  }

  /** The preloaded element failed; fall back to a normal load when the track ends. */
  onPreparedDeckError(deck: MediaDeck): void {
    if (!this.ownsDeck(deck)) return;
    this.prepared = null;
    deck.release();
  }

  dispose(): void {
    this.discardPrepared();
    this.undecodable.clear();
  }

  private prepare(next: PlayableTrack): void {
    if (this.prepared?.key === next.key || this.inflight?.key === next.key) return;
    this.discardPrepared();

    const graph = this.host.graph;
    const hint = typeof next.durationHint === "number" ? next.durationHint : null;
    const decodable = graph !== null &&
      !this.undecodable.has(next.key) &&
      (hint === null || hint <= this.options.maxDecodeSeconds);
    if (!graph || !decodable) {
      this.prepareElement(next);
      return;
    }

    const controller = new AbortController();
    const inflight = { key: next.key, controller };
    this.inflight = inflight;
    fetchWithRangeResume(next.src, {
      fetchImpl: this.options.fetchImpl,
      init: this.options.fetchInit,
      headers: this.options.fetchHeaders,
      signal: controller.signal,
      maxBytes: this.options.maxFetchBytes,
      maxRetries: this.options.maxFetchRetries,
      backoffMs: this.options.backoffMs,
    })
      .then((bytes) => decode(graph.ctx, bytes))
      .then((buffer) => {
        if (this.inflight !== inflight) return;
        this.inflight = null;
        if (buffer.duration > this.options.maxDecodeSeconds) {
          this.markUndecodable(next.key);
          this.prepareElementIfStillNext(next);
          return;
        }
        this.prepared = { strategy: "decoded", key: next.key, buffer };
      })
      .catch((error: unknown) => {
        if (this.inflight !== inflight) return;
        this.inflight = null;
        if (error instanceof FetchAbortedError || controller.signal.aborted) return;
        this.markUndecodable(next.key);
        this.prepareElementIfStillNext(next);
      });
  }

  private prepareElementIfStillNext(next: PlayableTrack): void {
    if (this.host.upcomingTrack()?.key === next.key && !this.prepared) this.prepareElement(next);
  }

  private prepareElement(next: PlayableTrack): void {
    const deck = this.host.idleDeck();
    deck.load(next, "auto");
    this.prepared = { strategy: "element", key: next.key, deck };
  }

  private markUndecodable(key: string): void {
    if (this.undecodable.size >= MAX_REMEMBERED_FAILURES) this.undecodable.clear();
    this.undecodable.add(key);
  }

  private schedule(
    outgoing: PlaybackOutput,
    buffer: AudioBuffer,
    next: PlayableTrack,
    end: number
  ): void {
    const graph = this.host.graph;
    if (!graph) return;
    const ticket = this.host.beginTransition("gapless", next.key);
    if (!ticket) return;

    let when: number;
    if (outgoing instanceof BufferVoice) {
      when = outgoing.endContextTime();
    } else {
      const rate = outgoing instanceof MediaDeck ? outgoing.element.playbackRate || 1 : 1;
      when = graph.now + Math.max(0, end - outgoing.position()) / rate;
    }
    when = Math.max(when, graph.now);

    // The incoming voice starts after its own leading silence (if trimmed).
    const voice = new BufferVoice(graph, next, buffer);
    voice.start(when);
    outgoing.gain.cutAt(0, when);
    const scheduled: Scheduled = { ticket, voice, outgoing, when, timer: null };
    this.scheduled = scheduled;
    this.armCommit(scheduled);
  }

  private armCommit(scheduled: Scheduled): void {
    const graph = this.host.graph;
    const delayMs = graph ? Math.max(0, (scheduled.when - graph.now) * 1000) : 0;
    scheduled.timer = setTimeout(() => {
      scheduled.timer = null;
      if (this.scheduled !== scheduled) return;
      // Timers and the audio clock drift slightly; never release the outgoing track early.
      if (graph && graph.now < scheduled.when - COMMIT_TOLERANCE_SECONDS) {
        this.armCommit(scheduled);
        return;
      }
      this.commit(scheduled);
    }, delayMs);
  }

  private commit(scheduled: Scheduled): void {
    if (this.scheduled !== scheduled) return;
    this.scheduled = null;
    if (scheduled.timer !== null) clearTimeout(scheduled.timer);
    if (this.prepared?.key === scheduled.voice.key) this.prepared = null;
    if (!this.host.isCurrentTicket(scheduled.ticket)) {
      scheduled.voice.release();
      return;
    }
    this.host.commitTransition(scheduled.ticket, scheduled.voice);
  }
}
