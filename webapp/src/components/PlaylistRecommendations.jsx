import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getPlaylistRecommendations, editPlaylistTracks } from "../api/playlists";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";
import { usePrivacy } from "../context/PrivacyContext";
import { useExternalAction } from "../services/externalActions";
import { resolveTrackPreview } from "../services/resolveTrackPreview";
import { toUnifiedTrack } from "../types/track";

import TrackRow from "./TrackRow";
import TrackActionScope from "./TrackActionScope";
import "../styles/playlist-recommendations.css";

const normalize = (value) => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
const recording = (track) => `${normalize(track.artist || track.artistName)}:${normalize(track.title)}`;

const Recommendation = memo(function Recommendation({ song, playlistId, editable, disabled, canImport, onAdded, onImported,
  onPlay, index }) {
  const { snapshot, start } = useExternalAction("track", song);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (song.external && snapshot.state === "IN_LIBRARY") onImported();
  }, [snapshot.state, song.external, onImported]);
  const importing = snapshot.state === "QUEUED" || snapshot.state === "IMPORTING";
  const imported = song.external && snapshot.state === "IN_LIBRARY";
  async function add() {
    if (lock.current || disabled || !editable) return;
    lock.current = true; setAdding(true); setError("");
    try {
      const updated = await editPlaylistTracks(playlistId, { action: "add", trackIds: [String(song.id)] });
      if (mounted.current) onAdded(updated);
    } catch (failure) {
      if (mounted.current) setError(failure.message || "Could not add this song. Try again.");
    } finally {
      lock.current = false;
      if (mounted.current) setAdding(false);
    }
  }
  const label = adding ? "Adding…" : !song.external ? "Add" : imported ? "Imported"
    : importing ? snapshot.progress == null ? "Importing…" : `${Math.round(snapshot.progress)}%`
      : snapshot.state === "FAILED" ? "Retry" : "Import";
  const action = <button type="button" className={`playlist-recommendation-action${song.external ? " is-external" : ""}`}
    aria-label={`${!song.external ? "Add" : imported ? "Imported" : "Import"} ${song.title}${!song.external ? " to playlist" : ""}`}
    disabled={disabled || adding || importing || imported || (!song.external && !editable) || (song.external && !canImport)}
    title={song.external ? canImport ? "Download to your server library" : "Server imports are disabled for your account or by privacy settings"
      : editable ? "Add to this playlist" : "You cannot edit this playlist"}
    onClick={() => { if (song.external) void start(); else void add(); }}>
    {song.external && !importing && !imported && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18H6a4 4 0 0 1-.4-8A6 6 0 0 1 17 7a5 5 0 0 1 1 10h-1M12 11v10m-4-4 4 4 4-4" /></svg>}
    {label}
  </button>;
  return <div className="playlist-recommendation">
    <TrackRow song={song} index={index} showArtwork showImportAction={false} action={action}
      onPlay={onPlay}   className="playlist-recommendation-row" />
    {(error || (song.external && snapshot.message && snapshot.state === "FAILED")) &&
      <p className="playlist-recommendation-error" role="alert">{error || snapshot.message}</p>}
    {song.external && snapshot.connectionLost && <p className="playlist-recommendation-note" role="status">{snapshot.message}</p>}
  </div>;
});

