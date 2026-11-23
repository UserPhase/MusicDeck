import {
  createContext, ReactNode, useCallback, useContext, useLayoutEffect, useRef,
  useState, useSyncExternalStore,
} from "react";
import { usePlayer } from "./PlayerContext";
import type { LibraryPlaybackSelection } from "../types/libraryTracks";

type Song = { id: string | number; [key: string]: unknown };
interface Actions {
  togglePlay(): void;
  toggleLikeSong(song: Song): void | Promise<void>;
  playContext(songs: Song[], index: number, context: {
    type: string; id: string; name: string; coverArt: string | null;
  }): void | Promise<void>;
  playSongFromSource(song: Song, source: string | { id: string; [key: string]: unknown }): void | Promise<void>;
  playLibraryTracks(selection: LibraryPlaybackSelection, signal: AbortSignal, excluded?: ReadonlySet<string>): void | Promise<void>;
}
interface PlayerValue extends Partial<Actions> {
  currentSong?: Song | null;
  isPlaying?: boolean;
  likedSongIds?: Set<string>;
  downloadQuality?: string;
}
export interface ItemState {
  currentId: string | null;
  currentPlaylistItemId: string | null;
  isPlaying: boolean;
  likedSongIds: ReadonlySet<string>;
  downloadQuality: string;
}
const emptyLikes = new Set<string>();
const initialState: ItemState = {
  currentId: null, currentPlaylistItemId: null, isPlaying: false, likedSongIds: emptyLikes, downloadQuality: "320kbps",
};

export function createPlayerItemStore(initial: PlayerValue = {}) {
  let player = initial;
  let state = initialState;
  const listeners = new Set<() => void>();
  const actions: Actions = {
    togglePlay: () => player.togglePlay?.(),
    toggleLikeSong: (song) => player.toggleLikeSong?.(song),
    playContext: (songs, index, context) => player.playContext?.(songs, index, context),
    playSongFromSource: (song, source) => player.playSongFromSource?.(song, source),
    playLibraryTracks: (selection, signal, excluded) => player.playLibraryTracks?.(selection, signal, excluded),
  };
  const update = (value: PlayerValue) => {
    player = value;
    const next: ItemState = {
      currentId: value.currentSong ? String(value.currentSong.id) : null,
      currentPlaylistItemId: typeof value.currentSong?.playlistItemId === "string" ? value.currentSong.playlistItemId : null,
      isPlaying: Boolean(value.isPlaying),
      likedSongIds: value.likedSongIds ?? emptyLikes,
      downloadQuality: value.downloadQuality ?? "320kbps",
    };
    if (Object.keys(next).every((key) =>
      next[key as keyof ItemState] === state[key as keyof ItemState])) return;
    state = next;
    listeners.forEach((notify) => notify());
  };
  update(initial);
  return {
    actions, update, getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

type Store = ReturnType<typeof createPlayerItemStore>;
const ItemContext = createContext<Store | null>(null);
const fallbackStore = createPlayerItemStore();

/** Only this bridge observes the broad player value. Its context identity and
 * action functions stay stable, including when playback time changes. */
export function PlayerItemStateProvider({ value, children }: { value: PlayerValue; children: ReactNode }) {
  const [store] = useState(() => createPlayerItemStore(value));
  useLayoutEffect(() => store.update(value), [store, value]);
  return <ItemContext.Provider value={store}>{children}</ItemContext.Provider>;
}

function shallowEqual<T extends object>(left: T, right: T) {
  const keys = Object.keys(left) as (keyof T)[];
  return keys.length === Object.keys(right).length && keys.every((key) => Object.is(left[key], right[key]));
}

/** getSnapshot retains its object identity when this selector's fields have
 * not changed. React therefore does not render unaffected subscribers. */
export function usePlayerItemSelector<T extends object>(selector: (state: ItemState) => T) {
  const context = useContext(ItemContext);
  const legacy: PlayerValue = usePlayer(Boolean(context)) ?? {};
  const store = context ?? fallbackStore;
  const cached = useRef<T | null>(null);
  const getSnapshot = useCallback(() => {
    const selected = selector(store.getSnapshot());
    if (!cached.current || !shallowEqual(cached.current, selected)) cached.current = selected;
    return cached.current;
  }, [selector, store]);
  const selected = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  return {
    selected: context ? selected : selector({
      currentId: legacy?.currentSong ? String(legacy.currentSong.id) : null,
      currentPlaylistItemId: typeof legacy?.currentSong?.playlistItemId === "string" ? legacy.currentSong.playlistItemId : null,
      isPlaying: Boolean(legacy?.isPlaying),
      likedSongIds: legacy?.likedSongIds ?? emptyLikes,
      downloadQuality: legacy?.downloadQuality ?? "320kbps",
    }),
    actions: context ? store.actions : legacy,
  };
}

const noSelection = () => ({});
export function usePlayerActions() {
  return usePlayerItemSelector(noSelection).actions;
}

export function useTrackPlayer(id: string | number, playlistItemId?: string) {
  const select = useCallback((state: ItemState) => {
    const isCurrentTrack = state.currentId === String(id) &&
      (!playlistItemId || playlistItemId === state.currentPlaylistItemId);
    return { isCurrentTrack, isPlaying: isCurrentTrack && state.isPlaying, downloadQuality: state.downloadQuality };
  }, [id, playlistItemId]);
  const { selected, actions } = usePlayerItemSelector(select);
  return { ...selected, togglePlay: actions.togglePlay };
}

export function useTrackFavorite(id: string | number | undefined) {
  const select = useCallback((state: ItemState) => ({
    isLiked: state.likedSongIds.has(String(id)),
  }), [id]);
  const { selected, actions } = usePlayerItemSelector(select);
  return { ...selected, toggleLikeSong: actions.toggleLikeSong };
}
