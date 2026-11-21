import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getStarred, LISTENING_ACTIVITY_CHANGED_EVENT, request } from "../api/musicdeck";
import { deletePlaylist, getPlaylist, getRecentlyPlayedPlaylists } from "../api/playlists";
import LibraryBrowseControls from "../components/LibraryBrowseControls";
import PlaylistCover, { LikedSongsCover } from "../components/PlaylistCover";
import TrackPlaybackIndicator from "../components/TrackPlaybackIndicator";
import FloatingPanel from "../components/ui/FloatingPanel";
import { useViewStateValue } from "../hooks/useViewStateStore";
import { normalizePlaylistSearch } from "../utils/playlistSearch";

const sorts = { custom: "Custom order", recent: "Recently played", az: "Alphabetical", za: "Z\u2013A", newest: "Newest", oldest: "Oldest" };
const compareNames = new Intl.Collator(undefined, { sensitivity: "base", numeric: true }).compare;
const likedSongs = { id: "liked-songs", name: "Liked Songs", kind: "liked" };

function usePlaylistRanks(sort) {
  const [order, setOrder] = useState(null);
  useEffect(() => {
    if (sort !== "custom" && sort !== "recent") return undefined;
    let pending;
    async function load() {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      const signal = controller.signal;
      try {
        const playlists = sort === "recent"
          ? await getRecentlyPlayedPlaylists(signal)
          : (await request("/api/v1/playlist-organization", { signal, cache: "no-store" })).playlists;
        if (signal.aborted) return;
        setOrder({ sort, ranks: new Map(playlists.map((item, index) => [String(item.id), sort === "custom" ? item.position ?? index : index])) });
      } catch {
        if (!signal.aborted) setOrder({ sort, error: "Could not load this playlist order." });
      }
    }
    const event = sort === "recent" ? LISTENING_ACTIVITY_CHANGED_EVENT : "playlistOrganizationChanged";
    setOrder(null);
    void load();
    window.addEventListener(event, load);
    return () => { pending?.abort(); window.removeEventListener(event, load); };
  }, [sort]);
  return order?.sort === sort ? order : null;
}

function PlaylistRowCover({ item }) {
  if (item.kind === "liked") return <LikedSongsCover className="mobile-playlist-cover" />;
  if (item.kind === "smart") return <div className="smart-playlist-cover mobile-playlist-cover" aria-hidden="true">{"\u2726"}</div>;
  return <div className="mobile-playlist-cover" aria-hidden="true"><PlaylistCover playlist={item} size={112} /></div>;
}

function PlaylistRow({ item, active, isPlaying, busy, onQueue, onDelete }) {
  const nameId = useId();
  const subtitleId = useId();
  const trigger = useRef(null);
  const [open, setOpen] = useState(false);
  const regular = item.kind === "regular";
  const hasMenu = regular || item.kind === "liked";
  const canManage = regular && item.permissions?.canManage === true;
  const id = encodeURIComponent(item.id);
  const href = item.kind === "liked" ? "/liked" : `/${regular ? "playlist" : "smart-playlist"}/${id}`;
  const count = item.songCount ?? 0;
  const subtitle = item.kind === "smart" ? "Smart playlist" :
    `${item.kind === "liked" ? "Pinned \u00b7 " : ""}${count} ${count === 1 ? "song" : "songs"}`;
  function run(action) {
    setOpen(false);
    trigger.current?.focus();
    action(item);
  }

  return <li className={`mobile-playlist-row${active ? " is-current" : ""}`}>
    <Link className="mobile-playlist-link" to={href} aria-labelledby={nameId} aria-describedby={subtitleId}>
      <PlaylistRowCover item={item} />
      <span className="mobile-playlist-info">
        <span id={nameId} className="playlist-title">{item.name}</span>
        <span id={subtitleId} className="playlist-meta">{subtitle}</span>
      </span>
      {active && <TrackPlaybackIndicator isCurrentTrack isPlaying={isPlaying} />}
    </Link>
    {hasMenu && <>
      <button type="button" ref={trigger} className="mobile-playlist-more" aria-label={`More options for ${item.name}`}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.75" /><circle cx="12" cy="12" r="1.75" /><circle cx="19" cy="12" r="1.75" />
        </svg>
      </button>
      {open && <FloatingPanel anchorRef={trigger} className="folder-sort-menu folder-item-menu mobile-playlist-menu" aria-label={`${item.name} options`} onClose={() => setOpen(false)}>
        <button type="button" role="menuitem" disabled={busy || item.songCount === 0} onClick={() => run(onQueue)}>Add to queue</button>
        {canManage && <>
          <Link className="mobile-playlist-menu-link" role="menuitem" to={href} state={{ editPlaylistDetails: true }} onClick={() => setOpen(false)}>Edit details</Link>
          <button type="button" role="menuitem" disabled={busy} onClick={() => run(onDelete)}>Delete playlist</button>
        </>}
      </FloatingPanel>}
    </>}
  </li>;
}

