import { useRef, useState } from "react";
import { sendRecommendationFeedback, startRadio } from "../api/musicdeck";
import { usePlayer } from "../context/PlayerContext";
import type { Song } from "../context/PlayerContext";

type Action = "more-like-this" | "hide" | "block-artist";

export default function RecommendationMenuItems({ song, onRequestClose, excludeHide = false, disabled = false, allowRadio = true }: {
  song: Song;
  onRequestClose?: () => void;
  excludeHide?: boolean;
  disabled?: boolean;
  allowRadio?: boolean;
}) {
  const player = usePlayer();
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const artistId = song.artistId ?? song.metadata?.artistId;

  async function apply(action: Action) {
    if (busy.current) return;
    busy.current = true;
    setPending(action);
    setError("");
    try {
      if (!player) throw new Error("Playback is not available. Please reload and try again.");
      await sendRecommendationFeedback({
        action,
        itemType: action === "block-artist" ? "artist" : "track",
        itemId: action === "block-artist" ? artistId ? String(artistId) : undefined : String(song.id),
        title: song.title,
        artist: song.artist || song.artistName,
      });
      if (action === "more-like-this") {
        const tracks: Song[] = await startRadio({ type: "track", id: String(song.id) }, 10);
        if (!tracks.length) {
          setError("Preference saved. No eligible local tracks are available right now.");
          return;
        }
        for (const track of tracks) player.addToQueue({ ...track, recommendationGenerated: true });
      }
      onRequestClose?.();
    } catch (failure) {
      console.error("Could not update recommendations", failure);
      setError(failure instanceof Error ? failure.message : "Could not update recommendations. Please try again.");
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  const actions: Array<{ action: Action; label: string; hint: string; icon: string }> = [
    { action: "more-like-this", label: "More like this", hint: "Queue similar music from your library", icon: "+" },
    { action: "hide", label: "Hide from recommendations", hint: "Never suggest this track", icon: "x" },
    ...(artistId || song.artist || song.artistName ? [{ action: "block-artist" as const, label: "Hide artist from recommendations", hint: "Never suggest this artist", icon: "x" }] : []),
  ];

  return <>
    <div className="track-context-menu-divider" aria-hidden="true" />
    {actions.filter(({ action }) => (!excludeHide || action !== "hide") && (allowRadio || action === "hide" || action === "block-artist")).map(({ action, label, hint, icon }) => (
      <button key={action} type="button" role="menuitem"
        className="playlist-menu-item track-context-menu-item"
        disabled={disabled || pending !== null} onClick={() => { void apply(action); }}>
        <span className="track-context-menu-icon" aria-hidden="true">{icon}</span>
        <span className="track-context-menu-copy">
          <span>{pending === action ? "Updating recommendations..." : label}</span>
          <small>{hint}</small>
        </span>
      </button>
    ))}
    {error && <p role="alert" className="track-context-menu-error">{error}</p>}
  </>;
}
