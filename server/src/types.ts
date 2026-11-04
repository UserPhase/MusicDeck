export type Role = "admin" | "user";

export type User = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  avatarRef: string | null;
  /** Server-hosted, versioned URL of the user's uploaded avatar, if any. */
  avatarUrl: string | null;
  disabled: boolean;
  /** The protected bootstrap administrator; cannot be disabled, deleted, or demoted. */
  isMasterAdmin: boolean;
  externalSearchEnabled: boolean;
  externalPlaybackEnabled: boolean;
  lastLoginAt: string | null;
  lastPlaybackAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionUser = User;

export type IdentityHints = {
  musicBrainzId?: string | null;
  isrc?: string | null;
  upc?: string | null;
};

export type TrackArtistCredit = { id: string | null; name: string };

export type Track = {
  sourceServer?: string;
  addedByUserId?: string | null;
  addedBy?: { id: string; displayName: string; avatarUrl: string | null } | null;
  /** Discovery entries retain metadata; they do not claim to be full library audio. */
  external?: boolean;
  provider?: "external" | "library";
  source?: { kind: "external" | "library"; count: number };
  previewUrl?: string | null;
  /** Occurrence identity when returned inside a MusicDeck playlist. */
  playlistItemId?: string;
  playlistAddedAt?: string;
  id: string;
  providerId: string;
  title: string;
  artistId: string | null;
  artistName: string;
  artistCredits?: TrackArtistCredit[];
  albumId: string | null;
  albumName: string;
  durationSeconds: number | null;
  genres?: string[];
  moods?: string[];
  year?: number | null;
  originalReleaseYear?: number | null;
  bpm?: number | null;
  relatedArtistIds?: string[];
  /** Provider aggregate; not a 45-day count. */
  playCount?: number | null;
  /** Provider's most recent play, when exposed by Subsonic. */
  lastPlayedAt?: string | null;
  addedAt?: string | null;
  trackNumber: number | null;
  artworkId: string | null;
  artworkUrl: string | null;
  streamUrl: string;
  audioMetadata?: {
    codec: string | null; container: string | null; bitrateKbps: number | null;
    sampleRateHz: number | null; bitDepth: number | null; channels: number | null;
  };
  /** Measured at import, applied before the first audible sample. */
  normalizationGainDb?: number;
  loudness?: { integratedLufs: number; truePeakDb: number };
  replayGain?: {
    trackGainDb?: number | null;
    trackPeak?: number | null;
    albumGainDb?: number | null;
    albumPeak?: number | null;
  };
  identityHints?: IdentityHints;
};

export type Album = {
  sourceServer?: string;
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
  createdAt?: string;
  sharingMode?: "PRIVATE" | "SHARED_READ" | "COLLABORATIVE" | "PUBLIC_SERVER";
  sharingRevision?: number;
  permissions?: { canRead: boolean; canEditTracks: boolean; canManage: boolean };
  excludeFromTaste?: boolean;
  editRevision?: number;
  /** Complete ordered entry identities, including temporarily unavailable tracks. */
  itemIds?: string[];
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
