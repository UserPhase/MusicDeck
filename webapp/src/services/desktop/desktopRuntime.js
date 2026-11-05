export const DEFAULT_DESKTOP_SERVER_URL = "http://localhost:4534";
export const DEFAULT_DESKTOP_UPDATE_MANIFEST_URL =
  "https://github.com/UserPhase/MusicDeck/releases/download/desktop-latest/latest.json";
export const DESKTOP_SERVER_URL_KEY = "musicdeck.desktop.serverUrl";
export const DESKTOP_PROXY_URL_KEY = "musicdeck.desktop.proxyUrl";
export const DESKTOP_CLOSE_TO_TRAY_KEY = "musicdeck.desktop.closeToTray";
export const DESKTOP_AUTO_UPDATE_KEY = "musicdeck.desktop.autoCheckUpdates";
export const DESKTOP_CONFIG_CHANGED_EVENT = "musicdeck:desktop-config-changed";
export const DESKTOP_OPEN_SERVER_MODAL_EVENT = "musicdeck:desktop-open-server-settings";
export const DESKTOP_MEDIA_CONTROL_EVENT = "musicdeck:desktop-media-control";
export const DESKTOP_CHECK_UPDATES_EVENT = "musicdeck:desktop-check-for-updates";
export const DESKTOP_UPDATE_STATUS_EVENT = "musicdeck:desktop-update-status";

let fetchInterceptorInstalled = false;
let originalFetch = null;
let activeDesktopProxyUrl = null;
let runtimeSyncPromise = null;

function isBinaryOrStreamApiPath(path) {
  if (typeof path !== "string") return false;
  return (
    /^\/api\/tracks\/[^/?]+\/stream(?:\?|$)/.test(path) ||
    /^\/api\/playback\/normalized\//.test(path) ||
    /^\/api\/playback\/preview(?:\?|$)/.test(path) ||
    /^\/api\/artwork\//.test(path) ||
    /^\/api\/albums\/[^/?]+\/artwork(?:\?|$)/.test(path) ||
    /^\/api\/playlists\/[^/?]+\/artwork(?:\?|$)/.test(path) ||
    /^\/api\/metadata\/album-artwork(?:\?|$)/.test(path) ||
    /^\/api\/users\/[^/?]+\/avatar(?:\?|$)/.test(path) ||
    (/^\/api\/v1\/user\/export\//.test(path) &&
      !/^\/api\/v1\/user\/export\/summary(?:\?|$)/.test(path)) ||
    /\/(?:stream|events)(?:\?|$)/.test(path)
  );
}

export function isDesktopRuntime(win = typeof window !== "undefined" ? window : undefined) {
  if (!win) return false;
  return Boolean(
    win.__TAURI_INTERNALS__ ||
      win.__TAURI__ ||
      win.__MUSICDECK_DESKTOP__
  );
}

export function normalizeDesktopServerUrl(raw) {
  if (typeof raw !== "string") {
    throw new Error("Server URL must be a string.");
  }

  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("Server URL is required.");
  }

  let candidate = trimmed;
  if (!candidate.includes("://")) {
    const hostPart = candidate.split("/")[0] || "";
    const isIpv4OrLocal =
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostPart) || hostPart.toLowerCase() === "localhost";
    candidate = !hostPart.includes(":") && isIpv4OrLocal
      ? `http://${hostPart}:8080`
      : `http://${candidate}`;
  } else if (!/^https?:\/\//i.test(candidate)) {
    throw new Error("Server URL must start with http:// or https://.");
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid http:// or https:// MusicDeck server URL.");
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.host) {
    throw new Error("Enter a valid http:// or https:// MusicDeck server URL.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Server URL must not embed credentials.");
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${cleanPath}`;
}

export function getCandidateDesktopServerUrls(raw) {
  const primary = normalizeDesktopServerUrl(raw);
  const parsed = new URL(primary);
  const candidates = [primary];

  if (!parsed.pathname || parsed.pathname === "/") {
    const scheme = `${parsed.protocol}//`;
    const hostOnly = parsed.hostname;
    for (const alt of [
      `${scheme}${hostOnly}:8080`,
      `${scheme}${hostOnly}:4534`,
      `${scheme}${hostOnly}`,
    ]) {
      if (!candidates.includes(alt)) {
        candidates.push(alt);
      }
    }
  }

  return candidates;
}

