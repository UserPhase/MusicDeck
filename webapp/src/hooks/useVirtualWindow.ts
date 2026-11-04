import { RefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export function findScrollParent(element: HTMLElement): HTMLElement | Window {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return window;
}

export function indexAtOffset(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (offsets[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return Math.min(low, Math.max(0, offsets.length - 2));
}

/** Uses the existing page scroller, not a nested scroll area. Measurements are
 * cached by slot; scroll work is a binary search rather than a full list scan. */
export function useVirtualWindow(
  ref: RefObject<HTMLDivElement | null>,
  count: number,
  estimateSize: number,
  dynamic = false,
  resetKey: unknown = count,
) {
  const [revision, setRevision] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 600, width: 0, overscan: 2 });
  const measurementWidth = dynamic ? viewport.width : 0;
  // Layout keys intentionally invalidate this mutable measurement cache.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sizes = useMemo(() => new Map<number, number>(), [resetKey, estimateSize, measurementWidth]);

  const offsets = useMemo(() => {
    const result = [0];
    for (let index = 0; index < count; index += 1) {
      result.push(result[index] + (dynamic ? sizes.get(index) ?? estimateSize : estimateSize));
    }
    return result;
    // ResizeObserver mutates sizes; revision invalidates the prefix sums.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, dynamic, estimateSize, revision, sizes]);
  const totalSize = offsets[count];
  const anchor = useRef<{ index: number; offsets: number[]; sizes: Map<number, number> } | null>(null);
  useLayoutEffect(() => {
    const previous = anchor.current;
    let correction = 0;
    // Only size corrections above the anchor should move the scroll position.
    if (dynamic && previous && previous.sizes === sizes && previous.offsets !== offsets) {
      correction = (offsets[previous.index] ?? 0) - (previous.offsets[previous.index] ?? 0);
      if (correction && ref.current && viewport.top > 0) {
        const parent = findScrollParent(ref.current);
        if (parent instanceof HTMLElement) parent.scrollTop += correction;
        else window.scrollTo({ top: window.scrollY + correction });
        setViewport((old) => ({ ...old, top: old.top + correction }));
      }
    }
    anchor.current = { index: indexAtOffset(offsets, viewport.top + correction), offsets, sizes };
  }, [dynamic, offsets, ref, sizes, viewport.top]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const parent = findScrollParent(element);
    let frame = 0;
    let previousTop = 0;
    const update = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const parentRect = parent instanceof HTMLElement ? parent.getBoundingClientRect() : null;
      const top = (parentRect ? parentRect.top + (parent as HTMLElement).clientTop : 0) - rect.top;
      const height = parent instanceof HTMLElement ? parent.clientHeight : window.innerHeight;
      const width = element.clientWidth;
      const overscan = Math.abs(top - previousTop) > estimateSize ? 3 : 2;
      previousTop = top;
      setViewport((old) => old.top === top && old.height === height &&
        old.width === width && old.overscan === overscan ? old : { top, height, width, overscan });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    if (parent instanceof HTMLElement) observer?.observe(parent);
    parent.addEventListener("scroll", schedule, { passive: true });
    parent.addEventListener("musicdeck:scroll-restored", update);
    window.addEventListener("resize", schedule);
    update();
    element.dispatchEvent(new Event("musicdeck:view-layout", { bubbles: true }));
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      parent.removeEventListener("scroll", schedule);
      parent.removeEventListener("musicdeck:scroll-restored", update);
      window.removeEventListener("resize", schedule);
    };
  }, [ref, estimateSize, dynamic, totalSize, sizes]);

  const measure = useCallback((index: number, height: number) => {
    if (!dynamic || height <= 0 || sizes.get(index) === height) return;
    sizes.set(index, height);
    setRevision((value) => value + 1);
  }, [dynamic, sizes]);

  const start = count ? Math.max(0, indexAtOffset(offsets, Math.max(0, viewport.top)) - viewport.overscan) : 0;
  const bottom = Math.max(0, viewport.top + viewport.height);
  const bottomIndex = indexAtOffset(offsets, bottom);
  const visibleEnd = offsets[bottomIndex] === bottom ? bottomIndex : bottomIndex + 1;
  const end = count ? Math.min(count, visibleEnd + viewport.overscan) : 0;
  const scrollToIndex = useCallback((index: number) => {
    const element = ref.current;
    if (!element) return;
    const parent = findScrollParent(element);
    const rect = element.getBoundingClientRect();
    const parentTop = parent instanceof HTMLElement ? parent.getBoundingClientRect().top + parent.clientTop : 0;
    const delta = rect.top - parentTop + offsets[index];
    if (parent instanceof HTMLElement) parent.scrollTop += delta;
    else window.scrollTo({ top: window.scrollY + delta });
    parent.dispatchEvent(new Event("scroll"));
  }, [offsets, ref]);

  return { start, end, offsets, totalSize, width: viewport.width, measure, scrollToIndex };
}
