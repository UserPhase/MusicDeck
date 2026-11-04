import { act, renderHook } from "@testing-library/react";
import { performance } from "perf_hooks";
import { selectTrackRange, useTrackSelection } from "./useTrackSelection";

test("single, Ctrl/Cmd toggle, Shift range and additive ranges use occurrence IDs", () => {
  const ids = ["same-song-first", "b", "c", "same-song-second", "e"];
  const { result } = renderHook(() => useTrackSelection(ids, "playlist"));
  act(() => result.current.select(0));
  act(() => result.current.select(3, { metaKey: true }));
  expect([...result.current.selectedIds]).toEqual(["same-song-first", "same-song-second"]);
  act(() => result.current.select(1, { shiftKey: true }));
  expect([...result.current.selectedIds]).toEqual(["b", "c", "same-song-second"]);
  act(() => result.current.select(0, { ctrlKey: true, shiftKey: true }));
  expect(result.current.selectedCount).toBe(4);
  act(() => result.current.select(3, { ctrlKey: true }));
  expect(result.current.selectedIds.has("same-song-second")).toBe(false);
  act(() => result.current.select(4));
  expect([...result.current.selectedIds]).toEqual(["e"]);
});

test("same-tick toggles are atomic; selection follows occurrences through reorder and prunes removals", () => {
  const { result, rerender } = renderHook(({ ids, key }) => useTrackSelection(ids, key),
    { initialProps: { ids: ["a", "b", "c"], key: "one" } });
  act(() => {
    result.current.select(0);
    result.current.select(2, { ctrlKey: true });
  });
  expect([...result.current.selectedIds]).toEqual(["a", "c"]);
  rerender({ ids: ["c", "b", "a"], key: "one" });
  expect(result.current.selectedCount).toBe(2);
  act(() => result.current.select(1, { shiftKey: true }));
  expect([...result.current.selectedIds]).toEqual(["c", "b"]);
  rerender({ ids: ["b", "a"], key: "one" });
  expect([...result.current.selectedIds]).toEqual(["b"]);
  rerender({ ids: ["b", "a"], key: "two" });
  expect(result.current.selectedCount).toBe(0);
  act(() => result.current.selectAll());
  expect(result.current.allSelected).toBe(true);
  act(() => result.current.clear());
  expect(result.current.selectedCount).toBe(0);
});

test("invalid indices fail explicitly and a deleted anchor starts a new range", () => {
  expect(() => selectTrackRange(["a"], new Set(), null, 2)).toThrow(RangeError);
  expect(selectTrackRange(["a", "b"], new Set(), "removed", 1, { shiftKey: true }).selectedIds).toEqual(new Set(["b"]));
});

test("500+ virtualized selections and select-all across 5,000 entries complete below 5 ms", () => {
  const ids = Array.from({ length: 5000 }, (_, index) => `occurrence-${index}`);
  const { result } = renderHook(() => useTrackSelection(ids, "performance"));
  for (let count = 0; count < 20; count++) act(() => { result.current.select(10); result.current.select(1010, { shiftKey: true }); });
  const durations: number[] = [];
  for (let count = 0; count < 50; count++) {
    const started = performance.now();
    act(() => { result.current.select(10); result.current.select(1010, { shiftKey: true }); });
    durations.push(performance.now() - started);
    expect(result.current.selectedCount).toBe(1001);
  }
  const allDurations: number[] = [];
  for (let count = 0; count < 30; count++) {
    const started = performance.now();
    act(() => result.current.selectAll());
    allDurations.push(performance.now() - started);
  }
  const percentile = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * .95)];
  console.info(`Playlist selection (including React commit): range p95 ${percentile(durations).toFixed(2)} ms; select-all p95 ${percentile(allDurations).toFixed(2)} ms`);
  expect(percentile(durations)).toBeLessThan(5);
  expect(percentile(allDurations)).toBeLessThan(5);
});
