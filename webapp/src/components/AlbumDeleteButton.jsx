import { useRef, useState } from "react";
import FloatingPanel from "./ui/FloatingPanel";
import { useAuth } from "../context/AuthContext";
import { useServerDeletion } from "../context/ServerDeletionContext";

export default function AlbumDeleteButton({ album }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const isAdmin = useAuth()?.session?.role === "admin";
  const deletion = useServerDeletion();
  if (!isAdmin || !deletion || !album?.id || /^(external_|extdetail_)/.test(String(album.id)) || album.availability?.libraryAvailable === false) return null;
  return <div className="album-admin-actions" onClick={(event) => event.stopPropagation()}>
    <button ref={triggerRef} type="button" className="album-admin-menu-toggle" aria-label={`More options for ${album.title || album.name}`} aria-expanded={open} aria-haspopup="menu" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value); }}>⋯</button>
    {open && <FloatingPanel anchorRef={triggerRef} onClose={() => setOpen(false)} className="playlist-menu album-admin-menu" role="menu">
      <button type="button" role="menuitem" className="playlist-menu-item server-delete-menu-item" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(false); deletion.openAlbum(album); }}>🗑 Delete from Server</button>
    </FloatingPanel>}
  </div>;
}
