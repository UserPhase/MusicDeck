import { useEffect, useState } from "react";
import { getTrackArtistBiography } from "../api/musicdeck";
import { getCachedWikipediaBiography, getWikipediaBiography } from "../services/biographyFallback";

export function useArtistBiography({ artistId, artistName, trackId, enabled = true }) {
  const [biography, setBiography] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    const cached = enabled ? getCachedWikipediaBiography(artistId || artistName, artistName) : null;
    setBiography(cached);
    if (!enabled || !artistName) {
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(!cached);
    const resolve = async () => {
      let nativeText = null;
      if (trackId) {
        try { nativeText = await getTrackArtistBiography(trackId); } catch { /* Wikipedia can still work. */ }
      }
      if (!active) return;
      const trimmed = typeof nativeText === "string" ? nativeText.trim() : "";
      if (trimmed.length >= 50) {
        setBiography({ text: trimmed, source: "server", url: null });
        setLoading(false);
        return;
      }
      // Preserve a short native bio if Wikipedia is unavailable.
      if (trimmed) setBiography({ text: trimmed, source: "server", url: null });
      const fallback = await getWikipediaBiography(artistId || artistName, artistName);
      if (active) {
        setBiography(fallback || (trimmed ? { text: trimmed, source: "server", url: null } : null));
        setLoading(false);
      }
    };
    void resolve().catch(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [artistId, artistName, trackId, enabled]);

  return { biography, loading };
}
