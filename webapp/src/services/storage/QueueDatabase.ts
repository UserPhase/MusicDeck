import { isMediaResumeContext } from "../mediaSessions";
import { readQueueSnapshot, queueStorageKey } from "../../utils/queuePersistence";
import { replayGainMetadata, validLoudness } from "../../utils/loudness";
import { normalizeArtistCredits } from "../../utils/normalizeTrackData";
export interface PersistedQueueTrack { id: string; [key: string]: unknown }
export interface PersistedQueueEntry { entryId: string; track: PersistedQueueTrack }
export interface QueueCheckpoint {
  index: number; position: number; repeatOne: boolean; shuffle: boolean; shuffleSeed: number | null;
  shuffleMode: "standard" | "smart"; albumAware: boolean; volume: number; wasPlaying: boolean;
  context: { type: string; id: string; name: string; coverArt: string | null } | null; capturedAt: number;
}
export interface QueueContent { version: 2; entries: PersistedQueueEntry[] }

export function sameQueueCheckpoint(first: QueueCheckpoint, second: QueueCheckpoint): boolean {
  return Object.keys(first).every(key => {
    const field = key as keyof QueueCheckpoint;
    if (field === "capturedAt") return true;
    return field === "context" ? JSON.stringify(first.context) === JSON.stringify(second.context)
      : first[field] === second[field];
  });
}
export interface QueueHead { owner: string; contentKey: string; checkpoint: QueueCheckpoint; sequence: number; updatedAt: number; serverContentId?: string }
export interface LocalQueue { content: QueueContent; head: QueueHead; serialized: string; timing: { ioMs: number; decodeMs: number } }
const DATABASE = "musicdeck-queues", VERSION = 1;
let connection: Promise<IDBDatabase> | null = null, counter = 0;
export const QUEUE_LOCAL_CHANGED = "musicdeck:queue-local-changed";
export function openQueueDatabase(): Promise<IDBDatabase> {
  if (connection) return connection;
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("This browser cannot save queues in IndexedDB.")); return; }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => { for (const name of ["contents", "heads"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "owner" }); };
    request.onerror = () => reject(request.error || new Error("Could not open queue storage."));
    let blocked = false;
    request.onblocked = () => { blocked = true; reject(new Error("Queue storage is waiting for another MusicDeck tab. Close the older tab and retry.")); };
    request.onsuccess = () => { const db = request.result; if (blocked) { db.close(); return; } db.onversionchange = () => { db.close(); connection = null; }; resolve(db); };
  }).catch(error => { connection = null; throw error; });
  return connection;
}
const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || new Error("Queue storage read failed.")); });
const finished = (tx: IDBTransaction) => { const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error || new Error("Queue storage write was interrupted.")); tx.onerror = () => reject(tx.error || new Error("Queue storage write failed.")); }); void done.catch(() => undefined); return done; };
const finite = (n: unknown, fallback: number) => typeof n === "number" && Number.isFinite(n) ? n : fallback;
export function queueStorageError(error: unknown): string {
  return error instanceof DOMException && error.name === "QuotaExceededError" ? "Browser storage is full. Free some space to keep this queue across restarts."
    : error instanceof Error ? error.message : "Could not save the listening queue. Please retry.";
}
export function sanitizeQueueTrack(input: { id: string | number }): PersistedQueueTrack {
  const value = input as { id: string | number; [key: string]: unknown };
  const track: PersistedQueueTrack = { id: String(value.id) };
  for (const field of ["title", "artist", "album", "artistId", "albumId", "coverArt", "provider", "albumPlaybackId", "playlistItemId", "tastePlaylistId"])
    if (typeof value[field] === "string") track[field] = (value[field] as string).slice(0, 1000);
  const credits = normalizeArtistCredits(value.artistCredits);
  if (credits.length) track.artistCredits = credits.map(({ id, name }) => ({
    id: id && id.length <= 1000 ? id : null, name: name.slice(0, 1000),
  }));
  for (const field of ["external", "isDownloaded", "recommendationGenerated", "autoplayGenerated", "excludeFromTaste", "tasteSessionExcluded"])
    if (value[field] === true) track[field] = true;
  if (typeof value.duration === "number" && Number.isFinite(value.duration) && value.duration >= 0) track.duration = value.duration;
  if (Number.isInteger(value.albumTrackIndex) && Number(value.albumTrackIndex) >= 0) track.albumTrackIndex = value.albumTrackIndex;
  const gain = value.normalizationGainDb ?? (value.metadata as Record<string, unknown> | null)?.normalizationGainDb;
  if (typeof gain === "number" && Number.isFinite(gain) && gain >= -60 && gain <= 12) track.normalizationGainDb = gain;
  if (typeof value.previewUrl === "string") { try { const url = new URL(value.previewUrl);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port && /(^|\.)(itunes\.apple\.com|dzcdn\.net)$/.test(url.hostname)) track.previewUrl = url.href;
  } catch { /* Expired or invalid preview references are resolved again by the player. */ } }
  const source = value.source as { kind?: unknown; count?: unknown } | null;
  if (source?.kind === "library" || source?.kind === "external") track.source = { kind: source.kind, count: Math.max(0, finite(source.count, 0)) };
  const metadata = value.metadata as Record<string, unknown> | null;
  if (metadata) { const selected: Record<string, unknown> = {};
    for (const key of ["artistId", "albumId", "year"])
      if (typeof metadata[key] === "string" || (typeof metadata[key] === "number" && Number.isFinite(metadata[key]))) selected[key] = typeof metadata[key] === "string" ? (metadata[key] as string).slice(0, 1000) : metadata[key];
    for (const key of ["isrc", "recommendationReason"]) if (typeof metadata[key] === "string") selected[key] = metadata[key].slice(0, 1000);
    if (typeof metadata.normalizationGainDb === "number" && Number.isFinite(metadata.normalizationGainDb)) selected.normalizationGainDb = metadata.normalizationGainDb;
    if (typeof metadata.durationSeconds === "number" && Number.isFinite(metadata.durationSeconds) && metadata.durationSeconds >= 0) selected.durationSeconds = metadata.durationSeconds;
    if (Object.keys(selected).length) track.metadata = selected;
  }
  const replay = Object.fromEntries(Object.entries(replayGainMetadata(value)).filter(([key, number]) => typeof number === "number" && Number.isFinite(number) && (!key.endsWith("Peak") || number >= 0)));
  if (Object.keys(replay).length) track.replayGain = replay;
  const loudness = validLoudness(value.loudness ?? metadata?.loudness);
  if (loudness) track.loudness = loudness;
  if (isMediaResumeContext(value.mediaResume)) track.mediaResume = { ...value.mediaResume };
  return track;
}
/** The array and occurrence IDs are retained directly; hydration does not clone or normalize every track again. */
export function decodeQueueContent(serialized: string): QueueContent {
  let value = JSON.parse(serialized);
  if (value?.version === 3) {
    const { tracks, occurrences } = value;
    if (!Array.isArray(tracks) || !Array.isArray(occurrences)) throw new Error("The saved queue format is invalid.");
    value = { version: 2, entries: occurrences.map((row: unknown) => {
      if (!Array.isArray(row) || row.length !== 2 || !Number.isInteger(row[1]) || row[1] < 0 || row[1] >= tracks.length) throw new Error("The saved queue reference is invalid.");
      return { entryId: row[0], track: tracks[row[1]] };
    }) };
  }
  if (value?.version !== 2 || !Array.isArray(value.entries)) throw new Error("The saved queue format is invalid.");
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || typeof entry.entryId !== "string" || !entry.entryId || entry.entryId.length > 160 || seen.has(entry.entryId) || !entry.track || typeof entry.track.id !== "string" || !entry.track.id)
      throw new Error("The saved queue contains an invalid or duplicate occurrence.");
    seen.add(entry.entryId);
  }
  return value;
}
export function validateCheckpoint(raw: QueueCheckpoint, count: number): QueueCheckpoint {
  if (!raw || !Number.isInteger(raw.index) || (count ? raw.index < 0 || raw.index >= count : raw.index !== -1)) throw new Error("The saved queue position is invalid.");
  return { ...raw, position: Math.max(0, finite(raw.position, 0)), volume: Math.min(1, Math.max(0, finite(raw.volume, 1))),
    wasPlaying: raw.wasPlaying === true, repeatOne: raw.repeatOne === true, shuffle: raw.shuffle === true, albumAware: raw.albumAware === true,
    shuffleMode: raw.shuffleMode === "smart" ? "smart" : "standard", shuffleSeed: Number.isInteger(raw.shuffleSeed) ? raw.shuffleSeed : null };
}
export async function readLocalQueue(owner: string, migrate = true): Promise<LocalQueue | null> {
  const db = await openQueueDatabase(), start = performance.now();
  const tx = db.transaction(["contents", "heads"], "readonly"), done = finished(tx);
  const [record, head] = await Promise.all([result(tx.objectStore("contents").get(owner)) as Promise<{ owner: string; key: string; serialized: string } | undefined>, result(tx.objectStore("heads").get(owner)) as Promise<QueueHead | undefined>]);
  await done; const ioMs = performance.now() - start;
  if (!record && !head && migrate) {
    let legacy; try { legacy = readQueueSnapshot(localStorage, owner); } catch { legacy = null; }
    if (!legacy) return null;
    let shuffleMode: "standard" | "smart" = "standard", albumAware = false;
    try { shuffleMode = localStorage.getItem("playerShuffleMode") === "smart" ? "smart" : "standard"; albumAware = localStorage.getItem("playerAlbumAware") === "true"; } catch { /* Legacy preferences are optional. */ }
    const entries = legacy.queueItems.map((track: { id: string }, i: number) => ({ entryId: `q${i}`, track: sanitizeQueueTrack(track) }));
    const checkpoint: QueueCheckpoint = { index: entries.length ? legacy.queueIndex : -1, position: legacy.playbackProgressSeconds,
      repeatOne: legacy.repeatMode === "one", shuffle: legacy.shuffleEnabled, shuffleSeed: legacy.shuffleSeed, shuffleMode, albumAware,
      volume: legacy.volume, wasPlaying: legacy.wasPlaying, context: null, capturedAt: Date.now() };
    await writeLocalQueue(owner, { version: 2, entries }, checkpoint);
    try { localStorage.removeItem(queueStorageKey(owner)); } catch { /* A committed IndexedDB copy is authoritative. */ }
    return readLocalQueue(owner, false);
  }
  if (!record && !head) return null;
  if (!record || !head || record.key !== head.contentKey || head.owner !== owner) throw new Error("Queue storage is incomplete. Restore a named or synced queue.");
  const decodeStart = performance.now(), content = decodeQueueContent(record.serialized);
  head.checkpoint = validateCheckpoint(head.checkpoint, content.entries.length);
  return { content, head, serialized: record.serialized, timing: { ioMs, decodeMs: performance.now() - decodeStart } };
}
export async function writeLocalQueue(owner: string, content: QueueContent, checkpoint: QueueCheckpoint): Promise<QueueHead> {
  // Store identical metadata once, retaining every occurrence separately. Encoding
  // yields between batches; dictionary keys include resume/taste metadata, not just track IDs.
  const tracks: string[] = [], dictionary = new Map<string, number>(), occurrences: [string, number][] = [];
  for (let i = 0; i < content.entries.length; i++) {
    const entry = content.entries[i], encoded = JSON.stringify(entry.track);
    let index = dictionary.get(encoded);
    if (index === undefined) { index = tracks.length; dictionary.set(encoded, index); tracks.push(encoded); }
    occurrences.push([entry.entryId, index]);
    if (i > 0 && i % 1000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  const serialized = `{"version":3,"tracks":[${tracks.join(",")}],"occurrences":${JSON.stringify(occurrences)}}`, db = await openQueueDatabase();
  const tx = db.transaction(["contents", "heads"], "readwrite"), done = finished(tx), heads = tx.objectStore("heads");
  const old = await result(heads.get(owner)) as QueueHead | undefined;
  const key = `${Date.now().toString(36)}-${++counter}-${Math.random().toString(36).slice(2)}`;
  const head: QueueHead = { owner, contentKey: key, sequence: (old?.sequence ?? 0) + 1, checkpoint: validateCheckpoint(checkpoint, content.entries.length), updatedAt: Date.now() };
  tx.objectStore("contents").put({ owner, key, serialized }); heads.put(head); await done;
  window.dispatchEvent(new CustomEvent(QUEUE_LOCAL_CHANGED, { detail: { owner, contentChanged: true } })); return head;
}
export async function writeQueueCheckpoint(owner: string, contentKey: string, checkpoint: QueueCheckpoint): Promise<QueueHead | null> {
  const db = await openQueueDatabase(), tx = db.transaction("heads", "readwrite"), done = finished(tx), store = tx.objectStore("heads");
  const head = await result(store.get(owner)) as QueueHead | undefined;
  if (!head || head.contentKey !== contentKey || checkpoint.capturedAt < head.checkpoint.capturedAt) { await done; return null; }
  if (sameQueueCheckpoint(head.checkpoint, checkpoint)) { await done; return head; }
  const next = { ...head, checkpoint, sequence: head.sequence + 1, updatedAt: Date.now() }; store.put(next); await done; return next;
}
export async function markQueueSynced(owner: string, contentKey: string, serverContentId: string | undefined): Promise<void> {
  const db = await openQueueDatabase(), tx = db.transaction("heads", "readwrite"), done = finished(tx), store = tx.objectStore("heads");
  const head = await result(store.get(owner)) as QueueHead | undefined;
  if (head?.contentKey === contentKey) store.put({ ...head, serverContentId }); await done;
}
export async function clearLocalQueue(owner: string): Promise<void> {
  const db = await openQueueDatabase(), tx = db.transaction(["contents", "heads"], "readwrite"), done = finished(tx);
  for (const name of ["contents", "heads"]) tx.objectStore(name).delete(owner); await done;
}
