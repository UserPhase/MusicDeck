import { useEffect, useRef, useState } from "react";

function TrackListHeader({ showAlbum = true, sort = undefined, showDateAdded = Boolean(sort) }) {
  const sentinelRef = useRef(null);
  const [isStuck, setIsStuck] = useState(() => typeof IntersectionObserver !== "function");

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver !== "function") return undefined;
    let root = sentinel.parentElement;
    while (root && !/(auto|scroll|overlay)/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
    // Observe the header's original position, not the sticky element itself.
    // Only crossing the scroll edge causes a render; scrolling rows does not.
    const observer = new IntersectionObserver(([entry]) => {
      setIsStuck(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0));
    }, { root });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const column = (field, label, content = label, className) => {
    const direction = field !== "custom" && sort?.field === field ? (sort.descending ? "descending" : "ascending") : undefined;
    return <span className={className} role="columnheader" aria-label={label} aria-sort={direction}>
      {sort ? <button type="button" className="track-header-sort" aria-label={label} onClick={() => sort.onChange(field)}>
        {content}{direction && <span aria-hidden="true">{direction === "ascending" ? "↑" : "↓"}</span>}
      </button> : content}
    </span>;
  };
  return (
    <>
      <div ref={sentinelRef} className="track-list-header-sentinel" aria-hidden="true" />
      <div className={`track-list-header${isStuck ? " is-stuck" : ""}`} role="row">
        {column("custom", "Track number", "#")}
        {column("title", "Title")}
        {showAlbum ? column("album", "Album") : <span role="columnheader" />}
        {showDateAdded ? column("added", "Date added", "Date added", "track-date-added") : <div aria-hidden="true" />}
        {column("duration", "Duration", "⏱", "track-list-header-duration")}
        <div aria-hidden="true" />
      </div>
    </>
  );
}

export default TrackListHeader;
