function TrackListHeader({ showAlbum = true }) {
  return (
    <div className="track-list-header">
      <span aria-label="Track number">#</span>
      <span>Title</span>
      <span>{showAlbum ? "Album" : ""}</span>
      <div aria-hidden="true" />
      <span className="track-list-header-duration" aria-label="Duration" title="Duration">⏱</span>
      <div aria-hidden="true" />
    </div>
  );
}

export default TrackListHeader;
