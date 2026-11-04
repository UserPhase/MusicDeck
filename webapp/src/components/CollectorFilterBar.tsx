import { useRef } from "react";
import { collectorFormats, collectorSources, emptyCollectorFilters, type CollectorFilters } from "../hooks/useCollectorFilters";
import PlaylistSearchBox from "./playlists/PlaylistSearchBox";
import FloatingPanel from "./ui/FloatingPanel";
import "../styles/playlist-organization.css";
import "../styles/collector.css";

type Props = {
  open: boolean;
  onOpenChange(open: boolean): void;
  query: string;
  onQueryChange(query: string): void;
  filters: CollectorFilters;
  onChange(filters: CollectorFilters): void;
  genres: [string, string][];
  busy: boolean;
  error?: string;
  degraded?: boolean;
  onRetry(): void;
  sort?: { label: string; value: string; choices: Record<string, string>; onChange(value: string): void };
};
export default function CollectorFilterBar({ open, onOpenChange, query, onQueryChange, filters, onChange, genres, busy, error, degraded, onRetry, sort }: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panelLabel = sort?.label ?? "Collector filters";
  const change = (key: keyof CollectorFilters, value: string) => onChange({ ...filters, [key]: value });
  const labels = { from: "From", to: "Through", genre: "Genre", format: "Format", source: "Server" };
  const active = (Object.keys(filters) as (keyof CollectorFilters)[]).filter(key => filters[key]);
  return <div className="collector-panel">
    <div className="collector-panel-heading">
      <PlaylistSearchBox label="Search this library" closeLabel="Close library search" value={query} onChange={onQueryChange} />
      <button type="button" className="folder-sort-trigger" ref={trigger} aria-label={panelLabel} aria-haspopup={sort ? "menu" : undefined} aria-expanded={open} onClick={() => onOpenChange(!open)}>
        {sort ? "Sort" : "Filters"}{active.length > 0 && ` (${active.length})`}
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h12M8 12h8M8 18h4M4 5v2m0 4v2m0 4v2" /></svg>
      </button>
    </div>
    {active.length > 0 && <div className="collector-pills">
      {active.map(key => <button type="button" key={key} onClick={() => change(key, "")}
        aria-label={`Remove ${labels[key]} filter`}>{labels[key]} · {key === "genre" ? genres.find(([id]) => id === filters.genre)?.[1] ?? filters.genre : filters[key]} ×</button>)}
      <button type="button" onClick={() => onChange(emptyCollectorFilters)}>Clear all</button>
    </div>}
    {open && <FloatingPanel anchorRef={trigger} className={sort ? "folder-sort-menu" : "collector-filter-popover"} role={sort ? "menu" : "region"} aria-label={panelLabel}
      onClose={() => onOpenChange(false)}>
      {sort ? <>
        <span className="folder-sort-caption" aria-hidden="true">Sort by</span>
        {Object.entries(sort.choices).map(([value, title]) => <button key={value} type="button" role="menuitemradio"
          aria-checked={sort.value === value}
          onClick={() => { sort.onChange(value); onOpenChange(false); trigger.current?.focus(); }}>
          {title}{sort.value === value && <span aria-hidden="true">✓</span>}
        </button>)}
      </> :
      <fieldset className="collector-fields" disabled={busy || Boolean(error)}>
      <legend className="collector-legend">Catalog metadata</legend>
      {([
        ["genre", genres],
        ["format", collectorFormats.map(value => [value, value])],
        ["source", collectorSources.map(value => [value, value])],
      ] as const).map(([key, choices]) => <label key={key}>{labels[key]}
        <select value={filters[key]} onChange={event => change(key, event.target.value)}>
          <option value="">Any</option>
          {choices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>)}
      {(["from", "to"] as const).map(key => <label key={key}>{labels[key]} year
        <select value={filters[key]} onChange={event => change(key, event.target.value)}>
          <option value="">Any</option>
          {Array.from({ length: 77 }, (_, index) => 2026 - index).map(year => <option key={year}
            disabled={key === "from" ? Boolean(filters.to && year > Number(filters.to)) : Boolean(filters.from && year < Number(filters.from))}
            value={year}>{year}</option>)}
        </select>
      </label>)}
      </fieldset>}
    </FloatingPanel>}
    {busy && <p role="status">Loading collector catalog…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={onRetry}>Retry</button></p>}
    {degraded && <p role="status">Some music servers are unavailable. {sort ? "Sorting covers" : "Filters cover"} the available catalog.</p>}
  </div>;
}
