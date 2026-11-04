import { Link } from "react-router-dom";
import { useLikedAlbums } from "../hooks/useLikedAlbums";
import { DiscoveryArtwork } from "./DiscoveryCards";

export default function LikedAlbumsSection() {
  const { albums, enabled, loading, error, refresh } = useLikedAlbums();
  if (!enabled || (!loading && !error && !albums.length)) return null;
  return <section className="library-section" aria-labelledby="liked-albums-heading">
    <div className="library-section-header"><h2 id="liked-albums-heading">Liked Albums</h2></div>
    {loading && <p role="status">Loading liked albums…</p>}
    {error && <p role="alert">Could not load liked albums. <button type="button" onClick={() => { void refresh(); }}>Retry</button></p>}
    <div className="playlist-grid">{albums.map((album) => <Link key={album.id}
      to={`/album/${encodeURIComponent(album.id)}`} className="playlist-card">
      <div className="playlist-cover"><DiscoveryArtwork item={album} /></div>
      <div className="playlist-title">{album.name}</div>
      <div className="playlist-meta">Album{album.artist ? ` · ${album.artist}` : ""}</div>
    </Link>)}</div>
  </section>;
}
