function TrackPlaybackIndicator({
  index,
  isCurrentTrack,
  isPlaying,
}) {
  if (!isCurrentTrack) {
    return (
      <span className="track-number-text">
        {index + 1}
      </span>
    );
  }

  return (
    <span
      className={
        `track-equalizer ${
          isPlaying
            ? "is-animating"
            : "is-paused"
        }`
      }
      aria-label={
        isPlaying
          ? "Now playing"
          : "Current track paused"
      }
      role="img"
    >
      <i aria-hidden="true" />
      <i aria-hidden="true" />
      <i aria-hidden="true" />
    </span>
  );
}

export default TrackPlaybackIndicator;
