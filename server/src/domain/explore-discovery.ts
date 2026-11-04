import type { Db } from "../db/database.js";
import { tasteProfile, tasteTarget } from "../services/TasteProfileManager.js";
import type { Available, CatalogService } from "./catalog.js";
import type { Track } from "../types.js";
import type { RecommendationService } from "./recommendations.js";
import type { ExternalArtist, ExternalAlbum, ExternalTrack } from "./deezer-discovery.js";
import type { DiscoveryCatalog } from "../services/discovery/deezerDiscoveryCatalog.js";
import { versionSignature } from "./music-identity.js";
import { normalizeDiscoveryText as normalizeMusicText } from "../services/discovery/discoveryIdentity.js";
import { currentPrivacyManager } from "../services/PrivacyManager.js";

type Group = "favourite" | "adjacent" | "popular";
type Annotation = { recommendationReason: string; discoveryGroup: Group };
type Picked<T> = T & Annotation;
type Item = ExternalArtist | ExternalAlbum | ExternalTrack;
type FeedbackRow = { item_type: string; item_id: string; action: string; weight: number };
export type ExploreDiscovery = {
  tracks: Picked<ExternalTrack>[];
  artists: Picked<ExternalArtist>[];
  albums: Picked<ExternalAlbum>[];
  personalized: boolean;
  degraded: boolean;
  message: string | null;
};

function canonicalId(id: string, type: string): string {
  return id.replace(new RegExp(`^(deezer|itunes)_${type}_`), `external_$1_${type}_`)
    .replace(/^ext:(deezer|itunes):(.+)$/, `external_$1_${type}_$2`);
}
function recordingKey(title: string, artist: string): string {
  // Remaster marketing is not a new recording; live/remix/acoustic titles
  // remain distinct. ISRC matching below is preferred when available.
  const recording = title.replace(/\s*(?:[-–—]\s*|\()(?:\d{4}\s*)?remaster(?:ed)?(?:\s+\d{4})?\)?$/i, "");
  return `${normalizeMusicText(artist)}:${normalizeMusicText(recording)}`;
}
function releaseKey(title: string, artist: string): string {
  const edition = versionSignature(title).split("+").filter((word) => !/^(deluxe|reissue|remaster(?:ed)?)$/.test(word)).join("+");
  const base = title.replace(/[([{][^\]})]*\b(?:deluxe|expanded|anniversary|remaster(?:ed)?|bonus|edition|reissue)[^\]})]*[\]})]/gi, " ")
    .replace(/\b(?:deluxe|expanded|anniversary|remaster(?:ed)?|bonus(?:\s+tracks?)?|edition|reissue|re-release|digital|explicit|clean)\b(?:\s+\d{2,4})?/gi, " ");
  // Keep non-Latin titles: an empty ASCII-only key would collapse every
  // Japanese/Korean/etc. album by the same artist into a single release.
  return `${normalizeMusicText(artist)}:${normalizeMusicText(base) || normalizeMusicText(title)}:${edition}`;
}
function artistName(item: Item): string { return item.type === "artist" ? item.name : item.artist; }
function identity(item: Item): string {
  if (item.type === "artist") return normalizeMusicText(item.name);
  return item.type === "track" ? recordingKey(item.title, item.artist) : releaseKey(item.title, item.artist);
}

/** Interleave both pools, then fill a missing side without inventing similar
 * artists or substituting owned media. Diversity limits are relaxed only if
 * the available pool would otherwise leave the shelf unnecessarily empty. */
