export const libraryTrackSorts = {
  custom: "Library order",
  "title-asc": "Title (A-Z)", "title-desc": "Title (Z-A)",
  "album-asc": "Album (A-Z)", "album-desc": "Album (Z-A)",
  "duration-asc": "Shortest first", "duration-desc": "Longest first",
};

export interface TrackLibraryQuery {
  query: string;
  sort: keyof typeof libraryTrackSorts;
  favoritesOnly: boolean;
  unplayedOnly: boolean;
}

export interface LibraryPlaybackSelection {
  query: TrackLibraryQuery;
  trackId: string | null;
  shuffle?: boolean;
}
