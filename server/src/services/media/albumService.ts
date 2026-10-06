import { artwork, type ArtworkEntity } from "./albumArtwork.js";

type Cover = { id: string | null; url: string | null };
type AlbumMetadata = ArtworkEntity & { name?: string; title?: string; artistName?: string; artist?: string };

export class AlbumArtworkService {
  private readonly checks = new Map<string, { expiresAt: number; value: Promise<boolean> }>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly validateLocal: (id: string) => Promise<boolean>,
    private readonly lookup: (artist: string, album: string) => Promise<string | null>,
    private readonly reportFailure: (error: Error) => void,
    private readonly importedArtwork?: { find(artist: string, album: string): string | null },
  ) {}

  private check(id: string): Promise<boolean> {
    const cached = this.checks.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (this.waiting.length >= 100) return Promise.reject(new Error("Artwork validation capacity exceeded"));
    const slot = this.active < 5 ? (this.active++, Promise.resolve())
      : new Promise<void>((resolve) => { this.waiting.push(resolve); });
    const entry = { expiresAt: Number.POSITIVE_INFINITY, value: Promise.resolve(false) };
    entry.value = slot.then(() => this.validateLocal(id)).then((valid) => {
      entry.expiresAt = Date.now() + (valid ? 60 * 60_000 : 5 * 60_000);
      return valid;
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

  async resolve<T extends AlbumMetadata>(album: T, tracks: ArtworkEntity[]) {
    const rejected: string[] = [];
    const candidates = [artwork(album), ...tracks.map(artwork)];
    const seen = new Set<string>();
    let artworkResolutionFailed = false;
    let selected: Cover = { id: null, url: null };
    for (const candidate of candidates) {
      if (!candidate.url || seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      const match = /^\/api\/artwork\/([^/?]+)(?:\?|$)/.exec(candidate.url);
      const localId = match ? decodeURIComponent(match[1]) : null;
      if (localId && !localId.startsWith("mdplart_")) {
        let valid: boolean;
        try {
          valid = await this.check(localId);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          this.reportFailure(error);
          artworkResolutionFailed = true;
          valid = false;
        }
        if (!valid) {
          rejected.push(localId);
          continue;
        }
      }
      selected = candidate;
      break;
    }
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
