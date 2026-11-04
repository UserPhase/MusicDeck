import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/authorization.js";
import type { Db } from "../db/database.js";
import type { CatalogService } from "../domain/catalog.js";
import { createLibraryMatchIndex } from "../utils/libraryMatcher.js";
import { createId } from "../utils/ids.js";
import { sendError } from "../utils/http.js";

const saveSchema = z.object({
  provider: z.enum(["deezer", "itunes"]),
  external_id: z.string().trim().min(1).max(200),
  type: z.enum(["track", "album"]),
  title: z.string().trim().min(1).max(300),
  artist: z.string().trim().min(1).max(300),
  cover_url: z.string().max(2048).refine((value) => {
    if (value.startsWith("/api/") && !value.includes("\\")) return true;
    try { return ["https:", "http:"].includes(new URL(value).protocol); }
    catch { return false; }
  }).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();

type SavedRow = z.infer<typeof saveSchema> & {
  id: string;
  metadata_json: string;
  created_at: string;
};

function serialize(row: SavedRow) {
  return {
    id: row.id, provider: row.provider, external_id: row.external_id,
    type: row.type, title: row.title, artist: row.artist,
    cover_url: row.cover_url, metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    created_at: row.created_at,
  };
}

function expectedAlbumTracks(metadata: Record<string, unknown>): number | null {
  const counts = new Set<number>();
  for (const value of [metadata.songCount, metadata.trackCount]) {
    if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value.trim()))) continue;
    const count = Number(value);
    if (Number.isSafeInteger(count) && count > 0) counts.add(count);
  }
  // Conflicting totals are uncertainty, not permission to remove a bookmark.
  return counts.size === 1 ? [...counts][0] : null;
}

/** Bookmarks own metadata only. Imports use the existing permission-checked
 * acquisition endpoint, which delegates execution to SPOTDL_IMPORT tasks. */
export async function registerSavedDiscoveryRoutes(app: FastifyInstance, db: Db, catalog: CatalogService) {
  app.post("/api/v1/discoveries/save", { bodyLimit: 65_536 }, async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const parsed = saveSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid saved discovery", "VALIDATION_ERROR");
    const item = parsed.data;
    // Canonicalize IDs so raw provider IDs and prefixed Explore IDs deduplicate.
    const externalId = item.external_id.replace(new RegExp(`^external_${item.provider}_${item.type}_`), "");
    if (!externalId) return sendError(reply, 400, "External ID is required", "VALIDATION_ERROR");
    const result = db.prepare(`INSERT INTO saved_discoveries
      (id, user_id, provider, external_id, type, title, artist, cover_url, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, provider, type, external_id) DO NOTHING`).run(
      createId("discovery"), user.id, item.provider, externalId, item.type,
      item.title, item.artist, item.cover_url ?? null, JSON.stringify(item.metadata), new Date().toISOString(),
    );
    const row = db.prepare(`SELECT * FROM saved_discoveries
      WHERE user_id = ? AND provider = ? AND type = ? AND external_id = ?`)
      .get(user.id, item.provider, item.type, externalId) as SavedRow;
    return reply.code(result.changes ? 201 : 200).send({ discovery: serialize(row) });
  });

  app.delete("/api/v1/discoveries/saved/:id", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const { id } = request.params as { id: string };
    const result = db.prepare("DELETE FROM saved_discoveries WHERE id = ? AND user_id = ?").run(id, user.id);
    if (!result.changes) return sendError(reply, 404, "Saved discovery not found");
    return reply.code(204).send();
  });

  app.get("/api/v1/discoveries/saved", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    reply.header("cache-control", "private, no-store");
    const rows = db.prepare("SELECT * FROM saved_discoveries WHERE user_id = ? ORDER BY created_at DESC, id")
      .all(user.id) as SavedRow[];
    if (!rows.length) return { discoveries: [], warning: null };
    let index: ReturnType<typeof createLibraryMatchIndex> | undefined;
    const albumTrackCounts = new Map<string, number>();
    let warning: string | null = null;
    try {
      const [tracks, albums] = await Promise.all([catalog.listTracks(), catalog.listAlbums()]);
      const albumTracks = new Map<string, Set<string>>();
      for (const track of tracks.items) {
        if (!track.albumId) continue;
        const ids = albumTracks.get(track.albumId) ?? new Set<string>();
        ids.add(track.id);
        albumTracks.set(track.albumId, ids);
      }
      for (const [albumId, ids] of albumTracks) albumTrackCounts.set(albumId, ids.size);
      index = createLibraryMatchIndex(
        tracks.items.map((track) => ({
          id: track.id, title: track.title, artist: track.artistName, isrc: track.identityHints?.isrc,
        })),
        albums.items.map((album) => ({ id: album.id, title: album.name, artist: album.artistName || "" })),
      );
      if (tracks.degraded || albums.degraded) warning = "Some library sources are unavailable. Library status may be incomplete.";
    } catch (error) {
      request.log.warn({ err: error }, "Could not cross-reference saved discoveries");
      warning = "Your saved discoveries are available, but library status could not be checked. Try refreshing shortly.";
    }
    const latestJob = db.prepare(`SELECT status, error_message, updated_at FROM acquisition_jobs
      WHERE user_id = ? AND
      ((? = 'track' AND requested_track_id = ?) OR
       (? = 'album' AND requested_album_id = ? AND requested_track_id IS NULL))
      ORDER BY created_at DESC, rowid DESC LIMIT 1`);
    const removeImported = db.prepare("DELETE FROM saved_discoveries WHERE id = ? AND user_id = ?");
    const importedIds: string[] = [];
    const discoveries = rows.flatMap((row) => {
        const item = serialize(row);
        const externalKey = `external_${row.provider}_${row.type}_${row.external_id}`;
        const match = row.type === "track"
          ? index?.matchTrack({
            id: externalKey, title: row.title, artist: row.artist,
            isrc: typeof item.metadata.isrc === "string" ? item.metadata.isrc : null,
          })
          : index?.matchAlbum({ id: externalKey, title: row.title, artist: row.artist });
        const job = latestJob.get(user.id, row.type, externalKey, row.type, externalKey) as
          { status: string; error_message: string | null; updated_at: string } | undefined;
        const expectedTracks = expectedAlbumTracks(item.metadata);
        const matchedAlbumId = match && "localAlbumId" in match ? match.localAlbumId : undefined;
        const completeMatch = match?.inLibrary && (row.type === "track"
          || Boolean(expectedTracks !== null && matchedAlbumId && albumTrackCounts.get(matchedAlbumId) === expectedTracks));
        const importedSinceSave = job?.status === "completed" && Date.parse(job.updated_at) >= Date.parse(row.created_at);
        const inLibrary = Boolean(completeMatch || importedSinceSave);
        if (inLibrary) {
          importedIds.push(row.id);
          return [];
        }
        const status = job?.status === "queued" ? "QUEUED"
          : job && ["discovering", "downloading", "processing", "importing"].includes(job.status) ? "IMPORTING"
          : job?.status === "failed" ? "FAILED"
          : warning ? "UNKNOWN" : "IDLE";
        return [{ ...item, inLibrary, status, error: job?.error_message || null }];
      });
    // Remove bookmarks only after a positive library match or completed import.
    // An unavailable source, queued job or failed import never removes a save.
    if (importedIds.length) db.transaction(() => {
      for (const id of importedIds) removeImported.run(id, user.id);
    })();
    return {
      discoveries,
      warning,
    };
  });
}
