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
