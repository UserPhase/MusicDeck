import { useState } from "react";
import { Link } from "react-router-dom";

import { getCoverUrl } from "../api/musicdeck";
import { useServerDeletion } from "../context/ServerDeletionContext";
import { toArtistRouteIdFromApiId } from "../utils/idResolver";
import ArtistAvatar from "./ArtistAvatar";
import AlbumDeleteButton from "./AlbumDeleteButton";

const nameOf = (item) => item?.name || item?.title || "Unknown";

function itemLink(item, type) {
  if (type === "artist" && (item.external || item.sample || item.source?.kind === "external")) {
    return `/artist/${encodeURIComponent(toArtistRouteIdFromApiId(item.id))}`;
  }
  return item.external || item.sample || !item.id
    ? `/search?q=${encodeURIComponent(type === "album" ? `${nameOf(item)} ${item.artist || ""}`.trim() : nameOf(item))}`
    : `/${type}/${encodeURIComponent(item.id)}`;
}

export function DiscoveryArtwork({ item, className = "" }) {
  const [failedImage, setFailedImage] = useState(null);
  const image = getCoverUrl(item?.coverArt, 360) || item?.coverUrl;
  return <span className={`explore-artwork ${className}`}>
    {image && failedImage !== image ? <img src={image} alt="" onError={() => setFailedImage(image)} />
      : <span className="explore-artwork-fallback" aria-hidden="true">{nameOf(item).slice(0, 1).toUpperCase()}</span>}
  </span>;
}

export function DiscoveryArtistCard({ artist }) {
  return <Link className="explore-artist" to={itemLink(artist, "artist")}>
    <ArtistAvatar artist={artist} className="explore-artist-image" allowAlbumTileFallback />
    <span className="explore-card-name">{nameOf(artist)}</span>
  </Link>;
}

export function DiscoveryAlbumCard({ album, onPlay, showAdminActions = false }) {
  const deletion = useServerDeletion();
  if (album.id && deletion?.deletedAlbums.has(String(album.id))) return null;
  return <article className="explore-album">
    <div className="explore-album-image">
      <Link to={itemLink(album, "album")} aria-label={`Open ${nameOf(album)}`}><DiscoveryArtwork item={album} /></Link>
      <button type="button" onClick={() => onPlay(album)} aria-label={`Play ${nameOf(album)}`} className="explore-album-play">▶</button>
      {showAdminActions && <AlbumDeleteButton album={album} />}
    </div>
    <Link className="explore-card-name" to={itemLink(album, "album")}>{nameOf(album)}</Link>
    <span className="explore-card-subtitle">{album.artist || "Unknown artist"}</span>
  </article>;
}
