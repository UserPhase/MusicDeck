import { useCallback, useDeferredValue, useEffect, useMemo, useState, useRef } from "react";
import { startVisualPolling } from "../services/visualActivity";
import { normalizePlaylistSearch, playlistTrackSearchText } from "../utils/playlistSearch";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link, useNavigate } from "react-router-dom";

import PlaylistCover from "../components/PlaylistCover";
import PlaylistSearchBox from "../components/playlists/PlaylistSearchBox";
import PlaylistTasteOption from "../components/playlists/PlaylistTasteOption";
import PlaylistShareModal from "../components/playlists/PlaylistShareModal";
import PlaylistPartyPanel from "../components/playlists/PlaylistPartyPanel";
import { request } from "../api/musicdeck";
import CollectionDownloadButton from "../components/CollectionDownloadButton";
import TrackListHeader from "../components/TrackListHeader";
import VirtualizedTrackList from "../components/VirtualizedTrackList";

import PlaylistRecommendations from "../components/PlaylistRecommendations";
import { useTrackSelection } from "../hooks/useTrackSelection";
import { usePlaylistUndo } from "../hooks/usePlaylistUndo";
import { reorderPlaylistEntries } from "../utils/playlistEditing";

import PlaylistDetailsDialog from "../components/PlaylistDetailsDialog";
import FloatingPanel from "../components/ui/FloatingPanel";

import {
  getPlaylist,
  removeSongFromPlaylist as removeSongFromPlaylistRequest,
  deletePlaylist,
  setPlaylistArtwork,
  clearPlaylistArtwork,
  updatePlaylist,
  reorderPlaylistItems,
  editPlaylistTracks,
} from "../api/playlists";

import { usePlayer } from "../context/PlayerContext";
import "../styles/playlist-organization.css";

