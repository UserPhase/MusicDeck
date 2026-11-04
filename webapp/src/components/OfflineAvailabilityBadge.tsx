import { useEffect, useState, useSyncExternalStore } from "react";
import { offlineDownloadEngine } from "../services/storage/OfflineDownloadEngine";
import { useOfflineAudit } from "../services/storage/OfflineAuditor";
import "../styles/downloads.css";

export function TrackOfflineBadge({ trackId }: { trackId: string | number }) {
  const audit = useOfflineAudit(trackId);
  return audit.status === "verified" ? <span className="offline-available-badge" title="Verified audio saved on this device">↓ Offline</span> : null;
}
export function AlbumOfflineBadge({ albumId }: { albumId: string | number }) {
  const snapshot = useSyncExternalStore(offlineDownloadEngine.subscribe, offlineDownloadEngine.getSnapshot);
  const [verified, setVerified] = useState<string[]>([]);
  const collection = snapshot.collections.find((item) => item.kind === "album" && item.id === String(albumId));
  const membership = JSON.stringify(collection?.trackIds || []);
  const integrity = snapshot.tracks.filter((track) => collection?.trackIds.includes(track.track_id)).map((track) => `${track.key}:${track.checksum}:${track.status}`).join("|");
  useEffect(() => {
    let cancelled = false;
    setVerified([]);
    const trackIds: string[] = JSON.parse(membership);
    if (trackIds.length) {
      void (async () => {
        const ids: string[] = [];
        for (const id of trackIds) { if (cancelled) return; if (await offlineDownloadEngine.readVerifiedTrack(id)) ids.push(id); }
        if (!cancelled) setVerified(ids);
      })().catch(() => { if (!cancelled) setVerified([]); });
    }
    return () => { cancelled = true; };
  }, [membership, integrity]);
  if (!collection || !verified.length) return null;
  const complete = verified.length === collection.trackIds.length;
  return <span className="offline-available-badge" title={`${verified.length} of ${collection.trackIds.length} tracks verified on this device`}>
    ↓ {complete ? "Offline" : `${verified.length}/${collection.trackIds.length} offline`}
  </span>;
}
