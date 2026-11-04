import { Link } from "react-router-dom";
import type { SmartPlaylist } from "../api/smartPlaylists";

export default function SmartPlaylistShelf({ items, loading, error, refresh }: {
  items: SmartPlaylist[]; loading: boolean; error: unknown; refresh(): Promise<unknown>;
}) {
  if (loading) return <p className="home-section-state" role="status">Loading smart playlists…</p>;
  if (error) return <p className="home-section-state" role="status">Could not load smart playlists. <button onClick={() => { void refresh(); }}>Retry</button></p>;
  if (!items.length) return null;
  return <section className="library-section" aria-label="Smart playlists">
    <div className="playlist-grid">{items.map((item) => <Link key={item.id} to={`/smart-playlist/${encodeURIComponent(item.id)}`} className="playlist-card">
      <div className="playlist-cover smart-playlist-cover" aria-hidden="true">✦</div>
      <div className="playlist-title">{item.name}</div>
      <div className="playlist-meta">Smart playlist · Updates automatically</div>
    </Link>)}</div>
  </section>;
}
