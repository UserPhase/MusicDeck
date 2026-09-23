export type Role = "admin" | "user";

export type User = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  avatarRef: string | null;
  disabled: boolean;
  externalSearchEnabled: boolean;
  externalPlaybackEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SessionUser = User;

export type IdentityHints = {
  musicBrainzId?: string | null;
  isrc?: string | null;
  upc?: string | null;
};

export type Track = {
  id: string;
  providerId: string;
  title: string;
  artistId: string | null;
  artistName: string;
  albumId: string | null;
  albumName: string;
  durationSeconds: number | null;
  /** Provider aggregate; not a 45-day count. */
  playCount?: number | null;
  /** Provider's most recent play, when exposed by Subsonic. */
  lastPlayedAt?: string | null;
  addedAt?: string | null;
  trackNumber: number | null;
  artworkId: string | null;
  artworkUrl: string | null;
  streamUrl: string;
  replayGain?: {
    trackGainDb?: number | null;
    trackPeak?: number | null;
    albumGainDb?: number | null;
    albumPeak?: number | null;
  };
  identityHints?: IdentityHints;
};

export type Album = {
  id: string;
  providerId: string;
  name: string;
  artistId: string | null;
  artistName: string;
  year: number | null;
  artworkId: string | null;
  artworkUrl: string | null;
  songCount: number;
  identityHints?: IdentityHints;
};

export type Artist = {
  id: string;
  providerId: string;
  name: string;
  artworkId: string | null;
  artworkUrl: string | null;
  /** Artist portrait from getArtist/getArtistInfo2; never album artwork. */
  imageUrl?: string | null;
  albumCount: number;
  /** Provider's ID-scoped total, when exposed without loading every song. */
  songCount?: number | null;
  identityHints?: IdentityHints;
};

export type Playlist = {
  id: string;
  providerId: string;
  name: string;
  description: string | null;
  artworkId: string | null;
  artworkUrl: string | null;
  /** How the cover art was resolved: user-supplied art or the automatic collage. */
  artworkMode?: "custom" | "collage" | null;
  songCount: number;
  tracks?: Track[];
};
