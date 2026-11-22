import { useId, useLayoutEffect, useRef, type ReactNode } from "react";

export default function FullScreenLyricsModal({ title, artist, artwork, onClose, children, mobile, controls }: {
  title: string;
  artist?: string;
  artwork?: string | null;
  onClose(): void;
  children: ReactNode;
  mobile?: boolean;
  controls?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);
  return <dialog ref={dialog} className={`lyrics-reader${mobile ? " lyrics-reader--mobile" : ""}`} aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => event.stopPropagation()}>
    {artwork && <img className="lyrics-reader-backdrop" alt="" aria-hidden="true" src={artwork} />}
    <div className="lyrics-reader-surface">
      <header className="lyrics-reader-heading">
        <div>
          <div className="lyrics-reader-kicker">Lyrics</div>
          <h2 id={heading}>{title}</h2>
          {artist && <p>{artist}</p>}
        </div>
        <button type="button" aria-label="Close full-screen lyrics" onClick={onClose}>×</button>
      </header>
      {children}
      {controls}
    </div>
  </dialog>;
}
