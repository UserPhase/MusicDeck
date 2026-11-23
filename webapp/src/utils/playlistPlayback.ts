import type { Song } from "../context/PlayerContext";
import { normalizePlaylistSearch, playlistTrackSearchText } from "./playlistSearch";

export const playlistTrackSortLabels = {
  custom: "Custom order", added: "Date added", title: "Title", artist: "Artist", album: "Album", duration: "Duration",
};

export interface PlaylistPlaybackView {
  query: string;
  sort: keyof typeof playlistTrackSortLabels;
  descending: boolean;
  locale: string;
}

export interface PlaylistPlaybackSelection {
  playlistId: string;
  startIndex: number;
  fromHere: boolean;
  view: PlaylistPlaybackView;
  order: string;
}

export function playlistSearchTokens(view: Pick<PlaylistPlaybackView, "query" | "locale">) {
  return normalizePlaylistSearch(view.query, view.locale).trim().split(/\s+/).filter(Boolean);
}

function compareTrackNumbers(left: number, right: number, direction: number) {
  if (!Number.isFinite(left)) return Number(Number.isFinite(right));
  if (!Number.isFinite(right)) return -1;
  return (left - right) * direction;
}

export function playlistViewTracks(tracks: Song[], view: PlaylistPlaybackView,
  tokens = playlistSearchTokens(view), searchIndex?: readonly string[]): Song[] {
  if (!tokens.length && view.sort === "custom") return tracks;
  const matches = tokens.length ? tracks.filter((track, index) => {
    const text = searchIndex?.[index] ?? playlistTrackSearchText(track, view.locale);
    return tokens.every(token => text.includes(token));
  }) : tracks.slice();
  const direction = view.descending ? -1 : 1;
  if (view.sort === "added") {
    return matches.map(song => ({ song, added: Date.parse(song.playlistAddedAt) }))
      .sort((a, b) => compareTrackNumbers(a.added, b.added, direction)).map(item => item.song);
  }
  if (view.sort === "duration") {
    matches.sort((a, b) => compareTrackNumbers(a.duration, b.duration, direction));
  } else if (view.sort !== "custom") {
    const collator = new Intl.Collator(view.locale, { numeric: true, sensitivity: "base" });
    matches.sort((a, b) => direction * collator.compare(a[view.sort] || "", b[view.sort] || ""));
  }
  return matches;
}

export function playlistPlaybackContext(playlist: { id: string; name: string; coverArt?: string | null }, view: PlaylistPlaybackView) {
  const isCustomView = Boolean(view.query.trim()) || view.sort !== "custom";
  return { type: isCustomView ? "collection" : "playlist", id: playlist.id, name: playlist.name,
    coverArt: playlist.coverArt ?? null, ...(isCustomView && { playlistLoopId: playlist.id }) };
}

export function playlistOrder(tracks: readonly Song[]): string {
  // A compact order check also works on HTTP LAN sessions without Web Crypto.
  // Include occurrence IDs so exchanging two copies of a track changes the check.
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  for (const track of tracks) {
    const entry = JSON.stringify([String(track.id), track.playlistItemId ?? null]);
    for (let i = 0; i < entry.length; i++) {
      hash = BigInt.asUintN(64, (hash ^ BigInt(entry.charCodeAt(i))) * prime);
    }
  }
  return hash.toString(16).padStart(16, "0");
}
