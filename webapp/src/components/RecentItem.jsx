import { Link } from "react-router-dom";

function RecentItem({
  title,
  artist,
  artistId,
  cover,
  onPlay,
}) {
  return (
    <div className="recent-item">

      <div className="recent-cover">

        <img
          src={cover}
          alt={`${title} cover`}
        />

        <button
          className="recent-play"
          onClick={(event) => {
            event.stopPropagation();
            onPlay();
          }}
          aria-label={`Play ${title}`}
        >
          ▶
        </button>

      </div>

      <div className="recent-info">

        <div className="recent-title">
          {title}
        </div>

        {artistId ? (
          <Link
            to={`/artist/${artistId}`}
            className="recent-artist"
            onClick={(event) =>
              event.stopPropagation()
            }
          >
            {artist}
          </Link>
        ) : (
          <div className="recent-artist">
            {artist}
          </div>
        )}

      </div>

    </div>
  );
}

export default RecentItem;