function mix<T extends Item>(favourites: Picked<T>[], adjacent: Picked<T>[], limit: number): Picked<T>[] {
  const selected: Picked<T>[] = [];
  const seen = new Set<string>();
  const seenIsrc = new Set<string>();
  const artists = new Map<string, number>();
  const albums = new Map<string, number>();
  const overflow: [Picked<T>[], Picked<T>[]] = [[], []];
  const insert = (item: Picked<T>, diverse: boolean) => {
    const key = identity(item);
    const isrc = item.type === "track" ? (item.isrc || "").replace(/[^a-z0-9]/gi, "").toUpperCase() : "";
    if (seen.has(key) || (isrc && seenIsrc.has(isrc))) return false;
    const artist = normalizeMusicText(artistName(item));
    const album = item.type === "track" ? releaseKey(item.album || "", item.artist) : key;
    if (diverse && item.type !== "artist" && ((artists.get(artist) || 0) >= 2 || (albums.get(album) || 0) >= 2)) {
      return false;
    }
    selected.push(item);
    seen.add(key);
    if (isrc) seenIsrc.add(isrc);
    artists.set(artist, (artists.get(artist) || 0) + 1);
    albums.set(album, (albums.get(album) || 0) + 1);
    return true;
  };
  const pools = [favourites, adjacent];
  const offsets = [0, 0];
  while (offsets.some((offset, index) => offset < pools[index].length)) {
    for (let index = 0; index < pools.length; index++) {
      while (offsets[index] < pools[index].length) {
        const item = pools[index][offsets[index]++];
        if (insert(item, true)) break;
        overflow[index].push(item);
      }
      if (selected.length >= limit) return selected;
    }
  }
  const extraOffsets = [0, 0];
  while (extraOffsets.some((offset, index) => offset < overflow[index].length)) {
    for (let index = 0; index < overflow.length; index++) {
      while (extraOffsets[index] < overflow[index].length) {
        if (insert(overflow[index][extraOffsets[index]++], false)) break;
      }
      if (selected.length >= limit) return selected;
    }
  }
  return selected;
}

export class ExploreDiscoveryService {
  private inventory: { expires: number; value: ReturnType<ExploreDiscoveryService["loadInventory"]> } | null = null;
  private readonly pending = new Map<string, Promise<ExploreDiscovery>>();
  constructor(private readonly db: Db, private readonly library: CatalogService,
    private readonly recommendations: Pick<RecommendationService, "discoverySeeds">,
    private readonly catalog: DiscoveryCatalog, private readonly now = Date.now) {}

  private async loadInventory() {
    const [tracks, albums, artists] = await Promise.all([
      this.library.listTracks(), this.library.listAlbums(), this.library.listArtists(),
    ]);
    const ownedArtists = new Set([
      ...artists.items.map((artist) => artist.name),
      ...tracks.items.map((track) => track.artistName),
      ...albums.items.map((album) => album.artistName),
    ].flatMap((name) => name.split(/\s*[;•]\s*|\s+\/\s+/)).map(normalizeMusicText).filter(Boolean));
    const releases = [...albums.items.map((album) => ({ id: album.id, title: album.name, artist: album.artistName })),
      ...tracks.items.filter((track) => track.albumName).map((track) => ({ id: track.albumId || track.id, title: track.albumName, artist: track.artistName }))];
    const recordings = new Set(tracks.items.map((track) => recordingKey(track.title, track.artistName)));
    const releaseKeys = new Set(releases.map((album) => releaseKey(album.title, album.artist)));
    const isrcs = new Set(tracks.items.map((track) => (track.identityHints?.isrc || "").replace(/[^a-z0-9]/gi, "").toUpperCase()).filter(Boolean));
    return { tracks: tracks.items, albums: albums.items, recordings, releaseKeys, isrcs, ownedArtists,
      degraded: tracks.degraded || albums.degraded || artists.degraded };
  }
  private getInventory() {
    if (this.inventory && this.inventory.expires > this.now()) return this.inventory.value;
    const value = this.loadInventory().catch((error) => { this.inventory = null; throw error; });
    // One short-lived index for the whole server, independent of user count.
    this.inventory = { expires: this.now() + 15_000, value };
    return value;
  }
  private feedback(userId: string, tracks: Array<Available<Track>>) {
    const shared = tasteProfile(this.db).feedbackFilter(userId);
    const rows = this.db.prepare(`SELECT item_type, item_id, action, weight FROM recommendation_feedback WHERE user_id = ?`)
      .all(userId) as FeedbackRow[];
    const hidden = new Set<string>();
    const weights = new Map<string, number>();
    const blockedNames = new Set<string>();
    const blockedReleases = new Set<string>();
    const byArtist = new Map(tracks.filter((track) => track.artistId).map((track) => [track.artistId!, track.artistName]));
    const byAlbum = new Map(tracks.filter((track) => track.albumId).map((track) => [track.albumId!, track]));
    for (const row of rows) {
      const id = canonicalId(row.item_id, row.item_type);
      const key = `${row.item_type}:${id}`;
      if (["hide", "not-interested", "block-artist", "block-album"].includes(row.action)) {
        hidden.add(key);
        const name = row.item_type === "artist" ? byArtist.get(row.item_id) : undefined;
        if (name) blockedNames.add(normalizeMusicText(name));
        const album = row.item_type === "album" ? byAlbum.get(row.item_id) : undefined;
        if (album) blockedReleases.add(releaseKey(album.albumName, album.artistName));
      } else weights.set(key, (weights.get(key) || 0) + row.weight);
    }
    return {
      allows: (item: Item) => {
        const artistId = item.type === "artist" ? item.id : item.type === "track" ? item.metadata.artistId : undefined;
        const albumId = item.type === "album" ? item.id : item.type === "track" ? item.metadata.albumId : undefined;
        return shared(tasteTarget(item)) && !hidden.has(`${item.type}:${item.id}`) && !blockedNames.has(normalizeMusicText(artistName(item)))
          && !(artistId && hidden.has(`artist:${artistId}`)) && !(albumId && hidden.has(`album:${albumId}`))
          && !(item.type !== "artist" && blockedReleases.has(releaseKey(item.type === "album" ? item.title : item.album || "", item.artist)));
      },
      weight: (item: Item) => (weights.get(`${item.type}:${item.id}`) || 0)
        + (item.type === "track" ? (weights.get(`artist:${item.metadata.artistId}`) || 0) + (weights.get(`album:${item.metadata.albumId}`) || 0) : 0),
    };
  }

