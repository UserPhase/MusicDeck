import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../context/AuthContext";
import { useTrackSelection, type SelectionModifiers, type TrackSelection } from "../hooks/useTrackSelection";
import type { Track } from "./TrackRow";
import UniversalTrackContextMenu from "./UniversalTrackContextMenu";
import "../styles/track-actions.css";

interface Scope {
  identity: unknown;
  disabled: boolean;
  selection: TrackSelection; selectionMode: boolean; legacySelection: boolean;
  keyAt(index: number): string; select(index: number, modifiers?: SelectionModifiers): void;
  enter(index?: number): void; exit(): void; selectedPreview: Track[];
  selectAll(): void;
  reportActionError(message: string): void;
  resolveSelected(): Promise<Track[]>;
}
const Context = createContext<Scope | null>(null);
export const useTrackActionScope = () => useContext(Context);
export interface TrackActionScopeProps {
  tracks?: readonly Track[]; itemCount?: number; getItem?(index: number): Track | undefined;
  getItemKey?(index: number): string; selection?: TrackSelection; dataKey?: unknown;
  loadSelection?(indices: readonly number[], signal: AbortSignal): Promise<Track[]>;
  disabled?: boolean; children: ReactNode;
}
/** Collection-owned occurrence selection survives row virtualization, but never a collection/account change. */
export default function TrackActionScope(props: TrackActionScopeProps) {
  const owner = useAuth()?.session?.id ?? "anonymous";
  return <CollectionScope key={owner} {...props} />;
}
function CollectionScope({ tracks, itemCount = tracks?.length || 0, getItem, getItemKey, selection: supplied,
  dataKey, loadSelection, disabled = false, children }: TrackActionScopeProps) {
  const instance = useId();
  const ids = useMemo(() => {
    const occurrences = new Map<string, number>();
    return Array.from({ length: itemCount }, (_, index) => {
      if (getItemKey) return getItemKey(index);
      if (!tracks) return String(index);
      const id = String(tracks[index]?.id), occurrence = occurrences.get(id) || 0;
      occurrences.set(id, occurrence + 1);
      return `${id}:${occurrence}`;
    });
  }, [itemCount, getItemKey, tracks]);
  const own = useTrackSelection(ids, dataKey);
  const selection = supplied || own;
  const [mode, setMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [actionError, setActionError] = useState("");
  const alive = useRef(false);
  const locked = disabled || resolving;
  const trigger = useRef<HTMLButtonElement>(null);
  const lastIndex = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const live = useRef({ selection, tracks, getItem, ids, disabled, dataKey, loadSelection });
  live.current = { selection, tracks, getItem, ids, disabled: locked, dataKey, loadSelection };
  const get = (index: number) => getItem ? getItem(index) : tracks?.[index];
  const exit = useCallback(() => { if (!live.current.disabled) { live.current.selection.clear(); setMode(false); setMenuOpen(false); } }, []);
  useEffect(() => {
    alive.current = true;
    setMode(false); setMenuOpen(false); setResolving(false); setActionError(""); controller.current?.abort();
    return () => { alive.current = false; controller.current?.abort(); };
  }, [dataKey]);
  const reportActionError = useCallback((message: string) => { if (alive.current) setActionError(message); }, []);
  useEffect(() => {
    const changed = (event: Event) => { if ((event as CustomEvent).detail !== instance) exit(); };
    window.addEventListener("musicdeck:track-selection", changed);
    return () => window.removeEventListener("musicdeck:track-selection", changed);
  }, [exit, instance]);
  const announce = useCallback(() => window.dispatchEvent(new CustomEvent("musicdeck:track-selection", { detail: instance })), [instance]);
  const select = useCallback((index: number, modifiers: SelectionModifiers = {}) => {
    if (live.current.disabled) return;
    announce(); lastIndex.current = index;
    live.current.selection.select(index, modifiers);
  }, [announce]);
  const enter = useCallback((index?: number) => {
    if (live.current.disabled) return;
    announce(); setMode(true);
    if (index !== undefined) {
      lastIndex.current = index;
      if (!live.current.selection.selectedIds.has(live.current.ids[index])) live.current.selection.select(index, { ctrlKey: true });
    }
  }, [announce]);
  const selectAll = useCallback(() => { if (!live.current.disabled) { announce(); live.current.selection.selectAll(); } }, [announce]);
  async function resolveSelected(): Promise<Track[]> {
    if (controller.current) throw new Error("Selected tracks are already being loaded.");
    const current = live.current;
    const indices = current.ids.flatMap((key, index) => current.selection.selectedIds.has(key) ? [index] : []);
    if (!indices.length) throw new Error("Select at least one track.");
    const operation = new AbortController(); controller.current = operation; setResolving(true);
    try {
      const cached = indices.map((index) => current.getItem ? current.getItem(index) : current.tracks?.[index]);
      const result = cached.every((item): item is Track => Boolean(item)) ? cached
        : current.loadSelection ? await current.loadSelection(indices, operation.signal) : null;
      if (operation.signal.aborted || live.current.dataKey !== current.dataKey) throw new Error("The collection changed. Select the tracks again.");
      if (!result || result.length !== indices.length) throw new Error("Some selected tracks could not be loaded. Reload the collection before trying again.");
      return result;
    } finally { if (controller.current === operation) { controller.current = null; if (!operation.signal.aborted) setResolving(false); } }
  }
  const firstIndex = !selection.selectedCount ? -1 : selection.selectedIds.has(ids[lastIndex.current]) ? lastIndex.current : ids.findIndex((id) => selection.selectedIds.has(id));
  const preview = firstIndex >= 0 ? get(firstIndex) : undefined;
  const scope: Scope = { identity: dataKey, disabled: locked, selection, selectionMode: mode, legacySelection: Boolean(supplied), keyAt: (index) => ids[index], select, selectAll, enter, exit, reportActionError,
    selectedPreview: preview ? [preview] : [], resolveSelected };
  // Selection controls live in the fixed toolbar, never in the list's flow: an
  // in-flow bar inserted when a long-press enters selection mode would shift the
  // held row out from under the finger, and the release could land on "Done".
  const showToolbar = mode || (selection.selectedCount > 0 && !supplied);
  return <Context.Provider value={scope}><div className="track-action-scope" onKeyDown={(event) => {
    if (event.defaultPrevented || locked || !(event.target instanceof Element) || event.target !== event.target.closest(".track")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); event.stopPropagation(); selectAll(); }
    if (event.key === "Escape") { event.stopPropagation(); exit(); }
  }}>
    {actionError && <p className="track-action-scope-error" role="alert">{actionError}
      <button type="button" onClick={() => setActionError("")}>Dismiss</button></p>}
    {children}
    {showToolbar && createPortal(<aside className="universal-track-toolbar"
      aria-label={selection.selectedCount > 0 ? "Selected track actions" : "Track selection"} data-track-selection-menu="">
      {selection.selectedCount > 0 ? <>
        <strong aria-live="polite">{selection.selectedCount.toLocaleString()} selected</strong>
        <button type="button" disabled={disabled || resolving} onClick={selectAll}>Select all</button>
        <button type="button" disabled={disabled || resolving} onClick={exit}>Clear selection</button>
        <button type="button" ref={trigger} disabled={disabled || resolving} aria-haspopup="menu" aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}>{resolving ? "Loading selected tracks…" : "Actions for selected tracks"}</button>
        {menuOpen && <UniversalTrackContextMenu song={preview || { id: "selection", title: "selected tracks" }}
          targets={scope.selectedPreview} targetCount={selection.selectedCount} resolveTargets={resolveSelected}
          triggerRef={trigger} actionsDisabled={disabled} onActionError={reportActionError} onRequestClose={() => setMenuOpen(false)} />}
      </> : <>
        <span className="track-selection-hint">Tap tracks to select. Artist and album links still open normally.</span>
        <button type="button" disabled={locked} onClick={exit}>Done selecting</button>
      </>}
    </aside>, document.body)}
  </div></Context.Provider>;
}
