import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { playlistCommands } from "../../services/playlists/PlaylistCommandStore";
import PlaylistCover from "../PlaylistCover";
import FloatingPanel from "../ui/FloatingPanel";
import PlaylistSearchHighlight from "./PlaylistSearchHighlight";
import { normalizePlaylistSearch } from "../../utils/playlistSearch";
import "../../styles/playlist-organization.css";

interface Folder { id: string; name: string; parent_folder_id: string | null; user_id: string; pinned: boolean; position: number }
interface Playlist { id: string; name: string; artworkId?: string | null; coverArt?: string | null; folderId?: string | null; ownerUserId?: string | null; pinned?: boolean; position?: number; pinPosition?: number | null; createdAt?: string; creator?: string | null }
interface Tree { revision: number; folders: Folder[]; playlists: Playlist[] }
interface Trash { id: string; name: string; deletedAt: string; revision: number; trackCount: number }
type Operation = { kind: "createFolder"; name: string; parentId: string | null } | { kind: "deleteFolder"; id: string }
  | { kind: "folder"; id: string; name?: string; parentId?: string | null; position?: number; pinned?: boolean }
  | { kind: "playlist"; id: string; folderId?: string | null; position?: number; pinned?: boolean }
  | { kind: "pinOrder"; id: string; position: number };
type Target = { kind: "folder" | "playlist"; id: string; owner: string };
const MIME = "application/x-musicdeck-playlist-tree";
async function json<T>(url: string, signal?: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(url, { credentials: "include", signal, ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error?.message || `Playlist organization could not be loaded (${response.status}).`);
  return data;
}
const message = (error: unknown) => error instanceof Error ? error.message : "The playlist operation failed.";
const sortLabels = { recent: "Recents", added: "Recently added", name: "Alphabetical", creator: "Creator", manual: "Custom order" } as const;
type Sort = keyof typeof sortLabels;
function readPreference<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; }
  catch { return fallback; }
}
function writePreference(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Preferences remain usable in memory. */ }
}

