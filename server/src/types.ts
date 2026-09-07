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
  trackNumber: number | null;
  artworkId: string | null;
  artworkUrl: string | null;
  streamUrl: string;
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
  albumCount: number;
  identityHints?: IdentityHints;
};

export type Playlist = {
  id: string;
  providerId: string;
  name: string;
  description: string | null;
  artworkId: string | null;
  artworkUrl: string | null;
  songCount: number;
  tracks?: Track[];
};