export default function PlaylistRecommendations({ playlistId, songs, disabled = false, onPlaylistChange }) {
  const { session } = useAuth() || {};
  const { canMetadata, canImport } = usePrivacy();
  const player = usePlayer();
  const playSong = player?.playSong;
  const audioEngine = player?.audioEngine;
  const client = useQueryClient();
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState("");
  const importRefresh = useRef(null);
  const previewRequest = useRef(0);
  useEffect(() => () => { previewRequest.current += 1; }, [playlistId]);
  useEffect(() => () => { if (importRefresh.current) clearTimeout(importRefresh.current); }, []);
  
  const signature = useMemo(() => songs.map((song) => String(song.id)).sort().join("|"), [songs]);
  const baseKey = useMemo(() => ["playlist-recommendations", session?.id || "current", playlistId], [session?.id, playlistId]);
  const externalEnabled = canMetadata && (session?.role === "admin" || session?.externalSearchEnabled === true);
  const load = (source) => ({ queryKey: [...baseKey, source, signature], enabled: songs.length > 0,
    queryFn: ({ signal }) => getPlaylistRecommendations(playlistId, source, signal), staleTime: 60_000, retry: 1 });
  const local = useQuery(load("library"));
  const external = useQuery({ ...load("external"), enabled: songs.length > 0 && externalEnabled });
  const items = useMemo(() => {
    const existingIds = new Set(songs.map((song) => String(song.id)));
    const seen = new Set(songs.map(recording));
    const seenIsrc = new Set(songs.map((song) => song.identityHints?.isrc || song.metadata?.isrc).filter(Boolean));
    const owned = (local.data?.items || []).map((item) => toUnifiedTrack(item, "playlist-recommendations"));
    const discovered = (externalEnabled ? external.data?.items || [] : []).map((item) => toUnifiedTrack(item, "playlist-recommendations"));
    const all = [];
    for (let index = 0; index < Math.max(owned.length, discovered.length); index++) {
      for (const item of [owned[index], discovered[index]]) {
        if (!item || existingIds.has(String(item.id)) || seen.has(recording(item))) continue;
        const isrc = item.identityHints?.isrc || item.metadata?.isrc;
        if (isrc && seenIsrc.has(isrc)) continue;
        seen.add(recording(item)); if (isrc) seenIsrc.add(isrc);
        all.push(item);
      }
    }
    return all;
  }, [songs, local.data, external.data, externalEnabled]);
  const onPlay = useCallback(async (song) => {
    const request = ++previewRequest.current;
    setNotice("");
    try {
      if (!playSong) throw new Error("The player is unavailable.");
      if (!song.external) { await playSong(song); return; }
      if (!canMetadata) throw new Error("External previews are disabled in your privacy settings.");
      // Resume Web Audio while the click still counts as a user gesture.
      void Promise.resolve(audioEngine?.unlock?.()).catch(() => {});
      setNotice("Loading preview…");
      const previewUrl = await resolveTrackPreview(song, () => request === previewRequest.current);
      if (request !== previewRequest.current) return;
      if (!previewUrl) throw new Error(`Preview unavailable for ${song.title}.`);
      setNotice("");
      await playSong({ ...song, previewUrl, source: song.source?.kind === "external" ? song.source : { kind: "external", count: 0 } });
    } catch (failure) {
      if (request === previewRequest.current) setNotice(failure.message || "Could not play this song.");
    }
  }, [audioEngine, canMetadata, playSong]);
  const onImported = useCallback(() => {
    setNotice("Imported songs become available to add after your library updates.");
    void client.invalidateQueries({ queryKey: baseKey });
    // Give the provider rescan and short-lived catalog index time to catch up.
    // A single bounded follow-up avoids polling every recommendation row.
    if (importRefresh.current) clearTimeout(importRefresh.current);
    importRefresh.current = setTimeout(() => {
      importRefresh.current = null;
      void client.invalidateQueries({ queryKey: baseKey });
    }, 16_000);
  }, [client, baseKey]);
  const totalPages = Math.max(1, Math.ceil(items.length / 6));
  const visible = items.slice((page % totalPages) * 6, (page % totalPages) * 6 + 6);
  const loading = local.isFetching || (externalEnabled && external.isFetching);
  if (!songs.length) return null;
  return <section className="playlist-recommendations" aria-labelledby="playlist-recommendations-title">
    <div className="playlist-recommendations-heading"><div>
      <h2 id="playlist-recommendations-title">Recommended</h2>
      <p>Based on what's in this playlist</p>
    </div><button type="button" className="playlist-recommendations-refresh" disabled={loading}
      onClick={() => {
        setPage((value) => value + 1);
        if (totalPages === 1 || (page + 1) % totalPages === 0) {
          void local.refetch(); if (externalEnabled) void external.refetch();
        }
      }}>Refresh</button></div>
    <TrackActionScope tracks={visible} dataKey={`${playlistId}:${page}`} disabled={disabled}><div className="playlist-recommendations-list track-list" role="table" aria-label="Recommended songs">
      {visible.map((song, index) => <Recommendation key={song.id} song={song} index={index} playlistId={playlistId}
        editable={local.data?.canModify === true} disabled={disabled}
        canImport={canImport && (session?.role === "admin" || session?.externalPlaybackEnabled === true)}
        onAdded={onPlaylistChange} onImported={onImported} onPlay={onPlay}
          />)}
    </div></TrackActionScope>
    {loading && <p className="playlist-recommendations-status" role="status">{items.length ? "Finding more songs…" : "Finding songs for this playlist…"}</p>}
    {!loading && !items.length && !local.isError && !(externalEnabled && external.isError) && <p className="playlist-recommendations-status">No more suggestions yet. Try again after adding a few different songs.</p>}
    {(local.isError || (externalEnabled && external.isError)) && <p className="playlist-recommendations-status" role="status">
      Some recommendations couldn't be loaded. <button type="button" onClick={() => {
        if (local.isError) void local.refetch(); if (externalEnabled && external.isError) void external.refetch();
      }}>Retry recommendations</button>
    </p>}
    {(local.data?.message || (externalEnabled && external.data?.message)) && <p className="playlist-recommendations-status">{local.data?.message || external.data?.message}</p>}
    {notice && <p className="playlist-recommendations-status" role="status">{notice}</p>}
  </section>;
}
