import { ComponentProps, memo, ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, DragEvent, MouseEvent } from "react";
import TrackRow, { isTrackControl } from "./TrackRow";
import TrackActionScope, { useTrackActionScope } from "./TrackActionScope";
import { findScrollParent, indexAtOffset, useVirtualWindow } from "../hooks/useVirtualWindow";
import type { TrackSelection } from "../hooks/useTrackSelection";
import "../styles/virtual-library.css";
import "../styles/playlist-editing.css";

export type LibraryTrack = ComponentProps<typeof TrackRow>["song"];
type RowProps = ComponentProps<typeof TrackRow>;

export interface VirtualizedTrackListProps {
  itemCount: number;
  getItem(index: number): LibraryTrack | undefined;
  onPlay: RowProps["onPlay"];
  onToggleMenu?: RowProps["onToggleMenu"];
  onQueue?: RowProps["onQueue"];
  onDownload?: RowProps["onDownload"];
  showDateAdded?: boolean;
  searchTokens?: readonly string[];
  renderMenu?(song: LibraryTrack, index: number): ReactNode;
  getItemKey?(index: number): string;
  selection?: TrackSelection;
  onToggleEntryMenu?(song: LibraryTrack, index: number, event?: MouseEvent): void;
  /** Target is a boundary in the original visible order, from 0 through itemCount. */
  onReorder?(ids: readonly string[], targetIndex: number): void;
  editingDisabled?: boolean;
  /** Fetches pages intersecting the window, including the 2–3 row overscan. */
  onRangeChange?(start: number, end: number): void;
  estimateRowHeight?: number;
  /** Measure variable-height content and preserve the viewport's scroll anchor. */
  dynamicHeight?: boolean;
  /** Changing collection/filter identity invalidates cached measurements. */
  dataKey?: unknown;
  loadSelection?(indices: readonly number[], signal: AbortSignal): Promise<LibraryTrack[]>;
}

const MeasuredSlot = memo(function MeasuredSlot({
  index, height, dynamic, measure, children, style,
}: {
  index: number; height: number; dynamic: boolean;
  measure(index: number, height: number): void; children: ReactNode;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !dynamic) return;
    const update = () => measure(index, element.getBoundingClientRect().height);
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [dynamic, index, measure]);
  return <div ref={ref} role="presentation" data-slot={index}
    style={{ ...(dynamic ? {} : { height }), ...style }} className={dynamic ? "" : "virtual-track-fixed"}>
    {children}
  </div>;
});

/** Rows receive stable data/actions only. Player state is selected inside the
 * row; neither playback ticks nor favorites remap the virtual window. */
