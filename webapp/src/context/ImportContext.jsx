import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { getSpotifyPlaylistImport, startSpotifyPlaylistImport } from "../api/playlists";
import { useAuth } from "./AuthContext";

const ImportContext = createContext(null);
const active = (job) => job && (job.status === "queued" || job.status === "running");

export function ImportProvider({ children }) {
  const { session } = useAuth();
  const storageKey = `musicdeck:spotify-import:${session?.id || session?.username || "user"}`;
  const [job, setJob] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [openProgressToken, setOpenProgressToken] = useState(0);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    const jobId = sessionStorage.getItem(storageKey);
    if (!jobId) return;
    getSpotifyPlaylistImport(jobId).then((restored) => {
      setJob(restored);
      setIsMinimized(true);
    }).catch(() => sessionStorage.removeItem(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!job?.id) return;
    if (active(job)) sessionStorage.setItem(storageKey, job.id);
    else sessionStorage.removeItem(storageKey);
  }, [job, storageKey]);

  useEffect(() => {
    if (!active(job)) return undefined;
    let stopped = false;
    const timer = window.setTimeout(async () => {
      try {
        const updated = await getSpotifyPlaylistImport(job.id);
        if (!stopped) setJob((current) => current?.id === updated.id ? updated : current);
      } catch {
        // Keep polling: a lost status request does not stop the server job.
        if (!stopped) setJob((current) => current ? { ...current } : current);
      }
    }, 1500);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [job]);

  useEffect(() => {
    if (!job || active(job) || !isMinimized) return;
    window.dispatchEvent(new Event("playlistsChanged"));
    setNotice(job.status === "completed"
      ? { type: "success", text: `Successfully imported '${job.playlistName}'!` }
      : { type: "error", text: job.error || "Could not import the Spotify playlist." });
    setIsMinimized(false);
  }, [job, isMinimized]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const startImport = useCallback(async (url) => {
    const started = await startSpotifyPlaylistImport(url);
    setJob(started);
    setIsMinimized(false);
    return started;
  }, []);
  const minimize = useCallback(() => {
    setIsMinimized(true);
    setNotice({ type: "success", text: "Importing playlist in the background..." });
  }, []);
  const openProgress = useCallback(() => {
    setIsMinimized(false);
    setOpenProgressToken((current) => current + 1);
  }, []);

  return <ImportContext.Provider value={{ job, isMinimized, openProgressToken, startImport, minimize, openProgress, setNotice }}>
    {children}
    {notice && <div className={`playlist-notice playlist-notice--${notice.type}`} role={notice.type === "error" ? "alert" : "status"}>{notice.text}</div>}
  </ImportContext.Provider>;
}

export function useImport() {
  const value = useContext(ImportContext);
  if (!value) throw new Error("useImport must be used inside ImportProvider");
  return value;
}
