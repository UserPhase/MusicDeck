import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { usePrivacy } from "../context/PrivacyContext";
import { followArtist, unfollowArtist, getArtistFollows, followsChanged, type FollowedArtist, type ArtistProvider } from "../api/artistFollows";

export default function ArtistFollowButton({ artistId, artistName }: { artistId: string; artistName: string }) {
  const ownerId = useAuth()?.session?.id;
  if (!ownerId || !artistId || !artistName || (/^(external_|extdetail_)/.test(artistId) && !/^external_(deezer|itunes)_artist_\d+$/.test(artistId))) return null;
  return <FollowControl key={`${ownerId}:${artistId}`} ownerId={ownerId} artistId={artistId} artistName={artistName} />;
}
function FollowControl({ ownerId, artistId, artistName }: { ownerId: string; artistId: string; artistName: string }) {
  const { canMetadata } = usePrivacy();
  const provider: ArtistProvider = /^external_deezer_/.test(artistId) ? "deezer" : /^external_itunes_/.test(artistId) ? "itunes" : "library";
  const [following, setFollowing] = useState<FollowedArtist | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  useEffect(() => {
    const load = () => {
      if (mutation.current) return;
      controller.current?.abort(); const active = new AbortController(); controller.current = active;
      void getArtistFollows(active.signal).then(result => {
        if (!active.signal.aborted) { setFollowing(result.artists.find(a => a.artistId === artistId && a.provider === provider) || null); setError(""); }
      }).catch(reason => { if (!active.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not check artist follows."); })
        .finally(() => { if (!active.signal.aborted) setLoading(false); });
    };
    load(); window.addEventListener("musicdeck:artist-follows-changed", load);
    return () => { controller.current?.abort(); window.removeEventListener("musicdeck:artist-follows-changed", load); };
  }, [artistId, provider]);
  return <span className="artist-follow-control">
    <button type="button" className={`detail-secondary-action${following ? " is-active" : ""}`} aria-pressed={Boolean(following)}
      disabled={loading || busy || Boolean(error) || (!following && !canMetadata)} title="Following checks for releases. Imports are always your choice."
      onClick={async () => {
        if (mutation.current) return; mutation.current = true;
        controller.current?.abort(); const active = new AbortController(); controller.current = active;
        setBusy(true); setError("");
        try {
          if (following) { await unfollowArtist(ownerId, following.key, active.signal); if (!active.signal.aborted) setFollowing(null); }
          else { const result = await followArtist(ownerId, artistId, artistName, provider, active.signal); if (!active.signal.aborted) setFollowing(result.artist); }
          if (!active.signal.aborted) { if (controller.current === active) controller.current = null; mutation.current = false; followsChanged(); }
        } catch (reason) { if (!active.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not update artist follow."); }
        finally { mutation.current = false; if (!active.signal.aborted) setBusy(false); }
      }}>{loading ? "Checking follow…" : busy ? "Updating…" : following ? "Following" : "Follow artist"}</button>
    {error && <span role="alert">{error} <button type="button" onClick={() => { setError(""); followsChanged(); }}>Retry</button></span>}
  </span>;
}
