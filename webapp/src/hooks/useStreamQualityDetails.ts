import { useEffect, useState } from "react";
import { startVisualPolling } from "../services/visualActivity";
import { inspectAudioStream } from "../api/musicdeck";
import { parsePlaybackUrl } from "../utils/streamRecovery";
import { playbackFeatureEnabled } from "../services/playbackFeatures";
import type { PlaybackEngine } from "../services/audio/PlaybackEngine";

const INSPECTION_INTERVAL_MS = 2000;
const INSPECTION_TIMEOUT_MS = 10_000;
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
  engine, trackId, streamUrl, userId, preview, serverNormalized, enabled = playbackFeatureEnabled("streamInspection"),
}: {
  engine: PlaybackEngine | null; trackId: string | null; streamUrl: string | null;
  userId: string | null; preview: boolean; serverNormalized: boolean; enabled?: boolean;
}): StreamQualityDetails {
  const [state, setState] = useState<{ key: string; source: StreamQualityDetails["source"]; output: StreamQualityDetails["output"];
    delivery: StreamQualityDetails["delivery"]; sourceError?: string | null; loading: boolean; error: string; pipeline: StreamQualityDetails["pipeline"] }>({
    key: "", source: null, output: null, delivery: null, loading: false, error: "", pipeline: null,
  });
  const url = enabled && !preview && !serverNormalized ? parsePlaybackUrl(streamUrl) as URL | null : null;
  const inspectionId = url?.searchParams.get("inspect") === "false" ? null : url?.searchParams.get("inspectionId") ?? null;
  const key = JSON.stringify([userId, trackId, streamUrl, inspectionId]);
  useEffect(() => {
    const pipeline = engine?.getAudioDiagnostics() ?? null;
    setState({ key, source: null, output: null, delivery: null, loading: Boolean(inspectionId && trackId && userId), error: "", pipeline });
    if (!trackId || !userId || !inspectionId) return;
    let controller: AbortController | null = null;
    let timeout: number | undefined;
    let cancelled = false;
    let retryDelay = INSPECTION_INTERVAL_MS;
    let retryAt = 0;
    const update = async () => {
      if (controller || cancelled || performance.now() < retryAt) return;
      const pipeline = engine?.getAudioDiagnostics() ?? null;
      const attempt = new AbortController();
      controller = attempt;
      const signal = attempt.signal;
      timeout = window.setTimeout(() => attempt.abort(), INSPECTION_TIMEOUT_MS);
      try {
        const data: Pick<StreamQualityDetails, "source" | "output" | "delivery" | "sourceError"> =
          await inspectAudioStream(trackId, inspectionId, signal);
        if (!cancelled) {
          retryDelay = INSPECTION_INTERVAL_MS;
          retryAt = 0;
          setState({ key, source: data?.source ?? null, output: data?.output ?? null,
            delivery: data?.delivery ?? null, sourceError: data?.sourceError, loading: false, error: "", pipeline });
        }
      } catch (error) {
        if (!cancelled) {
          retryDelay = Math.min(retryDelay * 2, MAX_INSPECTION_RETRY_MS);
          retryAt = performance.now() + retryDelay;
          const requestId = (error as { requestId?: unknown } | null)?.requestId;
          const message = signal.aborted ? "Audio inspection timed out."
            : error instanceof Error ? error.message : "Audio inspection failed.";
          setState((previous) => ({ ...previous, key, loading: false, pipeline,
            error: typeof requestId === "string" ? `${message} Request ID: ${requestId}.` : message }));
        }
      } finally {
        window.clearTimeout(timeout);
        controller = null;
      }
    };
    const stopPolling = startVisualPolling(update, INSPECTION_INTERVAL_MS);
    return () => { cancelled = true; window.clearTimeout(timeout); controller?.abort(); stopPolling(); };
  }, [engine, key, userId, trackId, inspectionId]);
  const current = state.key === key ? state : { source: null, output: null, delivery: null, pipeline: null, loading: Boolean(inspectionId), error: "" };
  return { ...current, serverNormalized, preview,
    pipeline: inspectionId ? current.pipeline : engine?.getAudioDiagnostics() ?? null,
    note: preview ? "Provider preview: full-file source and output properties cannot be verified."
      : serverNormalized ? "Server-normalized asset: the library stream observer does not inspect this separate processed file."
        : !enabled ? "Server stream inspection is disabled."
        : !inspectionId ? "No observable library stream is active." : "Delivery rate measures server-to-MusicDeck transfer speed, not encoded audio bitrate. Unknown properties are not inferred from settings." };
}