export default function MobilePlaylists({ playlists, loading, error, smart, player }) {
  const [query, setQuery] = useState("");
  const [savedSort, setSort] = useViewStateValue("/library/playlists", "sortBy", "az");
  const sort = Object.hasOwn(sorts, savedSort) ? savedSort : "az";
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const order = usePlaylistRanks(sort);
  const search = normalizePlaylistSearch(query.trim());
  const visible = useMemo(() => [
    ...playlists.map((playlist) => ({ ...playlist, kind: "regular" })),
    ...smart.items.map((playlist) => ({ ...playlist, kind: "smart" })),
  ].filter((playlist) => normalizePlaylistSearch(playlist.name).includes(search)).sort((a, b) => {
    const byName = compareNames(a.name, b.name);
    if (sort === "az" || sort === "za") return sort === "az" ? byName : -byName;
    if (sort === "recent" || sort === "custom") {
      const ranks = order?.ranks;
      return (ranks?.get(String(a.id)) ?? Infinity) - (ranks?.get(String(b.id)) ?? Infinity) || byName;
    }
    const dateA = Date.parse(a.createdAt);
    const dateB = Date.parse(b.createdAt);
    if (Number.isFinite(dateA) !== Number.isFinite(dateB)) return Number.isFinite(dateA) ? -1 : 1;
    return (sort === "newest" ? dateB - dateA : dateA - dateB) || byName;
  }), [order, playlists, search, smart.items, sort]);

  const song = player?.currentSong;
  const context = player?.playbackContext;
  const playlistId = song && (song.tastePlaylistId || (song.mediaResume?.type === "playlist" && song.mediaResume.mediaId) ||
    (player.isRemotePlayback && (context?.type === "playlist" ? context.id : context?.playlistLoopId)));
  const likedActive = Boolean(song && !playlistId && context?.type !== "downloads" && (song.origin === "liked" ||
    (!song.origin && context?.type === "collection" && context.id === likedSongs.id)));

  async function queuePlaylist(item) {
    setBusy(true);
    try {
      const tracks = item.kind === "liked" ? await getStarred() : (await getPlaylist(item.id))?.entry || [];
      if (tracks.length) player.queueTracks(tracks);
      setNotice({ text: tracks.length ? `Added ${item.name} to the queue.` : "This playlist is empty." });
    } catch (reason) {
      setNotice({ error: true, text: reason.message || "Could not add the playlist to the queue." });
    } finally {
      setBusy(false);
    }
  }

  async function removePlaylist(item) {
    if (!window.confirm(`Move "${item.name}" to Trash? You can restore it for 30 days.`)) return;
    setBusy(true);
    try {
      await deletePlaylist(item.id);
      window.dispatchEvent(new Event("playlistsChanged"));
      setNotice({ text: `Moved ${item.name} to Trash.` });
    } catch (reason) {
      setNotice({ error: true, text: reason.message || "Could not delete the playlist." });
    } finally {
      setBusy(false);
    }
  }

  return <section className="mobile-playlists" aria-label="Playlists">
    <div className="mobile-playlists-actions">
      <button type="button" className="mobile-playlist-new" aria-label="New playlist" onClick={(event) => {
        window.dispatchEvent(new CustomEvent("musicdeck:open-playlist-creator", { detail: event.currentTarget }));
      }}>
        <span aria-hidden="true">+</span><span className="mobile-playlist-new-label">New playlist</span>
      </button>
      <LibraryBrowseControls label="playlists" query={query} onQueryChange={setQuery}
        sort={sort} onSortChange={setSort} sortChoices={sorts} />
    </div>
    {notice && <p role={notice.error ? "alert" : "status"} className="home-section-state">{notice.text}</p>}
    {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- Keep the list exposed in Safari with list markers hidden. */}
    <ul className="mobile-playlist-list" role="list" aria-label="Library playlists">
      <PlaylistRow item={{ ...likedSongs, songCount: player?.likedSongIds?.size ?? 0 }} active={likedActive}
        isPlaying={player?.isPlaying} busy={busy} onQueue={queuePlaylist} />
      {visible.map((item) => <PlaylistRow key={`${item.kind}:${item.id}`} item={item}
        active={Boolean(playlistId && String(playlistId) === String(item.id))} isPlaying={player?.isPlaying}
        busy={busy} onQueue={queuePlaylist} onDelete={removePlaylist} />)}
    </ul>
    {loading && <p className="home-section-state" role="status">Loading playlists…</p>}
    {error && <p className="home-section-state" role="alert">{error}</p>}
    {smart.error && <p className="home-section-state">Could not load smart playlists. <button type="button" onClick={() => { void smart.refresh(); }}>Retry</button></p>}
    {order?.error && <p className="home-section-state" role="status">{order.error}</p>}
    {!loading && !error && !smart.loading && !smart.error && !visible.length && (
      <p className="home-section-state">{search ? "No other playlists match your search." : "No other playlists yet."}</p>
    )}
  </section>;
}
