import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRemoteControl } from "../../context/RemoteSessionContext";
import { useCast } from "../../context/CastContext";
import CastButton from "./CastButton";
import type { RemoteDevice } from "../../types/remoteSession";
import "../../styles/remote-devices.css";

function time(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function DeviceRow({ device, current, disabled, onTransfer, onVolume }: {
  device: RemoteDevice; current: boolean; disabled: boolean;
  onTransfer(): void; onVolume(volume: number): void;
}) {
  const [volume, setVolume] = useState(device.volume);
  const dragging = useRef(false);
  useEffect(() => { if (!dragging.current) setVolume(device.volume); }, [device.volume]);
  return <li className={`remote-device${device.is_active_player ? " is-active" : ""}`}>
    <div className="remote-device-symbol" aria-hidden="true">{device.device_type === "computer" ? "PC" : device.device_type === "phone" ? "PH" : "WEB"}</div>
    <div className="remote-device-copy"><strong>{device.device_name}{current ? " / This device" : ""}</strong>
      <span>{device.is_active_player ? "Active player" : device.can_receive ? "Ready to receive" : "Playback permission needed"}</span>
      {device.current_track && <small>{device.current_track.title} / {time(device.position_ms)}</small>}
      <label className="remote-device-volume">Volume <output>{Math.round(volume * 100)}%</output>
        <input type="range" min={0} max={1} step={.01} value={volume} disabled={disabled}
          aria-label={`Volume on ${device.device_name}`}
          onPointerDown={() => { dragging.current = true; }}
          onChange={(event) => { const next = Number(event.target.value); setVolume(next); onVolume(next); }}
          onPointerUp={() => { dragging.current = false; }}
          onPointerCancel={() => { dragging.current = false; }}
          onBlur={() => { dragging.current = false; }} />
      </label>
    </div>
    <button type="button" className="remote-transfer" disabled={disabled || device.is_active_player || !device.can_receive}
      onClick={onTransfer} aria-label={`Transfer playback to ${device.device_name}`}>
      {device.is_active_player ? "Active" : "Play here"}
    </button>
  </li>;
}
export default function DeviceSelectorModal({ onClose }: { onClose(): void }) {
  const remote = useRemoteControl();
  const cast = useCast();
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const closeHandler = useRef(onClose); closeHandler.current = onClose;
  const [name, setName] = useState(remote?.name || "");
  const [enabling, setEnabling] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeHandler.current(); return; }
      if (event.key !== "Tab") return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled)") || [])];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !controls.some((control) => control === document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !controls.some((control) => control === document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const enable = async () => {
    if (!remote || enabling) return;
    setEnabling(true); setNotice("");
    try { await remote.enable(); setNotice("This device can now receive playback while this tab remains open."); }
    catch (error) { console.error("Could not enable remote playback:", error); }
    finally { setEnabling(false); }
  };
  return createPortal(<div className="remote-device-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="remote-device-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} ref={dialog}>
      <header><div><p className="remote-device-eyebrow">MUSICDECK / LISTENING NETWORK</p><h2 id={`${id}-title`}>Choose where it plays.</h2></div>
        <button type="button" ref={close} onClick={onClose} aria-label="Close device selector">Close</button></header>
      <p id={`${id}-description`}>Choose a device signed in to MusicDeck, or connect to a Chromecast, speaker or TV.</p>
      {remote && <div className="remote-connection" role="status"><span aria-hidden="true" />{remote.status === "connected" ? "Connected / Local network or server relay"
        : remote.status === "reconnecting" ? "Reconnecting to device control..." : remote.status === "connecting" ? "Connecting to device control..." : "Device control unavailable"}</div>}
      {remote && <div className="remote-local-settings"><label>Device name<input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <button type="button" disabled={!name.trim()} onClick={() => { remote.rename(name); setNotice("Device name updated for this tab."); }}>Save name</button>
        <button type="button" disabled={remote.enabled || enabling || remote.status !== "connected"} onClick={() => { void enable(); }}>
          {enabling ? "Enabling..." : remote.enabled ? "Playback enabled" : "Enable playback on this device"}</button></div>}
      {!remote?.devices.length ? <p className="remote-empty">No online devices yet. Open MusicDeck on another device using the same account.</p>
        : <ul className="remote-device-list">{remote.devices.map((device) => <DeviceRow key={device.device_id} device={device}
          current={device.device_id === remote.deviceId} disabled={remote.busy || remote.status !== "connected"}
          onTransfer={() => {
            setNotice("");
            void remote.transfer(device.device_id).then(() => setNotice(`Playback transferred to ${device.device_name}.`))
              .catch((error: unknown) => console.error("Playback transfer failed:", error));
          }}
          onVolume={(volume) => { void remote.command({ type: "SET_VOLUME", volume }, device.device_id)
            .catch((error: unknown) => console.error("Remote volume failed:", error)); }} />)}</ul>}
      {cast && <section className="remote-cast-section" aria-labelledby={`${id}-cast-title`}>
        <h3 id={`${id}-cast-title`}>Google Cast</h3>
        <CastButton variant="device" />
      </section>}
      {remote?.busy && <p role="status">Preparing the target player. Your current device continues until it is ready...</p>}
      {notice && <p role="status">{notice}</p>}
      {remote?.error && <div className="remote-error" role="alert">{remote.error}
        <button type="button" onClick={remote.clearError}>Dismiss</button></div>}
      <p className="remote-footnote">Keep MusicDeck open on other signed-in devices and enable playback there before transferring.
        Chromecast and speakers connect through Google Cast.</p>
    </div>
  </div>, document.body);
}
