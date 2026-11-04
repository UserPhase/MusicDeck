import { useState } from "react";
import { useLikedAlbums } from "../hooks/useLikedAlbums";
import { toAlbumRouteIdFromApiId } from "../utils/idResolver";

export default function AlbumLikeButton({ album }) {
  const saved = useLikedAlbums();
  const [notice, setNotice] = useState("");
  const liked = saved.albums.some((item) => item.id === toAlbumRouteIdFromApiId(album.id));
  return <>
    <button type="button" className={`detail-secondary-action album-action${liked ? " is-liked" : ""}`}
      aria-label={liked ? "Unlike album" : "Like album"} aria-pressed={liked}
      title={liked ? "Remove from Playlists" : "Save album to Playlists"}
      disabled={!saved.enabled || saved.loading || saved.saving || Boolean(saved.error)}
      onClick={async () => {
        setNotice("");
        try {
          await saved.setLiked({ album, liked: !liked });
          setNotice(liked ? "Album removed from Playlists." : "Album saved to Playlists.");
        } catch { /* The mutation exposes the error below, without claiming a save. */ }
      }}>{liked ? "♥" : "♡"}</button>
    {(saved.saveError || saved.error) ? <p className="album-import-status error" role="alert">
      {saved.saveError?.message || saved.error?.message || "Could not save album. Please try again."}
      {saved.error && <button type="button" onClick={() => { void saved.refresh(); }}>Retry</button>}
    </p> : notice && <p className="album-import-status" role="status">{notice}</p>}
  </>;
}