const trackSortLabels = { custom: "Custom order", added: "Date added", title: "Title", artist: "Artist", album: "Album", duration: "Duration" };
const trackSortCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function Playlist() {

  const { id } = useParams();


  const [playlist, setPlaylist] =
    useState(null);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(null);

  const [
    menuSongId,
    setMenuSongId,
  ] = useState(null);


  const optionsTriggerRef = useRef(null);
  const coverInputRef = useRef(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editDetailsOpen, setEditDetailsOpen] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [editingBusy, setEditingBusy] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [editError, setEditError] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const editLock = useRef(false);
  const batchLock = useRef(false);
  const pageGeneration = useRef(0);
  const playlistRef = useRef(playlist);
  playlistRef.current = playlist;
  const [trackQuery, setTrackQuery] = useState("");
  const history = usePlaylistUndo();
  const [trackSort, setTrackSort] = useState("custom");
  const [sortDescending, setSortDescending] = useState(false);
  const sortBy = (field) => {
    setSortDescending(field !== "custom" && field === trackSort ? !sortDescending : false);
    setTrackSort(field);
  };
  const [trackSortOpen, setTrackSortOpen] = useState(false);
  const trackSortTrigger = useRef(null);
  const deferredQuery = useDeferredValue(trackQuery);
  const searchTokens = useMemo(() => normalizePlaylistSearch(deferredQuery).trim().split(/\s+/).filter(Boolean), [deferredQuery]);
  const searchIndex = useMemo(() => (playlist?.entry || []).map(song => ({
    song, text: playlistTrackSearchText(song), added: Date.parse(song.playlistAddedAt),
  })), [playlist?.entry]);
  const songs = useMemo(() => {
    const matches = searchIndex.filter(item => searchTokens.every(token => item.text.includes(token)));
    const direction = sortDescending ? -1 : 1;
    if (trackSort === "added" || trackSort === "duration") {
      const value = (entry) => trackSort === "added" ? entry.added : entry.song.duration;
      matches.sort((a, b) => {
        const left = value(a), right = value(b);
        if (!Number.isFinite(left)) return Number(Number.isFinite(right));
        if (!Number.isFinite(right)) return -1;
        return (left - right) * direction;
      });
    } else if (trackSort !== "custom") {
      matches.sort((a, b) => direction * trackSortCollator.compare(a.song[trackSort] || "", b.song[trackSort] || ""));
    }
    return matches.map(item => item.song);
  }, [searchIndex, searchTokens, trackSort, sortDescending]);
  const occurrenceIds = useMemo(() => songs.map((song, index) => song.playlistItemId || `${index}:${song.id}`), [songs]);
  const selection = useTrackSelection(occurrenceIds, `${id}:${deferredQuery}`);
  const { selectAll: selectAllTracks, clear: clearTrackSelection, selectedCount: trackSelectionCount } = selection;
  const selectedSongs = useMemo(() => songs.filter((_song, index) => selection.selectedIds.has(occurrenceIds[index])),
    [songs, occurrenceIds, selection.selectedIds]);
  const canManage = playlist?.permissions?.canManage === true;
  const canEditTracks = playlist?.permissions?.canEditTracks === true;
  const canEditEntries = Boolean(canEditTracks && Array.isArray(playlist?.itemIds) && songs.every((song) => song.playlistItemId));
  useEffect(() => {
    const updated = (event) => {
      if (String(event.detail?.playlistId) === String(id) && event.detail?.deletedAt) { navigate("/library/playlists"); return; }
      if (String(event.detail?.playlistId) === String(id) && event.detail?.playlist?.id) setPlaylist(event.detail.playlist);
    };
    window.addEventListener("playlistsChanged", updated);
    return () => window.removeEventListener("playlistsChanged", updated);
  }, [id, navigate]);
  useEffect(() => { setTrackQuery(""); setTrackSort("custom"); setSortDescending(false); setTrackSortOpen(false); }, [id]);
  useEffect(() => {
    let active = true, controller;
    const check = async () => {
      if (editLock.current || batchLock.current || document.visibilityState !== "visible") return;
      controller?.abort(); const polling = new AbortController(); controller = polling;
      try {
        const state = await request(`/api/v1/playlists/${encodeURIComponent(id)}/access-state`, { signal: polling.signal });
        if (!active || polling.signal.aborted || editLock.current || batchLock.current) return;
        const current = playlistRef.current;
        if (!current) return;
        if (current.editRevision !== state.editRevision || current.sharingRevision !== state.sharingRevision) {
          const updated = await getPlaylist(id);
          if (active && !polling.signal.aborted && !editLock.current && !batchLock.current) setPlaylist(updated);
        } else setPlaylist(previous => previous ? { ...previous, permissions: state.permissions } : previous);
      } catch (failure) {
        if (active && !polling.signal.aborted && /permission|access denied/i.test(failure.message)) { setError("Playlist access changed. Ask the owner to share it again."); setPlaylist(null); }
      }
    };
    const stopPolling = startVisualPolling(check, 5000, { immediate: false, refreshOnWindowFocus: true });
    return () => { active = false; controller?.abort(); stopPolling(); };
  }, [id]);

  const [
  showMenu,
  setShowMenu,
  ] = useState(false);

  const [
  deleting,
  setDeleting,
  ] = useState(false);

  const [
    artworkBusy,
    setArtworkBusy,
  ] = useState(false);

  const [
    artworkError,
    setArtworkError,
  ] = useState(null);

  const {
    playContext,
    playQueue,
    addToQueue,
    downloadQuality,
    isShuffleEnabled,
    toggleShuffle,
    isRemotePlayback,
    loopPlaylistId,
    togglePlaylistLoop,
  } = usePlayer();

  const updatePlaylistMutation = useMutation({
    mutationFn: async ({ updates, cover }) => {
      const updated = await updatePlaylist(id, updates);
      if (cover === undefined) return updated;
      try {
        const artwork = cover === null ? await clearPlaylistArtwork(id) : await setPlaylistArtwork(id, cover);
        return artwork ? { ...updated, coverArt: artwork.coverArt, coverMode: artwork.coverMode } : updated;
      } catch (error) {
        if (updated) setPlaylist(current => current?.id === playlist.id
          ? { ...current, ...updated, entry: current.entry, songCount: current.songCount } : current);
        notifyPlaylistChange();
        throw new Error(`Playlist details were saved. ${error.message || "Could not save the playlist cover."}`);
      }
    },
    onSuccess: (updatedPlaylist) => {
      if (updatedPlaylist) setPlaylist((current) => current && String(current.id) === String(id)
        ? { ...current, ...updatedPlaylist, entry: current.entry, songCount: current.songCount }
        : current);
      setEditDetailsOpen(false);
      queryClient.invalidateQueries({ queryKey: ["playlists"] });
      queryClient.invalidateQueries({ queryKey: ["playlist", id] });
      window.dispatchEvent(new Event("playlistsChanged"));
    },
  });

  const closeEditDetails = useCallback(() => {
    if (!updatePlaylistMutation.isPending) setEditDetailsOpen(false);
  }, [updatePlaylistMutation.isPending]);
  const openEditDetails = () => {
    if (!canManage || artworkBusy) return;
    updatePlaylistMutation.reset();
    setEditDetailsOpen(true);
  };

  function handleTrackPlayback(song, index) {
    playContext(
      songs,
      index,
      {
        type: deferredQuery.trim() || trackSort !== "custom" ? "collection" : "playlist",
        ...(deferredQuery.trim() || trackSort !== "custom" ? { playlistLoopId: String(playlist.id) } : {}),
        id: playlist.id,
        name: playlist.name,
        coverArt: playlist.coverArt,
      }
    );
  }

  useEffect(() => {
    function selectAllSongs(event) {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey ||
          event.key.toLowerCase() !== "a" || loading || editingBusy || batchBusy || !songs.length) return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      // Keep normal select-all behavior in search fields, editors and dialogs.
      if (target?.closest('input, textarea, select, [role="textbox"], [role="combobox"], [contenteditable]:not([contenteditable="false"]), [role="dialog"]') ||
          document.querySelector('[aria-modal="true"], dialog[open]')) return;
      event.preventDefault();
      selectAllTracks();
    }
    function deselectOutsideSongs(event) {
      const target = event.target instanceof Element ? event.target : null;
      // Row menus are portaled outside the list. Their actions still need the
      // current selection when the click reaches the action handler.
      if (target?.closest('.track[aria-selected], [data-track-selection-menu]')) return;
      if (trackSelectionCount) clearTrackSelection();
      setMenuSongId(null);
    }
    document.addEventListener("keydown", selectAllSongs);
    document.addEventListener("click", deselectOutsideSongs, true);
    return () => {
      document.removeEventListener("keydown", selectAllSongs);
      document.removeEventListener("click", deselectOutsideSongs, true);
    };
  }, [loading, editingBusy, batchBusy, songs.length, selectAllTracks, clearTrackSelection, trackSelectionCount]);

  /*
   * Load playlist from Navidrome
   */

  useEffect(() => {
    let cancelled = false;
    const generation = pageGeneration.current + 1;
    pageGeneration.current = generation;
    editLock.current = false;
    batchLock.current = false;
    setEditingBusy(false);
    setBatchBusy(false);
    setEditError("");
    setEditStatus("");
    setMenuSongId(null);

    async function loadPlaylist() {

      try {

        setLoading(true);
        setError(null);


        const data =
          await getPlaylist(id);


        if (!cancelled) {
          setPlaylist(data);
        }

      } catch (err) {

        console.error(
          "Could not load playlist:",
          err
        );


        if (!cancelled) {
          setError(
            err.message ||
            "Could not load playlist."
          );
        }

      } finally {

        if (!cancelled) {
          setLoading(false);
        }

      }

    }


    loadPlaylist();

    return () => {
      cancelled = true;
      pageGeneration.current = generation + 1;
    };
  }, [id, reloadToken]);


  /*
   * CUSTOM COVER ART
   *
   * Custom artwork overrides the automatic 2x2 collage. Only the custom image
   * is stored server-side; clearing it restores the generated collage.
   *
   * The server is the authority on what it accepts; these client-side limits
   * only mirror it so an obviously invalid file is reported immediately
   * instead of after a large upload.
   */

  const MAX_COVER_BYTES = 5 * 1024 * 1024;

  const ACCEPTED_COVER_TYPES = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
  ];

  function readImageAsDataUrl(file) {

    return new Promise((resolve, reject) => {

      const reader = new FileReader();

      reader.onload = () =>
        resolve(reader.result);

      reader.onerror = () =>
        reject(
          new Error(
            "Could not read the selected image."
          )
        );

      reader.readAsDataURL(file);

    });

  }

  function prepareCover(file) {
    if (!ACCEPTED_COVER_TYPES.includes(file.type)) throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
    if (file.size > MAX_COVER_BYTES) throw new Error("Cover images must be 5 MB or smaller.");
    return readImageAsDataUrl(file);
  }


  function applyArtwork(updated) {

    if (!updated) {
      return;
    }

    setPlaylist((currentPlaylist) =>
      currentPlaylist
        ? {
            ...currentPlaylist,
            coverArt: updated.coverArt,
            coverMode: updated.coverMode,
          }
        : currentPlaylist
    );

    // The sidebar and library grids own separate playlist lists; the new
    // artwork reference carries an updated signature, so a reload is enough
    // to bust their cached thumbnails.
    queryClient.invalidateQueries({ queryKey: ["playlists"] });
    queryClient.invalidateQueries({ queryKey: ["playlist", id] });
    window.dispatchEvent(new Event("playlistsChanged"));

  }


  async function handleCoverUpload(event) {

    const file =
      event.target.files &&
      event.target.files[0];

    event.target.value = "";

    if (!file) {
      return;
    }

    setArtworkBusy(true);
    setArtworkError(null);

    try {

      applyArtwork(
        await setPlaylistArtwork(
          id,
          await prepareCover(file)
        )
      );

    } catch (err) {

      setArtworkError(
        err.message ||
        "Could not update the playlist cover."
      );

    } finally {

      setArtworkBusy(false);

    }

  }


  async function handleCoverReset() {

    setArtworkBusy(true);
    setArtworkError(null);

    try {

      applyArtwork(
        await clearPlaylistArtwork(id)
      );

    } catch (err) {

      setArtworkError(
        err.message ||
        "Could not restore the automatic cover."
      );

    } finally {

      setArtworkBusy(false);

    }

  }


  function notifyPlaylistChange() {
    queryClient.invalidateQueries({ queryKey: ["playlists"] });
    queryClient.invalidateQueries({ queryKey: ["playlist", id] });
    window.dispatchEvent(new Event("playlistsChanged"));
  }

  async function persistEntryEdit(nextPlaylist, requestEdit) {
    if (editLock.current) throw new Error("A playlist edit is already being saved.");
    const previous = playlistRef.current;
    const generation = pageGeneration.current;
    editLock.current = true;
    setEditingBusy(true);
    setEditError("");
    setMenuSongId(null);
    if (nextPlaylist) setPlaylist(nextPlaylist);
    try {
      const updated = await requestEdit();
      if (generation !== pageGeneration.current) return;
      setPlaylist((current) => ({
        ...current, entry: updated.entry, itemIds: updated.itemIds, songCount: updated.songCount,
      }));
      notifyPlaylistChange();
    } catch (failure) {
      console.error("Could not save playlist entries:", failure);
      if (generation === pageGeneration.current) {
        if (nextPlaylist) setPlaylist((current) => ({
          ...current, entry: previous.entry, itemIds: previous.itemIds, songCount: previous.songCount,
        }));
        setEditError(failure.message || "Could not save playlist changes.");
      }
      throw failure;
    } finally {
      if (generation === pageGeneration.current) {
        editLock.current = false;
        setEditingBusy(false);
      }
    }
  }

  async function reorderEntries(ids, targetIndex) {
    if (!canEditEntries) throw new Error("Reload this playlist before reordering its tracks.");
    const previous = playlistRef.current;
    const visible = songs.map((song) => song.playlistItemId);
    const reordered = reorderPlaylistEntries(visible, new Set(ids), targetIndex);
    if (reordered.every((key, index) => key === visible[index])) return;
    const visibleSet = new Set(visible);
    let cursor = 0;
    // Unavailable catalog entries keep their slots and cannot be accidentally deleted.
    const itemIds = previous.itemIds.map((key) => visibleSet.has(key) ? reordered[cursor++] : key);
    const byId = new Map(previous.entry.map((song) => [song.playlistItemId, song]));
    await persistEntryEdit({ ...previous, itemIds, entry: itemIds.flatMap(key => byId.has(key) ? [byId.get(key)] : []) },
      () => reorderPlaylistItems(id, itemIds, previous.itemIds));
  }

  async function removeEntries(ids) {
    if (!canEditEntries) throw new Error("Reload this playlist before removing selected tracks.");
    const expectedItemIds = playlistRef.current.itemIds;
    await persistEntryEdit(null, () => editPlaylistTracks(id, {
      action: "remove", itemIds: ids, expectedItemIds,
    }));
  }

  async function runTrackAction(action) {
    if (batchLock.current || editLock.current) return;
    const generation = pageGeneration.current;
    batchLock.current = true;
    setBatchBusy(true);
    setEditError("");
    try {
      await action();
      if (generation === pageGeneration.current) setMenuSongId(null);
    } catch (failure) {
      console.error("Could not complete track action:", failure);
      if (generation === pageGeneration.current) setEditError(failure.message || "Could not complete this action.");
    } finally {
      if (generation === pageGeneration.current) {
        batchLock.current = false;
        setBatchBusy(false);
      }
    }
  }

  function menuSongs(song) {
    return selectedSongs.length ? selectedSongs : [song];
  }


