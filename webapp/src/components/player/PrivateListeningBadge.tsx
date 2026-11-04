import { useTasteProfile } from "../../hooks/useTasteProfile";
import "../../styles/taste-profile.css";
export default function PrivateListeningBadge() {
  const state = useTasteProfile();
  if (!state.owner) return null;
  return <div className="private-listening-control"><button type="button" role="switch" aria-label="Private listening" aria-checked={state.privateListening}
    className={`private-listening-badge${state.privateListening ? " is-active" : ""}`} title={state.error || (state.pending ? "Preference saved on this device; syncing with MusicDeck." : "Private listening keeps history and scrobbling, but excludes these sessions from your taste profile.")}
    onClick={() => { void state.setPrivate(!state.privateListening).catch(() => undefined); }}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 3l18 18M9.5 9.5a3.5 3.5 0 005 5M4.2 6.8C2.8 8 1.7 9.7 1 12c2 6 8 9 13.9 6.6M8 5.3C14.6 3 20.7 6.2 23 12a14 14 0 01-3 4.6" /></svg>
    <span>Private<span className="private-listening-state"> {state.pending ? "· Syncing" : state.privateListening ? "· On" : "· Off"}</span></span></button>
    {state.error && <span role="status" className="private-listening-error">{state.error}</span>}</div>;
}
