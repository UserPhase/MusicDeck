import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { usePlayer } from "../../context/PlayerContext";
import type { PlaybackEngine } from "../../services/audio/PlaybackEngine";
import SleepTimerModal from "./SleepTimerModal";
import "../../styles/audio-tools.css";

export default function PlayerAudioTools() {
  const player = usePlayer();
  if (!player?.audioEngine) return null;
  return <AudioTools engine={player.audioEngine} albumKeys={player.sleepAlbumKeys ?? []}
    local={!player.isCasting && !player.isRemotePlayback} />;
}

function AudioTools({ engine, albumKeys, local }: {
  engine: PlaybackEngine;
  albumKeys: readonly string[];
  local: boolean;
}) {
  const [open, setOpen] = useState(false);
  const timer = useSyncExternalStore(engine.sleepTimer.subscribe, engine.sleepTimer.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  function close() {
    dialog.current?.close();
    setOpen(false);
  }
  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, [open]);
  const active = timer.status === "armed" || timer.status === "fading";
  return <>
    <button type="button" className={`audio-tools-launch${active ? " is-active" : ""}`}
      aria-label={active ? "Sleep timer, timer active" : "Sleep timer"}
      title="Sleep timer" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <circle cx="12" cy="13" r="8" />
        <path d="M12 9v4l2.5 1.5M9 2h6" />
      </svg>
    </button>
    {open && <dialog className="audio-tools-dialog" ref={dialog} aria-labelledby={heading}
      onCancel={event => { event.preventDefault(); close(); }}
      onKeyDown={event => event.stopPropagation()}>
      <header>
        <h2 id={heading}>Sleep timer</h2>
        <button type="button" aria-label="Close sleep timer" onClick={close}>×</button>
      </header>
      <SleepTimerModal engine={engine} local={local} albumKeys={albumKeys} />
    </dialog>}
  </>;
}
