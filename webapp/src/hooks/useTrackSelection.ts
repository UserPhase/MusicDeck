import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface SelectionModifiers {
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

export interface TrackSelection {
  readonly selectedIds: ReadonlySet<string>;
  readonly selectedCount: number;
  readonly allSelected: boolean;
  select(index: number, modifiers?: SelectionModifiers): void;
  selectAll(): void;
  clear(): void;
}

/** IDs represent list occurrences, not songs: duplicates are independently editable. */
export function selectTrackRange(
  ids: readonly string[], previous: ReadonlySet<string>, anchor: string | null,
  index: number, modifiers: SelectionModifiers = {},
): { selectedIds: Set<string>; anchor: string | null } {
  if (!Number.isInteger(index) || index < 0 || index >= ids.length) {
    throw new RangeError("Selection index is outside the track list.");
  }
  const id = ids[index];
  const toggle = modifiers.ctrlKey || modifiers.metaKey;
  const next = new Set<string>(toggle ? previous : []);
  if (modifiers.shiftKey) {
    const anchorIndex = anchor === null ? index : ids.indexOf(anchor);
    const start = anchorIndex < 0 ? index : anchorIndex;
    for (let offset = Math.min(start, index); offset <= Math.max(start, index); offset++) next.add(ids[offset]);
    return { selectedIds: next, anchor: anchorIndex < 0 || anchor === null ? id : anchor };
  }
  if (toggle && next.has(id)) next.delete(id);
  else next.add(id);
  return { selectedIds: next, anchor: id };
}

export function useTrackSelection(ids: readonly string[], dataKey?: unknown): TrackSelection {
  const [state, setState] = useState<{ selectedIds: ReadonlySet<string>; anchor: string | null; key: unknown }>(
    () => ({ selectedIds: new Set(), anchor: null, key: dataKey }),
  );
  const valid = useMemo(() => new Set(ids), [ids]);
  const selectedIds = useMemo(() => state.key !== dataKey ? new Set<string>()
    : new Set([...state.selectedIds].filter((id) => valid.has(id))), [state, valid, dataKey]);
  const live = useRef<{ ids: readonly string[]; selectedIds: ReadonlySet<string>; anchor: string | null; key: unknown }>(
    { ids, selectedIds, anchor: state.key === dataKey ? state.anchor : null, key: dataKey },
  );
  live.current = { ids, selectedIds, anchor: state.key === dataKey ? state.anchor : null, key: dataKey };
  useEffect(() => {
    if (state.key !== dataKey || state.selectedIds.size !== selectedIds.size) {
      setState({ selectedIds, anchor: live.current.anchor, key: dataKey });
    }
  }, [dataKey, selectedIds, state]);
  const commit = useCallback((next: { selectedIds: ReadonlySet<string>; anchor: string | null }) => {
    live.current = { ...live.current, ...next };
    setState({ ...next, key: live.current.key });
  }, []);
  const select = useCallback((index: number, modifiers?: SelectionModifiers) => {
    const current = live.current;
    commit(selectTrackRange(current.ids, current.selectedIds, current.anchor, index, modifiers));
  }, [commit]);
  const selectAll = useCallback(() => commit({ selectedIds: new Set(live.current.ids), anchor: live.current.ids[0] ?? null }), [commit]);
  const clear = useCallback(() => commit({ selectedIds: new Set(), anchor: null }), [commit]);
  return { selectedIds, selectedCount: selectedIds.size, allSelected: ids.length > 0 && selectedIds.size === ids.length, select, selectAll, clear };
}
