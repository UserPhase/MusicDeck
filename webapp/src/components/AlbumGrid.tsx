import { memo, ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAlbumArtwork } from "../hooks/useAlbumArtwork";
import { useVirtualWindow } from "../hooks/useVirtualWindow";
import { useServerDeletion } from "../context/ServerDeletionContext";
import { AlbumOfflineBadge } from "./OfflineAvailabilityBadge";
import { EditionBadges } from "./common/EditionBadges";
import AlbumDeleteButton from "./AlbumDeleteButton";
import "../styles/virtual-library.css";

export interface GridAlbum {
  id: string;
  name: string;
  artist?: string;
  coverArt?: string | null;
  metadata?: Record<string, unknown>;
}

export const AlbumGridCard = memo(function AlbumGridCard({ album }: { album: GridAlbum }) {
  const deletion = useServerDeletion();
  // Same resolver as the album detail page: placeholder covers fall back to
  // track art / external metadata instead of rendering the default vinyl.
  const { url: cover, onError } = useAlbumArtwork(album, 180);
  if (deletion?.deletedAlbums.has(String(album.id))) return null;
  return <div className="album-card-shell">
    <Link to={`/album/${encodeURIComponent(album.id)}`} className="album">
      <div className="album-cover">
        {cover
          ? <img src={cover} alt={`${album.name} cover`} loading="lazy" decoding="async"
            width={180} height={180} onError={onError} />
          : <div className="album-cover-placeholder" aria-hidden="true">{"\u266a"}</div>}
      </div>
      <div className="album-title">{album.name}</div>
      <div className="album-artist">{album.artist}<AlbumOfflineBadge albumId={album.id} /></div>
      <EditionBadges item={album} showFormats={false} />
    </Link>
    {deletion?.canDelete && <AlbumDeleteButton album={album} />}
  </div>;
}, (previous, next) => previous.album === next.album);

function AlbumGrid({ itemCount, getItem, onRangeChange }: {
  itemCount: number;
  getItem(index: number): GridAlbum | undefined;
  onRangeChange?(start: number, end: number): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
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
  const columns = Math.max(1, Math.floor((width + 20) / 200));
  // Card padding, single-line captions and the row gap sit below the square.
  const rowHeight = Math.max(180, (width - (columns - 1) * 20) / columns) + 112;
  const windowed = useVirtualWindow(ref, Math.ceil(itemCount / columns), rowHeight, false, columns);
  useLayoutEffect(() => {
    onRangeChange?.(windowed.start * columns, Math.min(itemCount, windowed.end * columns));
  }, [columns, itemCount, onRangeChange, windowed.start, windowed.end]);
  const rows: ReactNode[] = [];
  for (let row = windowed.start; row < windowed.end; row += 1) {
    const cards: ReactNode[] = [];
    for (let index = row * columns; index < Math.min(itemCount, (row + 1) * columns); index += 1) {
      const album = getItem(index);
      cards.push(album ? <AlbumGridCard key={album.id} album={album} />
        : <div key={`pending-${index}`} className="album virtual-album-skeleton"
          aria-label={`Loading album ${index + 1}`} aria-busy="true"><div className="album-cover" /><div className="album-title" /></div>);
    }
    rows.push(<div key={row} className="virtual-album-row" role="listitem"
      style={{ height: rowHeight, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{cards}</div>);
  }
  return <div ref={ref} className="virtual-album-window" role="list" aria-label="Albums">
    <div aria-hidden="true" style={{ height: windowed.offsets[windowed.start] }} />
    {rows}
    <div aria-hidden="true" style={{ height: windowed.totalSize - windowed.offsets[windowed.end] }} />
  </div>;
}

export default memo(AlbumGrid);
