import { useRef, useState } from "react";
import FloatingPanel from "./ui/FloatingPanel";
import PlaylistSearchBox from "./playlists/PlaylistSearchBox";
import "../styles/playlist-organization.css";
import "../styles/collector.css";

export default function LibraryBrowseControls({ label, query, onQueryChange, filter, onFilterChange, choices, sort, onSortChange, sortChoices }) {
  const trigger = useRef(null);
  const [open, setOpen] = useState(false);
  const menuLabel = `${choices ? "Filter" : "Sort"} ${label}`;
  return <div className="collector-panel">
    <div className="collector-panel-heading">
      <PlaylistSearchBox label={`Search ${label}`} closeLabel={`Close ${label} search`} value={query} onChange={onQueryChange} />
      <button type="button" ref={trigger} className="folder-sort-trigger" aria-label={menuLabel}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {choices ? (filter === "all" ? "Filters" : choices[filter]) : "Sort"}
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h12M8 12h8M8 18h4M4 5v2m0 4v2m0 4v2" /></svg>
      </button>
      {open && <FloatingPanel anchorRef={trigger} className="folder-sort-menu" aria-label={menuLabel} onClose={() => setOpen(false)}>
        {choices && <>
          <span className="folder-sort-caption" aria-hidden="true">Show</span>
          {Object.entries(choices).map(([value, title]) => <button key={value} type="button" role="menuitemradio"
            aria-checked={filter === value} onClick={() => { onFilterChange(value); setOpen(false); trigger.current?.focus(); }}>
            {title}{filter === value && <span aria-hidden="true">✓</span>}
          </button>)}
        </>}
        {sortChoices && <>
          {choices && <div className="folder-item-menu-divider" role="separator" />}
          <div role="group" aria-label="Sort by">
            <span className="folder-sort-caption" aria-hidden="true">Sort by</span>
            {Object.entries(sortChoices).map(([value, title]) => <button key={value} type="button" role="menuitemradio"
              aria-checked={sort === value} onClick={() => { onSortChange(value); setOpen(false); trigger.current?.focus(); }}>
              {title}{sort === value && <span aria-hidden="true">✓</span>}
            </button>)}
          </div>
        </>}
      </FloatingPanel>}
    </div>
  </div>;
}