export default function PlaylistFolderTree({ playlists: fallback = [], onAddPlaylist, extraItems, loading = false }: {
  playlists?: Playlist[];
  onAddPlaylist?: (trigger: HTMLButtonElement) => void;
  extraItems?: (tokens: readonly string[]) => ReactNode[];
  loading?: boolean;
}) {
  const auth = useAuth(), owner = auth?.session?.id ? String(auth.session.id) : null;
  const location = useLocation(), navigate = useNavigate(), prefix = useId();
  const [tree, setTree] = useState<Tree | null>(null), [error, setError] = useState("");
  const [treeOwner, setTreeOwner] = useState<string | null>(null), [trashOwner, setTrashOwner] = useState<string | null>(null);
  const fallbackOwner = useRef(owner);
  const data = owner && treeOwner === owner ? tree : null;
  const ownerVisible = fallbackOwner.current === owner || treeOwner === owner;
  const [busy, setBusy] = useState(false), [query, setQuery] = useState("");
  const sortKey = `musicdeck:playlist-sort:${owner}`;
  const recentsKey = `musicdeck:playlist-recents:${owner}`;
  const [sortPreference, setSortPreference] = useState<{ owner: string | null; value: Sort }>();
  const sort = sortPreference && sortPreference.owner === owner ? sortPreference.value : "recent";
  const setSort = (value: Sort) => { setSortPreference({ owner, value }); if (owner) writePreference(sortKey, value); };
  const [recents, setRecents] = useState<{ owner: string | null; ids: string[] }>();
  const recentsRef = useRef(recents);
  const recentRanks = useMemo(() => new Map((recents?.owner === owner ? recents?.ids ?? [] : []).map((id, index) => [id, index])), [owner, recents]);
  const [searchOpen, setSearchOpen] = useState(false);
  const treeRoot = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set()), [active, setActive] = useState("");
  const [menu, setMenu] = useState("");
  const [choosingFolder, setChoosingFolder] = useState(false);
  const actionsAnchor = useRef<HTMLButtonElement>(null);
  const playlistActionsAnchor = useRef<HTMLAnchorElement>(null);
  useEffect(() => { setChoosingFolder(false); }, [menu]);
  const [editor, setEditor] = useState<{ id?: string; parentId: string | null; name: string } | null>(null);
  const [trashOpen, setTrashOpen] = useState(false), [trash, setTrash] = useState<Trash[]>([]), [trashLoading, setTrashLoading] = useState(false);
  const epoch = useRef(0), currentOwner = useRef(owner), lock = useRef(false), drag = useRef<Target | null>(null);
  const reads = useRef<AbortController | null>(null), writes = useRef<AbortController | null>(null);
  const trashDialog = useRef<HTMLDivElement>(null), collectionTrigger = useRef<HTMLButtonElement>(null);
  const [collectionMenu, setCollectionMenu] = useState<"actions" | "sort" | null>(null);
  const closeSearch = () => { setSearchOpen(false); setQuery(""); };
  useEffect(() => {
    if (!searchOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !treeRoot.current?.contains(event.target)) {
        setSearchOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [searchOpen]);
  currentOwner.current = owner;
  useEffect(() => {
    const value = readPreference<Sort>(sortKey, "recent");
    setSortPreference({ owner, value: Object.prototype.hasOwnProperty.call(sortLabels, value) ? value : "recent" });
  }, [owner, sortKey]);
  useEffect(() => {
    if (!owner) return;
    const match = /^\/playlist\/([^/]+)\/?$/.exec(location.pathname);
    const stored = readPreference<unknown>(recentsKey, recentsRef.current?.owner === owner ? recentsRef.current.ids : []);
    const saved = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string").slice(0, 500) : [];
    let opened: string | undefined;
    try { if (match) opened = decodeURIComponent(match[1]); } catch { /* Ignore an invalid playlist URL. */ }
    const ids = opened ? [opened, ...saved.filter(id => id !== opened)].slice(0, 500) : saved;
    if (opened) writePreference(recentsKey, ids);
    recentsRef.current = { owner, ids };
    setRecents(recentsRef.current);
  }, [location.pathname, owner, recentsKey]);
  const reload = useCallback(async (clearError = true) => {
    if (!owner) return;
    reads.current?.abort(); const controller = new AbortController(); reads.current = controller;
    const generation = epoch.current;
    try {
      const result = await json<Tree>("/api/v1/playlist-organization", controller.signal);
      if (!controller.signal.aborted && generation === epoch.current && currentOwner.current === owner) { setTreeOwner(owner); setTree(current => current && current.revision > result.revision ? current : result); if (clearError) setError(""); }
    } catch (reason) { if (!controller.signal.aborted && generation === epoch.current) setError(message(reason)); }
  }, [owner]);
  useEffect(() => {
    const generation = ++epoch.current; lock.current = false; setBusy(false); setTree(null); setError(""); setEditor(null); setMenu(""); setCollectionMenu(null); setTrashOpen(false); setTrash([]); setSearchOpen(false); setQuery("");
    try { const saved: unknown = JSON.parse(localStorage.getItem(`musicdeck:playlist-folders:${owner}`) || "[]"); setExpanded(new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [])); }
    catch { setExpanded(new Set()); }
    void reload();
    const changed = () => { void reload(); };
    window.addEventListener("playlistsChanged", changed); window.addEventListener("playlistOrganizationChanged", changed);
    return () => { epoch.current = generation + 1; reads.current?.abort(); writes.current?.abort(); window.removeEventListener("playlistsChanged", changed); window.removeEventListener("playlistOrganizationChanged", changed); };
  }, [owner, reload]);
  const toggle = (id: string, open?: boolean) => setExpanded(current => {
    const next = new Set(current); if (open ?? !next.has(id)) next.add(id); else next.delete(id);
    try { localStorage.setItem(`musicdeck:playlist-folders:${owner}`, JSON.stringify([...next])); } catch { /* Expansion remains usable without local storage. */ }
    return next;
  });
  const mutate = async (operation: Operation) => {
    if (!data || !owner || lock.current) return;
    const generation = epoch.current; lock.current = true; setBusy(true); setError(""); reads.current?.abort();
    const controller = new AbortController(); writes.current = controller;
    try {
      const result = await json<Tree>("/api/v1/playlist-organization", controller.signal, { ownerId: owner, revision: data.revision, operation });
      if (generation !== epoch.current) return;
      setTree(result); setEditor(null); setMenu("");
      if (operation.kind === "playlist" && operation.folderId) toggle(operation.folderId, true);
      if (operation.kind === "folder" && operation.parentId) toggle(operation.parentId, true);
      window.dispatchEvent(new Event("playlistOrganizationChanged"));
    } catch (reason) {
      if (generation === epoch.current && !controller.signal.aborted) { setError(message(reason)); void reload(false); }
    } finally { if (generation === epoch.current) { lock.current = false; setBusy(false); } }
  };
  const loadTrash = useCallback(async () => {
    const generation = epoch.current, requestedOwner = currentOwner.current; if (!requestedOwner) return; setTrashLoading(true);
    try { const result = await json<{ playlists: Trash[] }>("/api/v1/playlists/trash"); if (generation === epoch.current && currentOwner.current === requestedOwner) setTrash(result.playlists); }
    catch (reason) { if (generation === epoch.current) setError(message(reason)); }
    finally { if (generation === epoch.current) setTrashLoading(false); }
  }, []);
  const trashAction = async (id: string, restore: boolean) => {
    if (lock.current) return;
    const generation = epoch.current; lock.current = true; setBusy(true); setError("");
    try {
      await playlistCommands.execute(id, { kind: restore ? "restore" : "trash" });
      if (generation !== epoch.current) return;
      if (restore) await loadTrash(); setMenu("");
    } catch (reason) { if (generation === epoch.current) setError(message(reason)); }
    finally { if (generation === epoch.current) { lock.current = false; setBusy(false); } }
  };
  useEffect(() => {
    if (!trashOpen) return;
    void loadTrash(); trashDialog.current?.focus();
    const changed = () => { void loadTrash(); };
    window.addEventListener("playlistsChanged", changed);
    return () => window.removeEventListener("playlistsChanged", changed);
  }, [trashOpen, loadTrash]);
  const folders = data?.folders || [], playlists = data?.playlists || (fallbackOwner.current === owner ? fallback : []);
  const artworkByPlaylist = useMemo(() => new Map(fallback.map(playlist => [playlist.id, playlist])), [fallback]);
  const byFolder = useMemo(() => new Map((data?.folders || []).map(folder => [folder.id, folder])), [data?.folders]);
  const parentPath = (id: string): string => {
    const parts: string[] = []; let cursor: string | null = id;
    for (let depth = 0; cursor && depth < 16; depth++) { const folder = byFolder.get(cursor); if (!folder) break; parts.unshift(folder.name); cursor = folder.parent_folder_id; }
    return parts.join(" / ");
  };
  const nameOrder = (a: Playlist | Folder, b: Playlist | Folder) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id);
  const positionOrder = (a: Playlist | Folder, b: Playlist | Folder) => (a.position ?? 2147483647) - (b.position ?? 2147483647);
  const addedOrder = (a: Playlist, b: Playlist) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  const compare = (a: Playlist, b: Playlist) => {
    const order = sort === "recent" ? (recentRanks.get(a.id) ?? Infinity) - (recentRanks.get(b.id) ?? Infinity) || addedOrder(a, b)
      : sort === "added" ? addedOrder(a, b)
        : sort === "creator" ? (a.creator || "\uffff").localeCompare(b.creator || "\uffff")
          : sort === "manual" ? positionOrder(a, b) : 0;
    return order || nameOrder(a, b);
  };
  const compareFolders = (a: Folder, b: Folder) => Number(b.pinned) - Number(a.pinned) ||
    (sort === "name" ? 0 : positionOrder(a, b)) || nameOrder(a, b);
  const allPins = playlists.filter(playlist => playlist.pinned).sort((a, b) =>
    (a.pinPosition ?? Infinity) - (b.pinPosition ?? Infinity) ||
    a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id, "en"));
  const tokens = normalizePlaylistSearch(query).trim().split(/\s+/).filter(Boolean);
  const searching = tokens.length > 0;
  const matches = (name: string) => {
    const normalized = normalizePlaylistSearch(name);
    return tokens.every(token => normalized.includes(token));
  };
  const visibleFolder = (folder: Folder): boolean => matches(folder.name) ||
    playlists.some(playlist => playlist.folderId === folder.id && matches(playlist.name)) || folders.some(child => child.parent_folder_id === folder.id && visibleFolder(child));
  interface Visible { key: string; kind: "folder" | "playlist"; id: string; parent: string | null }
  const visible: Visible[] = [];
  const [dropMarker, setDropMarker] = useState<{ id: string; edge: "before" | "after" | "inside" } | null>(null);
  const finishDrag = () => { drag.current = null; setDropMarker(null); };
  const playlistEdge = (event: DragEvent) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY > bounds.top + bounds.height / 2 ? "after" : "before";
  };
  const folderEdge = (event: DragEvent) => {
    if (drag.current?.kind !== "folder") return "inside";
    const bounds = event.currentTarget.querySelector(".folder-tree-row")!.getBoundingClientRect();
    if (event.clientY < bounds.top + bounds.height / 4) return "before";
    if (event.clientY > bounds.bottom - bounds.height / 4) return "after";
    return "inside";
  };
  const onDragStart = (event: DragEvent, kind: Target["kind"], id: string) => {
    if (busy || !owner) { event.preventDefault(); return; }
    event.stopPropagation(); const target = { kind, id, owner }; drag.current = target;
    event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(MIME, JSON.stringify(target));
  };
  const drop = (event: DragEvent, folderId: string | null, beforeFolder?: Folder, beforePlaylist?: Playlist, afterFolder = false) => {
    if (!event.dataTransfer.types.includes(MIME) || !owner || busy) return;
    event.preventDefault(); event.stopPropagation();
    let target: Target;
    try { const raw = event.dataTransfer.getData(MIME); if (raw.length > 2000) return; target = JSON.parse(raw); }
    catch { setError("This item cannot be moved. Try dragging it again."); return; }
    finishDrag();
    if (target.owner !== owner || !["folder", "playlist"].includes(target.kind)) return;
    if (beforePlaylist?.id === target.id || beforeFolder?.id === target.id) return;
    const known = target.kind === "folder" ? folders.some(item => item.id === target.id) : playlists.some(item => item.id === target.id);
    if (!known) { setError("This item changed. Refresh your playlists before moving it."); return; }
    if (allPins.some(item => item.id === target.id && target.kind === "playlist")) {
      if (!beforePlaylist?.pinned) return;
      const after = playlistEdge(event) === "after";
      const position = allPins.filter(item => item.id !== target.id).findIndex(item => item.id === beforePlaylist.id);
      void mutate({ kind: "pinOrder", id: target.id, position: position + Number(after) });
      return;
    }
    if (beforePlaylist?.pinned) return;
    setSort("manual");
    if (target.kind === "folder") {
      if (beforePlaylist) return;
      const parent = beforeFolder ? beforeFolder.parent_folder_id : folderId;
      const siblings = folders.filter(item => item.parent_folder_id === parent && item.id !== target.id).sort((a, b) => a.position - b.position);
      void mutate({ kind: "folder", id: target.id, parentId: parent, ...(beforeFolder ? { position: Math.max(0, siblings.findIndex(item => item.id === beforeFolder.id)) + Number(afterFolder) } : {}) });
    } else {
      const parent = beforePlaylist ? beforePlaylist.folderId ?? null : folderId;
      const siblings = playlists.filter(item => (item.folderId ?? null) === parent && item.id !== target.id).sort((a, b) => (a.position ?? 2147483647) - (b.position ?? 2147483647));
      const after = playlistEdge(event) === "after";
      void mutate({ kind: "playlist", id: target.id, folderId: parent, ...(beforePlaylist ? { position: Math.max(0, siblings.findIndex(item => item.id === beforePlaylist.id)) + Number(after) } : {}) });
    }
  };
  const markDrop = (event: DragEvent, item: Folder | Playlist, kind: Target["kind"]) => {
    const source = drag.current;
    if (busy || !source || !event.dataTransfer.types.includes(MIME)) return;
    event.stopPropagation();
    const pinned = source.kind === "playlist" && allPins.some(pin => pin.id === source.id);
    if (source.id === item.id || (kind === "playlist" && (source.kind !== "playlist" || pinned !== Boolean(item.pinned))) ||
        (kind === "folder" && (pinned || (source.kind === "folder" && isDescendant(item as Folder, source.id))))) {
      setDropMarker(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const edge = kind === "playlist" ? playlistEdge(event) : folderEdge(event);
    setDropMarker(current => current?.id === item.id && current.edge === edge ? current : { id: item.id, edge });
  };
  const clearDrop = (event: DragEvent, id: string) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDropMarker(current => current?.id === id ? null : current);
  };
  const isDescendant = (folder: Folder, ancestor: string) => {
    let cursor: Folder | undefined = folder;
    for (let depth = 0; cursor && depth < 16; depth++) { if (cursor.id === ancestor) return true; cursor = cursor.parent_folder_id ? byFolder.get(cursor.parent_folder_id) : undefined; }
    return false;
  };
  const actions = (item: Folder | Playlist, kind: Target["kind"], key: string) => {
    const folder = kind === "folder" ? item as Folder : null;
    const pinnedPlaylist = kind === "playlist" && item.pinned;
    const siblings: (Folder | Playlist)[] = pinnedPlaylist ? allPins : kind === "folder" ? folders.filter(row => row.parent_folder_id === folder!.parent_folder_id).sort((a, b) => a.position - b.position)
      : playlists.filter(row => (row.folderId ?? null) === ((item as Playlist).folderId ?? null)).sort((a, b) => (a.position ?? 2147483647) - (b.position ?? 2147483647));
    const reorderableSiblings = pinnedPlaylist || kind === "folder" ? siblings : siblings.filter(row => !row.pinned);
    const index = reorderableSiblings.findIndex(row => row.id === item.id);
    const moveBy = (delta: number) => {
      if (!pinnedPlaylist) setSort("manual");
      const neighbor = reorderableSiblings[index + delta];
      if (neighbor) void mutate({ kind: pinnedPlaylist ? "pinOrder" : kind, id: item.id, position: siblings.indexOf(neighbor) });
    };
    const parent = folder ? folder.parent_folder_id : (item as Playlist).folderId ?? null;
    const destinations = folders.filter(row => row.id !== parent && (!folder || !isDescendant(row, folder.id)));
    const moveTo = (destination: string | null) => {
      void mutate(folder ? { kind: "folder", id: item.id, parentId: destination } : { kind: "playlist", id: item.id, folderId: destination });
    };
    return <>{folder && <button type="button" className="folder-actions-trigger" ref={menu === key ? actionsAnchor : undefined}
      tabIndex={active === key ? 0 : -1} disabled={busy} aria-label={`Actions for ${item.name}`} aria-haspopup="menu" aria-expanded={menu === key}
      onClick={event => { event.stopPropagation(); setActive(key); setMenu(menu === key ? "" : key); }}>⋯</button>}
      {menu === key && <FloatingPanel key={choosingFolder ? "destinations" : "actions"} anchorRef={folder ? actionsAnchor : playlistActionsAnchor}
        className="folder-sort-menu folder-item-menu" aria-label={choosingFolder ? `Move ${item.name} to folder` : `${item.name} actions`} onClose={() => setMenu("")}>
        {choosingFolder ? <>
          <button type="button" role="menuitem" onClick={() => setChoosingFolder(false)}>‹ Back</button>
          {parent !== null && <button type="button" role="menuitem" disabled={busy} onClick={() => moveTo(null)}>Outside folders</button>}
          {destinations.map(row => <button key={row.id} type="button" role="menuitem" disabled={busy} onClick={() => moveTo(row.id)}>{parentPath(row.id)}</button>)}
        </> : <>
          <button type="button" role="menuitem" disabled={busy} onClick={() => { void mutate({ kind, id: item.id, pinned: !item.pinned }); }}>{item.pinned ? "Unpin" : "Pin"}</button>
          {folder && <button type="button" role="menuitem" disabled={busy} onClick={() => { setEditor({ id: folder.id, parentId: folder.parent_folder_id, name: folder.name }); setMenu(""); }}>Rename folder</button>}
          {folder && <button type="button" role="menuitem" disabled={busy} onClick={() => { toggle(folder.id, true); setEditor({ parentId: folder.id, name: "" }); setMenu(""); }}>New subfolder</button>}
          {(parent !== null || destinations.length > 0) && <button type="button" role="menuitem" disabled={busy} onClick={() => setChoosingFolder(true)}>Move to <span aria-hidden="true">›</span></button>}
          {index > 0 && <button type="button" role="menuitem" disabled={busy} onClick={() => moveBy(-1)}>Move up</button>}
          {index < reorderableSiblings.length - 1 && <button type="button" role="menuitem" disabled={busy} onClick={() => moveBy(1)}>Move down</button>}
          <div className="folder-item-menu-divider" role="separator" />
          {folder ? <button type="button" role="menuitem" disabled={busy} onClick={() => { if (window.confirm(`Remove folder “${folder.name}”? Its playlists and subfolders will move up one level.`)) void mutate({ kind: "deleteFolder", id: folder.id }); }}>Remove folder</button>
            : <button type="button" role="menuitem" disabled={busy || !((item as Playlist).ownerUserId === owner || auth?.session?.role === "admin")} onClick={() => { void trashAction(item.id, false); }}>Move to Trash</button>}
        </>}
      </FloatingPanel>}</>;
  };
  const renderPlaylist = (playlist: Playlist) => {
    const parent = playlist.folderId ?? null;
    const coverArt = playlist.artworkId !== undefined ? playlist.artworkId
      : playlist.coverArt ?? artworkByPlaylist.get(playlist.id)?.coverArt;
    const key = `playlist:${playlist.id}`; visible.push({ key, id: playlist.id, kind: "playlist", parent });
    const href = `/playlist/${encodeURIComponent(playlist.id)}`, selected = location.pathname === href;
    return <li key={key} id={`${prefix}-${key}`} role="treeitem" aria-selected={active === key} data-tree-key={key} className={`folder-playlist${selected ? " is-current" : ""}`}
      onFocus={() => setActive(key)} onDragOver={event => markDrop(event, playlist, "playlist")} onDragLeave={event => clearDrop(event, playlist.id)} onDrop={event => drop(event, parent, undefined, playlist)}
      onContextMenu={event => { if (data && !busy) { event.preventDefault(); event.stopPropagation(); setActive(key); setMenu(key); } }}>
      <div className="folder-tree-row" data-sidebar-drop={dropMarker?.id === playlist.id ? dropMarker.edge : undefined}
        draggable={!busy} onDragStart={event => onDragStart(event, "playlist", playlist.id)} onDragEnd={finishDrag}>
        <span className="folder-tree-symbol"><PlaylistCover playlist={{ name: playlist.name, coverArt }} size={64} placeholderClassName="nav-icon-playlist-placeholder" /></span>
        <Link to={href} ref={menu === key ? playlistActionsAnchor : undefined} draggable={false} tabIndex={-1} aria-current={selected ? "page" : undefined} aria-label={playlist.name} title={playlist.name} onClick={() => setActive(key)}>
          <span className="folder-playlist-name"><PlaylistSearchHighlight text={playlist.name} tokens={tokens} /></span>
          <span className="folder-playlist-meta">{playlist.pinned && <svg role="img" aria-label="Pinned playlist" viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="m16 3 5 5-2 1-3 3v4l-1 1-4-4-6 6-1-1 6-6-4-4 1-1h4l3-3z" /></svg>}
            <span>Playlist{playlist.creator ? ` · ${playlist.creator}` : ""}</span>
          </span>
        </Link>
        {actions(playlist, "playlist", key)}
      </div></li>;
  };
  const renderBranch = (parent: string | null, includeAll = false): React.ReactNode => {
    return <>{folders.filter(folder => folder.parent_folder_id === parent && (!searching || includeAll || visibleFolder(folder))).sort(compareFolders).map(folder => {
      const key = `folder:${folder.id}`, open = expanded.has(folder.id) || searching; visible.push({ key, kind: "folder", id: folder.id, parent });
      return <li key={key} id={`${prefix}-${key}`} role="treeitem" aria-expanded={open} aria-selected={active === key} data-tree-key={key}
        onContextMenu={event => { if (data && !busy) { event.preventDefault(); event.stopPropagation(); setActive(key); setMenu(key); } }}
        onDragOver={event => markDrop(event, folder, "folder")} onDragLeave={event => clearDrop(event, folder.id)} onDrop={event => {
          const edge = folderEdge(event);
          if (edge === "inside") drop(event, folder.id); else drop(event, parent, folder, undefined, edge === "after");
        }}>
        <div className="folder-tree-row" data-sidebar-drop={dropMarker?.id === folder.id ? dropMarker.edge : undefined}
          draggable={!busy} onDragStart={event => onDragStart(event, "folder", folder.id)} onDragEnd={finishDrag}>
          <button type="button" className="folder-toggle" tabIndex={-1} aria-label={`${open ? "Collapse" : "Expand"} ${folder.name}`} onClick={() => { setActive(key); toggle(folder.id); }}>
            <span aria-hidden="true">{open ? "⌄" : "›"}</span><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 7V5h6l2 2h10v13H3Z" /></svg><span><PlaylistSearchHighlight text={folder.name} tokens={tokens} /></span>
          </button>{folder.pinned && <span className="folder-pin" aria-label="Pinned folder">◆</span>}{actions(folder, "folder", key)}
        </div>{open && <ul role="group">{renderBranch(folder.id, includeAll || (searching && matches(folder.name)))}</ul>}
      </li>;
    })}{playlists.filter(playlist => !playlist.pinned && (playlist.folderId ?? null) === parent && (!searching || includeAll || matches(playlist.name))).sort(compare).map(renderPlaylist)}</>;
  };
  const pinned = allPins.filter(playlist => matches(playlist.name));
  const content = <>{pinned.map(renderPlaylist)}{renderBranch(null)}</>;
  const keydown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.target !== event.currentTarget) return;
    const index = Math.max(0, visible.findIndex(item => item.key === active)), item = visible[index]; if (!item) return;
    let target: Visible | undefined;
    if (event.key === "ArrowDown") target = visible[Math.min(visible.length - 1, index + 1)];
    else if (event.key === "ArrowUp") target = visible[Math.max(0, index - 1)];
    else if (event.key === "Home") target = visible[0]; else if (event.key === "End") target = visible[visible.length - 1];
    else if (event.key === "ArrowRight" && item.kind === "folder") { if (!expanded.has(item.id)) toggle(item.id, true); else target = visible[index + 1]; }
    else if (event.key === "ArrowLeft") { if (item.kind === "folder" && expanded.has(item.id)) toggle(item.id, false); else target = visible.find(row => row.kind === "folder" && row.id === item.parent); }
    else if (event.key === "Enter" || event.key === " ") { if (item.kind === "folder") toggle(item.id); else { closeSearch(); navigate(`/playlist/${encodeURIComponent(item.id)}`); } }
    else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) setMenu(item.key);
    else return;
    event.preventDefault(); if (target) { setActive(target.key); document.getElementById(`${prefix}-${target.key}`)?.scrollIntoView({ block: "nearest" }); }
  };
  const closeTrash = () => { if (!busy) { setTrashOpen(false); collectionTrigger.current?.focus(); } };
  const extras = extraItems?.(tokens) ?? [];
  return <div className="playlist-folder-tree" ref={treeRoot} aria-busy={busy}
    onClick={event => { if (searchOpen && event.target instanceof Element && event.target.closest("a[href]")) closeSearch(); }}
    onKeyDown={event => {
      if (searchOpen && !collectionMenu && event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault(); event.stopPropagation(); closeSearch(); collectionTrigger.current?.focus();
      }
    }}>
    <div className="nav-section-heading">
      <h2 className="nav-title">Playlists</h2>
      <button type="button" className="folder-actions-trigger" ref={collectionTrigger}
        aria-label="Playlist collection options" aria-haspopup="menu" aria-expanded={collectionMenu !== null}
        onClick={() => setCollectionMenu(collectionMenu ? null : "actions")}>⋯</button>
      {collectionMenu === "actions" && <FloatingPanel anchorRef={collectionTrigger} className="folder-sort-menu" aria-label="Playlist collection options"
        onClose={() => setCollectionMenu(null)}>
        <button type="button" role="menuitem" onClick={() => { setCollectionMenu(null); setSearchOpen(true); }}>Find a playlist</button>
        <button type="button" role="menuitem" onClick={() => setCollectionMenu("sort")}>Sort by <span aria-hidden="true">›</span></button>
        {onAddPlaylist && <button type="button" role="menuitem" onClick={() => {
          setCollectionMenu(null);
          if (collectionTrigger.current) onAddPlaylist(collectionTrigger.current);
        }}>Add playlist</button>}
        <button type="button" role="menuitem" onClick={() => {
          setCollectionMenu(null); setError(""); setTrash([]); setTrashOwner(owner); setTrashOpen(true);
        }}>Trash</button>
        <button type="button" role="menuitem" disabled={busy || !data} onClick={() => {
          setCollectionMenu(null); setEditor({ parentId: null, name: "" });
        }}>Add folder</button>
      </FloatingPanel>}
      {collectionMenu === "sort" && <FloatingPanel key="sort" anchorRef={collectionTrigger} className="folder-sort-menu" aria-label="Sort playlists" onClose={() => setCollectionMenu(null)}>
        <button type="button" role="menuitem" onClick={() => setCollectionMenu("actions")}>‹ Back</button>
        <span className="folder-sort-caption" aria-hidden="true">Sort by</span>
        {(Object.entries(sortLabels) as [Sort, string][]).map(([value, label]) => <button key={value} type="button" role="menuitemradio" aria-checked={sort === value}
          onClick={() => { setSort(value); setCollectionMenu(null); collectionTrigger.current?.focus(); }}>
          {label}{sort === value && <span aria-hidden="true">✓</span>}
        </button>)}
      </FloatingPanel>}
    </div>
    {searchOpen && <div className="playlist-track-search sidebar-playlist-search">
      <input type="search" aria-label="Search playlists and folders" placeholder="Find playlists" value={query}
        onChange={event => setQuery(event.target.value)} autoComplete="off" autoFocus />
      <button type="button" aria-label="Close playlist search" onClick={() => { closeSearch(); collectionTrigger.current?.focus(); }}>×</button>
    </div>}
    {ownerVisible && error && <p role={data ? "alert" : "status"} className="folder-tree-error">{error} <button type="button" onClick={() => { void reload(); }}>Refresh</button></p>}
    {ownerVisible && editor && <form className="folder-editor" onSubmit={event => { event.preventDefault(); if (editor.name.trim()) void mutate(editor.id ? { kind: "folder", id: editor.id, name: editor.name.trim() } : { kind: "createFolder", name: editor.name.trim(), parentId: editor.parentId }); }}>
      <label>{editor.id ? "Rename folder" : `New folder${editor.parentId ? ` in ${parentPath(editor.parentId)}` : ""}`}<input aria-label="Folder name" value={editor.name} maxLength={200} required autoFocus onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
      <button type="submit" disabled={busy || !editor.name.trim()}>Save folder</button><button type="button" disabled={busy} onClick={() => setEditor(null)}>Cancel</button>
    </form>}
    <ul role="tree" aria-label="Playlist folders" tabIndex={0} aria-activedescendant={visible.some(row => row.key === active) ? `${prefix}-${active}` : visible[0] ? `${prefix}-${visible[0].key}` : undefined} onKeyDown={keydown}>{content}</ul>
    {extras}
    {loading && !data && <p className="nav-loading">Loading playlists…</p>}
    {!loading && !visible.length && !extras.length && <p className="folder-tree-empty">{searching ? "No matching playlists or folders." : "Your folders and playlists appear here."}</p>}
    {onAddPlaylist && <button className="nav-item add-playlist" type="button" onClick={event => onAddPlaylist(event.currentTarget)}>
      <span className="nav-icon add-icon" aria-hidden="true">+</span><span className="nav-label">Add playlist</span>
    </button>}
    {trashOpen && trashOwner === owner && createPortal(<div className="playlist-trash-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeTrash(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby={`${prefix}-trash-title`} ref={trashDialog} tabIndex={-1} className="playlist-trash-dialog" onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); closeTrash(); }
        if (event.key === "Tab") { const items = [...(trashDialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],[tabindex="0"]') || [])]; const first = items[0], last = items[items.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === trashDialog.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
      }}><header><div><span className="playlist-undo-caption">YOUR COLLECTION / RECOVERY</span><h2 id={`${prefix}-trash-title`}>Playlist Trash</h2></div><button type="button" disabled={busy} aria-label="Close Trash" onClick={closeTrash}>×</button></header>
        <p>Deleted playlists keep their tracks and artwork for 30 days. Restoring brings them back to their folders.</p>
        {error && <p role="alert" className="folder-tree-error">{error}</p>}
        {trashLoading ? <p role="status">Loading Trash…</p> : !trash.length ? <p className="folder-tree-empty">Trash is empty.</p> : <ul>{trash.map(item => <li key={item.id}><div><strong>{item.name}</strong><span>{item.trackCount} tracks · {Math.max(0, Math.ceil((Date.parse(item.deletedAt) + 30 * 86400000 - Date.now()) / 86400000))} days left</span></div>
          <button type="button" disabled={busy} onClick={() => { void trashAction(item.id, true); }}>Restore {item.name}</button></li>)}</ul>}
        <footer><button type="button" disabled={trashLoading || busy} onClick={() => { void loadTrash(); }}>Refresh Trash</button></footer>
      </div></div>, document.body)}
  </div>;
}
