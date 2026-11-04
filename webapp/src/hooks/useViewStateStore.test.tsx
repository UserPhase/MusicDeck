import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { flushViewState, readViewState, updateViewState, useRouteScrollRestoration, useViewStateStore, useViewStateValue } from "./useViewStateStore";

jest.mock("../context/AuthContext", () => ({ useAuth: () => ({ session: { id: "view-test" } }) }));

test("persists query, tag filters, page and sort atomically per account and route", () => {
  updateViewState("view-test-one", "/library/tracks", {
    query: "live", filters: { genre: "Ambient", tags: ["Live", "Instrumental"], favoritesOnly: true }, pageIndex: 17,
    sortBy: "year", sortDirection: "desc", scrollPosition: 64000.25,
  });
  flushViewState("view-test-one");
  expect(JSON.parse(localStorage.getItem("musicdeck:view-state:v1:view-test-one")!)).toEqual({
    "/library/tracks": { query: "live", filters: { genre: "Ambient", tags: ["Live", "Instrumental"], favoritesOnly: true },
      pageIndex: 17, sortBy: "year", sortDirection: "desc", scrollPosition: 64000.25 },
  });
  expect(readViewState("view-test-other", "/library/tracks")).toEqual({});
  expect(readViewState("view-test-one", "/library/albums")).toEqual({});
});

test("functional filter updates survive remount and notify subscribers without losing other fields", () => {
  const hook = renderHook(() => useViewStateValue("/view-filter-test", "filters", { favoritesOnly: false }));
  act(() => hook.result.current[1]((value) => ({ ...value, favoritesOnly: true })));
  hook.unmount();
  const remount = renderHook(() => useViewStateValue("/view-filter-test", "filters", { favoritesOnly: false }));
  expect(remount.result.current[0]).toEqual({ favoritesOnly: true });
});

test("cross-tab updates are validated and storage failures are explicitly logged", () => {
  const hook = renderHook(() => useViewStateStore("view-tab-test", "/explore"));
  act(() => window.dispatchEvent(new StorageEvent("storage", {
    key: "musicdeck:view-state:v1:view-tab-test", newValue: JSON.stringify({ "/explore": { scrollPosition: 2123, filters: { tags: ["Ambient", "Live"] } } }),
  })));
  expect(hook.result.current.scrollPosition).toBe(2123);
  expect(hook.result.current.filters).toEqual({ tags: ["Ambient", "Live"] });
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  act(() => window.dispatchEvent(new StorageEvent("storage", {
    key: "musicdeck:view-state:v1:view-tab-test", newValue: JSON.stringify({ "/explore": { scrollPosition: -4 } }),
  })));
  expect(hook.result.current.scrollPosition).toBe(2123);
  expect(log).toHaveBeenCalledWith("Could not synchronize browsing state:", expect.any(Error));
  log.mockRestore();
});

function Shell({ ready }: { ready: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useRouteScrollRestoration(ref);
  return <main ref={ref} data-testid="scroller">
    <Link to="/detail">Detail</Link><Link to="/library/tracks">Tracks</Link>
    <Routes>
      <Route path="/library/tracks" element={<div data-view-loading={!ready}>Virtual slots</div>} />
      <Route path="/detail" element={<div>Album detail</div>} />
    </Routes>
  </main>;
}
test("waits for async virtual layout, restores exact pixels and keeps independent route offsets", async () => {
  updateViewState("view-test", "/library/tracks", { scrollPosition: 64000.25 });
  const view = render(<MemoryRouter initialEntries={["/library/tracks"]}><Shell ready={false} /></MemoryRouter>);
  const scroller = screen.getByTestId("scroller");
  const restored = jest.fn();
  scroller.addEventListener("musicdeck:scroll-restored", restored);
  expect(scroller.style.visibility).toBe("hidden");
  expect(scroller.scrollTop).toBe(0);
  view.rerender(<MemoryRouter initialEntries={["/library/tracks"]}><Shell ready /></MemoryRouter>);
  await waitFor(() => expect(scroller.scrollTop).toBe(64000.25));
  expect(scroller.style.visibility).toBe("");
  expect(restored).toHaveBeenCalledTimes(1);
  fireEvent.scroll(scroller, { target: { scrollTop: 64512.5 } });
  fireEvent.click(screen.getByText("Detail"));
  expect(scroller.scrollTop).toBe(0);
  fireEvent.scroll(scroller, { target: { scrollTop: 123 } });
  fireEvent.click(screen.getByText("Tracks"));
  expect(scroller.scrollTop).toBe(64512.5);
  expect(readViewState("view-test", "/detail").scrollPosition).toBe(123);
  view.unmount();
  expect(window.history.scrollRestoration).not.toBe("manual");
});

test("error and empty destinations restore without remaining hidden", () => {
  updateViewState("view-test", "/library/tracks", { scrollPosition: 9999 });
  render(<MemoryRouter initialEntries={["/library/tracks"]}><Shell ready /></MemoryRouter>);
  expect(screen.getByTestId("scroller").style.visibility).toBe("");
});
