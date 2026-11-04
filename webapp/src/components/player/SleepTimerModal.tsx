import { useEffect, useState, useSyncExternalStore } from "react";
import type { PlaybackEngine } from "../../services/audio/PlaybackEngine";
import { SLEEP_MINUTES, type SleepMinutes } from "../../services/audio/SleepTimerService";

export default function SleepTimerModal({ engine, albumKeys, local }: {
  engine: PlaybackEngine;
  albumKeys: readonly string[];
  local: boolean;
}) {
  const state = useSyncExternalStore(engine.sleepTimer.subscribe, engine.sleepTimer.getSnapshot);
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState("");
  const deadline = state.deadline;
  useEffect(() => {
    if (deadline === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  const seconds = Math.max(0, Math.ceil(((deadline ?? now) - now) / 1000));
  const trackKey = engine.getSnapshot().key;
  const active = state.status === "armed" || state.status === "fading";
  function start(choice: SleepMinutes | "track" | "album") {
    setError("");
    setNow(Date.now());
    try {
      engine.startSleepTimer(choice, albumKeys);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start the sleep timer.");
    }
  }
  return <section aria-label="Sleep timer settings">
    <p className="audio-tools-description">Playback fades to silence over the final five seconds.</p>
    {!local && <p role="status">Sleep timer is available for playback on this device.</p>}
    <fieldset className="audio-tools-fields" disabled={!local}>
      <legend>Stop after</legend>
      <div className="sleep-choices">
        {SLEEP_MINUTES.map(minutes => <button type="button" key={minutes} onClick={() => start(minutes)}>{minutes} min</button>)}
      </div>
      <div className="sleep-boundaries">
        <button type="button" disabled={!trackKey} onClick={() => start("track")}>End of current track</button>
        <button type="button" disabled={!trackKey || trackKey !== albumKeys[0]} onClick={() => start("album")}>End of active album</button>
      </div>
    </fieldset>
    <div className="sleep-state">
      <span role="status">
        {state.status === "fading" ? "Fading out…" : state.status === "stopped" ? "Playback stopped"
          : deadline !== null ? `Stops in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
            : state.mode === "album" ? "Stops after this album" : state.mode === "track" ? "Stops after this track" : "Timer off"}
      </span>
      {active && <button type="button" onClick={() => engine.sleepTimer.cancel()}>Cancel timer</button>}
    </div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
