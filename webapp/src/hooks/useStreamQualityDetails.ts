import { useEffect, useState } from "react";
import { startVisualPolling } from "../services/visualActivity";
import { inspectAudioStream } from "../api/musicdeck";
import type { PlaybackEngine } from "../services/audio/PlaybackEngine";

const INSPECTION_INTERVAL_MS = 2000;
const MAX_INSPECTION_RETRY_MS = 30_000;

export interface AudioProperties {
  codec: string | null; container: string | null; bitrateKbps: number | null;
  sampleRateHz: number | null; bitDepth: number | null; channels: number | null; lossless: boolean | null;
}
export interface StreamQualityDetails {
  sourceError?: string | null;
  source: AudioProperties | null;
  output: (AudioProperties & { mode: "DIRECT_STREAM" | "TRANSCODED" | "UNKNOWN"; observed: boolean;
    evidence: string; transcodeReason: string | null; downsampled: boolean | null; requestedBitrateKbps: number | null }) | null;
  delivery: { bytes: number; bitrateKbps: number | null; windowSeconds: number; state: string } | null;
  pipeline: ReturnType<PlaybackEngine["getAudioDiagnostics"]> | null;
  loading: boolean; error: string; note: string;
  serverNormalized: boolean;
  preview: boolean;
}
export function useStreamQualityDetails({
  engine, trackId, streamUrl, userId, preview, serverNormalized,
}: {
  engine: PlaybackEngine | null; trackId: string | null; streamUrl: string | null;
  userId: string | null; preview: boolean; serverNormalized: boolean;
}): StreamQualityDetails {
  const [state, setState] = useState<{ key: string; source: StreamQualityDetails["source"]; output: StreamQualityDetails["output"];
    delivery: StreamQualityDetails["delivery"]; sourceError?: string | null; loading: boolean; error: string; pipeline: StreamQualityDetails["pipeline"] }>({
    key: "", source: null, output: null, delivery: null, loading: false, error: "", pipeline: null,
  });
  const key = JSON.stringify([userId, trackId, streamUrl]);
  let inspectionId: string | null = null;
  if (streamUrl?.startsWith("/api/tracks/")) inspectionId = new URL(streamUrl, window.location.origin).searchParams.get("inspectionId");
  useEffect(() => {
    const pipeline = engine?.getAudioDiagnostics() ?? null;
    setState({ key, source: null, output: null, delivery: null, loading: Boolean(inspectionId && trackId && userId), error: "", pipeline });
    if (!trackId || !userId || !inspectionId) return;
    let controller: AbortController | null = null;
    let cancelled = false;
    let retryDelay = INSPECTION_INTERVAL_MS;
    let retryAt = 0;
    const update = async () => {
      if (controller || cancelled || Date.now() < retryAt) return;
      const pipeline = engine?.getAudioDiagnostics() ?? null;
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const data: Pick<StreamQualityDetails, "source" | "output" | "delivery" | "sourceError"> =
          await inspectAudioStream(trackId, inspectionId, signal);
        if (!cancelled) {
          retryDelay = INSPECTION_INTERVAL_MS;
          retryAt = 0;
          setState({ key, ...data, loading: false, error: "", pipeline });
        }
      } catch (error) {
        if (!signal.aborted && !cancelled) {
          retryDelay = Math.min(retryDelay * 2, MAX_INSPECTION_RETRY_MS);
          retryAt = Date.now() + retryDelay;
          const requestId = (error as { requestId?: unknown } | null)?.requestId;
          const message = error instanceof Error ? error.message : "Audio inspection failed.";
          setState((previous) => ({ ...previous, key, loading: false, pipeline,
            error: typeof requestId === "string" ? `${message} Request ID: ${requestId}.` : message }));
        }
      } finally { controller = null; }
    };
    const stopPolling = startVisualPolling(update, INSPECTION_INTERVAL_MS);
    return () => { cancelled = true; controller?.abort(); stopPolling(); };
  }, [engine, key, userId, trackId, inspectionId]);
  const current = state.key === key ? state : { source: null, output: null, delivery: null, pipeline: null, loading: Boolean(inspectionId), error: "" };
  return { ...current, serverNormalized, preview,
    note: preview ? "Provider preview: full-file source and output properties cannot be verified."
      : serverNormalized ? "Server-normalized asset: the library stream observer does not inspect this separate processed file."
        : !inspectionId ? "No observable library stream is active." : "Delivery rate measures server-to-MusicDeck transfer speed, not encoded audio bitrate. Unknown properties are not inferred from settings." };
}
