import { memo } from "react";
import { usePrivacy } from "../context/PrivacyContext";
import { Link } from "react-router-dom";

import { DiscoveryArtwork, itemLink } from "./DiscoveryCards";
import type { ExternalMetadataItem } from "../services/externalActions";

export type ExternalAlbum = ExternalMetadataItem & {
  coverArt?: { url: string } | null;
  external?: boolean;
  recommendationReason?: string;
};

type ExternalAlbumCardProps = {
  album: ExternalAlbum;
  /** Optional preview/playback handler; omitted cards show no play button. */
  onPlay?: (album: ExternalAlbum) => void;
};

const nameOf = (album: ExternalAlbum) => album.title || album.name || "Unknown";

/** Compact discovery card; saving and importing live on the album detail page. */
function ExternalAlbumCard({ album, onPlay }: ExternalAlbumCardProps) {
  const { canMetadata } = usePrivacy();
  const name = nameOf(album);
  // Share the album-detail destination with other discovery cards.
  const href = itemLink(album, "album");

  return <article className="explore-album external-album-card" title={album.recommendationReason}>
    <div className="explore-album-image">
      <Link to={href} aria-label={`Open ${name}`}><DiscoveryArtwork item={album} /></Link>
      {canMetadata && onPlay && <button type="button" onClick={() => onPlay(album)} aria-label={`Play ${name}`} className="explore-album-play">▶</button>}
    </div>
    <Link className="explore-card-name" to={href}>{name}</Link>
    <span className="explore-card-subtitle">{album.artist || "Unknown artist"}</span>
  </article>;
}

export default memo(ExternalAlbumCard);
