import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import PlaylistCover from "./PlaylistCover";

import {
  getPlaylists,
  createPlaylist,
  startSpotifyPlaylistImport,
  getSpotifyPlaylistImport,
} from "../api/playlists";

export function isSpotifyPlaylistUrl(value) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.hostname === "open.spotify.com" && !url.port && !url.username && !url.password &&
      /^\/playlist\/[a-zA-Z0-9]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function Sidebar() {

  const location = useLocation();
  const navigate = useNavigate();

  const [playlists, setPlaylists] = useState([]);

  const [loading, setLoading] = useState(true);
  const [modalStep, setModalStep] = useState(null);
  const [playlistName, setPlaylistName] = useState("");
  const [description, setDescription] = useState("");
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const triggerRef = useRef(null);
  const modalRef = useRef(null);
  const importAttemptRef = useRef(0);

  useEffect(() => () => { importAttemptRef.current += 1; }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!modalStep) return undefined;
    if (busy) modalRef.current?.focus();
    const closeOnEscape = (event) => {
      if (event.key === "Escape" && !busy) {
        setModalStep(null);
        triggerRef.current?.focus();
      } else if (event.key === "Tab") {
        const focusable = [...(modalRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled])') || [])];
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
  }, [modalStep, busy]);


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

  function handleAddPlaylist(event) {
    triggerRef.current = event.currentTarget;
    setModalStep("choose");
    setPlaylistName("");
    setDescription("");
    setPlaylistUrl("");
    setFormError("");
  }

  function closeModal() {
    if (busy) return;
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
      setNotice({ type: "success", text: `Created '${trimmedName}'.` });
    } catch (error) {
      setNotice({ type: "error", text: error.message || "Could not create playlist." });
    } finally {
      setBusy(false);
    }
  }

  async function handleImportPlaylist(event) {
    event.preventDefault();
    if (!isSpotifyPlaylistUrl(playlistUrl)) {
      setFormError("Please enter a valid open.spotify.com/playlist URL");
      return;
    }
    setFormError("");
    setBusy(true);
    const attempt = ++importAttemptRef.current;
    try {
      let job = await startSpotifyPlaylistImport(playlistUrl.trim());
      while ((job.status === "queued" || job.status === "running") && importAttemptRef.current === attempt) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        if (importAttemptRef.current !== attempt) return;
        job = await getSpotifyPlaylistImport(job.id);
      }
      if (importAttemptRef.current !== attempt) return;
      if ((job.status !== "completed" && job.status !== "partial") || !job.playlistId) {
        throw new Error(job.error || "Could not import the Spotify playlist.");
      }
      await loadPlaylists();
      window.dispatchEvent(new Event("playlistsChanged"));
      setModalStep(null);
      setNotice(job.status === "partial"
        ? { type: "error", text: job.error || `Only part of '${job.playlistName}' could be imported.` }
        : { type: "success", text: `Successfully imported '${job.playlistName}'!` });
      navigate(`/playlist/${encodeURIComponent(job.playlistId)}`);
    } catch (error) {
      if (importAttemptRef.current === attempt) {
        setNotice({ type: "error", text: error.message || "Could not import the Spotify playlist." });
      }
    } finally {
      if (importAttemptRef.current === attempt) setBusy(false);
    }
  }


  return (

    <aside className="sidebar" aria-label="Main navigation">
      <section className="nav-section" aria-labelledby="library-navigation">
        <h2 className="nav-title" id="library-navigation">Your Library</h2>

        <Link
          to="/explore"
          className={`nav-item ${location.pathname === "/explore" ? "active" : ""}`}
          aria-current={location.pathname === "/explore" ? "page" : undefined}
        >
          <span className="nav-icon" aria-hidden="true">◇</span>
          <span className="nav-label">Explore</span>
        </Link>

        <Link
          to="/library/playlists"
          className={`nav-item ${location.pathname.startsWith("/library") ? "active" : ""}`}
          aria-current={location.pathname.startsWith("/library") ? "page" : undefined}
        >
          <span className="nav-icon" aria-hidden="true">♫</span>
          <span className="nav-label">Library</span>
        </Link>

        <Link
          to="/liked"
          className={`nav-item ${location.pathname === "/liked" ? "active" : ""}`}
          aria-current={location.pathname === "/liked" ? "page" : undefined}
        >
          <span className="nav-icon" aria-hidden="true">♡</span>
          <span className="nav-label">Liked Songs</span>
        </Link>
      </section>

      <section className="nav-section playlists-section" aria-labelledby="playlist-navigation">
        <div className="nav-section-heading">
          <h2 className="nav-title" id="playlist-navigation">Playlists</h2>
          <button
            className="add-playlist-icon"
            type="button"
            onClick={handleAddPlaylist}
            aria-label="Add playlist"
            title="Add playlist"
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>

        <div className="playlist-list">
          {loading && <div className="nav-loading">Loading playlists…</div>}

          {!loading && playlists.map((playlist) => {
            const isActive = location.pathname === `/playlist/${playlist.id}`;

            return (
              <Link
                key={playlist.id}
                to={`/playlist/${playlist.id}`}
                className={`nav-item playlist-nav-item ${isActive ? "active" : ""}`}
                aria-current={isActive ? "page" : undefined}
                title={playlist.name}
              >
                <span className="nav-icon nav-icon-playlist" aria-hidden="true">
                  <PlaylistCover
                    playlist={playlist}
                    size={64}
                    placeholderClassName="nav-icon-playlist-placeholder"
                  />
                </span>
                <span className="nav-label">{playlist.name}</span>
              </Link>
            );
          })}
        </div>

        <button
          className="nav-item add-playlist"
          type="button"
          onClick={handleAddPlaylist}
        >
          <span className="nav-icon add-icon" aria-hidden="true">+</span>
          <span className="nav-label">Add playlist</span>
        </button>
      </section>
      {modalStep && (
        <div className="playlist-modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeModal();
        }}>
          <section className="playlist-modal" role="dialog" aria-modal="true" aria-labelledby="playlist-modal-title" ref={modalRef} tabIndex={-1}>
            <div className="playlist-modal-heading">
              <div>
                <span className="playlist-modal-eyebrow">YOUR LIBRARY / PLAYLISTS</span>
                <h2 id="playlist-modal-title">{modalStep === "choose" ? "Create New Playlist" : modalStep === "blank" ? "Blank Playlist" : "Import Spotify Playlist"}</h2>
              </div>
              <button className="playlist-modal-close" type="button" onClick={closeModal} disabled={busy} aria-label="Close playlist dialog">×</button>
            </div>

            {modalStep === "choose" ? (
              <>
                <p className="playlist-modal-intro">Choose how you'd like to get started.</p>
                <div className="playlist-modal-options">
                  <button type="button" className="playlist-modal-option" onClick={() => setModalStep("blank")} autoFocus>
                    <span className="playlist-modal-option-icon" aria-hidden="true">＋</span>
                    <strong>Blank Playlist</strong>
                    <span>Create from scratch</span>
                    <span className="playlist-modal-option-arrow" aria-hidden="true">↗</span>
                  </button>
                  <button type="button" className="playlist-modal-option" onClick={() => setModalStep("import")}>
                    <span className="playlist-modal-option-icon" aria-hidden="true">♫</span>
                    <strong>Import Spotify Playlist</strong>
                    <span>Import via URL</span>
                    <span className="playlist-modal-option-arrow" aria-hidden="true">↗</span>
                  </button>
                </div>
              </>
            ) : modalStep === "blank" ? (
              <form className="playlist-modal-form" onSubmit={handleCreatePlaylist}>
                <label htmlFor="new-playlist-name">Playlist name <span aria-hidden="true">*</span></label>
                <input id="new-playlist-name" value={playlistName} onChange={(event) => setPlaylistName(event.target.value)} placeholder="Give it a name" maxLength={200} autoFocus required />
                <label htmlFor="new-playlist-description">Description <span className="playlist-modal-optional">Optional</span></label>
                <textarea id="new-playlist-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What belongs in this playlist?" rows={3} maxLength={1000} />
                {formError && <p className="playlist-modal-error" role="alert">{formError}</p>}
                <div className="playlist-modal-actions">
                  <button type="button" className="playlist-modal-back" onClick={() => setModalStep("choose")} disabled={busy}>Back</button>
                  <button type="submit" className="playlist-modal-submit" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
                </div>
              </form>
            ) : (
              <form className="playlist-modal-form" onSubmit={handleImportPlaylist} noValidate>
                <p className="playlist-modal-intro">Paste a public Spotify playlist link. MusicDeck will download its songs and add the playlist to your library.</p>
                <label htmlFor="spotify-playlist-url">Spotify playlist URL</label>
                <input id="spotify-playlist-url" type="url" value={playlistUrl} onChange={(event) => { setPlaylistUrl(event.target.value); setFormError(""); }} placeholder="https://open.spotify.com/playlist/..." aria-invalid={Boolean(formError)} aria-describedby={formError ? "spotify-url-error" : undefined} autoFocus disabled={busy} />
                {formError && <p id="spotify-url-error" className="playlist-modal-error" role="alert">{formError}</p>}
                {busy && <p className="playlist-modal-progress" role="status"><span className="playlist-modal-spinner" aria-hidden="true" />Fetching playlist details and queueing download...</p>}
                <div className="playlist-modal-actions">
                  <button type="button" className="playlist-modal-back" onClick={() => setModalStep("choose")} disabled={busy}>Back</button>
                  <button type="submit" className="playlist-modal-submit" disabled={busy}>{busy ? "Importing…" : "Import & Download"}</button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
      {notice && <div className={`playlist-notice playlist-notice--${notice.type}`} role={notice.type === "error" ? "alert" : "status"}>{notice.text}</div>}
    </aside>

  );

}


export default Sidebar;
