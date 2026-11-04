import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { getAlbum } from "../api/musicdeck";
import { getPlaylist } from "../api/playlists";
import { usePlayer } from "../context/PlayerContext";
import type { Song } from "../context/PlayerContext";
import { useMediaSessions } from "../hooks/useMediaSessions";
import { resumeTrackIndex } from "../services/mediaSessions";
import type { MediaCheckpoint } from "../services/mediaSessions";
import "../styles/media-sessions.css";

function resumeTime(seconds: number): string {
  const value = Math.floor(seconds);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function ProgressRing({ progress }: { progress: number }) {
  const percent = Math.min(100, Math.max(0, Math.round(progress * 100)));
  return <span className="resume-ring" role="img" aria-label={`${percent}% complete`}>
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="20" className="resume-ring-track" />
      <circle cx="24" cy="24" r="20" pathLength="100" className="resume-ring-value"
        strokeDasharray="100" strokeDashoffset={100 - percent} />
    </svg>
    <span aria-hidden="true">{percent}<small>%</small></span>
  </span>;
}

function ResumeAction({ checkpoint }: { checkpoint: MediaCheckpoint }) {
  const player = usePlayer();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resume = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      let songs: Song[] | undefined;
      let coverArt: string | null;
      if (checkpoint.type === "album") {
        const collection = await getAlbum(checkpoint.mediaId);
        songs = collection?.song;
        coverArt = collection?.coverArt ?? null;
      } else {
        const collection = await getPlaylist(checkpoint.mediaId);
        songs = collection?.entry;
        coverArt = collection?.coverArt ?? null;
      }
      const index = songs ? resumeTrackIndex(checkpoint, songs) : -1;
      if (!songs?.length || index < 0) throw new Error("The bookmarked track is no longer in this collection. Open it to choose another track.");
      if (!player) throw new Error("Sign in to resume listening.");
      await player.resumeMedia(songs, index, {
        type: checkpoint.type, id: checkpoint.mediaId, name: checkpoint.title, coverArt,
      }, checkpoint.positionSeconds);
    } catch (failure) {
      console.error("Could not resume collection:", failure);
      setError(failure instanceof Error ? failure.message : "Could not resume this collection.");
    } finally { setBusy(false); }
  };
  return <div className="resume-collection">
    <ProgressRing progress={checkpoint.progress} />
    <div className="resume-collection-body">
      <Link className="resume-collection-title" to={`/${checkpoint.type}/${encodeURIComponent(checkpoint.mediaId)}`}>{checkpoint.title}</Link>
      <span className="resume-collection-meta">{checkpoint.type === "album" ? "Album" : "Playlist"} &middot; Track {checkpoint.trackIndex + 1} of {checkpoint.trackCount}</span>
      <button type="button" className="resume-collection-action" disabled={busy} onClick={() => { void resume(); }}>
        {busy ? "Preparing resume..." : `Resume from Track ${checkpoint.trackIndex + 1} - ${resumeTime(checkpoint.positionSeconds)}`}
      </button>
      {error && <p className="resume-error" role="alert">{error}</p>}
    </div>
  </div>;
}

export default function ContinueListeningRow({ fallback }: { fallback?: ReactNode }) {
  const { items, loading, error, retry } = useMediaSessions();
  return <>
    {loading && !items.length && <p className="home-section-state" role="status">Loading listening progress...</p>}
    {error && <p className="resume-error" role="status">{error} <button type="button" onClick={retry}>Retry listening progress</button></p>}
    {items.length > 0 && <div className="continue-collection-grid">
      {items.slice(0, 6).map((checkpoint) => <ResumeAction key={`${checkpoint.type}:${checkpoint.mediaId}`} checkpoint={checkpoint} />)}
    </div>}
    {!items.length && fallback}
  </>;
}