  async get(userId: string): Promise<ExploreDiscovery> {
    currentPrivacyManager()?.assertExternalAllowed("metadata");
    const pending = this.pending.get(userId);
    if (pending) return pending;
    if (this.pending.size >= 32) return { tracks: [], artists: [], albums: [], personalized: true,
      degraded: true, message: "Discovery is busy. Please try again shortly." };
    const request = this.build(userId).finally(() => { this.pending.delete(userId); });
    this.pending.set(userId, request);
    return request;
  }
  private async build(userId: string): Promise<ExploreDiscovery> {
    const empty = (message: string): ExploreDiscovery => ({ tracks: [], artists: [], albums: [], personalized: true, degraded: true, message });
    let inventory: Awaited<ReturnType<ExploreDiscoveryService["loadInventory"]>>;
    try { inventory = await this.getInventory(); }
    catch { return empty("Your library could not be checked. Discovery will return when it is available."); }
    if (inventory.degraded) return empty("Some library sources are unavailable. Discovery will return when your library can be checked.");
    const feedback = this.feedback(userId, inventory.tracks);
    const missingTrack = (track: ExternalTrack) => feedback.allows(track)
      && !(track.isrc && inventory.isrcs.has(track.isrc.replace(/[^a-z0-9]/gi, "").toUpperCase()))
      && !inventory.recordings.has(recordingKey(track.title, track.artist));
    const missingAlbum = (album: ExternalAlbum) => feedback.allows(album)
      && !inventory.releaseKeys.has(releaseKey(album.title, album.artist));
    const missingArtist = (artist: ExternalArtist) => feedback.allows(artist)
      && !inventory.ownedArtists.has(normalizeMusicText(artist.name));
    const seeds = this.recommendations.discoverySeeds(userId, inventory.tracks);
    const annotate = <T extends Item>(item: T, group: Group, seed: string): Picked<T> => ({
      ...item, discoveryGroup: group,
      recommendationReason: group === "favourite" ? `More from ${seed}`
        : group === "adjacent" ? `Because you listen to ${seed}` : "Popular picks to get started",
    });
    const rank = <T extends Item>(items: Picked<T>[]) => items.sort((a, b) => feedback.weight(b) - feedback.weight(a));
    if (!seeds.length) {
      try {
        const charts = await this.catalog.charts();
        return {
          tracks: mix(charts.tracks.filter(missingTrack).map((item) => annotate(item, "popular", "")), [], 6),
          artists: mix(charts.artists.filter(missingArtist).map((item) => annotate(item, "popular", "")), [], 7),
          albums: mix(charts.albums.filter(missingAlbum).map((item) => annotate(item, "popular", "")), [], 7),
          personalized: false, degraded: false, message: "Listen to songs or like music to personalise these picks.",
        };
      } catch { return empty("External discovery is temporarily unavailable. Try again shortly."); }
    }

    let degraded = false;
    const resolved = await Promise.all(seeds.map(async (seed) => {
      try { return await this.catalog.searchArtist(seed.name); }
      catch { degraded = true; return null; }
    }));
    const favourites = [...new Map(resolved.filter((item): item is ExternalArtist => Boolean(item) && feedback.allows(item!))
      .map((artist) => [normalizeMusicText(artist.name), artist])).values()];
    if (!favourites.length) return empty("No external matches are available for your favourite artists yet. Try again later.");
    const favouriteNames = new Set(seeds.map((seed) => normalizeMusicText(seed.name)));
    const relatedLists = await Promise.all(favourites.map(async (artist) => {
      try { return (await this.catalog.related(artist)).filter(feedback.allows).map((item) => ({ artist: item, seed: artist.name })); }
      catch { degraded = true; return []; }
    }));
    const relatedCandidates: Array<{ artist: ExternalArtist; seed: string }> = [];
    const seenArtists = new Set(favouriteNames);
    for (let index = 0; index < 20; index++) {
      for (const list of relatedLists) {
        const item = list[index];
        const key = item && normalizeMusicText(item.artist.name);
        if (!item || !key || seenArtists.has(key)) continue;
        seenArtists.add(key); relatedCandidates.push(item);
      }
    }
    const newArtists = relatedCandidates.filter(({ artist }) => missingArtist(artist));
    // Artist cards need only their profile metadata. Fill their seven slots
    // independently of the smaller pool whose tracks/albums we need to fetch.
    const artistSuggestions = {
      favourite: favourites.filter(missingArtist).map((artist) => annotate(artist, "favourite", artist.name)),
      adjacent: newArtists.map(({ artist, seed }) => annotate(artist, "adjacent", seed)),
    };
    const adjacent = [...newArtists, ...relatedCandidates.filter(({ artist }) => !missingArtist(artist))].slice(0, 3);
    const pools = { favourite: { tracks: [] as Picked<ExternalTrack>[], albums: [] as Picked<ExternalAlbum>[] },
      adjacent: { tracks: [] as Picked<ExternalTrack>[], albums: [] as Picked<ExternalAlbum>[] } };
    const sources = [...favourites.map((artist) => ({ artist, seed: artist.name, group: "favourite" as const })),
      ...adjacent.map((item) => ({ ...item, group: "adjacent" as const }))];
    // Results are committed in seed order rather than network-completion order.
    const bundles = await Promise.all(sources.map(async ({ artist }) => {
      const [tracks, albums] = await Promise.allSettled([this.catalog.tracks(artist), this.catalog.albums(artist)]);
      if (tracks.status === "rejected" || albums.status === "rejected") degraded = true;
      return { tracks: tracks.status === "fulfilled" ? tracks.value.filter(missingTrack) : [],
        albums: albums.status === "fulfilled" ? albums.value.filter(missingAlbum) : [] };
    }));
    sources.forEach(({ artist, seed, group }, index) => {
      const bundle = bundles[index];
      // Albums may not carry an artist ID, so enforce artist-level blocks here too.
      if (!feedback.allows(artist)) return;
      pools[group].tracks.push(...bundle.tracks.map((item) => annotate(item, group, seed)));
      pools[group].albums.push(...bundle.albums.map((item) => annotate(item, group, seed)));
    });
    currentPrivacyManager()?.assertExternalAllowed("metadata");
    return {
      tracks: mix(rank(pools.favourite.tracks), rank(pools.adjacent.tracks), 6),
      artists: mix(rank(artistSuggestions.favourite), rank(artistSuggestions.adjacent), 7),
      albums: mix(rank(pools.favourite.albums), rank(pools.adjacent.albums), 7),
      personalized: true, degraded,
      message: degraded ? "Some discovery sources are unavailable. Showing the suggestions that could be checked." : null,
    };
  }
}
