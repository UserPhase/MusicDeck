import type { AudioGraph, MediaDeck, PlaybackOutput } from "./outputs";
import type { PlayableTrack, TransitionKind } from "./types";

export interface TransitionTicket {
  readonly id: number;
  readonly kind: TransitionKind;
  readonly fromKey: string;
  readonly toKey: string;
}

/**
 * The engine side of the transition contract. Only the handler whose kind
 * matches the engine's current mode can obtain a ticket, and only one ticket
 * can exist at a time, so gapless and crossfade paths can never overlap.
 */
export interface TransitionHost {
  readonly graph: AudioGraph | null;
  activeOutput(): PlaybackOutput | null;
  upcomingTrack(): PlayableTrack | null;
  /** The media deck that is not audible right now. */
  idleDeck(): MediaDeck;
  wantsPlayback(): boolean;
  beginTransition(kind: TransitionKind, toKey: string): TransitionTicket | null;
  isCurrentTicket(ticket: TransitionTicket): boolean;
  /** Hands ownership of `incoming` to the engine. `start` asks the engine to begin playback. */
  commitTransition(
    ticket: TransitionTicket,
    incoming: PlaybackOutput,
    options?: { start?: boolean }
  ): void;
  cancelTransition(ticket: TransitionTicket, reason: string): void;
}

/** Implemented by each transition path; the engine calls only the one matching its mode. */
export interface TransitionHandler {
  onProgress(): void;
  /** Returns true when the handler took over the end of the active track. */
  onActiveEnded(): boolean;
  /** Undo an in-flight transition without notifying the host. */
  abort(): void;
  /** Drop preloaded/decoded material for the upcoming track. */
  discardPrepared(): void;
  ownsDeck(deck: MediaDeck): boolean;
  dispose(): void;
}
