import crypto from "node:crypto";
import type { MusicBackend, SearchResult, StreamResult } from "../music-backend.js";
import type { Album, Artist, Playlist, Track } from "../../types.js";
import { mapAlbum, mapArtist, mapPlaylist, mapTrack } from "./mappers.js";

export type NavidromeConfig = {
  url: string;
  username: string;
  password: string;
};

type ArtistDetailResponse = {
  artist?: { id: string; name?: string; artistImageUrl?: unknown; coverArt?: string; songCount?: number; album?: any[] };
};

type ArtistInfoResponse = {
  artistInfo2?: { largeImageUrl?: unknown; mediumImageUrl?: unknown };
};

/**
 * Navidrome provides every current capability: catalog reads, media
 * streaming/artwork, and provider-side user-data sync (favorites,
 * playlists).
 */
export class NavidromeBackend implements MusicBackend {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;
  private readonly artistDetails = new Map<string, { expiresAt: number; value: Promise<ArtistDetailResponse> }>();

  constructor(config: NavidromeConfig, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.username = config.username;
    this.password = config.password;
    this.fetchImpl = fetchImpl;
  }

  private authParams() {
    const salt = crypto.randomUUID();
    const token = crypto
      .createHash("md5")
      .update(`${this.password}${salt}`)
      .digest("hex");

    return {
      u: this.username,
      t: token,
      s: salt,
      v: "1.16.1",
      c: "MusicDeck",
      f: "json",
    };
  }

