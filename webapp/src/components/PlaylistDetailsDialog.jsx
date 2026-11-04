import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PlaylistCover from "./PlaylistCover";

function PlaylistDetailsDialog({ playlist, busy, error, onClose, onSave, prepareCover }) {
  const [name, setName] = useState(playlist.name);
  const [description, setDescription] = useState(playlist.description || "");
  const [cover, setCover] = useState(undefined);
  const [coverError, setCoverError] = useState("");
  const [readingCover, setReadingCover] = useState(false);
  const coverInput = useRef(null);
  const dialogRef = useRef(null);
  const nameRef = useRef(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement;
    nameRef.current?.focus();

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current();
      } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        if (!busyRef.current) dialogRef.current?.requestSubmit();
      } else if (event.key === "Tab") {
        const focusable = [...(dialogRef.current?.querySelectorAll(
          'button:not([disabled]), input:not([disabled]):not([hidden]), textarea:not([disabled])'
        ) || [])];
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
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus?.();
    };
  }, []);

  function handleSubmit(event) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || busy || readingCover) return;
    onSave({ name: trimmedName, description: description.trim() || null }, cover);
  }

  async function chooseCover(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setReadingCover(true);
    setCoverError("");
    try { setCover(await prepareCover(file)); }
    catch (error) { setCoverError(error.message || "Could not read the selected image."); }
    finally { setReadingCover(false); }
  }

  return createPortal(
    <div
      className="playlist-details-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="playlist-details-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="playlist-details-title"
        aria-describedby="playlist-details-shortcut"
        ref={dialogRef}
        onSubmit={handleSubmit}
      >
        <div className="playlist-details-heading">
          <div>
            <p className="playlist-details-eyebrow">PLAYLIST SETTINGS</p>
            <h2 id="playlist-details-title">Edit details</h2>
          </div>
          <button
            className="playlist-modal-close"
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close edit playlist dialog"
          >
            ×
          </button>
        </div>

        <div className="playlist-details-body">
          <div className="playlist-details-artwork">
            <button type="button" className="playlist-details-cover" aria-label="Choose playlist cover"
              onClick={() => coverInput.current?.click()} disabled={busy || readingCover}>
              {cover ? <img src={cover} alt="New cover preview" /> : <PlaylistCover
                playlist={cover === null ? { ...playlist, coverArt: null } : playlist} size={384} />}
              <span className="playlist-details-cover-pencil" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="m15 5 4 4M4 20l4-.8L20 7l-4-4L4.8 15Z" /></svg>
              </span>
            </button>
            <input ref={coverInput} type="file" hidden aria-label="Playlist cover image"
              accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy || readingCover} onChange={chooseCover} />
            {(cover || (cover === undefined && playlist.coverMode === "custom")) && <button type="button"
              className="playlist-details-remove-cover" aria-label="Use automatic cover" disabled={busy || readingCover} onClick={() => {
                setCover(playlist.coverMode === "custom" ? null : undefined); setCoverError("");
              }}>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg>
              <span className="playlist-details-cover-tooltip" aria-hidden="true">Use automatic cover</span>
            </button>}
          </div>
          <label htmlFor="playlist-details-name">Name</label>
          <input ref={nameRef} id="playlist-details-name" value={name}
            onChange={(event) => setName(event.target.value)} maxLength={200} required autoComplete="off" />
          <label htmlFor="playlist-details-description">Description</label>
          <textarea id="playlist-details-description" value={description}
            onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={5} />
        </div>

        {readingCover && <p className="playlist-details-shortcut" role="status">Reading image…</p>}
        {coverError && <p className="playlist-details-error" role="alert">{coverError}</p>}
        {error && <p className="playlist-details-error" role="alert">{error}</p>}
        <p className="playlist-details-shortcut" id="playlist-details-shortcut">
          Press Ctrl+Enter or ⌘+Enter to save.
        </p>

        <div className="playlist-details-actions">
          <button type="button" className="playlist-modal-back" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="playlist-modal-submit" disabled={busy || readingCover || !name.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}

export default PlaylistDetailsDialog;
