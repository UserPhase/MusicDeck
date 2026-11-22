import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { normalizePlaylistSearch } from "../utils/playlistSearch";
import { useVisualViewportBounds } from "../hooks/useVisualViewportBounds";

type Playlist = { id: string; name: string; permissions?: { canEditTracks?: boolean } };

interface Props {
  label: string;
  title: string;
  subtitle?: string;
  triggerRef?: RefObject<HTMLElement | null>;
  onClose(): void;
  choosing: boolean;
  onChoose(open: boolean): void;
  destinations: Playlist[];
  loading: boolean;
  error: string;
  disabled: boolean;
  onRetry(): void;
  onAdd(id: string): void;
  messages: ReactNode;
  children: ReactNode;
}

export default function MobileTrackActionSheet({
  label, title, subtitle, triggerRef, onClose, choosing, onChoose,
  destinations, loading, error, disabled, onRetry, onAdd, messages, children,
}: Props) {
  const sheet = useRef<HTMLDialogElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const wasChoosing = useRef(false);
  const [filter, setFilter] = useState("");
  useVisualViewportBounds(sheet);

  useLayoutEffect(() => {
    const dialog = sheet.current;
    if (!dialog) return;
    const trigger = triggerRef?.current;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [triggerRef]);

  useLayoutEffect(() => {
    if (choosing) back.current?.focus({ preventScroll: true });
    else if (wasChoosing.current) sheet.current?.querySelector<HTMLButtonElement>("[data-open-playlist-picker]")?.focus({ preventScroll: true });
    wasChoosing.current = choosing;
  }, [choosing]);

  function returnToActions() {
    setFilter("");
    onChoose(false);
  }
  const editable = destinations.filter((playlist) => playlist.permissions?.canEditTracks !== false);
  const query = normalizePlaylistSearch(filter.trim());
  const matches = editable.filter((playlist) => normalizePlaylistSearch(playlist.name || "Untitled playlist").includes(query));

  return createPortal(<dialog ref={sheet} className="track-action-sheet" data-track-selection-menu=""
    aria-label={choosing ? "Add to playlist" : label}
    onCancel={(event) => { event.preventDefault(); if (choosing) returnToActions(); else onClose(); }}
    onKeyDown={(event) => event.stopPropagation()}
    onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <div className="track-action-sheet-surface">
      <header className="track-action-sheet-header">
        {choosing && <button ref={back} type="button" aria-label="Back to track actions" onClick={returnToActions}>‹</button>}
        <div>
          <h2>{choosing ? "Add to playlist" : title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button type="button" aria-label="Close track actions" onClick={onClose}>×</button>
      </header>
      {choosing ? <>
        <div className="track-sheet-filter">
          <input ref={input} type="search" aria-label="Search playlists" placeholder="Search playlists"
            value={filter} onChange={(event) => setFilter(event.target.value)} />
          {filter && <button type="button" aria-label="Clear playlist search" onClick={() => { setFilter(""); input.current?.focus(); }}>×</button>}
        </div>
        <div className="track-action-sheet-list" aria-busy={loading || disabled || undefined}>
          {loading ? <p role="status">Loading playlists…</p> : matches.map((playlist) => (
            <button key={playlist.id} className="track-sheet-action" type="button" disabled={disabled}
              onClick={() => onAdd(String(playlist.id))}>{playlist.name || "Untitled playlist"}</button>
          ))}
          {!loading && !matches.length && !error && <p>{editable.length ? "No playlists match your search." : "No editable playlists yet."}</p>}
          {error && !editable.length && <button type="button" className="track-sheet-action" onClick={onRetry}>Retry playlists</button>}
          {messages}
        </div>
      </> : <div className="track-action-sheet-list">
        {children}
        {messages}
      </div>}
    </div>
  </dialog>, document.body);
}