  private buildUrl(endpoint: string, params: Record<string, unknown> = {}) {
    const url = new URL(`/rest/${endpoint}.view`, this.baseUrl);
    const search = url.searchParams;

    for (const [key, value] of Object.entries({ ...this.authParams(), ...params })) {
      if (value === undefined || value === null) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          search.append(key, String(item));
        }
      } else {
        search.append(key, String(value));
      }
    }

    return url;
  }

  private async request<T = any>(endpoint: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchImpl(this.buildUrl(endpoint, params), signal ? { signal } : undefined);

    if (!response.ok) {
      throw new Error(`Navidrome returned ${response.status}`);
    }

    let json: any;

    try {
      json = await response.json();
    } catch {
      throw new Error("Navidrome returned invalid JSON");
    }

    const result = json["subsonic-response"];

    if (!result || result.status !== "ok") {
      throw new Error(result?.error?.message || "Navidrome API error");
    }

    return result as T;
  }

  private async getAlbumRaw(albumId: string) {
    const result = await this.request("getAlbum", { id: albumId });
    return result.album || null;
  }

  private getArtistDetail(artistId: string): Promise<ArtistDetailResponse> {
    const cached = this.artistDetails.get(artistId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = this.request<ArtistDetailResponse>("getArtist", { id: artistId }).catch((error) => {
      this.artistDetails.delete(artistId);
      throw error;
    });
    this.artistDetails.set(artistId, { expiresAt: Date.now() + 15_000, value });
    if (this.artistDetails.size > 100) this.artistDetails.delete(this.artistDetails.keys().next().value!);
    return value;
  }

  async listAlbums(limit = 500): Promise<Album[]> {
    const result = await this.request("getAlbumList2", {
      type: "alphabeticalByName",
      size: limit,
    });

    return (result.albumList2?.album || []).map(mapAlbum);
  }

  async getAlbum(albumId: string): Promise<Album | null> {
    const album = await this.getAlbumRaw(albumId);
    return album ? mapAlbum(album) : null;
  }

  async getAlbumTracks(albumId: string): Promise<Track[]> {
    const album = await this.getAlbumRaw(albumId);
    return (album?.song || []).map(mapTrack);
  }

  async listArtists(): Promise<Artist[]> {
    const result = await this.request("getArtists");
    const artists = result.artists?.index?.flatMap((index: any) => index.artist || []) || [];
    return artists.map(mapArtist);
  }

  async getArtist(artistId: string, options?: { includeArtistInfo?: boolean }): Promise<Artist | null> {
    const [result, info] = await Promise.all([
      this.getArtistDetail(artistId),
      options?.includeArtistInfo === false
        ? Promise.resolve(null)
        : this.request<ArtistInfoResponse>("getArtistInfo2", { id: artistId, count: 0, includeNotPresent: false }).catch(() => null),
    ]);
    if (!result.artist) return null;
    const imageUrl = [
      result.artist.artistImageUrl,
      info?.artistInfo2?.mediumImageUrl,
      info?.artistInfo2?.largeImageUrl,
    ].find((image): image is string => typeof image === "string" && /^https:\/\//i.test(image)) || null;
    return { ...mapArtist(result.artist), imageUrl };
  }

  async getArtistAlbums(artistId: string): Promise<Album[]> {
    const result = await this.getArtistDetail(artistId);
    return (result.artist?.album || [])
      .filter((album: any) => !album.artistId || String(album.artistId) === artistId)
      .map(mapAlbum);
  }

  async getArtistTopTracks(artistId: string, limit = 10): Promise<Track[]> {
    const count = Math.max(1, Math.min(10, Math.trunc(limit)));
    // Navidrome accepts an artist ID here. Its top-songs source is optional;
    // search3 is a bounded fallback for servers without that integration.
    try {
      const result = await this.request("getTopSongs", { id: artistId, count }, AbortSignal.timeout(1_200));
      const songs = (result.topSongs?.song || [])
        .filter((song: any) => String(song.artistId || "") === artistId)
        .slice(0, count);
      if (songs.length) return songs.map(mapTrack);
    } catch {
      // The optional server-side top-songs integration may not be configured.
    }
    const detail = await this.getArtistDetail(artistId);
    if (!detail.artist?.name) return [];
    try {
      const result = await this.request("search3", {
        query: detail.artist.name, artistCount: 0, albumCount: 0, songCount: count,
      });
      return (result.searchResult3?.song || [])
        .filter((song: any) => String(song.artistId || "") === artistId)
        .slice(0, count)
        .map(mapTrack);
    } catch {
      return [];
    }
  }

  async getArtistTracks(artistId: string): Promise<Track[]> {
    const albums = await this.getArtistAlbums(artistId);
    const albumResults = await Promise.all(albums.map((album) => this.getAlbumRaw(album.id)));
    return albumResults.flatMap((album) => (album?.song || [])
      .filter((song: any) => String(song.artistId || "") === artistId)
      .map(mapTrack));
  }

  async listTracks(): Promise<Track[]> {
    const albums = await this.listAlbums(500);
    const albumResults = await Promise.all(albums.map((album) => this.getAlbumRaw(album.id)));
    return albumResults.flatMap((album) => (album?.song || []).map(mapTrack));
  }

  async getTrack(trackId: string): Promise<Track | null> {
    const result = await this.request("getSong", { id: trackId });
    return result.song ? mapTrack(result.song) : null;
  }

  async scrobbleTrack(trackId: string, playedAt = Date.now()): Promise<void> {
    await this.request("scrobble", { id: trackId, time: playedAt, submission: true });
  }

  async getLyrics(trackId: string): Promise<string | null> {
    // OpenSubsonic/Navidrome exposes richer, song-ID based lyrics. Older
    // servers may only implement the classic artist/title endpoint, so keep
    // that as a provider-local fallback.
    try {
      const result = await this.request("getLyricsBySongId", { id: trackId });
      const structured = result.lyricsList?.structuredLyrics;
      const candidates = Array.isArray(structured) ? structured : structured ? [structured] : [];

      for (const candidate of candidates) {
        const lines = Array.isArray(candidate?.line) ? candidate.line : [];
        const text = lines
          .map((line: any) => typeof line === "string" ? line : line?.value ?? line?.text ?? "")
          .join("\n")
          .trim();
        if (text) return text;
      }

      const plain = typeof result.lyricsList?.lyrics === "string"
        ? result.lyricsList.lyrics
        : typeof result.lyrics?.value === "string"
          ? result.lyrics.value
          : typeof result.lyrics === "string"
            ? result.lyrics
            : "";
      if (plain.trim()) return plain.trim();
    } catch {
      // Fall through to the legacy Subsonic endpoint below.
    }

    try {
      const songResult = await this.request("getSong", { id: trackId });
      const song = songResult.song;
      if (!song?.artist || !song?.title) return null;
      const result = await this.request("getLyrics", { artist: song.artist, title: song.title });
      const lyrics = typeof result.lyrics?.value === "string"
        ? result.lyrics.value
        : typeof result.lyrics === "string"
          ? result.lyrics
          : "";
      return lyrics.trim() || null;
    } catch {
      return null;
    }
  }

  async getArtistBiographyForTrack(trackId: string): Promise<string | null> {
    try {
      const songResult = await this.request("getSong", { id: trackId });
      const artistId = songResult.song?.artistId;
      if (!artistId) return null;

      const result = await this.request("getArtistInfo2", {
        id: artistId,
        count: 0,
        includeNotPresent: false,
      });
      const biography = result.artistInfo2?.biography ?? result.artistInfo?.biography;
      return typeof biography === "string" && biography.trim() ? biography.trim() : null;
    } catch {
      return null;
    }
  }

  async search(query: string, types: string[] = ["artists", "albums", "tracks"]): Promise<SearchResult> {
    if (!query.trim()) {
      return { artists: [], albums: [], tracks: [] };
    }

    const wants = new Set(types);
    const result = await this.request("search3", {
      query: query.trim(),
      artistCount: wants.has("artists") ? 20 : 0,
      artistOffset: 0,
      albumCount: wants.has("albums") ? 20 : 0,
      albumOffset: 0,
      songCount: wants.has("tracks") || wants.has("songs") ? 50 : 0,
      songOffset: 0,
    });

    return {
      artists: (result.searchResult3?.artist || []).map(mapArtist),
      albums: (result.searchResult3?.album || []).map(mapAlbum),
      tracks: (result.searchResult3?.song || []).map(mapTrack),
    };
  }

  async listPlaylists(): Promise<Playlist[]> {
    const result = await this.request("getPlaylists");
    return (result.playlists?.playlist || []).map((playlist: any) => mapPlaylist(playlist));
  }

  async createPlaylist(name: string): Promise<Playlist | null> {
    const result = await this.request("createPlaylist", { name });
    return result.playlist ? mapPlaylist(result.playlist, true) : null;
  }

  async getPlaylist(playlistId: string): Promise<Playlist | null> {
    const result = await this.request("getPlaylist", { id: playlistId });
    return result.playlist ? mapPlaylist(result.playlist, true) : null;
  }

  async updatePlaylist(playlistId: string, input: { name?: string; description?: string | null }): Promise<Playlist | null> {
    await this.request("updatePlaylist", {
      playlistId,
      name: input.name,
      comment: input.description,
    });

    return this.getPlaylist(playlistId);
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    await this.request("deletePlaylist", { id: playlistId });
  }

  async addTrackToPlaylist(playlistId: string, trackId: string): Promise<{ added: boolean }> {
    const playlist = await this.getPlaylist(playlistId);
    const exists = (playlist?.tracks || []).some((track) => String(track.id) === String(trackId));

    if (exists) {
      return { added: false };
    }

    await this.request("updatePlaylist", {
      playlistId,
      songIdToAdd: trackId,
    });

    return { added: true };
  }

  async removePlaylistItem(playlistId: string, playlistItemId: string): Promise<void> {
    const playlist = await this.getPlaylist(playlistId);
    const index = (playlist?.tracks || []).findIndex(
      (track) => String(track.id) === String(playlistItemId)
    );

    if (index < 0) {
      return;
    }

    await this.request("updatePlaylist", {
      playlistId,
      songIndexToRemove: index,
    });
  }

  async reorderPlaylistTracks(playlistId: string, trackIds: string[]): Promise<Playlist | null> {
    await this.request("updatePlaylist", {
      playlistId,
      songId: trackIds,
    });

    return this.getPlaylist(playlistId);
  }

  async listFavoriteTracks(): Promise<Track[]> {
    const result = await this.request("getStarred2");
    return (result.starred2?.song || []).map(mapTrack);
  }

  async setTrackFavorite(trackId: string, liked: boolean): Promise<void> {
    await this.request(liked ? "star" : "unstar", { id: trackId });
  }

  async getRandomTracks(limit = 10): Promise<Track[]> {
    const result = await this.request("getRandomSongs", { size: limit });
    return (result.randomSongs?.song || []).map(mapTrack);
  }

  async getRandomAlbums(limit = 16): Promise<Album[]> {
    const result = await this.request("getAlbumList2", {
      type: "random",
      size: limit,
    });

    return (result.albumList2?.album || []).map(mapAlbum);
  }

  async fetchStream(trackId: string, range?: string, maxBitRate?: number): Promise<StreamResult> {
    const response = await this.fetchImpl(this.buildUrl("stream", {
      id: trackId,
      maxBitRate,
    }), {
      headers: range ? { Range: range } : undefined,
    });

    return {
      body: response.body,
      status: response.status,
      headers: response.headers,
    };
  }

  async fetchArtwork(artworkId: string, size?: number): Promise<StreamResult> {
    // Subsonic's `size` asks the server for a square thumbnail, which keeps
    // grid/sidebar artwork small without any local image processing.
    const response = await this.fetchImpl(this.buildUrl("getCoverArt", { id: artworkId, size }));

    return {
      body: response.body,
      status: response.status,
      headers: response.headers,
    };
  }

  async scanLibrary(): Promise<{ count?: number; scanning?: boolean }> {
    try {
      await this.request("startScan");
    } catch {
      return { scanning: false };
    }

    // Navidrome's startScan.view only *triggers* an async background scan;
    // it does not wait for indexing to finish. Callers (e.g. acquisition
    // import) need freshly-downloaded tracks to actually be queryable
    // immediately after this resolves, so poll getScanStatus.view until
    // Navidrome reports it's done (bounded so a stuck/slow scan can't hang
    // the caller forever).
    const pollIntervalMs = 500;
    const maxWaitMs = 20000;
    const deadline = Date.now() + maxWaitMs;
    let lastCount: number | undefined;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      try {
        const status = await this.request("getScanStatus");
        lastCount = status.scanStatus?.count ?? lastCount;

        if (!status.scanStatus?.scanning) {
          return { scanning: false, count: lastCount };
        }
      } catch {
        break;
      }
    }

    return { scanning: false, count: lastCount };
  }
}
