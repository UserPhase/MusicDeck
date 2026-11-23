import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";

import PlaylistFolderTree from "./playlists/PlaylistFolderTree";
import PlaylistSearchHighlight from "./playlists/PlaylistSearchHighlight";
import MixBuilderModal from "./discovery/MixBuilderModal";
import { normalizePlaylistSearch } from "../utils/playlistSearch";

import {
  getPlaylists,
  createPlaylist,
} from "../api/playlists";
import { useAuth } from "../context/AuthContext";
import { useImport } from "../context/ImportContext";
import { downloadPhaseLabels } from "../services/downloadStatus";
import { usePrivacy } from "../context/PrivacyContext";
import { useLikedAlbums } from "../hooks/useLikedAlbums";
import { DiscoveryArtwork } from "./DiscoveryCards";
import { useSmartPlaylists } from "../hooks/useSmartPlaylists";
import { useVisualViewportBounds } from "../hooks/useVisualViewportBounds";
import SmartPlaylistBuilder from "./SmartPlaylistBuilder";

const navigation = [
  { to: "/explore", label: "Discover", icon: "◇" },
  { to: "/new-releases", label: "New Releases", icon: "◎" },
  { to: "/saved-discoveries", label: "Saved Discoveries", icon: "☆" },
  { to: "/library/playlists", label: "Library", icon: "♫" },
  { to: "/liked", label: "Liked Songs", icon: "♡" },
];
const navigationItems = navigation.map(item => ({ ...item, id: item.to }));
function useSidebarOrder(items, group, owner) {
  const key = `musicdeck:sidebar-${group}:${owner}`;
  const mime = `application/x-musicdeck-sidebar-${group}`;
  const [preference, setPreference] = useState(null);
  const [dropMarker, setDropMarker] = useState(null);
  const dragged = useRef(null);
  useEffect(() => {
    let ids = [];
    try {
      const stored = JSON.parse(localStorage.getItem(key) || "null");
      if (Array.isArray(stored)) ids = stored.filter(id => typeof id === "string");
    } catch { /* Use the default order when browser storage is unavailable. */ }
    setPreference({ key, ids });
  }, [key]);
  const byId = new Map(items.map(item => [String(item.id), item]));
  const ids = [...new Set([...(preference?.key === key ? preference.ids.filter(id => byId.has(id)) : []), ...byId.keys()])];
  function move(id, position) {
    const from = ids.indexOf(id);
    if (from < 0 || position < 0 || position >= ids.length || position === from) return;
    const order = [...ids];
    order.splice(from, 1);
    order.splice(position, 0, id);
    setPreference({ key, ids: order });
    try { localStorage.setItem(key, JSON.stringify(order)); } catch { /* Keep the order for this session. */ }
  }
  function dragProps(itemId) {
    const id = String(itemId);
    const edge = event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      return event.clientY > bounds.top + bounds.height / 2 ? "after" : "before";
    };
    return {
      draggable: true,
      "data-sidebar-drop": dropMarker?.id === id ? dropMarker.edge : undefined,
      "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
      onKeyDown: event => {
        if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        move(id, ids.indexOf(id) + (event.key === "ArrowUp" ? -1 : 1));
      },
      onDragStart: event => {
        dragged.current = id;
        event.dataTransfer.clearData?.();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(mime, id);
      },
      onDragOver: event => {
        if (!event.dataTransfer.types.includes(mime) || !dragged.current || dragged.current === id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const side = edge(event);
        setDropMarker(current => current?.id === id && current.edge === side ? current : { id, edge: side });
      },
      onDragLeave: event => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDropMarker(current => current?.id === id ? null : current);
      },
      onDragEnd: () => { dragged.current = null; setDropMarker(null); },
      onDrop: event => {
        if (!event.dataTransfer.types.includes(mime)) return;
        event.preventDefault();
        setDropMarker(null);
        const source = event.dataTransfer.getData(mime);
        const from = ids.indexOf(source), to = ids.indexOf(id);
        if (from < 0 || from === to) return;
        const after = edge(event) === "after";
        move(source, to + Number(after) - Number(from < to));
      },
    };
  }
  return { items: ids.map(id => byId.get(id)), dragProps };
}

