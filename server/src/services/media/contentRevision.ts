import type { Db } from "../../db/database.js";

export type TrackContentHint = {
  filePath?: string;
  fingerprint?: string;
  attributes?: Record<string, string | number>;
};
// Paths and raw provider metadata stay server-side, outside serialized tracks.
const hints = new WeakMap<object, TrackContentHint>();

export function withTrackContent<T extends object>(track: T, fields: Record<string, unknown>): T {
  const known = Object.fromEntries(Object.entries(fields).filter(([, value]) =>
    (typeof value === "string" && value !== "") || (typeof value === "number" && Number.isFinite(value)))) as Record<string, string | number>;
  hints.set(track, {
    ...(typeof fields.path === "string" && fields.path ? { filePath: fields.path } : {}),
    ...(Object.keys(known).length ? { attributes: known } : {}),
  });
  return track;
}

export function trackContentHint(track: object): TrackContentHint | undefined { return hints.get(track); }

export function readContentRevision(db: Db, trackId: string): string | null {
  const row = db.prepare("SELECT content_revision FROM library_items WHERE id = ? AND type = 'track'")
    .get(trackId) as { content_revision: string } | undefined;
  return row?.content_revision ?? null;
}