export function hasStoredDesktopServerUrl() {
  try {
    const raw = localStorage.getItem(DESKTOP_SERVER_URL_KEY);
    return Boolean(raw && raw.trim());
  } catch {
    return false;
  }
}

export function getDesktopServerUrl() {
  try {
    const stored = localStorage.getItem(DESKTOP_SERVER_URL_KEY);
    if (stored && stored.trim()) {
      return normalizeDesktopServerUrl(stored);
    }
  } catch {
    // Fall back to the default local server URL.
  }

  return DEFAULT_DESKTOP_SERVER_URL;
}

export function getDesktopCloseToTray() {
  try {
    const stored = localStorage.getItem(DESKTOP_CLOSE_TO_TRAY_KEY);
    if (stored === "false") return false;
    if (stored === "true") return true;
  } catch {
    // Default to keeping playback running in the system tray.
  }
  return true;
}

export function getDesktopAutoCheckUpdates() {
  try {
    const stored = localStorage.getItem(DESKTOP_AUTO_UPDATE_KEY);
    if (stored === "false") return false;
    if (stored === "true") return true;
  } catch {
    // Default to checking for updates automatically on startup.
  }
  return true;
}

function getTauriInvoke(win = typeof window !== "undefined" ? window : undefined) {
  if (!win) return null;
  if (typeof win.__TAURI__?.core?.invoke === "function") {
    return win.__TAURI__.core.invoke.bind(win.__TAURI__.core);
  }
  if (typeof win.__TAURI_INTERNALS__?.invoke === "function") {
    return win.__TAURI_INTERNALS__.invoke.bind(win.__TAURI_INTERNALS__);
  }
  return null;
}

function getTauriEventListen(win = typeof window !== "undefined" ? window : undefined) {
  if (!win) return null;
  if (typeof win.__TAURI__?.event?.listen === "function") {
    return win.__TAURI__.event.listen.bind(win.__TAURI__.event);
  }
  return null;
}

export async function invokeDesktopCommand(command, args = {}) {
  const invoke = getTauriInvoke();
  if (!invoke) return null;
  return invoke(command, args);
}

export function stripDesktopApiOrigin(url) {
  if (typeof url !== "string" || !isDesktopRuntime()) return url;
  if (activeDesktopProxyUrl && url.startsWith(`${activeDesktopProxyUrl}/api/`)) {
    return url.slice(activeDesktopProxyUrl.length);
  }
  const serverUrl = getDesktopServerUrl();
  if (serverUrl && url.startsWith(`${serverUrl}/api/`)) {
    return url.slice(serverUrl.length);
  }
  return url;
}

export function resolveDesktopApiUrl(pathOrUrl) {
  if (typeof pathOrUrl !== "string" || !isDesktopRuntime()) {
    return pathOrUrl;
  }

  if (!pathOrUrl.startsWith("/api/") && pathOrUrl !== "/api" && !pathOrUrl.startsWith("/api?")) {
    return pathOrUrl;
  }

  if (activeDesktopProxyUrl) {
    return `${activeDesktopProxyUrl}${pathOrUrl}`;
  }

  try {
    const cachedProxy = localStorage.getItem(DESKTOP_PROXY_URL_KEY);
    if (cachedProxy && cachedProxy.trim()) {
      activeDesktopProxyUrl = cachedProxy.trim().replace(/\/+$/, "");
      return `${activeDesktopProxyUrl}${pathOrUrl}`;
    }
  } catch {
    // Ignore storage read errors.
  }

  const serverUrl = getDesktopServerUrl();
  if (!serverUrl) {
    return pathOrUrl;
  }

  if (typeof window !== "undefined" && window.location) {
    const currentOrigin = window.location.origin;
    if (currentOrigin === serverUrl) {
      return pathOrUrl;
    }
    // During `tauri dev` against the CRA dev server on localhost:3000, keep
    // relative `/api/*` paths when no custom server URL was configured so the
    // dev proxy preserves same-origin cookies automatically.
    if (
      currentOrigin === "http://localhost:3000" &&
      !hasStoredDesktopServerUrl() &&
      serverUrl === DEFAULT_DESKTOP_SERVER_URL
    ) {
      return pathOrUrl;
    }
  }

  return `${serverUrl}${pathOrUrl}`;
}

