import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { resolvePlaylistInvitation } from "../api/playlistCollaboration";
export default function PlaylistInvitationView() {
  const { hash } = useLocation(), navigate = useNavigate(), ownerId = useAuth()?.session?.id;
  const [error, setError] = useState("");
  useEffect(() => {
    const active = new AbortController(); const token = new URLSearchParams(hash.slice(1)).get("token") || "";
    setError("");
    if (!/^[a-f0-9]{64}$/.test(token)) { setError("This playlist invitation is invalid or incomplete."); return () => active.abort(); }
    void resolvePlaylistInvitation(token, active.signal).then(result => {
      if (!active.signal.aborted) navigate(`/playlist/${encodeURIComponent(result.playlistId)}`, { replace: true });
    }).catch(reason => { if (!active.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not open this invitation."); });
    return () => active.abort();
  }, [hash, navigate, ownerId]);
  return <div className="page-state">{error ? <p role="alert">{error}</p> : <p role="status">Opening playlist invitation…</p>}<Link to="/library/playlists">Your playlists</Link></div>;
}
