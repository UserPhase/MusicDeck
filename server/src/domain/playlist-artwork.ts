import { createHash } from "node:crypto";

import type { Db } from "../db/database.js";

/**
 * Playlist cover art.
 *
 * A playlist has exactly two cover-art modes:
 *
 * - **custom**  — operator/user supplied artwork, stored once in MusicDeck's
 *   own database and always winning over the automatic collage.
 * - **collage** — an automatic 2x2 collage built from the artwork of the
 *   playlist's first four tracks. Nothing about the collage is persisted; it
 *   is rendered on demand and cached in memory, so reordering or replacing
 *   the leading tracks changes the artwork without any stored state to
 *   invalidate.
 *
 * Both modes are addressed through a single opaque MusicDeck artwork token
 * (`mdplart_<signature>_<playlistId>`) served by the existing
 * `/api/artwork/:artworkId` proxy, so playlist cards, playlist pages, search
 * results, and the player all resolve artwork through the same authenticated
 * path as every other MusicDeck artwork reference. The signature only busts
 * caches; artwork is always re-resolved from current state server-side.
 */

export const PLAYLIST_ARTWORK_PREFIX = "mdplart_";

/** Tiles in the automatic 2x2 collage. */
export const COLLAGE_TILE_COUNT = 4;

export const MAX_CUSTOM_ARTWORK_BYTES = 5 * 1024 * 1024;

/**
 * Request-body ceiling for an artwork upload. Base64 inflates the payload by
 * roughly a third, so the transport limit must exceed
 * `MAX_CUSTOM_ARTWORK_BYTES` or the documented image cap is unreachable and
 * uploads fail at the transport layer instead of in validation.
 */
export const MAX_ARTWORK_REQUEST_BYTES = 8 * 1024 * 1024;

/** Guard against a single oversized cover blowing up a collage response. */
const MAX_TILE_BYTES = 2 * 1024 * 1024;

const MAX_CACHED_COLLAGES = 64;

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const COLLAGE_SIZE = 600;

/**
 * Thumbnail sizes the artwork endpoint will render. Requests are snapped to
 * the smallest size that covers them so the collage cache stays small and
 * clients cannot force arbitrary render sizes.
 */
export const PLAYLIST_ARTWORK_SIZES = [64, 160, 300, COLLAGE_SIZE] as const;

/**
 * Resolve a caller-supplied `size` hint to a supported render size. Anything
 * missing, malformed, or larger than the full size falls back to full size.
 */
export function resolveArtworkSize(value: unknown): number {
  const requested = Number(value);

  if (!Number.isFinite(requested) || requested <= 0) {
    return COLLAGE_SIZE;
  }

  return PLAYLIST_ARTWORK_SIZES.find((size) => size >= requested) ?? COLLAGE_SIZE;
}

export type PlaylistArtworkMode = "custom" | "collage";

export type PlaylistArtworkDescriptor = {
  artworkId: string;
  artworkUrl: string;
  artworkMode: PlaylistArtworkMode;
};

export type RenderedArtwork = {
  body: Buffer;
  contentType: string;
};

export type CustomPlaylistArtwork = {
  data: Buffer;
  contentType: string;
  updatedAt: string;
};

type StreamResult = {
  body: ReadableStream<Uint8Array> | null;
  status: number;
  headers: Headers;
};

type ArtworkFetcher = (artworkId: string, size?: number) => Promise<StreamResult>;

type ArtworkRow = {
  content_type: string;
  data: Buffer | Uint8Array;
  updated_at: string;
};

export function buildPlaylistArtworkId(playlistId: string, signature: string): string {
  return `${PLAYLIST_ARTWORK_PREFIX}${signature}_${playlistId}`;
}

/**
 * Parse an opaque playlist artwork token. The signature is a hex digest and
 * therefore never contains `_`, so the first separator always splits the
 * signature from the (underscore-bearing) playlist ID.
 */
export function parsePlaylistArtworkId(
  artworkId: string
): { playlistId: string; signature: string } | null {
  if (!artworkId.startsWith(PLAYLIST_ARTWORK_PREFIX)) {
    return null;
  }

  const rest = artworkId.slice(PLAYLIST_ARTWORK_PREFIX.length);
  const separator = rest.indexOf("_");

  if (separator <= 0 || separator === rest.length - 1) {
    return null;
  }

  return {
    signature: rest.slice(0, separator),
    playlistId: rest.slice(separator + 1),
  };
}

/**
 * Validate and decode a base64 image data URL. Custom artwork is uploaded as
 * JSON rather than multipart so the API stays dependency-free; the payload is
 * still strictly validated for media type and size before it is stored.
 */
export function parseImageDataUrl(value: unknown): { data: Buffer; contentType: string } | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value.trim());

  if (!match) {
    return null;
  }

  const contentType = match[1].toLowerCase();

  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    return null;
  }

  const data = Buffer.from(match[2].replace(/\s+/g, ""), "base64");

  if (data.length === 0 || data.length > MAX_CUSTOM_ARTWORK_BYTES) {
    return null;
  }

  return { data, contentType };
}

