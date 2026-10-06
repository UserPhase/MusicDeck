import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function PlaylistDetailsDialog({ playlist, busy, error, onClose, onSave }) {
  const [name, setName] = useState(playlist.name);
  const [description, setDescription] = useState(playlist.description || "");
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
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled])'
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
    if (!trimmedName) return;
    onSave({ name: trimmedName, description: description.trim() || null });
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

        <label htmlFor="playlist-details-name">Name</label>
        <input
          ref={nameRef}
          id="playlist-details-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={200}
          required
          autoComplete="off"
        />

        <label htmlFor="playlist-details-description">Description</label>
        <textarea
          id="playlist-details-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={1000}
          rows={5}
        />

        {error && <p className="playlist-details-error" role="alert">{error}</p>}
        <p className="playlist-details-shortcut" id="playlist-details-shortcut">
          Press Ctrl+Enter or ⌘+Enter to save.
        </p>

        <div className="playlist-details-actions">
          <button type="button" className="playlist-modal-back" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="playlist-modal-submit" disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}

export default PlaylistDetailsDialog;
