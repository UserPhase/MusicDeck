import { useCallback, useEffect, useRef, useState } from "react";

export interface LibraryPage<T> { items: T[]; total: number; revision?: string }
export type PageLoader<T> = (options: { offset: number; limit: number; signal: AbortSignal }) => Promise<LibraryPage<T>>;
const PAGE_SIZE = 200;
const MAX_CACHED_PAGES = 8;

// Each removed source slot reduces the live rank of every following slot.
function sourceSlot(index: number, omitted: readonly number[]) {
  let low = 0;
  let high = omitted.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (omitted[mid] - mid <= index) low = mid + 1;
    else high = mid;
  }
  return index + low;
}

function pagesForRange(start: number, end: number, omitted: readonly number[]) {
  const pages: number[] = [];
  const first = Math.floor(sourceSlot(start, omitted) / PAGE_SIZE);
  const last = Math.floor(sourceSlot(Math.max(start, end - 1), omitted) / PAGE_SIZE);
  for (let page = first; page <= last; page += 1) pages.push(page);
  return pages;
}

/** Sparse random-access pages keep the server's total slot count independent
 * of the cache. Fast jumps request the destination, not every preceding page. */
export function usePagedLibrary<T>(loadPage: PageLoader<T>, excludeItem?: (item: T) => boolean) {
  const [view, setView] = useState({ total: 0, loading: true, error: "", revision: 0 });
  const cache = useRef(new Map<number, T[]>());
  const pending = useRef(new Map<number, AbortController>());
  const failed = useRef(new Set<number>());
  const wanted = useRef([0]);
  const generation = useRef(0);
  const snapshotRevision = useRef<string | undefined>(undefined);
  const snapshotTotal = useRef<number | undefined>(undefined);
  const pumpRef = useRef<() => void>(() => {});
  const omitted = useRef<number[]>([]);
  const excluded = useRef(excludeItem);
  const range = useRef({ start: 0, end: 1 });

  useEffect(() => {
    const run = ++generation.current;
    const requests = pending.current;
    cache.current.clear();
    omitted.current = [];
    range.current = { start: 0, end: 1 };
    snapshotRevision.current = undefined;
    snapshotTotal.current = undefined;
    failed.current.clear();
    wanted.current = [0];
    setView({ total: 0, loading: true, error: "", revision: 0 });
    const pump = () => {
      for (const page of wanted.current) {
        if (requests.size >= 2) break;
        if (cache.current.has(page) || requests.has(page) || failed.current.has(page)) continue;
        const controller = new AbortController();
        requests.set(page, controller);
        Promise.resolve().then(() => loadPage({
          offset: page * PAGE_SIZE, limit: PAGE_SIZE, signal: controller.signal,
        })).then((result) => {
          if (generation.current !== run || controller.signal.aborted) return;
          if (!Number.isInteger(result.total) || result.total < 0 ||
            result.items.length > PAGE_SIZE ||
            result.items.length !== Math.min(PAGE_SIZE, Math.max(0, result.total - page * PAGE_SIZE))) {
            throw new Error("The library returned an invalid page. Please reload.");
          }
          if (snapshotRevision.current !== result.revision ||
            (snapshotTotal.current !== undefined && snapshotTotal.current !== result.total)) {
            cache.current.clear();
            omitted.current = [];
            requests.forEach((other) => { if (other !== controller) other.abort(); });
          }
          snapshotRevision.current = result.revision;
          snapshotTotal.current = result.total;
          cache.current.set(page, result.items);
          const hidden = new Set(omitted.current);
          result.items.forEach((item, index) => {
            if (excluded.current?.(item)) hidden.add(page * PAGE_SIZE + index);
          });
          omitted.current = [...hidden].sort((left, right) => left - right);
          wanted.current = pagesForRange(range.current.start, range.current.end, omitted.current);
          for (const key of cache.current.keys()) {
            if (cache.current.size <= MAX_CACHED_PAGES) break;
            if (!wanted.current.includes(key)) cache.current.delete(key);
          }
          setView((old) => ({ ...old, total: result.total - omitted.current.length, loading: false, revision: old.revision + 1 }));
        }).catch((error: unknown) => {
          if (generation.current !== run || controller.signal.aborted) return;
          console.error("Could not load library page:", error);
          failed.current.add(page);
          setView((old) => ({ ...old, loading: false, error: error instanceof Error ? error.message : "Could not load the library." }));
        }).finally(() => {
          if (generation.current !== run) return;
          requests.delete(page);
          pump();
        });
      }
    };
    pumpRef.current = pump;
    pump();
    return () => {
      generation.current += 1;
      requests.forEach((controller) => controller.abort());
      requests.clear();
      pumpRef.current = () => {};
    };
  }, [loadPage]);

  const onRangeChange = useCallback((start: number, end: number) => {
    range.current = { start, end };
    const pages = pagesForRange(start, end, omitted.current);
    wanted.current = pages;
    // Stale destinations must not occupy both network slots while flinging.
    pending.current.forEach((controller, page) => {
      if (!pages.includes(page)) controller.abort();
    });
    pumpRef.current();
  }, []);
  useEffect(() => {
    excluded.current = excludeItem;
    const hidden = new Set(omitted.current);
    cache.current.forEach((items, page) => items.forEach((item, index) => {
      if (excludeItem?.(item)) hidden.add(page * PAGE_SIZE + index);
    }));
    if (hidden.size === omitted.current.length) return;
    omitted.current = [...hidden].sort((left, right) => left - right);
    setView((old) => ({ ...old, total: (snapshotTotal.current ?? old.total) - hidden.size, revision: old.revision + 1 }));
    onRangeChange(range.current.start, range.current.end);
  }, [excludeItem, onRangeChange]);
  const getItem = useCallback((index: number) => {
    const source = sourceSlot(index, omitted.current);
    return cache.current.get(Math.floor(source / PAGE_SIZE))?.[source % PAGE_SIZE];
  },
    // The revision makes new pages visible to memoized lists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view.revision]);
  const retry = useCallback(() => {
    failed.current.clear();
    setView((old) => ({ ...old, error: "" }));
    pumpRef.current();
  }, []);
  const loadSelection = useCallback(async (indices: readonly number[], signal: AbortSignal): Promise<T[]> => {
    const run = generation.current, revision = snapshotRevision.current, total = snapshotTotal.current;
    const hidden = [...omitted.current];
    const sources = indices.map((index) => sourceSlot(index, hidden));
    const pages = new Map<number, T[]>();
    for (const slot of sources) {
      if (!Number.isInteger(slot) || slot < 0 || total === undefined || slot >= total) throw new Error("The library selection is no longer valid. Select the tracks again.");
      const page = Math.floor(slot / PAGE_SIZE);
      if (pages.has(page)) continue;
      if (signal.aborted) throw new DOMException("Loading selected tracks was cancelled.", "AbortError");
      const result = await loadPage({ offset: page * PAGE_SIZE, limit: PAGE_SIZE, signal });
      if (signal.aborted) throw new DOMException("Loading selected tracks was cancelled.", "AbortError");
      if (run !== generation.current || result.total !== total || result.revision !== revision) throw new Error("The library changed while loading selected tracks. Select them again.");
      pages.set(page, result.items);
    }
    return sources.map((slot) => {
      const item = pages.get(Math.floor(slot / PAGE_SIZE))?.[slot % PAGE_SIZE];
      if (item === undefined || excluded.current?.(item)) throw new Error("A selected track is no longer available. Select the tracks again.");
      return item;
    });
  }, [loadPage]);
  return { ...view, getItem, onRangeChange, retry, loadSelection, collectionRevision: snapshotRevision.current };
}
