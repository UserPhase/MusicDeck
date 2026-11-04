import { useState } from "react";
import { usePlayer } from "../../context/PlayerContext";
import AudioQualityInspector, { audioQualityLabel } from "./AudioQualityInspector";

export default function AudioQualityBadge({ className = "" }: { className?: string }) {
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  if (!player?.currentSong) return null;
  const details = player.streamQualityDetails;
  const label = audioQualityLabel(details);
  return <>
    <button type="button" className={`audio-quality-badge ${details?.output?.lossless ? "is-lossless" : ""} ${className}`}
      aria-label={`Audio quality: ${label}. Open audio inspector`} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(true)}>{label}</button>
    {open && <AudioQualityInspector onClose={() => setOpen(false)} />}
  </>;
}
