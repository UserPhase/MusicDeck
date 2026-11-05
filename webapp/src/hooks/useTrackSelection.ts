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

const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

export function useTrackSelection(ids: readonly string[], dataKey?: unknown): TrackSelection {
  const valid = useMemo(() => new Set(ids), [ids]);
  const [state, setState] = useState<{
    selectedIds: ReadonlySet<string>;
    anchor: string | null;
    key: unknown;
    valid: ReadonlySet<string>;
  }>(() => ({ selectedIds: EMPTY_SELECTION, anchor: null, key: dataKey, valid }));

  const selectedIds = useMemo(() => {
    if (state.key !== dataKey || state.selectedIds.size === 0) return EMPTY_SELECTION;
    if (state.valid === valid || state.selectedIds === valid) return state.selectedIds;
    const pruned = new Set<string>();
    state.selectedIds.forEach((id) => {
      if (valid.has(id)) pruned.add(id);
    });
    return pruned.size === state.selectedIds.size ? state.selectedIds : pruned;
  }, [state, valid, dataKey]);

  const live = useRef<{
    ids: readonly string[];
    valid: ReadonlySet<string>;
    selectedIds: ReadonlySet<string>;
    anchor: string | null;
    key: unknown;
  }>({
    ids,
    valid,
    selectedIds,
    anchor: state.key === dataKey ? state.anchor : null,
    key: dataKey,
  });
  live.current = {
    ids,
    valid,
    selectedIds,
    anchor: state.key === dataKey ? state.anchor : null,
    key: dataKey,
  };

  useEffect(() => {
    if (state.key !== dataKey || state.selectedIds.size !== selectedIds.size) {
      setState({
        selectedIds,
        anchor: live.current.anchor,
        key: dataKey,
        valid: live.current.valid,
      });
    }
  }, [dataKey, selectedIds, state]);

  const commit = useCallback((next: { selectedIds: ReadonlySet<string>; anchor: string | null }) => {
    const current = live.current;
    live.current = { ...current, ...next };
    setState({ ...next, key: current.key, valid: current.valid });
  }, []);

  const select = useCallback((index: number, modifiers?: SelectionModifiers) => {
    const current = live.current;
    commit(selectTrackRange(current.ids, current.selectedIds, current.anchor, index, modifiers));
  }, [commit]);

  const selectAll = useCallback(() => {
    const current = live.current;
    commit({ selectedIds: current.valid, anchor: current.ids[0] ?? null });
  }, [commit]);

  const clear = useCallback(() => commit({ selectedIds: EMPTY_SELECTION, anchor: null }), [commit]);

  return {
    selectedIds,
    selectedCount: selectedIds.size,
    allSelected: ids.length > 0 && selectedIds.size === ids.length,
    select,
    selectAll,
    clear,
  };
}
