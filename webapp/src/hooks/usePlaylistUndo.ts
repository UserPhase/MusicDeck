import { useSyncExternalStore } from "react";
import { playlistCommands } from "../services/playlists/PlaylistCommandStore";
export type { PlaylistCommand, PlaylistEdit } from "../services/playlists/PlaylistCommandStore";

/** One account-scoped command stack survives route changes and playlist deletion. */
export function usePlaylistUndo() {
  const state = useSyncExternalStore(playlistCommands.subscribe, playlistCommands.getSnapshot, playlistCommands.getSnapshot);
  return { ...state, undoHistory: state.undo, redoHistory: state.redo, canUndo: state.undo.length > 0, canRedo: state.redo.length > 0,
    undo: playlistCommands.undo, redo: playlistCommands.redo, execute: playlistCommands.execute, dismiss: playlistCommands.dismiss };
}
export default usePlaylistUndo;
