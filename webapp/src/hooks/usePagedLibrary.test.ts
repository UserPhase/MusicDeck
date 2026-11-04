import { act, renderHook, waitFor } from "@testing-library/react";
import { LibraryPage, PageLoader, usePagedLibrary } from "./usePagedLibrary";

const pageAt = (offset: number, revision = 1): LibraryPage<number> => ({
  items: Array.from({ length: Math.min(200, 10000 - offset) }, (_, index) => offset + index),
  total: 10000, revision: String(revision),
});
test("batch selection fetches only selected pages without replacing the visible cache", async () => {
  const loader = jest.fn<ReturnType<PageLoader<number>>, Parameters<PageLoader<number>>>(async ({ offset }) => pageAt(offset));
  const { result } = renderHook(() => usePagedLibrary(loader));
  await waitFor(() => expect(result.current.total).toBe(10000));
  const selected = await result.current.loadSelection([0, 9050, 9051], new AbortController().signal);
  expect(selected).toEqual([0, 9050, 9051]);
  expect(loader.mock.calls.map(([options]) => options.offset)).toEqual([0, 0, 9000]);
  expect(result.current.getItem(0)).toBe(0); expect(result.current.getItem(9050)).toBeUndefined();
});
test("batch selection rejects changed collection revisions instead of acting on shifted indices", async () => {
  const loader = jest.fn<ReturnType<PageLoader<number>>, Parameters<PageLoader<number>>>(async ({ offset }) => pageAt(offset));
  const { result } = renderHook(() => usePagedLibrary(loader));
  await waitFor(() => expect(result.current.total).toBe(10000));
  loader.mockImplementation(async ({ offset }) => pageAt(offset, 2));
  await expect(result.current.loadSelection([9000], new AbortController().signal)).rejects.toThrow("library changed");
});

test("jumps request only destination pages and evicted pages are fetched again", async () => {
  const loader = jest.fn<ReturnType<PageLoader<number>>, Parameters<PageLoader<number>>>(
    async ({ offset }) => pageAt(offset));
  const { result } = renderHook(() => usePagedLibrary(loader));
  await waitFor(() => expect(result.current.total).toBe(10000));
  act(() => result.current.onRangeChange(9050, 9070));
  await waitFor(() => expect(result.current.getItem(9050)).toBe(9050));
  expect(loader.mock.calls.map(([options]) => options.offset)).toEqual([0, 9000]);
  for (let page = 1; page <= 9; page += 1) {
    act(() => result.current.onRangeChange(page * 200, page * 200 + 10));
    await waitFor(() => expect(result.current.getItem(page * 200)).toBe(page * 200));
  }
  expect(result.current.getItem(0)).toBeUndefined();
  act(() => result.current.onRangeChange(0, 10));
  await waitFor(() => expect(result.current.getItem(0)).toBe(0));
  expect(loader.mock.calls.filter(([options]) => options.offset === 0)).toHaveLength(2);
});

test("keeps at most two requests active and aborts stale windows and unmounted requests", async () => {
  const requests: { offset: number; signal: AbortSignal; resolve(value: LibraryPage<number>): void }[] = [];
  const loader: PageLoader<number> = ({ offset, signal }) => new Promise((resolve) => requests.push({ offset, signal, resolve }));
  const { result, unmount } = renderHook(() => usePagedLibrary(loader));
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0].resolve(pageAt(0)));
  act(() => result.current.onRangeChange(199, 410));
  await waitFor(() => expect(requests).toHaveLength(3));
  act(() => result.current.onRangeChange(9000, 9010));
  expect(requests[1].signal.aborted).toBe(true);
  expect(requests[2].signal.aborted).toBe(true);
  await act(async () => {
    requests[1].resolve(pageAt(200));
    requests[2].resolve(pageAt(400));
  });
  await waitFor(() => expect(requests).toHaveLength(4));
  expect(requests[3].offset).toBe(9000);
  expect(result.current.getItem(200)).toBeUndefined();
  unmount();
  expect(requests[3].signal.aborted).toBe(true);
});

test("query changes reject stale results, errors are explicit, and retry can recover", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  const first: PageLoader<number> = () => Promise.resolve(pageAt(0));
  const second = jest.fn<ReturnType<PageLoader<number>>, Parameters<PageLoader<number>>>()
    .mockRejectedValueOnce(new Error("Network offline"))
    .mockResolvedValue(pageAt(0, 2));
  const { result, rerender } = renderHook(({ load }) => usePagedLibrary(load), { initialProps: { load: first } });
  await waitFor(() => expect(result.current.total).toBe(10000));
  rerender({ load: second });
  await waitFor(() => expect(result.current.error).toBe("Network offline"));
  expect(result.current.getItem(0)).toBeUndefined();
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.getItem(0)).toBe(0));
  expect(result.current.error).toBe("");
  expect(log).toHaveBeenCalledTimes(1);
  log.mockRestore();
});

test("a newer server snapshot drops incompatible cached slots", async () => {
  let revision = 1;
  const loader: PageLoader<number> = async ({ offset }) => pageAt(offset, revision);
  const { result } = renderHook(() => usePagedLibrary(loader));
  await waitFor(() => expect(result.current.getItem(0)).toBe(0));
  revision = 2;
  act(() => result.current.onRangeChange(500, 510));
  await waitFor(() => expect(result.current.getItem(500)).toBe(500));
  expect(result.current.getItem(0)).toBeUndefined();
});

test("malformed short pages fail rather than leaving permanent unexplained skeletons", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  const loader: PageLoader<number> = async () => ({ total: 10000, items: [] });
  const { result } = renderHook(() => usePagedLibrary(loader));
  await waitFor(() => expect(result.current.error).toMatch(/invalid page/));
  expect(result.current.loading).toBe(false);
  expect(log).toHaveBeenCalled();
  log.mockRestore();
});

test("deletions compact cached slots and translate subsequent viewport page requests", async () => {
  const loader: PageLoader<number> = async ({ offset }) => pageAt(offset);
  const { result, rerender } = renderHook(
    ({ exclude }) => usePagedLibrary(loader, exclude),
    { initialProps: { exclude: (_item: number) => false } },
  );
  await waitFor(() => expect(result.current.total).toBe(10000));
  rerender({ exclude: (item: number) => item === 5 || item === 199 });
  await waitFor(() => expect(result.current.total).toBe(9998));
  expect(result.current.getItem(5)).toBe(6);
  expect(result.current.getItem(197)).toBe(198);
  act(() => result.current.onRangeChange(190, 205));
  await waitFor(() => expect(result.current.getItem(198)).toBe(200));
  expect(result.current.getItem(200)).toBe(202);
});
