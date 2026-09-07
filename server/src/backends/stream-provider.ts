export type StreamResult = {
  body: ReadableStream<Uint8Array> | null;
  status: number;
  headers: Headers;
};

/**
 * Stream capability: answers "how can this item be played/displayed?".
 *
 * Identifiers are provider-native IDs in the current single-provider shape.
 * The stable MusicDeck ID / SourceRef resolution layer is intentionally
 * deferred to a later phase.
 */
export interface StreamProvider {
  fetchStream(trackId: string, range?: string): Promise<StreamResult>;
  fetchArtwork(artworkId: string): Promise<StreamResult>;
}
