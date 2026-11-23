import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { cancelSpotifyPlaylistImport, getSpotifyPlaylistImport, startSpotifyPlaylistImport } from "../api/playlists";
import { useAuth } from "./AuthContext";
import { assertBrowserIntegrationAllowed } from "../services/privacyPolicy";

const ImportContext = createContext(null);
const active = (job) => job && (job.status === "queued" || job.status === "running");

function watchImport(jobId, { initialDelay, onJob, onUnavailable, onRetrying }) {
  const controller = new AbortController();
  let timer;
  let failures = 0;
  async function refresh() {
    try {
      const job = await getSpotifyPlaylistImport(jobId, controller.signal);
      if (controller.signal.aborted) return;
      if (!job?.status) throw new Error("Missing import status");
      failures = 0;
      onRetrying(false);
      if (!onJob(job)) return;
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error.status === 403 || error.status === 404) {
        onRetrying(false);
        onUnavailable();
        return;
      }
      failures += 1;
      onRetrying(true);
    }
    timer = window.setTimeout(refresh, Math.min(10000, 1500 * 2 ** failures));
  }
  if (initialDelay) timer = window.setTimeout(refresh, initialDelay);
  else void refresh();
  return () => { controller.abort(); window.clearTimeout(timer); };
}

export function ImportProvider({ children }) {
  const { session } = useAuth();
  const storageKey = `musicdeck:spotify-import:${session?.id || session?.username || "user"}`;
  const [job, setJob] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [openProgressToken, setOpenProgressToken] = useState(0);
  const [notice, setNotice] = useState(null);
  const [statusRetrying, setStatusRetrying] = useState(false);

  useEffect(() => {
    const jobId = sessionStorage.getItem(storageKey);
    if (!jobId) return;
    return watchImport(jobId, {
      onJob: (restored) => {
        setJob(restored);
        setIsMinimized(true);
        return false;
      },
      onUnavailable: () => sessionStorage.removeItem(storageKey),
      onRetrying: setStatusRetrying,
    });
  }, [storageKey]);

  useEffect(() => {
    if (!job?.id) return;
    if (active(job)) sessionStorage.setItem(storageKey, job.id);
    else sessionStorage.removeItem(storageKey);
  }, [job, storageKey]);

  const activeJobId = active(job) ? job.id : null;
  useEffect(() => {
    if (!activeJobId) return undefined;
    return watchImport(activeJobId, {
      initialDelay: 1500,
      onJob: (updated) => {
        setJob((current) => current?.id === updated.id && active(current) ? updated : current);
        return active(updated);
      },
      onUnavailable: () => setJob((current) => current?.id === activeJobId && active(current)
        ? { ...current, status: "failed", error: "This import is no longer available." } : current),
      onRetrying: setStatusRetrying,
    });
  }, [activeJobId]);

  useEffect(() => {
    if (!job || active(job) || !isMinimized) return;
    if (job.playlistId && (job.status === "completed" || job.status === "partial")) {
      window.dispatchEvent(new Event("playlistsChanged"));
      setNotice({
        type: job.status === "partial" ? "warning" : "success",
        text: job.status === "partial"
          ? job.error || `Only part of '${job.playlistName}' could be imported.`
          : `Successfully imported '${job.playlistName}'!`,
        playlistId: job.playlistId,
        trackErrors: job.trackErrors,
      });
    } else {
      setNotice({
        type: job.status === "cancelled" ? "status" : "error",
        text: job.error || "Could not import the Spotify playlist.",
        playlistId: job.playlistId,
        trackErrors: job.trackErrors,
      });
    }
    setIsMinimized(false);
  }, [job, isMinimized]);

  useEffect(() => {
    if (!notice || notice.playlistId || notice.trackErrors?.length) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const startImport = useCallback(async (url, timeout) => {
    assertBrowserIntegrationAllowed("imports");
    const started = await startSpotifyPlaylistImport(url, timeout);
    setStatusRetrying(false);
    setNotice(null);
    setJob(started);
    setIsMinimized(false);
    return started;
  }, []);
  const cancelImport = useCallback(async () => {
    if (!activeJobId) return;
    const cancelled = await cancelSpotifyPlaylistImport(activeJobId);
    setStatusRetrying(false);
    setJob((current) => current?.id === cancelled.id && active(current) ? cancelled : current);
  }, [activeJobId]);
  const minimize = useCallback(() => {
    setIsMinimized(true);
    setNotice({ type: "success", text: "Importing playlist in the background..." });
  }, []);
  const openProgress = useCallback(() => {
    setIsMinimized(false);
    setOpenProgressToken((current) => current + 1);
  }, []);

  return <ImportContext.Provider value={{ job, isMinimized, statusRetrying, openProgressToken, startImport, cancelImport, minimize, openProgress, setNotice }}>
    {children}
    {statusRetrying && (!job || isMinimized) && !notice && <div className="playlist-notice playlist-notice--warning" role="status">
      Could not refresh playlist import status. Reconnecting…
    </div>}
    {notice && <div className={`playlist-notice playlist-notice--${notice.type}`} role={notice.type === "error" ? "alert" : "status"}>
      {notice.text}
      {notice.trackErrors?.length > 0 && <details>
        <summary>Track errors ({notice.trackErrors.length})</summary>
        <ul>{notice.trackErrors.map(({ position, title, message }) => <li key={position}>{title || `Track ${position}`} · {message}</li>)}</ul>
      </details>}
      {(notice.playlistId || notice.trackErrors?.length > 0) && <div className="playlist-notice-actions">
        {notice.playlistId && <Link to={`/playlist/${encodeURIComponent(notice.playlistId)}`} onClick={() => setNotice(null)}>Open playlist</Link>}
        <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
      </div>}
    </div>}
  </ImportContext.Provider>;
}

export function useImport() {
  const value = useContext(ImportContext);
  if (!value) throw new Error("useImport must be used inside ImportProvider");
  return value;
}
