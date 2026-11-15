let desktopForeground: boolean | null = null;
const listeners = new Set<() => void>();

export function getVisualActivity(): boolean {
  return typeof document === "undefined" || (document.visibilityState !== "hidden" && desktopForeground !== false);
}

let lastActive = true;
function refresh() {
  const active = getVisualActivity();
  if (typeof document !== "undefined") document.documentElement.dataset.visualActive = String(active);
  if (active === lastActive) return;
  lastActive = active;
  listeners.forEach(listener => listener());
}

/** Desktop focus is independent of WebView document visibility. */
export function setDesktopForeground(foreground: boolean | null) {
  desktopForeground = foreground;
  refresh();
}

export function subscribeVisualActivity(listener: () => void): () => void {
  if (listeners.size === 0) document.addEventListener("visibilitychange", refresh);
  listeners.add(listener);
  refresh();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) document.removeEventListener("visibilitychange", refresh);
  };
}

/** Refresh promptly on return, with an optional slower cadence for background work. */
export function startVisualPolling(
  refresh: () => void,
  intervalMs: number,
  { immediate = true, refreshOnWindowFocus = false, backgroundIntervalMs }: {
    immediate?: boolean;
    refreshOnWindowFocus?: boolean;
    backgroundIntervalMs?: number;
  } = {},
): () => void {
  let timer: number | undefined;
  let previousActivity: boolean | undefined;
  const sync = () => {
    const active = getVisualActivity();
    if (active === previousActivity) return;
    const shouldRefresh = active && (immediate || previousActivity !== undefined);
    previousActivity = active;
    window.clearInterval(timer);
    const interval = active ? intervalMs : backgroundIntervalMs;
    timer = interval === undefined ? undefined : window.setInterval(refresh, interval);
    if (shouldRefresh) refresh();
  };
  const unsubscribe = subscribeVisualActivity(sync);
  sync();
  const onFocus = () => {
    // Browsers may stay visible when a different window takes focus.
    if (desktopForeground === null && getVisualActivity()) refresh();
  };
  if (refreshOnWindowFocus) window.addEventListener("focus", onFocus);
  return () => {
    unsubscribe();
    window.clearInterval(timer);
    if (refreshOnWindowFocus) window.removeEventListener("focus", onFocus);
  };
}
