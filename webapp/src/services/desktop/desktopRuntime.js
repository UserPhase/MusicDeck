import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { setDesktopForeground } from "../visualActivity";

export const DEFAULT_DESKTOP_SERVER_URL = "http://localhost:4534";
export const DESKTOP_SERVER_URL_KEY = "musicdeck.desktop.serverUrl";
export const DESKTOP_CLOSE_TO_TRAY_KEY = "musicdeck.desktop.closeToTray";
export const DESKTOP_AUTO_UPDATE_KEY = "musicdeck.desktop.autoCheckUpdates";
export const DESKTOP_CONFIG_CHANGED_EVENT = "musicdeck:desktop-config-changed";
export const DESKTOP_OPEN_SERVER_MODAL_EVENT = "musicdeck:desktop-open-server-settings";
export const DESKTOP_MEDIA_CONTROL_EVENT = "musicdeck:desktop-media-control";
export const DESKTOP_CHECK_UPDATES_EVENT = "musicdeck:desktop-check-for-updates";

let fetchInterceptorInstalled = false;
let originalFetch = null;
let activeDesktopProxyUrl = null;
let remoteProxyUrl = null;
let runtimeSyncPromise = null;
let configSaveTail = Promise.resolve();

function isApiPath(path) {
  return /^\/api(?:\/|\?|$)/.test(path);
}

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

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Server URL is required.");
  }
  if (/[\s\\]/.test(trimmed)) {
    throw new Error("Server URL cannot contain whitespace or backslashes.");
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
  } else if (/^https?:\/\/(?:\/|$)/i.test(candidate)) {
    throw new Error("Enter a valid http:// or https:// MusicDeck server URL.");
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

function desktopApiPath(inputUrl) {
  const page = new URL(window.location.href);
  const url = new URL(inputUrl, page);
  url.hash = "";
  if (url.protocol === page.protocol && url.host === page.host) {
    const path = `${url.pathname}${url.search}`;
    if (isApiPath(path)) return path;
  }
  const path = stripDesktopApiOrigin(url.href);
  return isApiPath(path) ? path : null;
}

function abortReason(signal) {
  return signal.reason === undefined
    ? new DOMException("The operation was aborted.", "AbortError")
    : signal.reason;
}

function withAbort(signal, run, cancel) {
  if (!signal) return run();
  if (signal.aborted) throw abortReason(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(abortReason(signal));
      cancel?.();
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw abortReason(signal);
      return run();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function invokeDesktopFetch(invoke, request, signal, Channel) {
  if (!signal) return invoke("desktop_api_fetch", { request });
  let channel;
  let ready = false;
  const cancel = () => {
    if (ready) void invoke("desktop_cancel_api_fetch", { id: channel.id }).catch(() => {});
  };
  return withAbort(signal, () => {
    // Tauri may schedule the cancel command before the fetch command starts.
    // Wait for registration before sending the native cancellation.
    channel = new Channel(() => {
      ready = true;
      if (signal.aborted) cancel();
    });
    return invoke("desktop_api_fetch", { request: { ...request, cancelChannel: channel } });
  }, cancel);
}

async function fetchDesktopApi(fetch, input, init) {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const inputUrl = isRequest ? input.url : String(input);
  const path = desktopApiPath(inputUrl);
  if (!path) return fetch(input, init);

  const request = isRequest ? new Request(input, init) : null;
  const signal = request?.signal ?? init?.signal;
  if (signal?.aborted) throw abortReason(signal);
  const method = request?.method ?? init?.method ?? "GET";
  const headers = new Headers(request?.headers ?? init?.headers);
  const hasRequestBody = request && !/^(GET|HEAD)$/.test(method) && request.body !== null;
  const contentType = headers.get("content-type") ?? "";
  const isTextBody = hasRequestBody
    ? /^(?:text\/|application\/(?:[\w.-]+\+)?(?:json|xml|x-www-form-urlencoded)(?:;|$))/i.test(contentType)
    : init?.body == null || typeof init.body === "string";
  const invoke = getTauriInvoke();
  const Channel = window.__TAURI__?.core?.Channel;

  if (invoke && isTextBody && !isBinaryOrStreamApiPath(path) && (!signal || Channel)) {
    const body = hasRequestBody
      ? await withAbort(signal, () => request.clone().text())
      : init?.body ?? null;
    const response = await invokeDesktopFetch(invoke, {
      path, method, headers: Object.fromEntries(headers.entries()), body,
    }, signal, Channel);
    if (response && typeof response.status === "number") {
      const bodyless = method.toUpperCase() === "HEAD" || [204, 205, 304].includes(response.status);
      return new Response(bodyless ? null : response.body, {
        status: response.status,
        headers: response.headers,
      });
    }
  }

  const url = resolveDesktopApiUrl(path);
  if (!request) return fetch(url, { credentials: "include", ...init });
  if (url === request.url) return fetch(request);

  const body = hasRequestBody ? await withAbort(signal, () => request.blob()) : undefined;
  return fetch(url, {
    method, headers, signal, body,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode === "same-origin" ? "cors" : request.mode,
    redirect: request.redirect,
    referrerPolicy: request.referrerPolicy,
  });
}

export function stripDesktopApiOrigin(url) {
  if (typeof url !== "string" || !isDesktopRuntime()) return url;
  for (const base of [activeDesktopProxyUrl, getDesktopServerUrl()]) {
    if (base && url.startsWith(base) && isApiPath(url.slice(base.length))) {
      return url.slice(base.length);
    }
  }
  return url;
}

export function resolveDesktopApiUrl(pathOrUrl) {
  if (typeof pathOrUrl !== "string" || !isDesktopRuntime()) {
    return pathOrUrl;
  }

  if (!isApiPath(pathOrUrl)) {
    return pathOrUrl;
  }

  if (activeDesktopProxyUrl) {
    return `${activeDesktopProxyUrl}${pathOrUrl}`;
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

export function resolveRemoteSocketUrl() {
  const desktop = isDesktopRuntime();
  const base = desktop ? remoteProxyUrl : window.location.href;
  if (!base) return null;
  const url = desktop ? new URL("api/v1/remote", `${base}/`) : new URL("/api/v1/remote", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

export async function saveDesktopConfig({ serverUrl, closeToTray, autoCheckUpdates } = {}) {
  const update = {};
  if (serverUrl !== undefined) update.serverUrl = normalizeDesktopServerUrl(serverUrl);
  if (typeof closeToTray === "boolean") update.closeToTray = closeToTray;
  if (typeof autoCheckUpdates === "boolean") update.autoCheckUpdates = autoCheckUpdates;

  const save = configSaveTail.then(async () => {
    let saved;
    try {
      saved = await invokeDesktopCommand("desktop_set_config", { update });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (typeof saved?.serverUrl !== "string" || typeof saved.closeToTray !== "boolean" ||
        typeof saved.autoCheckUpdates !== "boolean") {
      throw new Error("The desktop app could not confirm that server settings were saved.");
    }
    const detail = { serverUrl: saved.serverUrl, closeToTray: saved.closeToTray, autoCheckUpdates: saved.autoCheckUpdates };
    try {
      localStorage.setItem(DESKTOP_SERVER_URL_KEY, detail.serverUrl);
      localStorage.setItem(DESKTOP_CLOSE_TO_TRAY_KEY, String(detail.closeToTray));
      localStorage.setItem(DESKTOP_AUTO_UPDATE_KEY, String(detail.autoCheckUpdates));
    } catch {
      // Native settings are already committed.
    }
    window.dispatchEvent(new CustomEvent(DESKTOP_CONFIG_CHANGED_EVENT, { detail }));
    return detail;
  });
  configSaveTail = save.catch(() => {});
  return save;
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

async function getDesktopUpdateEnvironment() {
  if (!isDesktopRuntime()) throw new Error("Updates are available in the desktop app.");
  const environment = await invokeDesktopCommand("desktop_update_environment");
  if (!environment) throw new Error("The desktop updater is unavailable.");
  return environment;
}

export async function checkDesktopUpdates() {
  let currentVersion;
  try {
    const environment = await getDesktopUpdateEnvironment();
    currentVersion = environment.currentVersion;
    if (environment.blockedReason) throw new Error(environment.blockedReason);
    const update = await check({ timeout: 10_000 });
    if (!update) return { updateAvailable: false, currentVersion };
    try {
      return { updateAvailable: true, currentVersion: update.currentVersion,
        latestVersion: update.version, notes: update.body };
    } finally {
      await update.close();
    }
  } catch (error) {
    return { updateAvailable: false, currentVersion, error: typeof error === "string"
      ? error : error?.message || "Failed to check for updates." };
  }
}

let pendingDesktopUpdate;

export async function installDesktopUpdate({ onProgress, beforeInstall } = {}) {
  if (pendingDesktopUpdate) throw new Error("An update is already in progress.");
  const install = async () => {
    const environment = await getDesktopUpdateEnvironment();
    if (environment.blockedReason) throw new Error(environment.blockedReason);
    const update = await check({ timeout: 10_000 });
    if (!update) return false;

    let downloadedBytes = 0;
    let totalBytes;
    let percentage = -1;
    try {
      await update.download(({ event, data }) => {
        if (event === "Started") {
          totalBytes = data.contentLength;
          onProgress?.({ stage: "downloading", downloadedBytes, totalBytes });
        } else if (event === "Progress" && totalBytes > 0) {
          downloadedBytes += data.chunkLength;
          const next = Math.floor(downloadedBytes / totalBytes * 100);
          if (next !== percentage) {
            percentage = next;
            onProgress?.({ stage: "downloading", downloadedBytes, totalBytes });
          }
        }
      }, { timeout: 300_000 });
      onProgress?.({ stage: "installing" });
      // The Windows installer can exit the app as soon as install is invoked.
      await beforeInstall?.();
      await update.install({ restartAfterInstall: true });
    } finally {
      await update.close().catch(() => {});
    }
    // On Windows the updater exits the old process and NSIS starts the new one.
    if (!environment.windows) {
      await relaunch();
    }
    return true;
  };
  pendingDesktopUpdate = install();
  try { return await pendingDesktopUpdate; }
  finally { pendingDesktopUpdate = undefined; }
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
  "[role='slider']",
  "[contenteditable]:not([contenteditable='false'])",
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
  if (event.currentTarget && !event.currentTarget.contains(event.target)) return;
  if (isInteractiveTitlebarTarget(event.target)) return;
  const nativeWindow = window.__TAURI__?.window?.getCurrentWindow?.();
  if (typeof nativeWindow?.startDragging === "function") {
    void nativeWindow.startDragging().catch(() => performDesktopWindowAction("start-dragging"));
  } else {
    void performDesktopWindowAction("start-dragging");
  }
}

export function handleDesktopTitlebarDoubleClick(event) {
  if (!isDesktopRuntime()) return;
  if (event.currentTarget && !event.currentTarget.contains(event.target)) return;
  if (isInteractiveTitlebarTarget(event.target)) return;
  void performDesktopWindowAction("toggle-maximize");
}

export function subscribeDesktopRuntimeEvents({
  onMediaControl,
  onOpenServerSettings,
  onCheckForUpdates,
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

  window.addEventListener(DESKTOP_MEDIA_CONTROL_EVENT, handleDomMediaControl);
  window.addEventListener(DESKTOP_OPEN_SERVER_MODAL_EVENT, handleDomOpenServer);
  window.addEventListener(DESKTOP_CHECK_UPDATES_EVENT, handleDomCheckUpdates);

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

  }

  return () => {
    disposed = true;
    window.removeEventListener(DESKTOP_MEDIA_CONTROL_EVENT, handleDomMediaControl);
    window.removeEventListener(DESKTOP_OPEN_SERVER_MODAL_EVENT, handleDomOpenServer);
    window.removeEventListener(DESKTOP_CHECK_UPDATES_EVENT, handleDomCheckUpdates);
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
  let disposed = false;
  let focusVersion = 0;
  let unlistenFocus;
  const updateFocus = (focused) => {
    if (disposed) return;
    focusVersion++;
    setDesktopForeground(focused);
  };
  const onFocus = () => updateFocus(true);
  const onBlur = () => updateFocus(false);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  updateFocus(document.hasFocus());
  try {
    const appWindow = window.__TAURI__?.window?.getCurrentWindow?.();
    if (appWindow) {
      Promise.resolve(appWindow.onFocusChanged(({ payload }) => updateFocus(payload)))
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlistenFocus = unlisten;
        }).catch(() => {});
      const initialVersion = focusVersion;
      Promise.resolve(appWindow.isFocused()).then((focused) => {
        if (focusVersion === initialVersion) updateFocus(focused);
      }).catch(() => {});
    }
  } catch {
    // DOM focus events also support older desktop shells.
  }

  if (!fetchInterceptorInstalled && typeof window.fetch === "function") {
    const fetch = window.fetch.bind(window);
    originalFetch = fetch;
    fetchInterceptorInstalled = true;

    window.fetch = (input, init) => fetchDesktopApi(fetch, input, init);
  }

  runtimeSyncPromise = Promise.resolve()
    .then(() => invokeDesktopCommand("desktop_get_config"))
    .then(async (config) => {
      if (!config || typeof config !== "object") return;
      if (typeof config.proxyUrl === "string" && config.proxyUrl.trim()) {
        activeDesktopProxyUrl = config.proxyUrl.trim().replace(/\/+$/, "");
        remoteProxyUrl = activeDesktopProxyUrl;
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
    disposed = true;
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    unlistenFocus?.();
    setDesktopForeground(null);
    if (fetchInterceptorInstalled && originalFetch) {
      window.fetch = originalFetch;
      fetchInterceptorInstalled = false;
      originalFetch = null;
    }
    activeDesktopProxyUrl = null;
    remoteProxyUrl = null;
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
