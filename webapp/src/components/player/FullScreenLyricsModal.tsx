import { useEffect, useId, useRef, type ReactNode } from "react";

export default function FullScreenLyricsModal({ title, artist, artwork, onClose, children }: {
  title: string;
  artist?: string;
  artwork?: string | null;
  onClose(): void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);
  function close() {
    dialog.current?.close();
    onClose();
  }
  return <dialog ref={dialog} className="lyrics-reader" aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); close(); }}
    onKeyDown={event => event.stopPropagation()}>
    {artwork && <img className="lyrics-reader-backdrop" alt="" aria-hidden="true" src={artwork} />}
    <div className="lyrics-reader-surface">
      <header className="lyrics-reader-heading">
        <div>
          <div className="lyrics-reader-kicker">Lyrics</div>
          <h2 id={heading}>{title}</h2>
          {artist && <p>{artist}</p>}
        </div>
        <button type="button" aria-label="Close full-screen lyrics" onClick={close}>×</button>
      </header>
      {children}
    </div>
  </dialog>;
}
