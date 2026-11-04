import { Link } from "react-router-dom";

import { useAlbumArtwork } from "../hooks/useAlbumArtwork";
import { useServerDeletion } from "../context/ServerDeletionContext";
import { toAlbumRouteIdFromApiId, toArtistRouteIdFromApiId } from "../utils/idResolver";
import ArtistAvatar from "./ArtistAvatar";
import { EditionBadges } from "./common/EditionBadges";

const nameOf = (item) => item?.name || item?.title || "Unknown";

export function itemLink(item, type) {
  if (type === "album" && item.id && !item.sample) {
    return `/album/${encodeURIComponent(toAlbumRouteIdFromApiId(item.localAlbumId || item.id))}`;
  }
  if (type === "artist" && (item.external || item.sample || item.source?.kind === "external")) {
    return `/artist/${encodeURIComponent(toArtistRouteIdFromApiId(item.id))}`;
  }
  return item.external || item.sample || !item.id
    ? `/search?q=${encodeURIComponent(type === "album" ? `${nameOf(item)} ${item.artist || ""}`.trim() : nameOf(item))}`
    : `/${type}/${encodeURIComponent(item.id)}`;
}

export function DiscoveryArtwork({ item, className = "" }) {
  const { url: image, onError } = useAlbumArtwork(item);
  return <span className={`explore-artwork ${className}`}>
    {image ? <img src={image} alt="" loading="lazy" decoding="async" onError={onError} />
      : <span className="explore-artwork-fallback" aria-hidden="true">{nameOf(item).slice(0, 1).toUpperCase()}</span>}
  </span>;
}

export function DiscoveryArtistCard({ artist }) {
  return <Link className="explore-artist" to={itemLink(artist, "artist")} title={artist.recommendationReason || undefined}>
    <ArtistAvatar artist={artist} className="explore-artist-image" allowAlbumTileFallback
      enableMusicBrainzFallback deferUntilVisible />
    <span className="explore-card-name">{nameOf(artist)}</span>
  </Link>;
}

export function DiscoveryAlbumCard({ album, onPlay }) {
  const deletion = useServerDeletion();
  if (album.id && deletion?.deletedAlbums.has(String(album.id))) return null;
  return <article className="explore-album" title={album.recommendationReason || undefined}>
    <div className="explore-album-image">
      <Link to={itemLink(album, "album")} aria-label={`Open ${nameOf(album)}`}><DiscoveryArtwork item={album} /></Link>
      <button type="button" onClick={() => onPlay(album)} aria-label={`Play ${nameOf(album)}`} className="explore-album-play">▶</button>
    </div>
    <Link className="explore-card-name" to={itemLink(album, "album")}>{nameOf(album)}</Link>
    <span className="explore-card-subtitle">{album.artist || "Unknown artist"}</span>
      <EditionBadges item={album} />
  </article>;
}