export function isSpotifyPlaylistUrl(value) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.hostname === "open.spotify.com" && !url.port && !url.username && !url.password &&
      /^\/playlist\/[a-zA-Z0-9]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function Sidebar({ id }) {
  const { canImport } = usePrivacy();
  const likedAlbums = useLikedAlbums();
  const smartPlaylists = useSmartPlaylists();

  const location = useLocation();
  const owner = useAuth()?.session?.id ?? "anonymous";
  const orderedNavigation = useSidebarOrder(navigationItems, "navigation", owner);
  const orderedSmart = useSidebarOrder(smartPlaylists.items, "smart-playlists", owner);
  const orderedAlbums = useSidebarOrder(likedAlbums.albums, "liked-albums", owner);

  const navigate = useNavigate();
  const [cancelPending, setCancelPending] = useState(false);
  const { job: importJob, statusRetrying, openProgressToken, startImport, cancelImport, minimize } = useImport();
  const importStage = importJob?.stage;
  const isScanStage = importStage === "scan" || importStage === "scanning";
  const waiting = importStage === "provider_cooldown" || importStage === "retry_wait";
  const trackTotal = (waiting || ["download", "downloading", "conversion"].includes(importStage)) ? importJob?.expectedCount : undefined;
  const tracksDownloaded = Math.min(importJob?.downloadedCount || 0, trackTotal || 0);

  const [playlists, setPlaylists] = useState([]);

  const [loading, setLoading] = useState(true);
  const [modalStep, setModalStep] = useState(null);
  const [playlistName, setPlaylistName] = useState("");
  const [description, setDescription] = useState("");
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [timeoutMode, setTimeoutMode] = useState("auto");
  const [timeoutMinutes, setTimeoutMinutes] = useState("60");
  const [timeoutError, setTimeoutError] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const triggerRef = useRef(null);
  const modalRef = useRef(null);
  const modalBackdropRef = useRef(null);
  useVisualViewportBounds(modalBackdropRef, Boolean(modalStep && modalStep !== "advanced-mix"));
  const handledImportRef = useRef(null);
  const lastOpenTokenRef = useRef(openProgressToken);

  useEffect(() => {
    if (openProgressToken !== lastOpenTokenRef.current) {
      lastOpenTokenRef.current = openProgressToken;
      setModalStep("progress");
    }
  }, [openProgressToken]);


  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!modalStep || modalStep === "advanced-mix") return undefined;
    modalRef.current?.focus();
  }, [modalStep]);

  useEffect(() => {
    if (!modalStep || modalStep === "advanced-mix") return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape" && !busy) {
        if (modalStep === "progress" && importJob && (importJob.status === "queued" || importJob.status === "running")) minimize();
        setModalStep(null);
        triggerRef.current?.focus();
      } else if (event.key === "Tab") {
        const focusable = [...(modalRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]') || [])];
        if (!focusable.length) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!focusable.includes(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [modalStep, busy, importJob, minimize]);


  /*
   * Load MusicDeck-owned playlists (including provider imports).
   *
   * Single source of truth: used for the initial load and
   * for reloads triggered by the "playlistsChanged" event.
   */

  const loadPlaylists = useCallback(
    async () => {

      try {

        const data = await getPlaylists();

        setPlaylists(data || []);

      } catch (error) {

        console.error(
          "Could not load playlists:",
          error
        );

      } finally {

        setLoading(false);

      }

    },
    []
  );

  useEffect(() => {
    if (modalStep !== "progress" || !importJob || (importJob.status === "queued" || importJob.status === "running") || handledImportRef.current === importJob.id) return;
    handledImportRef.current = importJob.id;
    if ((importJob.status === "completed" || importJob.status === "partial") && importJob.playlistId) {
      loadPlaylists();
      window.dispatchEvent(new Event("playlistsChanged"));
      setModalStep(null);
      setNotice(importJob.status === "partial"
        ? { type: "warning", text: importJob.error || `Only part of '${importJob.playlistName}' could be imported.`, trackErrors: importJob.trackErrors }
        : { type: "success", text: `Successfully imported '${importJob.playlistName}'!` });
      navigate(`/playlist/${encodeURIComponent(importJob.playlistId)}`);
    } else {
      setNotice({ type: importJob.status === "cancelled" ? "success" : "error", text: importJob.error || "Could not import the Spotify playlist.", trackErrors: importJob.trackErrors });
      setModalStep(importJob.status === "cancelled" ? null : "import");
    }
  }, [importJob, modalStep, loadPlaylists, navigate, setNotice]);

  useEffect(() => {

    loadPlaylists();


    // Reload when a playlist is
    // created/deleted elsewhere
    function handlePlaylistsChanged() {
      loadPlaylists();
    }


    window.addEventListener(
      "playlistsChanged",
      handlePlaylistsChanged
    );


    return () => {

      window.removeEventListener(
        "playlistsChanged",
        handlePlaylistsChanged
      );

    };

  }, [loadPlaylists]);

  /*
   * Create playlist
   */

  const handleAddPlaylist = useCallback((trigger) => {
    triggerRef.current = trigger;
    setModalStep(importJob && (importJob.status === "queued" || importJob.status === "running") ? "progress" : "choose");
    setPlaylistName("");
    setDescription("");
    setPlaylistUrl("");
    setTimeoutMode("auto");
    setTimeoutMinutes("60");
    setTimeoutError("");
    setFormError("");
  }, [importJob]);

  useEffect(() => {
    const open = (event) => handleAddPlaylist(event.detail);
    window.addEventListener("musicdeck:open-playlist-creator", open);
    return () => window.removeEventListener("musicdeck:open-playlist-creator", open);
  }, [handleAddPlaylist]);

  function closeModal() {
    if (busy) return;
    if (modalStep === "progress" && importJob && (importJob.status === "queued" || importJob.status === "running")) minimize();
    setModalStep(null);
    triggerRef.current?.focus();
  }

  async function handleCreatePlaylist(event) {
    event.preventDefault();
    const trimmedName = playlistName.trim();
    if (!trimmedName) {
      setFormError("Playlist name is required.");
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const playlist = await createPlaylist(trimmedName, description.trim());
      if (playlist) {
        setPlaylists((current) => [...current, playlist]);
      } else {
        await loadPlaylists();
      }
      window.dispatchEvent(new Event("playlistsChanged"));
      setModalStep(null);
      triggerRef.current?.focus();
      setNotice({ type: "success", text: `Created '${trimmedName}'.` });
    } catch (error) {
      setNotice({ type: "error", text: error.message || "Could not create playlist." });
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelImport() {
    if (cancelPending) return;
    setCancelPending(true);
    setFormError("");
    try {
      await cancelImport();
    } catch (error) {
      setFormError(error.message || "Could not cancel the import. You can try again.");
    } finally {
      setCancelPending(false);
    }
  }

  async function handleImportPlaylist(event) {
    event.preventDefault();
    if (!isSpotifyPlaylistUrl(playlistUrl)) {
      setFormError("Please enter a valid open.spotify.com/playlist URL");
      return;
    }
    setFormError("");
    const minutes = Number(timeoutMinutes);
    if (timeoutMode === "manual" && (!Number.isInteger(minutes) || minutes < 1 || minutes > 120)) {
      setTimeoutError("Enter a maximum download time between 1 and 120 minutes.");
      return;
    }
    setTimeoutError("");
    setBusy(true);
    try {
      const timeout = timeoutMode === "manual" ? { mode: "manual", minutes } : { mode: "auto" };
      await startImport(playlistUrl.trim(), timeout);
      setModalStep("progress");
    } catch (error) {
      setNotice({ type: "error", text: error.message || "Could not import the Spotify playlist." });
    } finally {
      setBusy(false);
    }
  }


  return (

    <aside id={id} className="sidebar" aria-label="Main navigation">
      <section className="nav-section" aria-labelledby="library-navigation">
        <h2 className="nav-title" id="library-navigation">Your Library</h2>

        {orderedNavigation.items.map(({ to: path, label, icon }) => {
          const active = path === "/library/playlists" ? location.pathname.startsWith("/library") : location.pathname === path;
          return <Link key={path} to={path} className={`nav-item sidebar-reorderable${active ? " active" : ""}`}
            aria-current={active ? "page" : undefined} {...orderedNavigation.dragProps(path)}>
            <span className="nav-icon" aria-hidden="true">{icon}</span>
            <span className="nav-label">{label}</span>
          </Link>;
        })}
      </section>

      <section className="nav-section playlists-section" aria-label="Playlists">
        <div className="playlist-list">
          <PlaylistFolderTree
            loading={loading}
            playlists={playlists}
            onAddPlaylist={handleAddPlaylist}
            extraItems={tokens => {
              const matches = item => {
                const name = normalizePlaylistSearch(item.name || "");
                return tokens.every(token => name.includes(token));
              };
              return [
                ...(smartPlaylists.error ? [<div key="smart-error" className="nav-loading" role="status">Could not load smart playlists.
                  <button type="button" onClick={() => { void smartPlaylists.refresh(); }}>Retry</button>
                </div>] : []),
                ...orderedSmart.items.filter(matches).map(playlist => {
                  const href = `/smart-playlist/${encodeURIComponent(playlist.id)}`;
                  return <Link key={playlist.id} to={href} className={`nav-item playlist-nav-item sidebar-reorderable ${location.pathname === href ? "active" : ""}`}
                    aria-current={location.pathname === href ? "page" : undefined} title={`${playlist.name} · Smart playlist`} {...orderedSmart.dragProps(playlist.id)}>
                    <span className="nav-icon nav-icon-playlist smart-playlist-mark" aria-hidden="true">✦</span>
                    <span className="nav-label"><PlaylistSearchHighlight text={playlist.name} tokens={tokens} /></span>
                  </Link>;
                }),
                ...orderedAlbums.items.filter(matches).map(album => {
                  const href = `/album/${encodeURIComponent(album.id)}`;
                  return <Link key={`album:${album.id}`} to={href} className={`nav-item playlist-nav-item sidebar-reorderable ${location.pathname === href ? "active" : ""}`}
                    aria-current={location.pathname === href ? "page" : undefined} title={`${album.name} · Album`} {...orderedAlbums.dragProps(album.id)}>
                    <span className="nav-icon nav-icon-playlist" aria-hidden="true"><DiscoveryArtwork item={album} /></span>
                    <span className="nav-label"><PlaylistSearchHighlight text={album.name} tokens={tokens} /></span>
                  </Link>;
                }),
              ];
            }}
          />
        </div>
      </section>
      {modalStep === "advanced-mix" && <MixBuilderModal open onClose={closeModal} />}
      {modalStep && modalStep !== "advanced-mix" && createPortal(
        <div ref={modalBackdropRef} className="playlist-modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeModal();
        }}>
          <section className={`playlist-modal${modalStep === "smart" ? " playlist-modal--smart" : ""}`} role="dialog" aria-modal="true" aria-labelledby="playlist-modal-title" ref={modalRef} tabIndex={-1}>
            <div className="playlist-modal-heading">
              <div>
                <span className="playlist-modal-eyebrow">YOUR LIBRARY / PLAYLISTS</span>
                <h2 id="playlist-modal-title">{modalStep === "choose" ? "Create New Playlist" : modalStep === "blank" ? "Blank Playlist" : modalStep === "smart" ? "Make a mix" : modalStep === "progress" ? "Importing Playlist..." : "Import Spotify Playlist"}</h2>
              </div>
              <button className="playlist-modal-close" type="button" onClick={closeModal} disabled={busy} aria-label="Close playlist dialog">×</button>
            </div>

            {modalStep === "choose" ? (
              <div className="playlist-modal-body">
                <p className="playlist-modal-intro">Choose how you'd like to get started.</p>
                <div className="playlist-modal-options">
                  <button type="button" className="playlist-modal-option" onClick={() => setModalStep("blank")} autoFocus>
                    <span className="playlist-modal-option-icon" aria-hidden="true">＋</span>
                    <strong>Blank Playlist</strong>
                    <span>Create from scratch</span>
                    <span className="playlist-modal-option-arrow" aria-hidden="true">↗</span>
                  </button>
                  <button type="button" className="playlist-modal-option" onClick={() => setModalStep("smart")}>
                    <span className="playlist-modal-option-icon" aria-hidden="true">✦</span>
                    <strong>Make a mix</strong><span>Find the right songs, automatically</span>
                    <span className="playlist-modal-option-arrow" aria-hidden="true">↗</span>
                  </button>
                  {canImport && <button type="button" className="playlist-modal-option" onClick={() => setModalStep("import")}>
                    <span className="playlist-modal-option-icon" aria-hidden="true">♫</span>
                    <strong>Import Spotify Playlist</strong>
                    <span>Import via URL</span>
                    <span className="playlist-modal-option-arrow" aria-hidden="true">↗</span>
                  </button>}
                </div>
              </div>
            ) : modalStep === "smart" ? <div className="playlist-modal-body">
              <button type="button" className="playlist-modal-back" disabled={busy} onClick={() => setModalStep("choose")}>Back</button>
              <button type="button" className="playlist-modal-back" disabled={busy} onClick={() => setModalStep("advanced-mix")}>Advanced mix</button>
              <SmartPlaylistBuilder onBusyChange={setBusy} onSaved={(playlist, kind) => {
                setModalStep(null); setBusy(false); triggerRef.current?.focus();
                navigate(`/${kind === "playlist" ? "playlist" : "smart-playlist"}/${encodeURIComponent(playlist.id)}`);
              }} />
            </div> : modalStep === "import" && !canImport ? (
              <div className="playlist-modal-body"><p className="playlist-modal-intro" role="status">Spotify imports are disabled by server privacy policy.</p></div>
            ) : modalStep === "blank" ? (
              <form className="playlist-modal-form" onSubmit={handleCreatePlaylist}>
                <div className="playlist-modal-fields">
                  <label htmlFor="new-playlist-name">Playlist name <span aria-hidden="true">*</span></label>
                  <input id="new-playlist-name" value={playlistName} onChange={(event) => setPlaylistName(event.target.value)} placeholder="Give it a name" maxLength={200} autoFocus required />
                  <label htmlFor="new-playlist-description">Description <span className="playlist-modal-optional">Optional</span></label>
                  <textarea id="new-playlist-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What belongs in this playlist?" rows={3} maxLength={1000} />
                  {formError && <p className="playlist-modal-error" role="alert">{formError}</p>}
                </div>
                <div className="playlist-modal-actions">
                  <button type="button" className="playlist-modal-back" onClick={() => setModalStep("choose")} disabled={busy}>Back</button>
                  <button type="submit" className="playlist-modal-submit" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
                </div>
              </form>
            ) : modalStep === "progress" ? (
              <div className="playlist-import-progress" role="status" aria-live="polite">
                <div className="playlist-modal-fields">
                  <p className="playlist-modal-intro">{importJob?.playlistName || "Your Spotify playlist"}</p>
                  <div className="playlist-import-counter">
                    {waiting ? downloadPhaseLabels[importStage]
                      : isScanStage ? "Scanning your music library..."
                      : importStage === "playlist_creation" ? "Creating your playlist..."
                      : importStage === "conversion" ? "Converting audio..."
                      : importStage === "queued" ? "Waiting to start download..."
                      : trackTotal ? `Downloading track ${importJob.currentTrack || Math.min(tracksDownloaded + 1, trackTotal)} of ${trackTotal}`
                      : "Fetching playlist details and downloading tracks..."}
                  </div>
                  {statusRetrying && <p role="status">Could not refresh playlist import status. Reconnecting…</p>}
                  <div className="playlist-import-track">
                    {importJob?.currentTrackName ? `Fetching: ${importJob.currentTrackName}`
                      : trackTotal ? `${tracksDownloaded} of ${trackTotal} tracks downloaded`
                      : isScanStage ? importJob?.importedCount ? `${importJob.importedCount} tracks indexed` : "Matching the audio files in Navidrome."
                      : importStage === "playlist_creation" ? "Saving tracks in playlist order." : "Preparing tracks..."}
                  </div>
                  <div className={`playlist-import-bar${!trackTotal ? " is-indeterminate" : ""}`} role="progressbar" aria-label="Playlist import progress" aria-valuemin={0} aria-valuemax={trackTotal || undefined} aria-valuenow={trackTotal ? tracksDownloaded : undefined}>
                    <span style={{ width: trackTotal ? `${100 * tracksDownloaded / trackTotal}%` : "35%" }} />
                  </div>
                  {formError && <p className="playlist-modal-error" role="alert">{formError}</p>}
                </div>
                <div className="playlist-modal-actions">
                  <button type="button" className="playlist-modal-back" disabled={cancelPending} onClick={handleCancelImport}>{cancelPending ? "Cancelling..." : "Cancel import"}</button>
                  <button type="button" className="playlist-modal-submit" onClick={closeModal} disabled={cancelPending}>Run in Background</button>
                </div>
              </div>
            ) : (
              <form className="playlist-modal-form" onSubmit={handleImportPlaylist} noValidate>
                <div className="playlist-modal-fields">
                  <p className="playlist-modal-intro">Paste a public Spotify playlist link. MusicDeck will download its songs and add the playlist to your library.</p>
                  <label htmlFor="spotify-playlist-url">Spotify playlist URL</label>
                  <input id="spotify-playlist-url" type="url" value={playlistUrl} onChange={(event) => { setPlaylistUrl(event.target.value); setFormError(""); }} placeholder="https://open.spotify.com/playlist/..." aria-invalid={Boolean(formError)} aria-describedby={formError ? "spotify-url-error" : undefined} autoFocus disabled={busy} />
                  {formError && <p id="spotify-url-error" className="playlist-modal-error" role="alert">{formError}</p>}
                  <label htmlFor="spotify-import-timeout-mode">Download timeout</label>
                  <select id="spotify-import-timeout-mode" value={timeoutMode} onChange={(event) => { setTimeoutMode(event.target.value); setTimeoutError(""); }} aria-describedby="spotify-import-timeout-help" disabled={busy}>
                    <option value="auto">Auto</option>
                    <option value="manual">Manual</option>
                  </select>
                  <p id="spotify-import-timeout-help" className="playlist-modal-help">
                    {timeoutMode === "auto"
                      ? "Adapts to playlist size and progress, up to 6 hours."
                      : "Choose a limit from 1 to 120 minutes."}
                    {" A stalled download stops within 15 minutes. Scanning and playlist creation have separate limits."}
                  </p>
                  {timeoutMode === "manual" && <>
                    <label htmlFor="spotify-import-timeout-minutes">Maximum download time (minutes)</label>
                    <input id="spotify-import-timeout-minutes" type="number" min="1" max="120" step="1" required value={timeoutMinutes} onChange={(event) => { setTimeoutMinutes(event.target.value); setTimeoutError(""); }} aria-invalid={Boolean(timeoutError)} aria-describedby={timeoutError ? "spotify-import-timeout-error" : undefined} disabled={busy} />
                    {timeoutError && <p id="spotify-import-timeout-error" className="playlist-modal-error" role="alert">{timeoutError}</p>}
                  </>}
                  {busy && <p className="playlist-modal-progress" role="status"><span className="playlist-modal-spinner" aria-hidden="true" />Fetching playlist details and queueing download...</p>}
                </div>
                <div className="playlist-modal-actions">
                  <button type="button" className="playlist-modal-back" onClick={() => setModalStep("choose")} disabled={busy}>Back</button>
                  <button type="submit" className="playlist-modal-submit" disabled={busy}>{busy ? "Importing…" : "Import & Download"}</button>
                </div>
              </form>
            )}
          </section>
        </div>, document.body
      )}
      {notice && createPortal(<div className={`playlist-notice playlist-notice--${notice.type}`} role={notice.type === "error" ? "alert" : "status"}>{notice.text}</div>, document.body)}
    </aside>

  );

}


export default Sidebar;