async function handleRemoveSong(
  song,
  songIndex
) {
  songIndex = playlistRef.current.entry.indexOf(song);
  if (songIndex < 0) { setEditError("This track is no longer in the playlist. Reload before editing."); return; }
  const generation = pageGeneration.current;
  try {
    if (canEditEntries) {
      await removeEntries([song.playlistItemId]);
      return;
    }

    await removeSongFromPlaylistRequest(
      id,
      songIndex
    );
    if (generation !== pageGeneration.current) return;

      setPlaylist((currentPlaylist) => {

        if (!currentPlaylist) {
          return currentPlaylist;
        }


        const updatedSongs =
          (currentPlaylist.entry || [])
            .filter(
              (_playlistSong, index) => index !== songIndex
            );


        return {
          ...currentPlaylist,

          entry: updatedSongs,

          songCount:
            updatedSongs.length,
        };

      });


      /*
       * Close the menu.
       */

      setMenuSongId(null);

    } catch (error) {

      console.error(
        "Could not remove song from playlist:",
        error
      );
      if (generation === pageGeneration.current) setEditError(error.message || "Could not remove song from playlist.");

    }

  }

  if (loading) {

    return (

      <div className="playlist-page" data-view-loading="true">

        <div className="loading">
          Loading playlist...
        </div>

      </div>

    );

  }

  if (error || !playlist) {

    return (

      <div className="playlist-page">

        <Link
          to="/library/playlists"
          className="playlist-back"
        >
          ← Back
        </Link>


        <div className="error">

          {error ||
            "Playlist not found."}

        </div>

      </div>

    );

  }

  function playPlaylist() {

    if (songs.length === 0) {
      return;
    }
    playQueue(
      songs,
      0,
      {
        type: deferredQuery.trim() || trackSort !== "custom" ? "collection" : "playlist",
        ...(deferredQuery.trim() || trackSort !== "custom" ? { playlistLoopId: String(playlist.id) } : {}),
        id: playlist.id,
        name: playlist.name,
        coverArt: playlist.coverArt,
      }
    );

  }

  return (

    <div
      className="playlist-page detail-hero-gradient"
      data-view-loading={String(playlist.id) !== id}
    >


      {/* BACK */}

      <Link
        to="/library/playlists"
        className="playlist-back"
      >
        ← Back
      </Link>

      <div className="playlist-header">


        <div className="playlist-cover-column">

          <button
            type="button"
            className="playlist-page-cover playlist-cover-editable"
            aria-label={`Choose photo for ${playlist.name}`}
            aria-busy={artworkBusy}
            disabled={artworkBusy || !canManage}
            onClick={() => coverInputRef.current?.click()}
          >

            <PlaylistCover
              playlist={playlist}
              placeholderClassName="playlist-placeholder"
            />

            {canManage && <span className="playlist-cover-overlay" aria-hidden="true">
              <svg
                className="playlist-cover-overlay-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21.17 6.81a2.83 2.83 0 0 0-4-4L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5Z" />
                <path d="m15 5 4 4" />
              </svg>
              <span>
                {artworkBusy ? "Updating…" : "Choose photo"}
              </span>
            </span>}

          </button>

          <input
            ref={coverInputRef}
            id="playlist-cover-upload"
            className="playlist-cover-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            tabIndex={-1}
            aria-hidden="true"
            disabled={artworkBusy}
            onChange={handleCoverUpload}
          />

          {artworkError && (
            <div className="error playlist-cover-error" role="alert">
              {artworkError}
            </div>
          )}

        </div>

        <div className="playlist-page-info">


          <div className="playlist-type">
            PLAYLIST
          </div>


          <h1>
            {canManage ? <button type="button" className="playlist-title-edit" onClick={openEditDetails} disabled={artworkBusy}
              aria-haspopup="dialog" title="Edit details">{playlist.name}</button> : playlist.name}
          </h1>


          {playlist.description && (

            <p className="playlist-description">
              {playlist.description}
            </p>

          )}


          <div className="playlist-meta">

            {songs.length}{" "}

            {songs.length === 1
              ? "song"
              : "songs"}

          </div>

        </div>


      </div>

      <div className="detail-action-row playlist-actions">


            <button
              className="playlist-play"
              onClick={playPlaylist}
              disabled={
                songs.length === 0
              }
            >
              ▶
              <span>
                Play
              </span>

            </button>

            <button
              type="button"
              className={`detail-secondary-action${isShuffleEnabled ? " is-active" : ""}`}
              aria-label="Toggle shuffle"
              aria-pressed={Boolean(isShuffleEnabled)}
              onClick={toggleShuffle}
              disabled={isRemotePlayback}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h3c5 0 6 12 11 12h4m-4-4 4 4-4 4M3 18h3c2 0 3.5-2 4.8-4.5M14 8.7C15 7 16 6 17 6h4m-4-4 4 4-4 4" />
              </svg>
            </button>

            <button type="button" className={`detail-secondary-action${loopPlaylistId === String(playlist.id) ? " is-active" : ""}`}
              aria-label="Loop playlist" aria-pressed={loopPlaylistId === String(playlist.id)}
              disabled={!songs.length || isRemotePlayback} onClick={() => togglePlaylistLoop(String(playlist.id))}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m17 3 4 4-4 4M3 7h18M7 21l-4-4 4-4m14 4H3" />
              </svg>
            </button>

            <CollectionDownloadButton
              tracks={songs}
              quality={downloadQuality}
              label="playlist"
              collectionId={playlist.id}
              collectionName={playlist.name}
            />
            {canManage && <button type="button" className="detail-secondary-action playlist-share-action" aria-label="Share playlist"
              onClick={() => setSharingOpen(true)}><span>Share<br />playlist</span></button>}

<div className="playlist-options">

  <button
    className="detail-secondary-action playlist-action"
    ref={optionsTriggerRef}
    aria-label="More options"
    aria-haspopup="menu"
    aria-expanded={showMenu}
    onClick={(event) => {
      event.stopPropagation();

      setShowMenu(
        (current) => !current
      );
    }}
  >
    ⋯
  </button>


  {showMenu && (

    <FloatingPanel anchorRef={optionsTriggerRef} onClose={() => setShowMenu(false)} className="playlist-options-menu" role="menu">
      {canManage && <PlaylistTasteOption id={String(id)} excluded={Boolean(playlist.excludeFromTaste)} onChanged={value => setPlaylist(previous => ({ ...previous, excludeFromTaste: value,
        entry: previous.entry.map(song => ({ ...song, excludeFromTaste: value })) }))} />}
      <div className="playlist-history-menu" role="group" aria-label="Playlist history">
        <span className="playlist-history-label">Playlist history</span>
        <button type="button" role="menuitem" className="playlist-menu-item" disabled={!history.canUndo || history.busy}
          onClick={() => { void history.undo().catch(() => undefined); }}><span aria-hidden="true">↶</span>Undo</button>
        <button type="button" role="menuitem" className="playlist-menu-item" disabled={!history.canRedo || history.busy}
          onClick={() => { void history.redo().catch(() => undefined); }}><span aria-hidden="true">↷</span>Redo</button>
        {(history.error || history.message || history.busy) && <p className="playlist-history-message" role={history.error ? "alert" : "status"}>
          {history.error || (history.busy ? "Saving playlist changes…" : history.message)}
        </p>}
      </div>

      <button
        type="button"
        className="playlist-menu-item"
        role="menuitem"
        disabled={songs.length === 0}
        aria-label={`Add ${songs.length} ${songs.length === 1 ? "track" : "tracks"} to queue`}
        onClick={() => {
          songs.forEach(addToQueue);
          setShowMenu(false);
        }}
      >
        <span aria-hidden="true">＋</span>
        Add to queue
      </button>

      <button
        type="button"
        className="playlist-menu-item"
        role="menuitem"
        disabled={!canManage}
        onClick={() => {
          setShowMenu(false);
          openEditDetails();
        }}
      >
        <span aria-hidden="true">✎</span>
        Edit details
      </button>

      {canManage && playlist.coverMode === "custom" && (
        <button
          type="button"
          className="playlist-menu-item"
          role="menuitem"
          disabled={artworkBusy}
          onClick={() => {
            setShowMenu(false);
            handleCoverReset();
          }}
        >
          <span aria-hidden="true">↺</span>
          Remove custom cover
        </button>
      )}

      <button
        type="button"
        className="playlist-delete"
        role="menuitem"
        disabled={deleting || !canManage}
        onClick={async (event) => {

          event.stopPropagation();

          const confirmed =
            window.confirm(
              `Move "${playlist.name}" to Trash? You can restore it for 30 days.`
            );

          if (!confirmed) {
            return;
          }

          try {

            setDeleting(true);

            await deletePlaylist(
              playlist.id
            );

            setShowMenu(false);

            /*
             * Return to the playlist list
             * after successful deletion.
             */

            navigate("/library/playlists");

            window.dispatchEvent(
            new Event("playlistsChanged")
            );

          } catch (error) {

            console.error(
              "Could not delete playlist:",
              error
            );

            alert(
              error.message ||
              "Could not delete playlist."
            );

            setDeleting(false);

          }

        }}
      >
        {deleting
            ? "Moving to Trash..."
          : "Delete playlist"}
      </button>

    </FloatingPanel>

  )}

</div>

        <div className="playlist-track-tools">
          <PlaylistSearchBox key={id} label="Search this playlist" value={trackQuery} onChange={setTrackQuery} />
          <button type="button" className="folder-sort-trigger" ref={trackSortTrigger} aria-label={`Sort tracks: ${trackSortLabels[trackSort]}`}
            aria-haspopup="menu" aria-expanded={trackSortOpen} onClick={() => setTrackSortOpen(!trackSortOpen)}>
            {trackSortLabels[trackSort]} <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h12M8 12h8M8 18h4M4 5v2m0 4v2m0 4v2" /></svg>
          </button>
          {trackSortOpen && <FloatingPanel anchorRef={trackSortTrigger} className="folder-sort-menu" aria-label="Sort playlist tracks" onClose={() => setTrackSortOpen(false)}>
            <span className="folder-sort-caption" aria-hidden="true">Sort by</span>
            {Object.entries(trackSortLabels).map(([value, label]) => <button key={value} type="button" role="menuitemradio" aria-checked={trackSort === value}
              onClick={() => { sortBy(value); setTrackSortOpen(false); trackSortTrigger.current?.focus(); }}>
              {label}{trackSort === value && <span aria-hidden="true">{value === "custom" ? "✓" : sortDescending ? "↓" : "↑"}</span>}
            </button>)}
          </FloatingPanel>}
        </div>

      </div>


      {/* SONG LIST */}

      {trackQuery && <p className="playlist-edit-message" role="status">{songs.length} of {playlist.entry?.length || 0} tracks</p>}

      {!canEditTracks && songs.length > 0 && <p className="playlist-edit-message">Viewer access · You can listen and add tracks to your own queue.</p>}
      {canEditTracks && !canEditEntries && songs.length > 0 && <p className="playlist-edit-message">Reload to enable batch removal and reordering.</p>}
      {playlist.sharingMode === "COLLABORATIVE" && canEditTracks && <PlaylistPartyPanel playlistId={String(id)} canManage={canManage} selectedTracks={selectedSongs} />}
      {editError && <div className="playlist-edit-message is-error" role="alert">
        <span>{editError}</span>
        <button type="button" disabled={editingBusy || batchBusy} onClick={() => { selection.clear(); setReloadToken((value) => value + 1); }}>Reload playlist</button>
      </div>}
      {editStatus && <p className="playlist-edit-message" role="status">{editStatus}</p>}
      {editingBusy && <p className="playlist-edit-message" role="status">Saving playlist changes...</p>}
      <div className="track-list playlist-track-list" role="grid" aria-label="Playlist tracks" aria-multiselectable="true" aria-rowcount={songs.length + 1}>

        <TrackListHeader sort={{ field: trackSort, descending: sortDescending, onChange: sortBy }} />

        {songs.length === 0 ? (

          <div className="library-empty">
            {trackQuery ? "No tracks match this search." : "This playlist doesn't have any songs yet."}
          </div>

        ) : (

            <VirtualizedTrackList
              itemCount={songs.length}
              getItem={(index) => songs[index]}
              getItemKey={(index) => occurrenceIds[index]}
              dataKey={id}
              onPlay={handleTrackPlayback}
              showDateAdded
              searchTokens={searchTokens}


              selection={selection}
              editingDisabled={editingBusy || batchBusy}
              onReorder={canEditEntries && trackSort === "custom" ? (ids, target) => {
                if (batchLock.current || editLock.current) return;
                const generation = pageGeneration.current;
                void reorderEntries(ids, target).catch((failure) => {
                  console.error("Playlist reorder failed:", failure);
                  if (generation === pageGeneration.current) setEditError(failure.message || "Could not reorder playlist tracks.");
                });
              } : undefined}
              onToggleEntryMenu={(_song, index) => {
                setMenuSongId(menuSongId === occurrenceIds[index] ? null : occurrenceIds[index]);
              }}
              renderMenu={(song, index) => canEditTracks && menuSongId === occurrenceIds[index] ? (
                <div className="playlist-menu">
                  <button type="button" role="menuitem" className="playlist-menu-item playlist-track-remove" disabled={editingBusy || batchBusy} onClick={() => { void runTrackAction(async () => {
                      const tracks = menuSongs(song);
                      if (tracks.length > 1 && !window.confirm(`Remove ${tracks.length} tracks from this playlist?`)) return;
                      if (canEditEntries) await removeEntries(tracks.map((track) => track.playlistItemId));
                      else await handleRemoveSong(song, index);
                    }); }}>Remove from Playlist</button>
                </div>
              ) : null}
            />

        )}

      </div>

      <PlaylistRecommendations key={id} playlistId={id} songs={songs} disabled={editingBusy || batchBusy}
        onPlaylistChange={(updated) => {
          setPlaylist((current) => current?.id === updated.id ? updated : current);
          notifyPlaylistChange();
        }} />
      {editDetailsOpen && (
        <PlaylistDetailsDialog
          playlist={playlist}
          busy={updatePlaylistMutation.isPending}
          error={updatePlaylistMutation.error?.message || ""}
          onClose={closeEditDetails}
          prepareCover={prepareCover}
          onSave={(updates, cover) => updatePlaylistMutation.mutate({ updates, cover })}
        />
      )}
      {sharingOpen && canManage && <PlaylistShareModal playlistId={String(id)} playlistName={playlist.name} onClose={() => setSharingOpen(false)}
        onSaved={state => { setPlaylist(previous => ({ ...previous, sharingMode: state.mode, sharingRevision: state.revision,
          entry: previous.entry.map(song => ({ ...song, showContributor: state.mode === "COLLABORATIVE" })) })); }} />}

    </div>

  );

}


export default Playlist;
