import { usePlayer } from "../context/PlayerContext";

function TrackLikeButton({ song }) {
  const { likedSongIds, toggleLikeSong } = usePlayer();

  if (!song?.id) return null;

  const isLiked = likedSongIds?.has(String(song.id));

  return (
    <button
      type="button"
      className={`track-like${isLiked ? " liked" : ""}`}
      aria-label={`${isLiked ? "Remove" : "Add"} ${song.title || "track"} ${isLiked ? "from" : "to"} liked songs`}
      aria-pressed={Boolean(isLiked)}
      title={isLiked ? "Remove from liked songs" : "Add to liked songs"}
      onClick={(event) => {
        event.stopPropagation();
        toggleLikeSong(song);
      }}
    >
      {isLiked ? "♥" : "♡"}
    </button>
  );
}

export default TrackLikeButton;