function VirtualizedTrackList({
  itemCount, getItem, onPlay, onToggleMenu, renderMenu, onRangeChange,
  estimateRowHeight = 64, dynamicHeight = false, dataKey, getItemKey,
  selection: suppliedSelection, onReorder, editingDisabled: editingDisabledProp = false, onToggleEntryMenu,
  onQueue, onDownload, showDateAdded, searchTokens,
}: VirtualizedTrackListProps) {
  const scope = useTrackActionScope();
  const editingDisabled = editingDisabledProp || Boolean(scope?.disabled);
  const selection = suppliedSelection || scope?.selection;
  const ref = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const windowed = useVirtualWindow(ref, itemCount, estimateRowHeight, dynamicHeight, dataKey);
  const [drag, setDrag] = useState<{ ids: string[]; source: number; label: string } | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const pointer = useRef<number | null>(null);
  const dragImage = useRef<HTMLDivElement | null>(null);
  const keyAt = (index: number) => getItemKey?.(index) ?? `${index}:${getItem(index)?.id ?? "pending"}`;
  const stopDrag = () => { pointer.current = null; setDrag(null); setDropIndex(null); };
  const boundaryAt = (clientY: number) => {
    const y = clientY - (ref.current?.getBoundingClientRect().top ?? 0);
    if (y <= 0) return 0;
    if (y >= windowed.totalSize) return itemCount;
    const index = indexAtOffset(windowed.offsets, y);
    return index + (y >= (windowed.offsets[index] + windowed.offsets[index + 1]) / 2 ? 1 : 0);
  };
  const boundaryRef = useRef(boundaryAt);
  boundaryRef.current = boundaryAt;
  useEffect(() => {
    stopDrag();
  }, [dataKey, editingDisabled]);
  useEffect(() => {
    if (!drag || !ref.current) return undefined;
    const parent = findScrollParent(ref.current);
    let frame = 0;
    const scroll = () => {
      if (pointer.current !== null) {
        const rect = parent instanceof HTMLElement ? parent.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
        const y = pointer.current;
        const delta = y < rect.top + 56 ? -Math.min(24, (rect.top + 56 - y) / 2)
          : y > rect.bottom - 56 ? Math.min(24, (y - rect.bottom + 56) / 2) : 0;
        if (delta) {
          if (parent instanceof HTMLElement) parent.scrollTop += delta;
          else window.scrollBy(0, delta);
          parent.dispatchEvent(new Event("scroll"));
        }
        setDropIndex(boundaryRef.current(y));
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    const end = () => stopDrag();
    document.addEventListener("dragend", end);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("dragend", end); };
  }, [drag]);
  function beginDrag(event: DragEvent) {
    if (!onReorder || editingDisabled || event.defaultPrevented || !(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>('.track[draggable="true"]');
    if (!row || !ref.current?.contains(row) || isTrackControl(event.target)) {
      event.preventDefault();
      return;
    }
    const slot = row.closest<HTMLElement>("[data-slot]");
    const source = Number(slot?.dataset.slot);
    if (!Number.isInteger(source) || source < 0 || source >= itemCount) return;
    const key = keyAt(source);
    const chosen = selection?.selectedIds.has(key) ? selection.selectedIds : new Set([key]);
    if (!selection?.selectedIds.has(key)) selection?.select(source);
    const ids: string[] = [];
    for (let index = 0; index < itemCount; index++) if (chosen.has(keyAt(index))) ids.push(keyAt(index));
    const label = `${ids.length} ${ids.length === 1 ? "track" : "tracks"}`;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", label);
    if (dragImage.current) {
      dragImage.current.textContent = `Moving ${label}`;
      event.dataTransfer.setDragImage?.(dragImage.current, 16, 16);
    }
    setDrag({ ids, source, label });
    setAnnouncement(`Moving ${label}. Drop between tracks. Escape cancels.`);
  }
  useLayoutEffect(() => {
    onRangeChange?.(windowed.start, windowed.end);
  }, [onRangeChange, windowed.start, windowed.end]);
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    const row = ref.current?.querySelector<HTMLElement>(`[data-slot="${pendingFocus.current}"] .track:not([aria-busy])`);
    if (row) {
      row.focus();
      pendingFocus.current = null;
    }
  });
  const slots: ReactNode[] = [];
  const indices = Array.from({ length: windowed.end - windowed.start }, (_value, index) => windowed.start + index);
  // Keep the native drag source mounted when its virtual slot scrolls off-screen.
  if (drag && !indices.includes(drag.source)) indices.push(drag.source);
  for (const index of indices) {
    const song = getItem(index);
    const pinned = index < windowed.start || index >= windowed.end;
    slots.push(<MeasuredSlot key={keyAt(index)} index={index}
      height={estimateRowHeight} dynamic={dynamicHeight} measure={windowed.measure}
      style={pinned ? { position: "absolute", top: windowed.offsets[index], left: 0, right: 0 } : undefined}>
      {song ? <TrackRow song={song} index={index} onPlay={onPlay}
        showDateAdded={showDateAdded}
        searchTokens={searchTokens}
        onQueue={onQueue} onDownload={onDownload}
        onToggleMenu={onToggleEntryMenu ? (track, event) => onToggleEntryMenu(track, index, event) : onToggleMenu}
        selected={selection ? selection.selectedIds.has(scope?.keyAt(index) ?? keyAt(index)) : undefined} onSelect={scope?.select || selection?.select}
        reorderable={Boolean(onReorder)} editingDisabled={editingDisabled}
        menu={renderMenu?.(song, index)} />
        : <div className="track virtual-track-skeleton" role="row" aria-rowindex={index + 2}
          aria-label={`Loading track ${index + 1}`} aria-busy="true"><span /><span /><span /></div>}
    </MeasuredSlot>);
  }
  return <div ref={ref} role="rowgroup" className="virtual-track-window"
    onDragStart={beginDrag}
    onDragEnd={stopDrag}
    onDragOver={(event) => {
      if (!drag || editingDisabled) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      pointer.current = event.clientY;
      setDropIndex(boundaryAt(event.clientY));
    }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) pointer.current = null;
    }}
    onDrop={(event) => {
      if (!drag || editingDisabled) return;
      event.preventDefault();
      const target = boundaryAt(event.clientY);
      onReorder?.(drag.ids, target);
      setAnnouncement(`Moved ${drag.label}.`);
      stopDrag();
    }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !isTrackControl(event.target)) { stopDrag(); if (!editingDisabled) { scope?.exit(); selection?.clear(); } return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && selection && !editingDisabled) {
        if (isTrackControl(event.target)) return;
        event.preventDefault(); event.stopPropagation(); if (scope) scope.selectAll(); else selection.selectAll(); return;
      }
      if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key) && onReorder && !editingDisabled) {
        const slot = (event.target as HTMLElement).closest<HTMLElement>("[data-slot]");
        if (!slot) return;
        const index = Number(slot.dataset.slot);
        const ids = selection?.selectedIds.has(keyAt(index)) ? selection.selectedIds : new Set([keyAt(index)]);
        const positions: number[] = [];
        for (let offset = 0; offset < itemCount; offset++) if (ids.has(keyAt(offset))) positions.push(offset);
        const target = event.key === "ArrowUp" ? Math.max(0, positions[0] - 1) : Math.min(itemCount, positions[positions.length - 1] + 2);
        event.preventDefault();
        onReorder([...ids], target);
        setAnnouncement(`Moved ${ids.size} selected tracks ${event.key === "ArrowUp" ? "up" : "down"}.`);
        return;
      }
      if (event.target !== (event.target as HTMLElement).closest(".track")) return;
      const slot = (event.target as HTMLElement).closest<HTMLElement>("[data-slot]");
      const index = Number(slot?.dataset.slot);
      const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1
        : event.key === "Home" ? 0 : event.key === "End" ? itemCount - 1 : -1;
      if (next < 0 || next >= itemCount) return;
      event.preventDefault();
      pendingFocus.current = next;
      windowed.scrollToIndex(next);
      const row = ref.current?.querySelector<HTMLElement>(`[data-slot="${next}"] .track:not([aria-busy])`);
      if (row) { row.focus(); pendingFocus.current = null; }
    }}>
    <div aria-hidden="true" style={{ height: windowed.offsets[windowed.start] }} />
    {slots}
    <div aria-hidden="true" style={{ height: windowed.totalSize - windowed.offsets[windowed.end] }} />
    {dropIndex !== null && drag && <div className="track-drop-marker" aria-hidden="true" style={{ top: windowed.offsets[dropIndex] }} />}
    {(suppliedSelection || onReorder) && <span className="track-edit-announcement" role="status" aria-live="polite">{announcement}</span>}
    {onReorder && createPortal(<div ref={dragImage} className="track-drag-image" aria-hidden="true">Moving tracks</div>, document.body)}
    {drag && createPortal(<div className="track-drag-feedback" aria-hidden="true">Moving {drag.label}</div>, document.body)}
  </div>;
}

export default memo(function SelectableVirtualizedTrackList(props: VirtualizedTrackListProps) {
  return <TrackActionScope itemCount={props.itemCount} getItem={props.getItem} getItemKey={props.getItemKey}
    selection={props.selection} dataKey={props.dataKey} loadSelection={props.loadSelection} disabled={props.editingDisabled}>
    <VirtualizedTrackList {...props} />
  </TrackActionScope>;
});
