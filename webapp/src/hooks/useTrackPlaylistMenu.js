import { useState } from "react";

import { searchNavidrome } from "../api/musicdeck";
import { addSongToPlaylist, getPlaylists } from "../api/playlists";

export default function useTrackPlaylistMenu(setActionMessage) {
  const [menuSongId, setMenuSongId] = useState(null);
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(false);

  const menuKey = (song, scope = "") => scope ? `${scope}:${song.id}` : song.id;

  async function toggleMenu(song, _event, scope = "") {
    const key = menuKey(song, scope);
    if (menuSongId === key) {
      setMenuSongId(null);
      return;
    }
    setMenuSongId(key);
    if (playlists.length || loading) return;
    setLoading(true);
    try {
      setPlaylists(await getPlaylists());
    } catch (error) {
      setActionMessage(error.message || "Could not load playlists.");
    } finally {
      setLoading(false);
    }
  }

  async function addToPlaylist(playlist, song) {
    try {
      let libraryTrack = song;
      if (song.external || song.sample) {
        const results = await searchNavidrome(song.title, { mode: "library" });
        libraryTrack = (results.results?.track || []).find((item) =>
          (item.title || item.name || "").toLowerCase() === song.title.toLowerCase() &&
          item.artist?.toLowerCase() === song.artist?.toLowerCase()
        );
      }
      if (!libraryTrack?.id) throw new Error("Download this track to your library before adding it to a playlist.");
      await addSongToPlaylist(playlist.id, libraryTrack.id);
      setMenuSongId(null);
      setActionMessage(`${song.title} added to ${playlist.name || playlist.title || "playlist"}.`);
    } catch (error) {
      setActionMessage(error.message || "Could not add this track to the playlist.");
    }
  }

  function renderMenu(song) {
    return <div className="playlist-menu">
      <div className="playlist-menu-title">Add to Playlist…</div>
      {loading ? <div className="playlist-menu-empty">Loading playlists…</div> : playlists.length ? playlists.map((playlist) =>
        <button type="button" role="menuitem" className="playlist-menu-item" key={playlist.id} onClick={() => addToPlaylist(playlist, song)}>{playlist.name || playlist.title || "Untitled playlist"}</button>
      ) : <div className="playlist-menu-empty">No playlists available</div>}
    </div>;
  }

  return { menuSongId, toggleMenu, renderMenu, isOpen: (song, scope) => menuSongId === menuKey(song, scope) };
}