export async function saveDesktopConfig({ serverUrl, closeToTray, autoCheckUpdates } = {}) {
  const nextServerUrl =
    serverUrl !== undefined ? normalizeDesktopServerUrl(serverUrl) : getDesktopServerUrl();
  const nextCloseToTray =
    typeof closeToTray === "boolean" ? closeToTray : getDesktopCloseToTray();
  const nextAutoCheckUpdates =
    typeof autoCheckUpdates === "boolean" ? autoCheckUpdates : getDesktopAutoCheckUpdates();

  try {
    localStorage.setItem(DESKTOP_SERVER_URL_KEY, nextServerUrl);
    localStorage.setItem(DESKTOP_CLOSE_TO_TRAY_KEY, String(nextCloseToTray));
    localStorage.setItem(DESKTOP_AUTO_UPDATE_KEY, String(nextAutoCheckUpdates));
  } catch {
    // Continue even if localStorage is restricted.
  }

  try {
    await invokeDesktopCommand("desktop_set_config", {
      update: {
        serverUrl: nextServerUrl,
        closeToTray: nextCloseToTray,
        autoCheckUpdates: nextAutoCheckUpdates,
      },
    });
  } catch {
    // Allow frontend config persistence when running in a mocked or preview shell.
  }

  const detail = {
    serverUrl: nextServerUrl,
    closeToTray: nextCloseToTray,
    autoCheckUpdates: nextAutoCheckUpdates,
  };

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DESKTOP_CONFIG_CHANGED_EVENT, { detail }));
  }

  return detail;
}

export async function checkDesktopServerConnection(candidateUrl) {
  const candidates = getCandidateDesktopServerUrls(candidateUrl);
  const normalized = candidates[0];

  try {
    const nativeResult = await invokeDesktopCommand("desktop_check_server", {
      serverUrl: normalized,
    });
    if (nativeResult && typeof nativeResult === "object" && "reachable" in nativeResult) {
      return {
        reachable: Boolean(nativeResult.reachable),
        serverUrl: nativeResult.serverUrl || normalized,
        appName: nativeResult.appName || "MusicDeck",
        error: nativeResult.error || null,
      };
    }
  } catch {
    // Fall back to standard fetch check below.
  }

  const fetchImpl = originalFetch || (typeof window !== "undefined" ? window.fetch?.bind(window) : fetch);
  let lastError = "Could not connect to MusicDeck server.";

  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(`${candidate}/api/public/config`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        lastError = `${candidate} responded with HTTP ${response.status}`;
        continue;
      }
      const payload = await response.json().catch(() => ({}));
      return {
        reachable: true,
        serverUrl: candidate,
        appName: typeof payload?.appName === "string" && payload.appName.trim()
          ? payload.appName.trim()
          : "MusicDeck",
        error: null,
      };
    } catch (err) {
      lastError = err?.message || lastError;
    }
  }

  return {
    reachable: false,
    serverUrl: normalized,
    appName: null,
    error: `${lastError} (For Docker Compose, use port 8080 e.g. http://192.168.2.38:8080 and set MUSICDECK_WEB_BIND=0.0.0.0 in .env)`,
  };
}

