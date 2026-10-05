import { usePlayer } from "../context/PlayerContext";

function TrackLikeButton({ song, variant = "icon", disabled = false, disabledHint = "" }) {
  const { likedSongIds, toggleLikeSong } = usePlayer();

  if (!song?.id) return null;

  const isLiked = likedSongIds?.has(String(song.id));

  if (variant === "menu") {
    return (
      <button
        type="button"
        role="menuitemcheckbox"
        className={`playlist-menu-item track-context-menu-item${isLiked ? " is-liked" : ""}`}
        aria-label={`${isLiked ? "Remove" : "Add"} ${song.title || "track"} ${isLiked ? "from" : "to"} liked songs`}
        aria-checked={Boolean(isLiked)}
        disabled={disabled}
        title={disabled ? disabledHint : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (!disabled) toggleLikeSong(song);
        }}
      >
        <span className="track-context-menu-icon" aria-hidden="true">{isLiked ? "♥" : "♡"}</span>
        <span className="track-context-menu-copy">
          <span>{isLiked ? "Remove from Liked Songs" : "Save to Liked Songs"}</span>
          <small>{isLiked ? "Currently liked" : "Like track"}</small>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`track-like${isLiked ? " liked" : ""}`}
      aria-label={`${isLiked ? "Remove" : "Add"} ${song.title || "track"} ${isLiked ? "from" : "to"} liked songs`}
      aria-pressed={Boolean(isLiked)}
      disabled={disabled}
      title={isLiked ? "Remove from liked songs" : "Add to liked songs"}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) toggleLikeSong(song);
      }}
    >
      {isLiked ? "♥" : "♡"}
    </button>
  );
}

export default TrackLikeButton;