function signatureOf(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

function tile(x: number, y: number, size: number, href: string): string {
  return (
    `<image x="${x}" y="${y}" width="${size}" height="${size}" ` +
    `preserveAspectRatio="xMidYMid slice" href="${href}" />`
  );
}

export class PlaylistArtworkService {
  /** Rendered collages keyed by their tile artwork IDs. */
  private readonly collageCache = new Map<string, RenderedArtwork>();

  constructor(
    private readonly db: Db,
    private readonly fetchArtwork?: ArtworkFetcher
  ) {}

  getCustom(playlistId: string): CustomPlaylistArtwork | null {
    const row = this.db.prepare(
      "SELECT content_type, data, updated_at FROM playlist_artwork WHERE playlist_id = ?"
    ).get(playlistId) as ArtworkRow | undefined;

    if (!row) {
      return null;
    }

    return {
      data: Buffer.from(row.data as Uint8Array),
      contentType: row.content_type,
      updatedAt: row.updated_at,
    };
  }

  setCustom(playlistId: string, data: Buffer, contentType: string): void {
    this.db.prepare(`
      INSERT INTO playlist_artwork (playlist_id, content_type, data, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(playlist_id) DO UPDATE SET
        content_type = excluded.content_type,
        data = excluded.data,
        updated_at = excluded.updated_at
    `).run(playlistId, contentType, data, new Date().toISOString());
  }

  clearCustom(playlistId: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM playlist_artwork WHERE playlist_id = ?"
    ).run(playlistId);

    return result.changes > 0;
  }

  /**
   * Resolve the playlist's artwork reference. `trackRefs` are the stable
   * references of the playlist's first tracks; only the collage tiles matter,
   * so the signature (and therefore the artwork token) changes whenever the
   * leading tracks are added, removed, or reordered.
   */
  describe(playlistId: string, trackRefs: string[]): PlaylistArtworkDescriptor | null {
    const custom = this.getCustom(playlistId);

    if (custom) {
      return this.descriptor(playlistId, signatureOf("custom", custom.updatedAt), "custom");
    }

    const tiles = trackRefs.slice(0, COLLAGE_TILE_COUNT);

    if (tiles.length === 0) {
      return null;
    }

    return this.descriptor(playlistId, signatureOf("collage", ...tiles), "collage");
  }

  private descriptor(
    playlistId: string,
    signature: string,
    artworkMode: PlaylistArtworkMode
  ): PlaylistArtworkDescriptor {
    const artworkId = buildPlaylistArtworkId(playlistId, signature);

    return {
      artworkId,
      artworkUrl: `/api/artwork/${encodeURIComponent(artworkId)}`,
      artworkMode,
    };
  }

  /**
   * Render the automatic collage for the given track artwork IDs at the
   * requested edge length. Tiles are requested from the backing provider at
   * the quadrant size, so a sidebar thumbnail never downloads full-resolution
   * covers. Unreadable or missing covers are skipped rather than failing the
   * render: a playlist whose first tracks have no artwork still resolves to a
   * usable placeholder.
   */
  async renderCollage(artworkIds: string[], size = COLLAGE_SIZE): Promise<RenderedArtwork> {
    const ids = artworkIds.slice(0, COLLAGE_TILE_COUNT);
    const cacheKey = `${size}|${ids.join("|")}`;
    const cached = this.collageCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    // A quadrant is half the collage edge; a single cover fills the frame.
    const tileSize = ids.length > 1 ? Math.round(size / 2) : size;

    const tiles = (await Promise.all(ids.map((id) => this.loadTile(id, tileSize))))
      .filter((value): value is string => Boolean(value));

    const rendered = {
      body: Buffer.from(this.buildCollage(tiles, size), "utf8"),
      contentType: "image/svg+xml",
    };

    if (this.collageCache.size >= MAX_CACHED_COLLAGES) {
      const oldest = this.collageCache.keys().next().value;
      if (oldest !== undefined) {
        this.collageCache.delete(oldest);
      }
    }

    this.collageCache.set(cacheKey, rendered);
    return rendered;
  }

  private async loadTile(artworkId: string, size?: number): Promise<string | null> {
    if (!this.fetchArtwork) {
      return null;
    }

    try {
      const response = await this.fetchArtwork(artworkId, size);

      if (response.status >= 400 || !response.body) {
        return null;
      }

      const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();

      if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
        return null;
      }

      const buffer = Buffer.from(await new Response(response.body).arrayBuffer());

      if (buffer.length === 0 || buffer.length > MAX_TILE_BYTES) {
        return null;
      }

      return `data:${contentType};base64,${buffer.toString("base64")}`;
    } catch {
      // A single unreachable cover must never fail the whole collage.
      return null;
    }
  }

  /**
   * Compose the collage as an SVG document. The document is fully generated
   * from validated media types and base64 payloads, so no external URL and no
   * caller-controlled markup ever reaches the client.
   */
  private buildCollage(tiles: string[], size = COLLAGE_SIZE): string {
    const half = size / 2;
    const open =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
      `viewBox="0 0 ${size} ${size}" role="img" aria-label="Playlist cover">` +
      `<rect width="${size}" height="${size}" fill="#181818" />`;

    if (tiles.length === 0) {
      return (
        `${open}<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" ` +
        `font-family="sans-serif" font-size="${Math.round(size / 3)}" fill="#b3b3b3">&#9834;</text></svg>`
      );
    }

    if (tiles.length === 1) {
      return `${open}${tile(0, 0, size, tiles[0])}</svg>`;
    }

    // Two or three covers still fill the 2x2 grid by cycling the available
    // artwork, so the collage never renders with empty quadrants.
    const quadrants = [
      [0, 0],
      [half, 0],
      [0, half],
      [half, half],
    ];

    const images = quadrants
      .map(([x, y], index) => tile(x, y, half, tiles[index % tiles.length]))
      .join("");

    return `${open}${images}</svg>`;
  }
}