export async function checkDesktopUpdates(manifestUrl) {
  if (!isDesktopRuntime()) {
    return {
      updateAvailable: false,
      currentVersion: "0.1.0",
      latestVersion: null,
      installerUrl: null,
      sha256: null,
      notes: null,
      error: null,
    };
  }

  try {
    const nativeResult = await invokeDesktopCommand("desktop_check_for_updates", {
      manifestUrl: manifestUrl || null,
    });
    if (nativeResult && typeof nativeResult === "object" && "updateAvailable" in nativeResult) {
      return {
        updateAvailable: Boolean(nativeResult.updateAvailable),
        currentVersion: nativeResult.currentVersion || "0.1.0",
        latestVersion: nativeResult.latestVersion || null,
        buildId: nativeResult.buildId || null,
        publishedAt: nativeResult.publishedAt || null,
        notes: nativeResult.notes || null,
        installerUrl: nativeResult.installerUrl || null,
        sha256: nativeResult.sha256 || null,
        error: nativeResult.error || null,
      };
    }
  } catch (err) {
    return {
      updateAvailable: false,
      currentVersion: "0.1.0",
      latestVersion: null,
      installerUrl: null,
      sha256: null,
      notes: null,
      error: err?.message || "Failed to check for updates.",
    };
  }

  return {
    updateAvailable: false,
    currentVersion: "0.1.0",
    latestVersion: null,
    installerUrl: null,
    sha256: null,
    notes: null,
    error: null,
  };
}

export async function installDesktopUpdate({ installerUrl, sha256 }) {
  if (!isDesktopRuntime()) {
    throw new Error("Desktop auto-updater is only available in the desktop app.");
  }
  if (!installerUrl || typeof installerUrl !== "string") {
    throw new Error("Update installer URL is missing.");
  }

  return invokeDesktopCommand("desktop_install_update", {
    installerUrl,
    sha256: sha256 || null,
  });
}

export async function syncDesktopPlaybackState({ title, artist, isPlaying }) {
  if (!isDesktopRuntime()) return;
  try {
    await invokeDesktopCommand("desktop_update_playback", {
      status: {
        title: title ? String(title) : null,
        artist: artist ? String(artist) : null,
        isPlaying: Boolean(isPlaying),
      },
    });
  } catch {
    // Ignore tray update errors when running outside native Tauri host.
  }
}

export async function performDesktopWindowAction(action) {
  if (!isDesktopRuntime()) return;
  try {
    await invokeDesktopCommand("desktop_window_action", { action });
  } catch {
    // Ignore window action errors when running outside native Tauri host.
  }
}

const INTERACTIVE_TITLEBAR_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "label",
  "[role='button']",
  "[role='menuitem']",
  "[role='listbox']",
  "[data-no-drag='true']",
  ".search-dropdown",
  ".account-menu",
  ".desktop-window-controls",
].join(",");

export function isInteractiveTitlebarTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(target.closest(INTERACTIVE_TITLEBAR_SELECTOR));
}

export function handleDesktopTitlebarMouseDown(event) {
  if (!isDesktopRuntime() || event.button !== 0 || event.detail > 1) return;
  if (isInteractiveTitlebarTarget(event.target)) return;
  void performDesktopWindowAction("start-dragging");
}

export function handleDesktopTitlebarDoubleClick(event) {
  if (!isDesktopRuntime()) return;
  if (isInteractiveTitlebarTarget(event.target)) return;
  void performDesktopWindowAction("toggle-maximize");
}

