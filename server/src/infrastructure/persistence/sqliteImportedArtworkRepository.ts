import { createHash } from "node:crypto";
import type { Db } from "../../db/database.js";
import { isSpotifyArtworkUrl } from "../../utils/spotifyArtworkUrl.js";

export function normalizeImportedAlbumName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/['\u2019]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ").toLowerCase();
}

export class SqliteImportedArtworkRepository {
  constructor(private readonly db: Db) {}

  save(artist: string, album: string, coverUrl: string, spotifyAlbumId?: string): void {
    const artistName = normalizeImportedAlbumName(artist);
    const albumName = normalizeImportedAlbumName(album);
    if (!artistName || !albumName || !isSpotifyArtworkUrl(coverUrl)) throw new Error("Invalid imported album artwork metadata");
    const id = createHash("sha256").update(JSON.stringify([artistName, albumName])).digest("hex");
    this.db.prepare(`
      INSERT INTO imported_album_artwork (id, artist_name, album_name, spotify_album_id, cover_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(artist_name, album_name) DO UPDATE SET cover_url = excluded.cover_url,
        spotify_album_id = COALESCE(excluded.spotify_album_id, imported_album_artwork.spotify_album_id)
    `).run(id, artistName, albumName, spotifyAlbumId || null, coverUrl, Date.now());
  }

  find(artist: string, album: string): string | null {
    const row = this.db.prepare("SELECT cover_url FROM imported_album_artwork WHERE artist_name = ? AND album_name = ?")
      .get(normalizeImportedAlbumName(artist), normalizeImportedAlbumName(album)) as { cover_url: string } | undefined;
    if (!row) return null;
    if (!isSpotifyArtworkUrl(row.cover_url)) throw new Error("Stored imported artwork URL is invalid");
    return row.cover_url;
  }
}
