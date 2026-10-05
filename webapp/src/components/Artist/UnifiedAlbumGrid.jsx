import { Link } from "react-router-dom";

import { getCoverUrl } from "../../api/musicdeck";

function UnifiedAlbumGrid({ albums, artistId }) {
  return <>
    {albums.map((album) => {
      const external = album.discographySource === "external";
      const cover = getCoverUrl(album.coverArt || album.artworkId, 300);
      const destination = external
        ? `/artist/${encodeURIComponent(artistId)}/album/${encodeURIComponent(album.id)}`
        : `/album/${encodeURIComponent(album.id)}`;
      return <Link className={`unified-album${external ? " unified-album--external" : ""}`} key={album.id} to={destination}>
        <div className="unified-album-cover">
          {cover ? <img src={cover} alt={`${album.title || album.name} cover`} loading="lazy" decoding="async" /> : <span aria-hidden="true">♪</span>}
          {external && <span className="unified-album-import" aria-label="Available to import">☁</span>}
        </div>
        <strong>{album.title || album.name}</strong>
        <span>{album.year || "External release"}</span>
        {external && <small>Available to import</small>}
      </Link>;
    })}
  </>;
}

export default UnifiedAlbumGrid;
