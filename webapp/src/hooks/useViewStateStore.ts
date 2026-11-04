import { useCallback, useId, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export interface ViewState {
  scrollPosition: number;
  query: string;
  filters: Record<string, boolean | string | number | string[]>;
  pageIndex: number;
  sortBy: string;
  sortDirection: "asc" | "desc";
}
type ViewRecord = Partial<ViewState>;
const EMPTY: ViewRecord = Object.freeze({});
const stores = new Map<string, { views: Record<string, ViewRecord>; listeners: Set<() => void>; timer: ReturnType<typeof setTimeout> | null }>();
const storageKey = (userId: string) => `musicdeck:view-state:v1:${encodeURIComponent(userId)}`;

function decode(raw: string | null): Record<string, ViewRecord> {
  if (!raw) return {};
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid saved view state.");
  const views: Record<string, ViewRecord> = {};
  for (const [route, value] of Object.entries(data).slice(-100)) {
    if (!route.startsWith("/") || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved route.");
    const entry = value as Record<string, unknown>;
    const valid: ViewRecord = {};
    for (const key of ["scrollPosition", "pageIndex"] as const) {
      if (entry[key] !== undefined) {
        if (typeof entry[key] !== "number" || !Number.isFinite(entry[key]) || entry[key] < 0 ||
          (key === "pageIndex" && !Number.isInteger(entry[key]))) throw new Error("Invalid saved scroll or page.");
        valid[key] = entry[key];
      }
    }
    for (const key of ["query", "sortBy"] as const) {
      if (entry[key] !== undefined) {
        if (typeof entry[key] !== "string") throw new Error("Invalid saved search or sort.");
        valid[key] = entry[key];
      }
    }
    if (entry.sortDirection !== undefined) {
      if (entry.sortDirection !== "asc" && entry.sortDirection !== "desc") throw new Error("Invalid saved sort direction.");
      valid.sortDirection = entry.sortDirection;
    }
    if (entry.filters !== undefined) {
      if (!entry.filters || typeof entry.filters !== "object" || Array.isArray(entry.filters) ||
        Object.values(entry.filters).some((item) => Array.isArray(item) ? item.some((tag) => typeof tag !== "string")
          : !["string", "boolean", "number"].includes(typeof item) ||
          (typeof item === "number" && !Number.isFinite(item)))) throw new Error("Invalid saved filters.");
      valid.filters = entry.filters as ViewState["filters"];
    }
    views[route] = valid;
  }
  return views;
}
function storeFor(userId: string) {
  let store = stores.get(userId);
  if (!store) {
    let views = {};
    try { views = decode(localStorage.getItem(storageKey(userId))); }
    catch (error) { console.error("Could not restore browsing state:", error); }
    store = { views, listeners: new Set(), timer: null };
    stores.set(userId, store);
  }
  return store;
}
export function flushViewState(userId: string): void {
  const store = storeFor(userId);
  if (store.timer) clearTimeout(store.timer);
  store.timer = null;
  try { localStorage.setItem(storageKey(userId), JSON.stringify(store.views)); }
  catch (error) { console.error("Could not save browsing state:", error); }
}
export function readViewState(userId: string, route: string): ViewRecord {
  return storeFor(userId).views[route] ?? EMPTY;
}
export function updateViewState(userId: string, route: string, patch: ViewRecord): void {
  const store = storeFor(userId);
  const previous = store.views[route] ?? EMPTY;
  if (Object.entries(patch).every(([key, value]) => previous[key as keyof ViewState] === value)) return;
  // Keep recently visited routes last, bounded even during a long browsing session.
  const { [route]: _previous, ...rest } = store.views;
  store.views = Object.fromEntries([...Object.entries(rest), [route, { ...previous, ...patch }]].slice(-100));
  store.listeners.forEach((listener) => listener());
  if (store.timer) clearTimeout(store.timer);
  store.timer = setTimeout(() => flushViewState(userId), 150);
}
function subscribe(userId: string, listener: () => void) {
  const store = storeFor(userId);
  store.listeners.add(listener);
  const receive = (event: StorageEvent) => {
    if (event.key !== storageKey(userId)) return;
    try {
      store.views = decode(event.newValue);
      store.listeners.forEach((notify) => notify());
    } catch (error) { console.error("Could not synchronize browsing state:", error); }
  };
  window.addEventListener("storage", receive);
  return () => { store.listeners.delete(listener); window.removeEventListener("storage", receive); };
}
export function useViewStateStore(userId: string, route: string): ViewRecord {
  return useSyncExternalStore(useCallback((notify) => subscribe(userId, notify), [userId]),
    useCallback(() => readViewState(userId, route), [userId, route]), () => EMPTY);
}
export function useViewStateValue<K extends keyof ViewState>(
  route: string, key: K, initialValue: ViewState[K],
): [ViewState[K], Dispatch<SetStateAction<ViewState[K]>>] {
  const instanceId = useId();
  const auth = useAuth() as { session?: { id?: string } | null } | null;
  const userId = auth?.session?.id ?? `anonymous:${instanceId}`;
  const initial = useRef(initialValue);
  const value = useSyncExternalStore(useCallback((notify) => subscribe(userId, notify), [userId]),
    useCallback(() => readViewState(userId, route)[key] ?? initial.current, [userId, route, key]), () => initial.current);
  const setValue = useCallback<Dispatch<SetStateAction<ViewState[K]>>>((next) => {
    const current = readViewState(userId, route)[key] ?? initial.current;
    updateViewState(userId, route, { [key]: typeof next === "function" ? next(current) : next });
  }, [userId, route, key]);
  return [value, setValue];
}

/** Wait for data/virtual spacers, then synchronously refresh the visible virtual
 * range before revealing it. No guessed timers or intermediate top-of-list paint. */
export function useRouteScrollRestoration(ref: RefObject<HTMLElement | null>): void {
  const location = useLocation();
  const auth = useAuth() as { session?: { id?: string } | null } | null;
  const userId = auth?.session?.id ?? "anonymous";
  const route = location.pathname + location.search;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    window.dispatchEvent(new Event("musicdeck:navigation"));
    const target = readViewState(userId, route).scrollPosition ?? 0;
    const previousRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    let restoring = true;
    let lastPosition = target;
    const previousVisibility = element.style.visibility;
    if (target > 0) element.style.visibility = "hidden";
    else element.scrollTop = 0;
    const remember = () => {
      if (restoring) return;
      lastPosition = element.scrollTop;
      updateViewState(userId, route, { scrollPosition: lastPosition });
    };
    const restore = () => {
      if (!restoring || element.querySelector('[data-view-loading="true"]')) return;
      element.scrollTop = target;
      restoring = false;
      observer.disconnect();
      element.removeEventListener("musicdeck:view-layout", restore);
      lastPosition = element.scrollTop;
      element.dispatchEvent(new Event("musicdeck:scroll-restored"));
      element.style.visibility = previousVisibility;
    };
    const observer = new MutationObserver(restore);
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-view-loading", "style"] });
    element.addEventListener("scroll", remember, { passive: true });
    element.addEventListener("musicdeck:view-layout", restore);
    const flush = () => { remember(); flushViewState(userId); };
    window.addEventListener("pagehide", flush);
    restore();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", remember);
      element.removeEventListener("musicdeck:view-layout", restore);
      window.removeEventListener("pagehide", flush);
      element.style.visibility = previousVisibility;
      window.history.scrollRestoration = previousRestoration;
      updateViewState(userId, route, { scrollPosition: lastPosition });
      flushViewState(userId);
    };
  }, [ref, route, userId]);
}
