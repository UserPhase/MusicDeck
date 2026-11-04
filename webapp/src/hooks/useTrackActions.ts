import { useEffect, useRef, useState } from "react";
import { usePlayer } from "../context/PlayerContext";
import { useAuth } from "../context/AuthContext";
import { usePrivacy } from "../context/PrivacyContext";
import { createPlaylist, editPlaylistTracks, getPlaylists } from "../api/playlists";
import { getUserSettings, sendRecommendationFeedback, startRadio, updateUserSettings } from "../api/musicdeck";
import { downloadToDevice } from "../utils/downloadManager";
import { offlineAuditor } from "../services/storage/OfflineAuditor";
import { offlineDownloadEngine } from "../services/storage/OfflineDownloadEngine";
import { externalActions } from "../services/externalActions";
import { discoveryInput, useSavedDiscoveries } from "./useSavedDiscoveries";
import type { Track } from "../components/TrackRow";

export type TrackActionName = "playNext" | "addToQueue" | "addToPlaylist" | "toggleFavorite" | "downloadSelected" | "hideFromRecommendations" | "saveForLater" | "startRadio";
export interface TrackActionResult { completed: number; imported: number; queued: number; playlistId?: string }
export class TrackActionError extends Error {
  constructor(message: string, readonly completed = 0, readonly failedIds: readonly string[] = []) { super(message); this.name = "TrackActionError"; }
}
export function normalizeActionTrack(track: Track): Track & { id: string } {
  const id = typeof track.id === "string" ? track.id : typeof track.id === "number" && Number.isFinite(track.id) ? String(track.id) : "";
  return { ...track, id, title: track.title || String(track.name || "Unknown title"),
    artist: track.artist || String(track.artistName || "Unknown artist"),
    ...(track.album === undefined && typeof track.albumName === "string" ? { album: track.albumName } : {}),
    ...(track.duration == null && typeof track.metadata?.durationSeconds === "number" ? { duration: track.metadata.durationSeconds } : {}) };
}
export function isLibraryActionTrack(track: Track): boolean {
  if (String(track.id).startsWith("external_") || track.sample) return false;
  return Boolean(track.isDownloaded || track.source?.kind === "library" || track.availability?.libraryAvailable ||
    (!track.external && !["external", "deezer", "itunes", "spotify"].includes(String(track.provider || "").toLowerCase())));
}
const playlistKey = "trackActions.savedForLaterPlaylist";
const savedPlaylistRequests = new Map<string, Promise<string>>();
async function savedPlaylist(owner: string, assertCurrent: () => void): Promise<string> {
  const pending = savedPlaylistRequests.get(owner);
  if (pending) return pending;
  const operation = (async () => {
    const settings = await getUserSettings(); assertCurrent();
    const setting = settings.find((item: { key: string; value: unknown }) => item.key === playlistKey);
    let id: unknown = null;
    if (setting) { try { id = JSON.parse(String(setting.value)); } catch { id = null; } }
    if (typeof id === "string") {
      const playlists = await getPlaylists(); assertCurrent();
      if (playlists.some((item: { id: string | number }) => String(item.id) === id)) return id;
    }
    const playlist = await createPlaylist("Saved for Later", "Tracks saved from MusicDeck's track actions."); assertCurrent();
    if (!playlist?.id) throw new Error("The server did not confirm the Saved for Later playlist. Refresh your playlists before retrying.");
    await updateUserSettings({ [playlistKey]: String(playlist.id) }); assertCurrent();
    window.dispatchEvent(new Event("playlistsChanged"));
    return String(playlist.id);
  })();
  savedPlaylistRequests.set(owner, operation);
  try { return await operation; } finally { if (savedPlaylistRequests.get(owner) === operation) savedPlaylistRequests.delete(owner); }
}

