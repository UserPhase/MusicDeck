export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator) || !window.isSecureContext) return null;
  try {
    const publicPath = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
    const base = new URL(`${publicPath}/`, window.location.origin);
    if (base.origin !== window.location.origin) throw new Error("MusicDeck service worker requires a same-origin PUBLIC_URL.");
    return await navigator.serviceWorker.register(new URL("service-worker.js", base).href, { scope: base.pathname });
  } catch (error) {
    console.error("Could not prepare MusicDeck's offline app shell:", error);
    window.dispatchEvent(new CustomEvent("musicdeck:service-worker-error"));
    return null;
  }
}

export function sendCachePolicy(owner: string | null, externalArtwork: boolean, metadata: boolean | null = null): void {
  navigator.serviceWorker?.controller?.postMessage({ type: "MUSICDECK_CACHE_POLICY", owner, externalArtwork, metadata });
}
