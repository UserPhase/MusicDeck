import { useEffect, useRef, useState } from "react";

export default function PlaylistSearchBox({ label, placeholder = label, closeLabel = "Close playlist search", value, onChange }) {
  const [open, setOpen] = useState(false);
  const field = useRef(null);
  const trigger = useRef(null);
  const input = useRef(null);
  const close = () => { setOpen(false); onChange(""); trigger.current?.focus(); };

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event) => {
      if (field.current?.contains(event.target)) return;
      setOpen(false);
      onChange("");
    };
    document.addEventListener("click", dismiss, true);
    return () => document.removeEventListener("click", dismiss, true);
  }, [open, onChange]);

  return <div className={open ? "playlist-track-search" : undefined} ref={field}>
    <button type="button" className="folder-sort-trigger playlist-search-trigger" ref={trigger}
      aria-label={open ? closeLabel : label} aria-expanded={open}
      onClick={() => open ? close() : setOpen(true)}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 5 5" /></svg>
    </button>
    {open && <>
      <input ref={input} type="search" aria-label={label} value={value} onChange={event => onChange(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}
        placeholder={placeholder} autoComplete="off" autoFocus />
      {value && <button type="button" aria-label="Clear search" onClick={() => { onChange(""); input.current?.focus(); }}>×</button>}
    </>}
  </div>;
}
