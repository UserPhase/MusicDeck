import type { Db } from "../db/database.js";
import type { Available, CatalogService } from "./catalog.js";
import type { Playlist, Track } from "../types.js";
import type { ExternalArtist, ExternalTrack } from "./deezer-discovery.js";
import type { DiscoveryCatalog } from "../services/discovery/deezerDiscoveryCatalog.js";
import { normalizeDiscoveryText as normalize } from "../services/discovery/discoveryIdentity.js";
import { currentPrivacyManager } from "../services/PrivacyManager.js";
import { tasteProfile, tasteTarget } from "../services/TasteProfileManager.js";

export type PlaylistSuggestion = (Available<Track> | ExternalTrack) & { recommendationReason: string };
export type PlaylistSuggestions = { items: PlaylistSuggestion[]; message: string | null };

export function playlistRecordingKey(title: string, artist: string): string {
  const recording = title.replace(/\s*(?:[-–—]\s*|\()(?:\d{4}\s*)?remaster(?:ed)?(?:\s+\d{4})?\)?$/i, "");
  return `${normalize(artist)}:${normalize(recording)}`;
}
const isrcKey = (value?: string | null) => (value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
const key = (track: Track | ExternalTrack) => "artistName" in track
  ? playlistRecordingKey(track.title, track.artistName) : playlistRecordingKey(track.title, track.artist);
const isrc = (track: Track | ExternalTrack) => isrcKey("artistName" in track ? track.identityHints?.isrc : track.isrc);
const tags = (values?: string[]) => new Set((values || []).map(normalize).filter(Boolean));

/** Bounded metadata recommendations. Public artist lookups use the existing
 * shared discovery cache; neither audio analysis nor downloads happen here. */
export class PlaylistRecommendationService {
  private inventory: { expires: number; promise: ReturnType<CatalogService["listTracks"]> } | null = null;
  private pending = new Map<string, Promise<PlaylistSuggestions>>();
  constructor(private readonly db: Db, private readonly library: Pick<CatalogService, "listTracks">,
    private readonly discovery: DiscoveryCatalog, private readonly now = Date.now) {}

  private tracks() {
    if (this.inventory && this.inventory.expires > this.now()) return this.inventory.promise;
    const promise = this.library.listTracks().catch((error) => { this.inventory = null; throw error; });
    this.inventory = { expires: this.now() + 15_000, promise };
    return promise;
  }

  async get(userId: string, playlist: Playlist, external: boolean): Promise<PlaylistSuggestions> {
    if (external) currentPrivacyManager()?.assertExternalAllowed("metadata");
    const requestKey = JSON.stringify([userId, playlist.id, external, (playlist.tracks || []).map((track) => track.id)]);
    const existing = this.pending.get(requestKey);
    if (existing) return existing;
    if (this.pending.size >= 16) return { items: [], message: "Recommendations are busy. Try again shortly." };
    const promise = this.build(userId, playlist, external).finally(() => this.pending.delete(requestKey));
    this.pending.set(requestKey, promise);
    return promise;
  }

  private async build(userId: string, playlist: Playlist, external: boolean): Promise<PlaylistSuggestions> {
    const seeds = playlist.tracks || [];
    if (!seeds.length) return { items: [], message: null };
    const inventory = await this.tracks();
    if (external && inventory.degraded) return { items: [], message: "External suggestions will return when all library sources can be checked." };
    const excludedIds = new Set(seeds.map((track) => track.id));
    const excludedKeys = new Set(seeds.map(key));
    const excludedIsrcs = new Set(seeds.map(isrc).filter(Boolean));
    const feedback = this.db.prepare(`SELECT item_type,item_id,action FROM recommendation_feedback
      WHERE user_id=? AND action IN ('hide','not-interested','block-artist','block-album')`).all(userId) as
      Array<{ item_type: string; item_id: string; action: string }>;
    const hidden = new Set(feedback.map((row) => `${row.item_type}:${row.item_id}`));
    const blockedArtists = new Set(inventory.items.filter((track) => track.artistId && hidden.has(`artist:${track.artistId}`))
      .map((track) => normalize(track.artistName)));
    const shared = tasteProfile(this.db).feedbackFilter(userId);
    const allowed = (track: Track | ExternalTrack) => {
      const local = "artistName" in track;
      const artistId = local ? track.artistId : track.metadata.artistId;
      const albumId = local ? track.albumId : track.metadata.albumId;
      return shared(tasteTarget(track)) && !excludedIds.has(track.id) && !excludedKeys.has(key(track)) &&
        !(isrc(track) && excludedIsrcs.has(isrc(track))) && !hidden.has(`track:${track.id}`) &&
        !(artistId && hidden.has(`artist:${artistId}`)) && !(albumId && hidden.has(`album:${albumId}`)) &&
        !blockedArtists.has(normalize(local ? track.artistName : track.artist));
    };
    const artistCounts = new Map<string, { name: string; count: number }>();
    const genres = new Set<string>();
    const moods = new Set<string>();
    for (const seed of seeds) {
      for (const name of seed.artistName.split(/\s*[;•]\s*|\s+\/\s+/)) {
        const artist = normalize(name);
        if (artist && !["unknown", "unknown artist", "various artists"].includes(artist)) {
          const entry = artistCounts.get(artist);
          artistCounts.set(artist, { name, count: (entry?.count || 0) + 1 });
        }
      }
      for (const genre of tags(seed.genres)) genres.add(genre);
      for (const mood of tags(seed.moods)) moods.add(mood);
    }
    const available = (track: Available<Track>) => track.availability.libraryAvailable !== false && track.availability.state !== "unavailable";
    let candidates: Array<{ item: PlaylistSuggestion; score: number }> = [];
    if (!external) {
      for (const track of inventory.items) {
        if (!available(track) || !allowed(track)) continue;
        const sameArtist = artistCounts.has(normalize(track.artistName));
        const sharedGenre = [...tags(track.genres)].filter((genre) => genres.has(genre)).length;
        const sharedMood = [...tags(track.moods)].filter((mood) => moods.has(mood)).length;
        if (!sameArtist && !sharedGenre && !sharedMood) continue;
        const score = Number(sameArtist) * 4 + Math.min(sharedGenre, 3) * 3 + Math.min(sharedMood, 2) * 2;
        candidates.push({ item: { ...track, recommendationReason: sameArtist
          ? `${track.artistName} is in this playlist` : "Shares genres or moods with this playlist" }, score });
      }
    } else {
      const names = [...artistCounts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 3);
      let failed = false;
      const resolved = await Promise.all(names.map(async ({ name }) => {
        try { return await this.discovery.searchArtist(name); } catch { failed = true; return null; }
      }));
      const artists = resolved.filter((artist): artist is ExternalArtist => Boolean(artist));
      const related = await Promise.all(artists.map(async (artist) => {
        try { return (await this.discovery.related(artist)).slice(0, 2); } catch { failed = true; return []; }
      }));
      const sources = new Map<string, { artist: ExternalArtist; reason: string; score: number }>();
      artists.forEach((artist) => sources.set(artist.id, { artist, reason: `${artist.name} is in this playlist`, score: 6 }));
      related.forEach((list, index) => list.forEach((artist) => {
        if (sources.size < 6 && !sources.has(artist.id)) sources.set(artist.id,
          { artist, reason: `Related to ${artists[index].name}`, score: 4 });
      }));
      const byKey = new Map(inventory.items.map((track) => [key(track), track]));
      const byIsrc = new Map(inventory.items.filter((track) => isrc(track)).map((track) => [isrc(track), track]));
      await Promise.all([...sources.values()].map(async ({ artist, reason, score }) => {
        try {
          for (const track of (await this.discovery.tracks(artist)).slice(0, 30)) {
            if (!allowed(track)) continue;
            const owned = (isrc(track) && byIsrc.get(isrc(track))) || byKey.get(key(track));
            if (owned && (!available(owned) || !allowed(owned))) continue;
            candidates.push({ item: { ...(owned || track), recommendationReason: reason }, score: score + (owned ? 0 : 3) });
          }
        } catch { failed = true; }
      }));
      currentPrivacyManager()?.assertExternalAllowed("metadata");
      return { items: this.pick(candidates), message: failed ? "Some external sources are unavailable. Showing the suggestions that could be checked." : null };
    }
    return { items: this.pick(candidates), message: inventory.degraded ? "Some library sources are unavailable." : null };
  }

  private pick(candidates: Array<{ item: PlaylistSuggestion; score: number }>): PlaylistSuggestion[] {
    candidates.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
    const selected: PlaylistSuggestion[] = [];
    const seen = new Set<string>();
    const isrcs = new Set<string>();
    const artistCounts = new Map<string, number>();
    for (const cap of [2, Number.POSITIVE_INFINITY]) for (const { item } of candidates) {
      const artist = normalize("artistName" in item ? item.artistName : item.artist);
      if (seen.has(key(item)) || (isrc(item) && isrcs.has(isrc(item))) || (artistCounts.get(artist) || 0) >= cap) continue;
      selected.push(item); seen.add(key(item)); if (isrc(item)) isrcs.add(isrc(item));
      artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
      if (selected.length >= 30) return selected;
    }
    return selected;
  }
}