export function subscribeDesktopRuntimeEvents({
  onMediaControl,
  onOpenServerSettings,
  onCheckForUpdates,
  onUpdateStatus,
} = {}) {
  if (!isDesktopRuntime() || typeof window === "undefined") {
    return () => {};
  }

  const unlisteners = [];
  let disposed = false;

  const handleDomMediaControl = (event) => {
    const action = event.detail?.action;
    if (action) onMediaControl?.(action);
  };

  const handleDomOpenServer = () => {
    onOpenServerSettings?.();
  };

  const handleDomCheckUpdates = () => {
    onCheckForUpdates?.();
  };

  const handleDomUpdateStatus = (event) => {
    if (event.detail) onUpdateStatus?.(event.detail);
  };

  window.addEventListener(DESKTOP_MEDIA_CONTROL_EVENT, handleDomMediaControl);
  window.addEventListener(DESKTOP_OPEN_SERVER_MODAL_EVENT, handleDomOpenServer);
  window.addEventListener(DESKTOP_CHECK_UPDATES_EVENT, handleDomCheckUpdates);
  window.addEventListener(DESKTOP_UPDATE_STATUS_EVENT, handleDomUpdateStatus);

  const listen = getTauriEventListen();
  if (listen) {
    Promise.resolve(
      listen("desktop://media-control", (event) => {
        if (!disposed && event?.payload?.action) {
          onMediaControl?.(event.payload.action);
        }
      })
    )
      .then((unlisten) => {
        if (disposed && typeof unlisten === "function") {
          unlisten();
        } else if (typeof unlisten === "function") {
          unlisteners.push(unlisten);
        }
      })
      .catch(() => {});

    Promise.resolve(
      listen("desktop://open-server-settings", () => {
        if (!disposed) {
          onOpenServerSettings?.();
        }
      })
    )
      .then((unlisten) => {
        if (disposed && typeof unlisten === "function") {
          unlisten();
        } else if (typeof unlisten === "function") {
          unlisteners.push(unlisten);
        }
      })
      .catch(() => {});

    Promise.resolve(
      listen("desktop://check-for-updates", () => {
        if (!disposed) {
          onCheckForUpdates?.();
        }
      })
    )
      .then((unlisten) => {
        if (disposed && typeof unlisten === "function") {
          unlisten();
        } else if (typeof unlisten === "function") {
          unlisteners.push(unlisten);
        }
      })
      .catch(() => {});

    Promise.resolve(
      listen("desktop://update-status", (event) => {
        if (!disposed && event?.payload) {
          onUpdateStatus?.(event.payload);
        }
      })
    )
      .then((unlisten) => {
        if (disposed && typeof unlisten === "function") {
          unlisten();
        } else if (typeof unlisten === "function") {
          unlisteners.push(unlisten);
        }
      })
      .catch(() => {});
  }

  return () => {
    disposed = true;
    window.removeEventListener(DESKTOP_MEDIA_CONTROL_EVENT, handleDomMediaControl);
    window.removeEventListener(DESKTOP_OPEN_SERVER_MODAL_EVENT, handleDomOpenServer);
    window.removeEventListener(DESKTOP_CHECK_UPDATES_EVENT, handleDomCheckUpdates);
    window.removeEventListener(DESKTOP_UPDATE_STATUS_EVENT, handleDomUpdateStatus);
    while (unlisteners.length > 0) {
      const fn = unlisteners.pop();
      try {
        fn();
      } catch {
        // Ignore cleanup errors.
      }
    }
  };
}

