import { useState } from "react";
import { useCast } from "../../context/CastContext";
import "../../styles/cast.css";

export default function CastButton({ variant = "inline" }: { variant?: "inline" | "device" }) {
  const cast = useCast();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!cast) return null;
  const act = async () => {
    if (busy) return;
    if (!cast.connected && !window.confirm("Connect to Google Cast? This loads Google's Sender SDK. Your receiver must be able to reach MusicDeck's public URL.")) return;
    setBusy(true); setError("");
    try { if (cast.connected) await cast.disconnect(); else await cast.connect(); }
    catch (failure) {
      console.error("Could not change Cast device:", failure);
      setError(failure instanceof Error ? failure.message : "Could not connect to the Cast receiver.");
    } finally { setBusy(false); }
  };
  const reason = !cast.allowed ? "Google Cast is disabled by server privacy policy."
    : !cast.supported ? "Google Cast needs a supported Chromium browser in a secure context." : "";
  const deviceRow = variant === "device";
  return <span className={`cast-control${deviceRow ? " cast-control--device" : ""}`}>
    <button type="button" className={`device-selector-button cast-button${cast.connected ? " is-remote" : ""}`}
      aria-label={cast.connected ? `Stop casting to ${cast.device}` : "Cast to a speaker"}
      aria-pressed={cast.connected} disabled={busy || cast.loading || Boolean(reason && !cast.connected)}
      title={cast.connected ? `Stop casting to ${cast.device}; local playback stays paused` : reason || "Google Cast"}
      onClick={() => { void act(); }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V5h18v14h-8M3 19h.01M3 15a4 4 0 0 1 4 4M3 11a8 8 0 0 1 8 8" /></svg>
      {deviceRow ? <>
        <span className="cast-device-copy"><strong>{cast.connected ? cast.device : "Chromecast, speakers & TVs"}</strong>
          <small>{busy || cast.loading ? "Connecting..." : cast.connected ? "Playing via Google Cast" : "Choose a Google Cast device"}</small></span>
        <span className="cast-device-action">{cast.connected ? "Disconnect" : "Connect"}</span>
      </> : <span>{busy || cast.loading ? "Connecting..." : cast.connected ? cast.device : "Cast"}</span>}
    </button>
    {(error || cast.error) && <span className="cast-error" role="alert">{error || cast.error}</span>}
    {deviceRow && reason && !cast.connected && <span className="cast-device-hint">{reason}</span>}
  </span>;
}
