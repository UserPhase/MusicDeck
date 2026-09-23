function TrackListHeader({ showAlbum = true }) {
  return (
    <div className="track-list-header" role="row">
      <span role="columnheader" aria-label="Track number">#</span>
      <span role="columnheader">Title</span>
      <span role="columnheader">{showAlbum ? "Album" : ""}</span>
      <div aria-hidden="true" />
      <span className="track-list-header-duration" role="columnheader" aria-label="Duration" title="Duration">⏱</span>
      <div aria-hidden="true" />
    </div>
  );
}

export default TrackListHeader;
