import { artwork, type ArtworkEntity } from "./albumArtwork.js";

type Cover = { id: string | null; url: string | null };
type AlbumMetadata = ArtworkEntity & { name?: string; title?: string; artistName?: string; artist?: string };

/**
 * genuine  — the local image is confirmed not to be the server's default placeholder.
 * placeholder — the local image is missing or confirmed to be the default placeholder.
 * uncertain — the server could not prove genuineness (no placeholder fingerprint
 *             available), so a suspect album-level cover should yield to a track's
 *             distinct embedded cover, matching what Now Playing shows.
 */
export type ArtworkVerdict = "genuine" | "placeholder" | "uncertain";

export class AlbumArtworkService {
  private readonly checks = new Map<string, { expiresAt: number; value: Promise<ArtworkVerdict> }>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly validateLocal: (id: string) => Promise<ArtworkVerdict>,
    private readonly lookup: (artist: string, album: string) => Promise<string | null>,
    private readonly reportFailure: (error: Error) => void,
    private readonly importedArtwork?: { find(artist: string, album: string): string | null },
  ) {}

  private check(id: string): Promise<ArtworkVerdict> {
    const cached = this.checks.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (this.waiting.length >= 100) return Promise.reject(new Error("Artwork validation capacity exceeded"));
    const slot = this.active < 5 ? (this.active++, Promise.resolve())
      : new Promise<void>((resolve) => { this.waiting.push(resolve); });
    const entry = { expiresAt: Number.POSITIVE_INFINITY, value: Promise.resolve<ArtworkVerdict>("uncertain") };
    entry.value = slot.then(() => this.validateLocal(id)).then((verdict) => {
      entry.expiresAt = Date.now() + (verdict === "genuine" ? 60 * 60_000 : 5 * 60_000);
      return verdict;
    }).catch((error: unknown) => {
      if (this.checks.get(id) === entry) this.checks.delete(id);
      throw error;
    }).finally(() => {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    });
    this.checks.set(id, entry);
    if (this.checks.size > 128) this.checks.delete(this.checks.keys().next().value!);
    return entry.value;
  }

  async resolve<T extends AlbumMetadata>(album: T, tracks: ArtworkEntity[] | (() => Promise<ArtworkEntity[]>)) {
    const rejected: string[] = [];
    async function* candidates() {
      yield artwork(album);
      const items = typeof tracks === "function" ? await tracks() : tracks;
      for (const track of items) yield artwork(track);
    }
    const seen = new Set<string>();
    let artworkResolutionFailed = false;
    let selected: Cover = { id: null, url: null };
    // An album-level cover that cannot be proven genuine is held back so a
    // track's distinct cover (the art Now Playing uses) can win instead.
    let uncertainRoot: Cover | null = null;
    for await (const candidate of candidates()) {
      if (!candidate.url || seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      const match = /^\/api\/artwork\/([^/?]+)(?:\?|$)/.exec(candidate.url);
      const localId = match ? decodeURIComponent(match[1]) : null;
      if (localId && !localId.startsWith("mdplart_")) {
        let verdict: ArtworkVerdict;
        try {
          verdict = await this.check(localId);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          this.reportFailure(error);
          artworkResolutionFailed = true;
          verdict = "placeholder";
        }
        if (verdict === "placeholder") {
          rejected.push(localId);
          continue;
        }
        if (verdict === "uncertain") {
          if (!uncertainRoot) {
            uncertainRoot = candidate;
            continue;
          }
          // A track with its own distinct cover ID has genuine embedded art;
          // prefer it over the unproven album-level cover.
          if (candidate.id && candidate.id !== uncertainRoot.id) {
            selected = candidate;
            break;
          }
          continue;
        }
        selected = candidate;
        break;
      }
      // External covers are not validated; never let one override a local
      // album cover that might still be genuine folder art.
      if (!uncertainRoot) {
        selected = candidate;
        break;
      }
    }
    if (!selected.url && uncertainRoot) selected = uncertainRoot;
    if (!selected.url) {
      const artist = album.artistName || album.artist;
      const title = album.name || album.title;
      if (artist && title && !/^unknown artist$/i.test(artist) && !/^unknown album$/i.test(title)) {
        try {
          const cached = this.importedArtwork?.find(artist, title);
          if (cached) selected.url = cached;
          else {
            const external = await this.lookup(artist, title);
            if (external) selected.url = `/api/metadata/album-artwork?${new URLSearchParams({ artist, album: title })}`;
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          this.reportFailure(error);
          artworkResolutionFailed = true;
        }
      }
    }
    return {
      ...album, artwork: selected.id && selected.url ? { id: selected.id, url: selected.url } : null,
      artworkId: selected.id, artworkUrl: selected.url, coverUrl: selected.url,
      unavailableArtworkIds: rejected,
      artworkResolutionFailed,
    };
  }
}
