import {
  getPlaylists as fetchPlaylists,
  getPlaylist as fetchPlaylist,
  createPlaylist as requestCreatePlaylist,
  addSongToPlaylist as requestAddSongToPlaylist,
  removeSongFromPlaylist as requestRemoveSongFromPlaylist,
  deletePlaylist as requestDeletePlaylist,
  setPlaylistArtwork as requestSetPlaylistArtwork,
  clearPlaylistArtwork as requestClearPlaylistArtwork,
} from "./musicdeck";


/*
 * Single source of truth for playlist read/write operations.
 *
 * Pages and components should use this module instead of
 * calling the raw Navidrome playlist endpoints directly.
 */


export async function getPlaylists() {
  return fetchPlaylists();
}


export async function getPlaylist(playlistId) {
  return fetchPlaylist(playlistId);
}


export async function createPlaylist(name) {
  return requestCreatePlaylist(name);
}


export async function deletePlaylist(playlistId) {
  return requestDeletePlaylist(playlistId);
}


/*
 * Add a song to a playlist.
 *
 * Navidrome's updatePlaylist only ever ADDS the song IDs it is
 * given — it never replaces the playlist's existing song list.
 * Resubmitting the current entries as songIdToAdd would
 * duplicate every existing song, so only the new song ID is
 * ever sent. IDs are compared as strings since Navidrome and
 * the UI do not always agree on string vs number ID types.
 */
export async function addSongToPlaylist(playlistId, songId) {
  return requestAddSongToPlaylist(
    playlistId,
    songId
  );

}


/*
 * Remove the song at the given queue index from a playlist.
 */
export async function removeSongFromPlaylist(
  playlistId,
  songIndex
) {
  return requestRemoveSongFromPlaylist(
    playlistId,
    songIndex
  );
}


/*
 * Playlist cover art.
 *
 * A playlist always resolves to one of exactly two modes: the automatic 2x2
 * collage of its first four tracks, or custom artwork that overrides it.
 * Setting artwork switches to custom mode; clearing it restores the collage.
 */
export async function setPlaylistArtwork(playlistId, image) {
  return requestSetPlaylistArtwork(playlistId, image);
}


export async function clearPlaylistArtwork(playlistId) {
  return requestClearPlaylistArtwork(playlistId);
}

