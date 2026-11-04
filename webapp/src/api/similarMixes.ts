export type MixScope = "LIBRARY_ONLY" | "DISCOVERY_ONLY" | "HYBRID_MIX";
export interface MixSeed { id: string; title: string; artist: string }
export interface MixCandidate extends MixSeed {
  album: string; inLibrary: boolean; similarity: number; familiarity: number; score: number; reason: string;
  track: Record<string, any>;
}
export interface MixPreview { previewId: string; tracks: MixCandidate[]; warnings: string[]; shuffleSeed: string; cached: boolean; generatedInMs: number }
export async function mixRequest<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api/v1/similar-mixes/${path}`, { credentials: "include", signal,
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }); }
  catch (error) { if (signal.aborted) throw error; throw new Error("Could not reach MusicDeck. Check your connection, then try again."); }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error?.message || `The mix request could not be completed (${response.status}).`);
  return data;
}