export function installDesktopRuntime() {
  if (!isDesktopRuntime() || typeof window === "undefined") {
    return () => {};
  }

  document.documentElement.dataset.desktopApp = "true";

  if (!fetchInterceptorInstalled && typeof window.fetch === "function") {
    originalFetch = window.fetch.bind(window);
    fetchInterceptorInstalled = true;

    window.fetch = async (input, init) => {
      if (typeof input === "string") {
        const relativePath = stripDesktopApiOrigin(input);
        const isApiCall =
          relativePath.startsWith("/api/") ||
          relativePath === "/api" ||
          relativePath.startsWith("/api?");

        if (isApiCall && !isBinaryOrStreamApiPath(relativePath) && getTauriInvoke()) {
          const headers = {};
          if (init?.headers) {
            if (init.headers instanceof Headers) {
              init.headers.forEach((value, key) => {
                headers[key] = value;
              });
            } else if (Array.isArray(init.headers)) {
              for (const [key, value] of init.headers) {
                headers[key] = value;
              }
            } else if (typeof init.headers === "object") {
              Object.assign(headers, init.headers);
            }
          }

          const ipcResult = await invokeDesktopCommand("desktop_api_fetch", {
            request: {
              path: relativePath,
              method: init?.method || "GET",
              headers,
              body: typeof init?.body === "string" ? init.body : null,
            },
          });

          if (ipcResult && typeof ipcResult === "object" && typeof ipcResult.status === "number") {
            const responseBody = ipcResult.status === 204 ? null : ipcResult.body ?? "";
            return new Response(responseBody, {
              status: ipcResult.status,
              headers: ipcResult.headers || {},
            });
          }
        }

        const resolved = resolveDesktopApiUrl(input);
        if (resolved !== input) {
          return originalFetch(resolved, {
            credentials: "include",
            ...init,
          });
        }
      }
      return originalFetch(input, init);
    };
  }

  runtimeSyncPromise = Promise.resolve()
    .then(() => invokeDesktopCommand("desktop_get_config"))
    .then(async (config) => {
      if (!config || typeof config !== "object") return;
      if (typeof config.proxyUrl === "string" && config.proxyUrl.trim()) {
        activeDesktopProxyUrl = config.proxyUrl.trim().replace(/\/+$/, "");
        try {
          localStorage.setItem(DESKTOP_PROXY_URL_KEY, activeDesktopProxyUrl);
        } catch {
          // Ignore storage errors.
        }
      }
      const hadStoredUrl = hasStoredDesktopServerUrl();
      const storedUrl = hadStoredUrl ? getDesktopServerUrl() : null;
      if (typeof config.serverUrl === "string" && config.serverUrl.trim()) {
        const normalizedRustUrl = normalizeDesktopServerUrl(config.serverUrl);
        const rustIsDefaultLocal =
          normalizedRustUrl === "http://localhost:8080" ||
          normalizedRustUrl === "http://localhost:4534";
        if (!hadStoredUrl || !rustIsDefaultLocal) {
          try {
            localStorage.setItem(DESKTOP_SERVER_URL_KEY, normalizedRustUrl);
          } catch {
            // Ignore invalid or unpersisted config.
          }
        } else if (storedUrl && storedUrl !== normalizedRustUrl) {
          // Ensure the Rust proxy and IPC client use the user's stored non-default server URL.
          await invokeDesktopCommand("desktop_set_config", {
            update: { serverUrl: storedUrl },
          }).catch(() => {});
        }
      }
      if (typeof config.closeToTray === "boolean") {
        try {
          localStorage.setItem(DESKTOP_CLOSE_TO_TRAY_KEY, String(config.closeToTray));
        } catch {
          // Ignore storage errors.
        }
      }
      if (typeof config.autoCheckUpdates === "boolean") {
        try {
          localStorage.setItem(DESKTOP_AUTO_UPDATE_KEY, String(config.autoCheckUpdates));
        } catch {
          // Ignore storage errors.
        }
      }
    })
    .catch(() => {});

  return () => {
    if (fetchInterceptorInstalled && originalFetch) {
      window.fetch = originalFetch;
      fetchInterceptorInstalled = false;
      originalFetch = null;
    }
    activeDesktopProxyUrl = null;
    runtimeSyncPromise = null;
    delete document.documentElement.dataset.desktopApp;
  };
}

export async function initDesktopRuntime() {
  const cleanup = installDesktopRuntime();
  if (runtimeSyncPromise) {
    await Promise.race([
      runtimeSyncPromise,
      new Promise((resolve) => setTimeout(resolve, 600)),
    ]);
  }
  return cleanup;
}
