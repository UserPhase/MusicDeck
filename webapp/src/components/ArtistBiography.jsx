import { useEffect, useState } from "react";

export default function ArtistBiography({ biography, loading, className = "", emptyText = "Biography not available." }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [biography?.text]);

  if (loading && !biography) return <p className="right-sidebar-metadata-state">Finding the artist story…</p>;
  if (!biography?.text) return <p className="right-sidebar-metadata-state">{emptyText}</p>;

  return (
    <div className={`artist-biography ${className}`}>
      <div className={`artist-biography-text${expanded ? " is-expanded" : ""}`}>{biography.text}</div>
      {biography.text.length > 280 && <button type="button" className="right-sidebar-read-more"
        onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        {expanded ? "Show less" : "Read more"}
      </button>}
      {biography.source === "wikipedia" && biography.url && (
        <a className="artist-biography-source" href={biography.url} target="_blank" rel="noopener noreferrer">
          Source: Wikipedia
        </a>
      )}
    </div>
  );
}
