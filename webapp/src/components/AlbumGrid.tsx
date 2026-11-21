import { memo, ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAlbumArtwork } from "../hooks/useAlbumArtwork";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useVirtualWindow } from "../hooks/useVirtualWindow";
import { usePlayer } from "../context/PlayerContext";
import { useServerDeletion } from "../context/ServerDeletionContext";
import { toAlbumRouteIdFromApiId, toTrackAlbumRouteId } from "../utils/idResolver";
import { MOBILE_LAYOUT_QUERY } from "../utils/layoutPreset";
import { AlbumOfflineBadge } from "./OfflineAvailabilityBadge";
import { EditionBadges } from "./common/EditionBadges";
import AlbumDeleteButton from "./AlbumDeleteButton";
import TrackPlaybackIndicator from "./TrackPlaybackIndicator";
import "../styles/virtual-library.css";

export interface GridAlbum {
  id: string;
  localAlbumId?: string | null;
  name: string;
  artist?: string;
  coverArt?: string | null;
  metadata?: Record<string, unknown>;
}

type PlaybackState = "playing" | "paused";

export const AlbumGridCard = memo(function AlbumGridCard({ album, mobile = false, playbackState }: {
  album: GridAlbum;
  mobile?: boolean;
  playbackState?: PlaybackState;
}) {
  const deletion = useServerDeletion();
  const artworkSize = mobile ? 320 : 180;
  // Same resolver as the album detail page: placeholder covers fall back to
  // track art / external metadata instead of rendering the default vinyl.
  const { url: cover, onError } = useAlbumArtwork(album, artworkSize);
  if (deletion?.deletedAlbums.has(String(album.id))) return null;
  return <div className="album-card-shell">
    <Link to={`/album/${encodeURIComponent(album.id)}`} className={`album${playbackState ? " is-current" : ""}`}
      aria-description={playbackState === "playing" ? "Now playing" : playbackState === "paused" ? "Playback paused" : undefined}>
      <div className="album-cover">
        {cover
          ? <img src={cover} alt={`${album.name} cover`} loading="lazy" decoding="async"
            width={artworkSize} height={artworkSize} onError={onError} />
          : <div className="album-cover-placeholder" aria-hidden="true">{"\u266a"}</div>}
      </div>
      <div className="album-grid-title">
        <div className="album-title">{album.name}</div>
        {playbackState && <span className="album-grid-indicator" aria-hidden="true">
          <TrackPlaybackIndicator isCurrentTrack isPlaying={playbackState === "playing"} />
        </span>}
      </div>
      <div className="album-artist">
        <span className="album-grid-artist-name">{album.artist || (mobile ? "Unknown artist" : "")}</span>
        <AlbumOfflineBadge albumId={album.id} />
      </div>
      <EditionBadges item={album} showFormats={false} />
    </Link>
    {deletion?.canDelete && <AlbumDeleteButton album={album} />}
  </div>;
});

function AlbumGrid({ itemCount, getItem, onRangeChange }: {
  itemCount: number;
  getItem(index: number): GridAlbum | undefined;
  onRangeChange?(start: number, end: number): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const player = usePlayer(!mobile);
  const currentAlbumId = mobile ? toTrackAlbumRouteId(player?.currentSong) : "";
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  const gap = mobile ? 12 : 20;
  const columns = mobile ? 2 : Math.max(1, Math.floor((width + gap) / 200));
  const columnWidth = (width - (columns - 1) * gap) / columns;
  // On mobile the height adds 68px for the caption and badges plus the row gap.
  const rowHeight = mobile ? Math.max(0, columnWidth) + 68 + gap : Math.max(180, columnWidth) + 112;
  const windowed = useVirtualWindow(ref, Math.ceil(itemCount / columns), rowHeight, false, columns);
  useLayoutEffect(() => {
    onRangeChange?.(windowed.start * columns, Math.min(itemCount, windowed.end * columns));
  }, [columns, itemCount, onRangeChange, windowed.start, windowed.end]);
  const rows: ReactNode[] = [];
  for (let row = windowed.start; row < windowed.end; row += 1) {
    const cards: ReactNode[] = [];
    for (let index = row * columns; index < Math.min(itemCount, (row + 1) * columns); index += 1) {
      const album = getItem(index);
      const active = currentAlbumId && album && currentAlbumId === toAlbumRouteIdFromApiId(album.localAlbumId || album.id);
      cards.push(album ? <AlbumGridCard key={album.id} album={album} mobile={mobile}
        playbackState={active ? (player?.isPlaying ? "playing" : "paused") : undefined} />
        : <div key={`pending-${index}`} className="album virtual-album-skeleton"
          aria-label={`Loading album ${index + 1}`} aria-busy="true"><div className="album-cover" /><div className="album-title" /></div>);
    }
    rows.push(<div key={row} className="virtual-album-row" role="listitem"
      style={{ height: rowHeight, gap, paddingBottom: gap, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{cards}</div>);
  }
  return <div ref={ref} className={`virtual-album-window${mobile ? " virtual-album-window--mobile" : ""}`} role="list" aria-label="Albums">
    <div aria-hidden="true" style={{ height: windowed.offsets[windowed.start] }} />
    {rows}
    <div aria-hidden="true" style={{ height: windowed.totalSize - windowed.offsets[windowed.end] }} />
  </div>;
}

export default memo(AlbumGrid);
