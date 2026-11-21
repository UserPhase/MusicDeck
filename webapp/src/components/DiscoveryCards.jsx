import { Link } from "react-router-dom";

import { useAlbumArtwork } from "../hooks/useAlbumArtwork";
import { useServerDeletion } from "../context/ServerDeletionContext";
import { toAlbumRouteIdFromApiId, toArtistRouteIdFromApiId } from "../utils/idResolver";
import ArtistAvatar from "./ArtistAvatar";
import TrackPlaybackIndicator from "./TrackPlaybackIndicator";
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

export function DiscoveryArtistCard({ artist, playbackState = null }) {
  const name = nameOf(artist);
  return <Link className={`explore-artist${playbackState ? " is-current" : ""}`} to={itemLink(artist, "artist")}
    title={artist.recommendationReason || undefined}
    aria-description={playbackState === "playing" ? "Now playing" : playbackState === "paused" ? "Playback paused" : undefined}>
    <ArtistAvatar artist={artist} className="explore-artist-image" allowAlbumTileFallback
      enableMusicBrainzFallback deferUntilVisible />
    {playbackState && <span className="explore-artist-status" aria-hidden="true">
      <TrackPlaybackIndicator isCurrentTrack isPlaying={playbackState === "playing"} />
    </span>}
    <span className="explore-card-name">{name}</span>
  </Link>;
}

export function DiscoveryAlbumCard({ album, onPlay, inlinePlay = false, playbackState = null }) {
  const deletion = useServerDeletion();
  if (album.id && deletion?.deletedAlbums.has(String(album.id))) return null;
  const name = nameOf(album);
  const playing = playbackState === "playing";
  const action = playing ? "Pause" : playbackState === "paused" ? "Resume" : "Play";
  const playButton = (
    <button type="button" onClick={() => onPlay(album)} aria-label={`${action} ${name}`}
      className={inlinePlay ? "explore-album-play-inline" : "explore-album-play"}>
      {playing ? <span aria-hidden="true"><TrackPlaybackIndicator isCurrentTrack isPlaying /></span> : "▶"}
    </button>
  );
  return <article className={`explore-album${inlinePlay ? " explore-album--inline-play" : ""}${playbackState ? " is-current" : ""}`}
    title={album.recommendationReason || undefined}>
    <div className="explore-album-image">
      <Link to={itemLink(album, "album")} aria-label={`Open ${name}`}><DiscoveryArtwork item={album} /></Link>
      {!inlinePlay && playButton}
    </div>
    <div className="explore-album-caption">
      <Link className="explore-card-name" to={itemLink(album, "album")}>{name}</Link>
      <span className="explore-card-subtitle">{album.artist || "Unknown artist"}</span>
      {inlinePlay && playButton}
    </div>
    <EditionBadges item={album} />
  </article>;
}
