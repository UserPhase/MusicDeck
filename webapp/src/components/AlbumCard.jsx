import AvailabilityHint from "./AvailabilityHint";

function AlbumCard({
  title,
  artist,
  cover,
  availability,
  onClick,
}) {

  return (

    <div
      className="album"
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`Play ${title}`}
      onKeyDown={(event) => {

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

  );
}


export default AlbumCard;
