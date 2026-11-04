import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "../../context/PlayerContext";
import type { StreamQuality } from "../../context/PlayerContext";
import type { AudioProperties, StreamQualityDetails } from "../../hooks/useStreamQualityDetails";
import "../../styles/audio-inspector.css";

function frequency(value: number | null | undefined): string {
  return value ? `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} kHz` : "Unknown";
}
function bitrate(value: number | null | undefined): string {
  return value ? `${Math.round(value).toLocaleString()} kbps` : "Unknown";
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="quality-field"><dt>{label}</dt><dd>{children ?? "Unknown"}</dd></div>;
}
function AudioFields({ properties }: { properties: AudioProperties | null }) {
  return <>
    <Field label="Codec">{properties?.codec}</Field>
    <Field label="Container">{properties?.container}</Field>
    <Field label="Encoded bitrate">{bitrate(properties?.bitrateKbps)}</Field>
    <Field label="Bit depth">{properties?.bitDepth ? `${properties.bitDepth}-bit` : "Unknown / not applicable"}</Field>
    <Field label="Sample rate">{frequency(properties?.sampleRateHz)}</Field>
    <Field label="Channels">{properties?.channels}</Field>
  </>;
}
export function audioQualityLabel(details?: StreamQualityDetails | null): string {
  if (details?.preview) return "PREVIEW";
  if (details?.serverNormalized) return "PROCESSED";
  const output = details?.output;
  if (!output) return "AUDIO";
  if (output.mode === "TRANSCODED") return "TRANSCODED";
  if (output.lossless) return output.bitDepth && output.bitDepth >= 24 ? `${output.bitDepth}-BIT` : "LOSSLESS";
  if (output.bitrateKbps) return `${Math.round(output.bitrateKbps)}k`;
  return output.codec ?? "AUDIO";
}

export default function AudioQualityInspector({ onClose }: { onClose(): void }) {
  const player = usePlayer();
  const details = player?.streamQualityDetails;
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const id = useId();
  const [selection, setSelection] = useState<StreamQuality>(player?.streamQuality ?? "original");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    const focus = document.activeElement;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); }
      if (event.key !== "Tab") return;
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? [])];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement as HTMLElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement as HTMLElement))) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("keydown", keydown, true); if (focus instanceof HTMLElement && focus.isConnected) focus.focus(); };
  }, []);
  const apply = async () => {
    if (!player || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await player.applyStreamQuality(selection);
      setMessage("Quality saved. The current stream reloads at its existing position.");
    } catch (failure) {
      console.error("Could not apply streaming quality:", failure);
      setError(failure instanceof Error ? failure.message : "Could not save streaming quality.");
    } finally { setBusy(false); }
  };
  const output = details?.output;
  return createPortal(<div className="audio-inspector-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <div className="audio-inspector" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-note`}>
      <header className="audio-inspector-heading">
        <div><p className="quality-eyebrow">MUSICDECK / SIGNAL MONITOR</p><h2 id={`${id}-title`}>Audio Inspector</h2>
          <p className="quality-track-name">{player?.currentSong?.title ?? "No active track"}</p></div>
        <button ref={closeRef} type="button" className="quality-close" onClick={onClose} aria-label="Close audio inspector">Close</button>
      </header>
      <div className="quality-signal-chain" aria-label="Audio signal chain">
        <span>Source <strong>{details?.source?.codec ?? "Unknown"}</strong></span><span aria-hidden="true">&rarr;</span>
        <span>Stream <strong>{details?.serverNormalized ? "Processed" : output?.codec ?? "Unknown"}</strong></span><span aria-hidden="true">&rarr;</span>
        <span>Playback <strong>{details?.pipeline?.path ?? "Unknown"}</strong></span>
      </div>
      {details?.loading && <p role="status">Inspecting active stream...</p>}
      {details?.error && <p className="quality-error" role="alert">{details.error} Inspection retries automatically.</p>}
      {details?.sourceError && <p className="quality-error" role="alert">{details.sourceError}</p>}
      <div className="quality-columns">
        <section><h3>Source file</h3><dl><AudioFields properties={details?.source ?? null} /></dl></section>
        <section><h3>Output stream</h3><dl>
          <AudioFields properties={output ?? null} />
          <Field label="Pipe state">{output?.mode === "DIRECT_STREAM" ? "Direct stream" : output?.mode === "TRANSCODED" ? "Transcoded" : details?.serverNormalized ? "Server-normalized asset" : "Not verified"}</Field>
          <Field label="Evidence">{output?.evidence === "provider-direct" ? "Provider raw/static request" : output?.evidence === "observed-conversion" ? "Delivered header differs from source" : "No verified conversion evidence"}</Field>
          <Field label="Transcode reason">{output?.transcodeReason ?? "Not reported"}</Field>
          <Field label="Server downsampling">{output?.downsampled === true ? "Yes" : output?.downsampled === false ? "No" : "Unknown"}</Field>
        </dl></section>
      </div>
      <section className="quality-pipeline"><h3>Playback pipeline</h3><dl>
        <Field label="Web Audio sample rate">{frequency(details?.pipeline?.sampleRateHz)}</Field>
        <Field label="Output device type">{details?.pipeline?.outputDeviceType ?? "Not exposed by browser"}</Field>
        <Field label="Output channels">{details?.pipeline?.outputChannels}</Field>
        <Field label="Client track gain">{details?.pipeline?.gainDb != null ? `${details.pipeline.gainDb >= 0 ? "+" : ""}${details.pipeline.gainDb.toFixed(2)} dB${details.serverNormalized ? " (server processing separate)" : ""}` : "Muted / unknown"}</Field>
        <Field label="Delivery throughput">{bitrate(details?.delivery?.bitrateKbps)}</Field>
        <Field label="Received bytes">{details?.delivery ? details.delivery.bytes.toLocaleString() : "Unknown"}</Field>
        <Field label="Transfer state">{details?.delivery?.state}</Field>
      </dl></section>
      <section className="quality-controls"><h3>Stream preference</h3>
        <div className="quality-selector"><label htmlFor={`${id}-quality`}>Maximum quality / bitrate</label>
          <select id={`${id}-quality`} value={selection} disabled={busy || details?.preview} onChange={(event) => setSelection(event.target.value as StreamQuality)}>
            <option value="128">128 kbps</option><option value="256">256 kbps</option><option value="320">320 kbps</option>
            <option value="original">Original (normalization allowed)</option><option value="direct">FLAC / Direct passthrough</option>
          </select>
          <button type="button" onClick={() => { void apply(); }} disabled={busy || !player?.currentSong || details?.preview}>{busy ? "Applying..." : "Apply to current track"}</button>
        </div>
        <p>Direct preserves the source codec, including lossy originals; it does not convert MP3 to FLAC. It bypasses server-normalized assets while retaining client gain. Bitrate caps are requests, not proof of transcoding.</p>
        {error && <p className="quality-error" role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
      </section>
      <p id={`${id}-note`} className="quality-note">{details?.note ?? "Stream properties are unavailable until playback begins."} Browser output-device details and hardware sample rate are not exposed reliably. Web Audio resampling is separate from server downsampling. Track gain excludes master volume and transition fades; HTML Audio volume may clip boosts.</p>
    </div>
  </div>, document.body);
}
