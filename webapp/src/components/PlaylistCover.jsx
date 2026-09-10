import {
  useState,
} from "react";

import {
  getCoverUrl,
} from "../api/musicdeck";


/*
 * PLAYLIST COVER
 *
 * Single resolution point for playlist cover art so the sidebar, Home cards,
 * playlist cards, the playlist page, search results, and the player all
 * render the same image. No component resolves playlist artwork on its own.
 *
 * A playlist resolves server-side to either its custom artwork or the
 * automatic 2x2 collage of its first four tracks. Both arrive as the same
 * opaque MusicDeck artwork reference, so this component never needs to know
 * which mode is active. `size` is a thumbnail hint in pixels, forwarded to
 * the artwork proxy so small UI surfaces do not fetch full-size art. The note
 * placeholder is used only when a playlist has no resolvable artwork at all,
 * or the artwork request fails.
 */

function PlaylistCover({
  playlist,
  size,
  placeholderClassName = "playlist-cover-icon",
}) {

  const [
    failed,
    setFailed,
  ] = useState(false);

  const coverArt =
    playlist?.coverArt || null;

  /*
   * A playlist whose artwork reference changes (custom art uploaded or
   * removed, or its first tracks reordered) must retry rather than stay
   * stuck on a previous failure.
   */

  const [
    lastCoverArt,
    setLastCoverArt,
  ] = useState(coverArt);

  if (lastCoverArt !== coverArt) {
    setLastCoverArt(coverArt);
    setFailed(false);
  }


  const url =
    failed
      ? null
      : getCoverUrl(
          coverArt,
          size
        );


  if (!url) {

    return (

      <div
        className={placeholderClassName}
        aria-hidden="true"
      >
        ♫
      </div>

    );

  }


  return (

    <img
      src={url}

      alt={
        `${playlist?.name ||
          playlist?.title ||
          "Playlist"} cover`
      }

      onError={() =>
        setFailed(true)
      }
    />

  );

}


export default PlaylistCover;
