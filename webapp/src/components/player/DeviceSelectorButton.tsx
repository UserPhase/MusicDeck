import { useState } from "react";
import { useRemoteControl } from "../../context/RemoteSessionContext";
import { useCast } from "../../context/CastContext";
import DeviceSelectorModal from "./DeviceSelectorModal";
import "../../styles/remote-devices.css";

export default function DeviceSelectorButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const remote = useRemoteControl();
  const cast = useCast();
  if (!remote && !cast) return null;
  const playingElsewhere = cast?.connected || remote?.isRemote;
  const deviceName = cast?.connected ? cast.device : remote?.activeDevice?.device_name;
  return <><button type="button" className={`device-selector-button${playingElsewhere ? " is-remote" : ""}${compact ? " is-compact" : ""}`}
    aria-label="Choose playback device" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}
    title={playingElsewhere ? `Playing on ${deviceName}` : "Playback devices"}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="13" height="11" rx="2" /><path d="M7 19h5M10 15v4" /><rect x="16" y="9" width="5" height="11" rx="1" /></svg>
    <span>{playingElsewhere ? deviceName : "Devices"}</span>
    {(remote?.error || cast?.error) && <span className="remote-device-error-dot" aria-label="Device control error">!</span>}
  </button>{open && <DeviceSelectorModal onClose={() => setOpen(false)} />}</>;
}