/** Menus and batch toolbars mount this controller; closed rows never subscribe to the broad player context. */
export function useTrackActions(target: Track | readonly Track[]) {
  const player = usePlayer();
  const owner = useAuth()?.session?.id ?? null;
  const { canImport } = usePrivacy();
  const saved = useSavedDiscoveries();
  const [busy, setBusy] = useState<TrackActionName | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(false), locked = useRef(false);
  const operationToken = useRef<symbol | null>(null);
  const favoriteRetry = useRef<{ key: string; favorite: boolean; ids: ReadonlySet<string> } | null>(null);
  const live = useRef({ player, owner, canImport, saved, target });
  live.current = { player, owner, canImport, saved, target };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { operationToken.current = null; locked.current = false; favoriteRetry.current = null; setBusy(null); setError(""); }, [owner]);
  const tracks = (Array.isArray(target) ? target : [target]).map(normalizeActionTrack);
  const allLibrary = tracks.length > 0 && tracks.every(isLibraryActionTrack);
  const allFavorite = tracks.length > 0 && tracks.every((track) => player?.likedSongIds?.has(track.id));

  async function perform(name: TrackActionName, playlistId?: string, targets?: readonly Track[]): Promise<TrackActionResult> {
    if (locked.current) throw new TrackActionError("Another track action is still running.");
    const current = live.current;
    const ownerAtStart = current.owner;
    // Selection mutations can remove their own row/menu. Bind continuation to
    // the authenticated storage owner and route, rather than that row's lifetime.
    const storageBound = Boolean(ownerAtStart && offlineDownloadEngine.getOwner() === ownerAtStart);
    let navigated = false;
    const navigation = () => { navigated = true; };
    const reject = (message: string): never => {
      if (mounted.current && live.current.owner === ownerAtStart) setError(message);
      throw new TrackActionError(message);
    };
    const assertCurrent = () => {
      if (navigated || live.current.owner !== ownerAtStart || (storageBound
        ? offlineDownloadEngine.getOwner() !== ownerAtStart : !mounted.current)) {
        throw new TrackActionError("The view or signed-in account changed. No further tracks were processed.");
      }
    };
    const chosen: Track[] = (targets ?? (Array.isArray(current.target) ? current.target : [current.target])).map(normalizeActionTrack);
    if (!chosen.length) reject("Select at least one track.");
    if (chosen.some((track) => !String(track.id).trim())) reject("A selected track has no valid ID. Refresh this collection and select it again.");
    const unique = [...new Map(chosen.map((track) => [String(track.id), track])).values()];
    if (["addToPlaylist", "toggleFavorite"].includes(name) && !unique.every(isLibraryActionTrack)) {
      reject("Import external tracks to your library before liking them or adding them to a playlist.");
    }
    if (!["playNext", "addToQueue", "startRadio"].includes(name) && !ownerAtStart) reject("Sign in to change your saved music.");
    if (name === "downloadSelected" && unique.some((track) => !isLibraryActionTrack(track)) && !current.canImport) reject("External imports are disabled by privacy settings.");
    const token = Symbol(name); operationToken.current = token; locked.current = true; setBusy(name); setError("");
    window.addEventListener("musicdeck:navigation", navigation);
    let completed = 0, imported = 0, queued = 0;
    const failed: string[] = [], messages: string[] = [];
    const each = async (items: Track[], operation: (track: Track) => Promise<void>) => {
      for (const track of items) {
        assertCurrent();
        try { await operation(track); assertCurrent(); completed++; }
        catch (failure) {
          assertCurrent(); failed.push(String(track.id)); messages.push(failure instanceof Error ? failure.message : "Please retry this track.");
        }
      }
    };
    const add = async (id: string, items: Track[]) => {
      for (let offset = 0; offset < items.length; offset += 500) {
        assertCurrent();
        const playlist = await editPlaylistTracks(id, { action: "add", trackIds: items.slice(offset, offset + 500).map((track) => String(track.id)) });
        assertCurrent(); completed += Math.min(500, items.length - offset);
        window.dispatchEvent(new CustomEvent("playlistsChanged", { detail: { playlistId: id, playlist } }));
      }
    };
    try {
      assertCurrent();
      if (name === "playNext" || name === "addToQueue") {
        const action = name === "playNext" ? current.player?.playTracksNext : current.player?.queueTracks;
        if (!action) throw new TrackActionError("Playback is unavailable. Reload MusicDeck and try again.");
        // Preserve playlist occurrences and order. Mutation actions below deduplicate song IDs.
        action(chosen); completed = chosen.length;
      } else if (name === "startRadio") {
        if (unique.length !== 1 || !current.player?.playQueue) throw new TrackActionError("Choose one track to start radio.");
        const track = unique[0];
        const radio = await startRadio({ type: "track", id: String(track.id), title: track.title, artist: track.artist, album: track.album,
          artistId: track.artistId || track.metadata?.artistId || null, albumId: track.albumId || track.metadata?.albumId || null });
        assertCurrent();
        if (!radio.length) throw new TrackActionError("No eligible tracks are available for this radio station.");
        await current.player.playQueue(radio, 0); completed = radio.length;
      } else if (name === "addToPlaylist") {
        if (!playlistId) throw new TrackActionError("Choose a destination playlist.");
        await add(playlistId, unique);
      } else if (name === "toggleFavorite") {
        const key = JSON.stringify(unique.map((track) => String(track.id)));
        const retry = favoriteRetry.current?.key === key ? favoriteRetry.current : null;
        const favorite = retry?.favorite ?? !unique.every((track) => current.player?.likedSongIds?.has(String(track.id)));
        if (!current.player?.setTrackFavorite) throw new TrackActionError("Favorites are unavailable. Reload MusicDeck and try again.");
        await each(retry ? unique.filter((track) => retry.ids.has(String(track.id))) : unique, (track) => current.player!.setTrackFavorite(track, favorite));
        favoriteRetry.current = failed.length ? { key, favorite, ids: new Set(failed) } : null;
      } else if (name === "hideFromRecommendations") {
        await each(unique, async (track) => { await sendRecommendationFeedback({ action: "hide", itemType: "track", itemId: String(track.id), title: track.title, artist: track.artist }); });
      } else if (name === "downloadSelected") {
        const local = unique.filter(isLibraryActionTrack);
        const deviceOwner = offlineDownloadEngine.getOwner();
        if (deviceOwner) {
          if (deviceOwner !== ownerAtStart) throw new TrackActionError("Offline storage belongs to another account. Reload MusicDeck before downloading.");
          await offlineDownloadEngine.enqueueDownloads(local, current.player?.downloadQuality || "320kbps");
          completed += local.length; queued = local.length;
        }
        await each(deviceOwner ? unique.filter((track) => !isLibraryActionTrack(track)) : unique, async (track) => {
          if (!isLibraryActionTrack(track)) {
            const result = await externalActions.importExternalTrack({ ...track, id: String(track.id) });
            if (!["QUEUED", "IMPORTING", "IN_LIBRARY"].includes(result.state)) throw new Error(result.message || "The external import could not be queued.");
            if (result.state !== "IN_LIBRARY") imported++;
          } else {
            await downloadToDevice(track.id, current.player?.downloadQuality || "320kbps", track);
            const result = await offlineAuditor.recordDownloaded(track.id);
            if (result.status !== "verified") throw new Error("The downloaded copy could not be verified. Retry the download.");
          }
        });
      } else {
        const local = unique.filter(isLibraryActionTrack);
        if (local.length) { playlistId = await savedPlaylist(ownerAtStart!, assertCurrent); assertCurrent(); await add(playlistId, local); }
        await each(unique.filter((track) => !isLibraryActionTrack(track)), async (track) => {
          const input = discoveryInput("track", { ...track, id: String(track.id) });
          if (!input) throw new Error("This external provider does not support saved discoveries. Import the track to save it in a playlist.");
          if (!await current.saved.save(input)) throw new Error("Could not save this discovery. Check your connection and retry.");
        });
      }
      if (failed.length) throw new TrackActionError(`${completed} completed; ${failed.length} failed. ${messages[0]}`, completed, failed);
      return { completed, imported, queued, ...(playlistId ? { playlistId } : {}) };
    } catch (failure) {
      const result = failure instanceof TrackActionError ? failure : new TrackActionError(
        `${completed ? `${completed} tracks completed before the error. ` : ""}${failure instanceof Error ? failure.message : "The track action failed. Try again."}`, completed);
      if (mounted.current && live.current.owner === ownerAtStart) setError(result.message);
      throw result;
    } finally {
      window.removeEventListener("musicdeck:navigation", navigation);
      if (operationToken.current === token) { operationToken.current = null; locked.current = false; if (mounted.current && live.current.owner === ownerAtStart) setBusy(null); }
    }
  }
  return { busy, error, allLibrary, allFavorite, tracks,
    execute: (name: TrackActionName, targets: readonly Track[], playlistId?: string) => perform(name, playlistId, targets),
    canDownload: allLibrary || canImport,
    playNext: () => perform("playNext"), addToQueue: () => perform("addToQueue"),
    addToPlaylist: (id: string) => perform("addToPlaylist", id), toggleFavorite: () => perform("toggleFavorite"),
    downloadSelected: () => perform("downloadSelected"), hideFromRecommendations: () => perform("hideFromRecommendations"),
    saveForLater: () => perform("saveForLater") };
}
