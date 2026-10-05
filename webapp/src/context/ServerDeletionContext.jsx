import { createContext, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { deleteServerAlbum, deleteServerTrack } from "../api/adminMedia";
import { useAuth } from "./AuthContext";

const ServerDeletionContext = createContext(null);

export function ServerDeletionProvider({ children }) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState(null);
  const [deletedTracks, setDeletedTracks] = useState(() => new Set());
  const [deletedAlbums, setDeletedAlbums] = useState(() => new Set());

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!target || busy) return undefined;
    const dismissOnEscape = (event) => {
      if (event.key === "Escape") setTarget(null);
    };
    window.addEventListener("keydown", dismissOnEscape);
    return () => window.removeEventListener("keydown", dismissOnEscape);
  }, [target, busy]);

  const open = (kind, item) => {
    if (session?.role !== "admin" || !item?.id) return;
    setError("");
    setTarget({ kind, id: item.id, title: item.title || item.name || "Untitled" });
  };

  const confirm = async () => {
    if (!target || busy || session?.role !== "admin") return;
    setBusy(true);
    setError("");
    try {
      const result = target.kind === "track" ? await deleteServerTrack(target.id) : await deleteServerAlbum(target.id);
      const trackIds = target.kind === "track" ? [target.id] : result.trackIds || [];
      if (target.kind === "track") setDeletedTracks((current) => new Set([...current, target.id]));
      else {
        setDeletedAlbums((current) => new Set([...current, target.id]));
        setDeletedTracks((current) => new Set([...current, ...trackIds]));
      }
      window.dispatchEvent(new CustomEvent("musicdeck:server-deleted", {
        detail: { trackIds, albumId: target.kind === "album" ? target.id : null },
      }));
      setToast({ type: result.warning ? "error" : "success", text: result.warning || (target.kind === "track" ? "Track deleted from server." : "Album deleted from server.") });
      if (target.kind === "album" && location.pathname === `/album/${target.id}`) navigate("/library/albums");
      setTarget(null);
    } catch (failure) {
      setError(failure.message || "Could not delete the file from the server.");
    } finally {
      setBusy(false);
    }
  };

  return <ServerDeletionContext.Provider value={{ openTrack: (item) => open("track", item), openAlbum: (item) => open("album", item), deletedTracks, deletedAlbums }}>
    {children}
    {target && createPortal(
      <div className="server-delete-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setTarget(null); }}>
        <section className="server-delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="server-delete-title" aria-describedby="server-delete-description">
          <h2 id="server-delete-title">{target.kind === "track" ? "Permanently Delete File?" : "Permanently Delete Album?"}</h2>
          <p id="server-delete-description">This action cannot be undone. This will permanently remove '{target.title}' {target.kind === "track" ? "from your server's storage." : "and its tracks from your server's storage."}</p>
          {error && <p className="server-delete-error" role="alert">{error}</p>}
          <div className="server-delete-actions">
            <button type="button" onClick={() => setTarget(null)} disabled={busy} autoFocus>Cancel</button>
            <button type="button" className="server-delete-confirm" onClick={confirm} disabled={busy}>{busy ? "Deleting..." : target.kind === "track" ? "Delete File" : "Delete Album"}</button>
          </div>
        </section>
      </div>, document.body
    )}
    {toast && createPortal(<div className={`playlist-notice playlist-notice--${toast.type}`} role={toast.type === "error" ? "alert" : "status"}>{toast.text}</div>, document.body)}
  </ServerDeletionContext.Provider>;
}

export const useServerDeletion = () => useContext(ServerDeletionContext);
