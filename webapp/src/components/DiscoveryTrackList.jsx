import { useMemo } from "react";
import TrackActionScope from "./TrackActionScope";
import TrackRow from "./TrackRow";

export const MOBILE_DISCOVERY_TRACK_LIMIT = 3;

export default function DiscoveryTrackList({ tracks, listId, onPlay, className, mobile = false, showArtwork = false, compactTile = false }) {
  const visible = useMemo(() => mobile ? tracks.slice(0, MOBILE_DISCOVERY_TRACK_LIMIT) : tracks, [tracks, mobile]);
  return <TrackActionScope tracks={visible} dataKey={listId}>
    <div className={`${className} track-list--compact${mobile ? " track-list--mobile-discovery" : ""}`} role="table" aria-label="Songs">
      {visible.map((song, index) => <TrackRow key={`${song.id}-${index}`} song={song} index={index}
        mobile={mobile} showAlbum={false} showArtwork={showArtwork || mobile}
        onPlay={onPlay} compactTile={compactTile} />)}
    </div>
  </TrackActionScope>;
}
