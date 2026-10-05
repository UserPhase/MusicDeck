import { memo } from "react";
import AvailabilityHint from "./AvailabilityHint";
import AlbumDeleteButton from "./AlbumDeleteButton";
import { useServerDeletion } from "../context/ServerDeletionContext";

function AlbumCard({
  id,
  title,
  artist,
  cover,
  availability,
  onClick,
}) {
  const deletion = useServerDeletion();
  if (id && deletion?.deletedAlbums.has(String(id))) return null;

  return (
    <div className="album-card-shell">
    <div
      className="album"
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`Play ${title}`}
      onKeyDown={(event) => {

        if (event.target !== event.currentTarget) return;

        if (
          event.key === "Enter" ||
          event.key === " "
        ) {

          event.preventDefault();

          onClick();

        }

      }}
    >

      <div className="album-cover">

        {cover && (
          <img
            src={cover}
            alt={title}
          />
        )}

        <button
          className="play-overlay"
          aria-label={`Play ${title}`}

          onClick={(event) => {

            event.stopPropagation();

            onClick();

          }}
        >
          ▶
        </button>

      </div>


      <div className="album-title">
        {title}
      </div>


      <div className="album-artist">
        {artist}
        <AvailabilityHint availability={availability} />
      </div>

    </div>
    <AlbumDeleteButton album={{ id, title, availability }} />
    </div>

  );
}


export default memo(AlbumCard);
