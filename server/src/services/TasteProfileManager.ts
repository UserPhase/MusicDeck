import type { Db } from "../db/database.js";
import { PlaylistCollaborationService, playlistReadPredicate } from "./PlaylistCollaborationService.js";
import { createHash } from "node:crypto";
import type { SessionUser } from "../types.js";
import { createId } from "../utils/ids.js";
import { normalizeMusicText, versionSignature } from "../domain/music-identity.js";

export const tasteArtistId = (artist: string) => `artist_name_${createHash("sha256").update(normalizeMusicText(artist)).digest("hex")}`;
export const tasteRecordingKey = (title: string, artist: string) => JSON.stringify([normalizeMusicText(artist), normalizeMusicText(title), versionSignature(title)]);
export interface TasteState { privateListening: boolean; revision: number; resetBefore: string | null; providerHistoryDisabled: boolean }
export interface TasteTarget { id: string; type?: "track" | "artist" | "album"; title?: string; artist?: string; album?: string; artistId?: string | null; albumId?: string | null }
interface FeedbackRow { item_type: "track" | "artist" | "album"; item_id: string; action: string; updated_at: string; identity_title: string | null; identity_artist: string | null; identity_album: string | null }
export class TasteProfileError extends Error { constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409) { super(message); } }

/** History and scrobbling retain their own records. Only the taste_* views feed affinity.
 * Privacy flags are monotonic per listen; a later retry cannot make an excluded session public. */
export class TasteProfileManager {
  private metadataVersion: string | null = null;
  private metadata = new Map<string, TasteTarget>();
  constructor(private readonly db: Db, private readonly now = Date.now) {}
  state(userId: string): TasteState {
    const row = this.db.prepare("SELECT * FROM taste_settings WHERE user_id=?").get(userId) as
      { private_listening: number; revision: number; reset_before: string | null; provider_history_disabled: number } | undefined;
    return { privateListening: Boolean(row?.private_listening), revision: row?.revision ?? 0, resetBefore: row?.reset_before ?? null, providerHistoryDisabled: Boolean(row?.provider_history_disabled) };
  }
  private ensure(userId: string) { this.db.prepare("INSERT OR IGNORE INTO taste_settings(user_id) VALUES(?)").run(userId); }
  bump(userId: string) { this.ensure(userId); this.db.prepare("UPDATE taste_settings SET revision=revision+1 WHERE user_id=?").run(userId); }
  private stopProviderHistory(userId: string) { this.ensure(userId); this.db.prepare("UPDATE taste_settings SET provider_history_disabled=1 WHERE user_id=? AND provider_history_disabled=0").run(userId); }
  canUseProviderHistory(userId: string): boolean { return !this.state(userId).providerHistoryDisabled; }
  private revision(userId: string, expected: number) { if (this.state(userId).revision !== expected) throw new TasteProfileError("Taste settings changed elsewhere. Refresh and try again.", 409); }
  setPrivate(userId: string, enabled: boolean, expectedRevision: number) {
    return this.db.transaction(() => {
      this.revision(userId, expectedRevision); this.ensure(userId);
      if (this.state(userId).privateListening === enabled) return this.state(userId);
      const now = new Date(this.now()).toISOString();
      if (enabled) {
        this.db.prepare("INSERT INTO taste_private_periods(id,user_id,started_at) VALUES(?,?,?)").run(createId("private"), userId, now);
        this.stopProviderHistory(userId);
        this.db.prepare(`UPDATE listening_events SET taste_excluded=1 WHERE user_id=? AND playback_session_id IS NOT NULL
          AND finished=0 AND updated_at>=?`).run(userId, new Date(this.now() - 86_400_000).toISOString());
        this.db.prepare(`UPDATE recently_played SET taste_excluded=1 WHERE user_id=? AND playback_session_id IN
          (SELECT playback_session_id FROM listening_events WHERE user_id=? AND taste_excluded=1)`).run(userId, userId);
      } else this.db.prepare("UPDATE taste_private_periods SET ended_at=? WHERE user_id=? AND ended_at IS NULL").run(now, userId);
      this.db.prepare("UPDATE taste_settings SET private_listening=?,revision=revision+1 WHERE user_id=?").run(Number(enabled), userId);
      return this.state(userId);
    })();
  }
  decision(userId: string, event: { trackId: string; startedAt: string; reportedAt?: string; privateListening?: boolean; excludeFromTaste?: boolean; playlistId?: string | null; track?: { title?: string; artist?: string } }) {
    const state = this.state(userId), at = event.reportedAt ?? new Date(this.now()).toISOString();
    const recordingKey = event.track?.title && event.track.artist ? tasteRecordingKey(event.track.title, event.track.artist) : null;
    const privatePeriod = this.db.prepare("SELECT 1 FROM taste_private_periods WHERE user_id=? AND started_at<=? AND COALESCE(ended_at,'9999')>=? LIMIT 1")
      .get(userId, at, event.startedAt);
    const playlist = event.playlistId ? this.db.prepare(`SELECT exclude_from_taste FROM playlists p WHERE id=@playlistId AND ${playlistReadPredicate()}`)
      .get({ viewer: userId, isAdmin: Number(Boolean(this.db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin'").get(userId))), playlistId: event.playlistId }) as { exclude_from_taste: number } | undefined : undefined;
    const trackExcluded = this.db.prepare("SELECT 1 FROM taste_track_exclusions WHERE user_id=? AND (track_id=? OR recording_key=?) LIMIT 1").get(userId, event.trackId, recordingKey);
    const excluded = Boolean(state.privateListening || event.privateListening || event.excludeFromTaste || privatePeriod || playlist?.exclude_from_taste || trackExcluded ||
      (state.resetBefore && event.startedAt <= state.resetBefore));
    if (excluded) this.stopProviderHistory(userId);
    return { excluded, recordingKey, playlistId: event.playlistId ?? null };
  }
  setPlaylist(user: SessionUser, playlistId: string, excluded: boolean) {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT owner_user_id,deleted_at FROM playlists WHERE id=?").get(playlistId) as { owner_user_id: string | null; deleted_at: string | null } | undefined;
      if (!row || row.deleted_at || !new PlaylistCollaborationService(this.db).access(playlistId, user).canManage) throw new TasteProfileError("Playlist not found or not editable.", 404);
      this.db.prepare("UPDATE playlists SET exclude_from_taste=? WHERE id=?").run(Number(excluded), playlistId);
      if (excluded) {
        this.stopProviderHistory(user.id);
        this.db.prepare("UPDATE listening_events SET taste_excluded=1 WHERE user_id=? AND context_playlist_id=? AND finished=0").run(user.id, playlistId);
        this.db.prepare(`UPDATE recently_played SET taste_excluded=1 WHERE user_id=? AND playback_session_id IN
          (SELECT playback_session_id FROM listening_events WHERE user_id=? AND context_playlist_id=? AND taste_excluded=1)`).run(user.id, user.id, playlistId);
      }
      this.bump(user.id);
    })();
    return { playlistId, excludeFromTaste: excluded };
  }
  setTrack(userId: string, target: TasteTarget, excluded: boolean) {
    const resolved = this.resolve(target), title = resolved.title?.trim(), artist = resolved.artist?.trim();
    if (excluded && (!title || !artist)) throw new TasteProfileError("A song title and artist are needed to exclude this recording.", 400);
    this.db.transaction(() => {
      if (excluded) {
        this.stopProviderHistory(userId);
        this.db.prepare(`INSERT INTO taste_track_exclusions(user_id,track_id,recording_key,title,artist,created_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(user_id,track_id) DO UPDATE SET recording_key=excluded.recording_key,title=excluded.title,artist=excluded.artist`)
          .run(userId, target.id, tasteRecordingKey(title!, artist!), title, artist, new Date(this.now()).toISOString());
      } else {
        const row = this.db.prepare("SELECT recording_key FROM taste_track_exclusions WHERE user_id=? AND track_id=?").get(userId, target.id) as { recording_key: string } | undefined;
        this.db.prepare("DELETE FROM taste_track_exclusions WHERE user_id=? AND (track_id=? OR recording_key=?)").run(userId, target.id, row?.recording_key ?? "");
      }
      this.rebuildActivity(userId); this.bump(userId);
    })();
  }
  reset(userId: string, expectedRevision: number) {
    return this.db.transaction(() => {
      this.revision(userId, expectedRevision); this.stopProviderHistory(userId);
      this.db.prepare("UPDATE taste_settings SET reset_before=?,revision=revision+1 WHERE user_id=?").run(new Date(this.now()).toISOString(), userId);
      this.db.prepare("DELETE FROM smart_playlist_activity WHERE user_id=?").run(userId);
      return this.state(userId);
    })();
  }
  private rebuildActivity(userId: string) {
    this.db.prepare("DELETE FROM smart_playlist_activity WHERE user_id=?").run(userId);
    this.db.prepare(`INSERT INTO smart_playlist_activity(user_id,track_id,plays,skips,last_played)
      SELECT user_id,track_id,COUNT(CASE WHEN event_type IN ('play','complete') THEN 1 END),
        SUM(CASE WHEN event_type='skip' OR(event_type='progress' AND finished=1 AND listened_seconds>0) THEN 1 ELSE 0 END),
        MAX(CAST(ROUND((julianday(created_at)-2440587.5)*86400000) AS INTEGER)) FROM taste_listening_events WHERE user_id=? GROUP BY user_id,track_id`).run(userId);
    this.db.prepare(`INSERT INTO smart_playlist_activity(user_id,track_id,recent_plays,recent_last_played)
      SELECT user_id,track_id,COUNT(*),MAX(CAST(ROUND((julianday(played_at)-2440587.5)*86400000) AS INTEGER)) FROM taste_recently_played WHERE user_id=? GROUP BY user_id,track_id
      ON CONFLICT(user_id,track_id) DO UPDATE SET recent_plays=excluded.recent_plays,recent_last_played=excluded.recent_last_played`).run(userId);
  }
  private loadMetadata() {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='smart_playlist_catalog_state'").get()) return;
    const state = this.db.prepare("SELECT refreshed_at,mix_revision FROM smart_playlist_catalog_state WHERE singleton=1").get() as { refreshed_at: string; mix_revision: number } | undefined;
    const version = state ? `${state.refreshed_at}:${state.mix_revision}` : "empty";
    if (this.metadataVersion === version) return;
    this.metadata.clear();
    for (const row of this.db.prepare("SELECT track_json FROM smart_playlist_track_payloads").iterate() as Iterable<{ track_json: string }>) {
      try {
        const t = JSON.parse(row.track_json); if (!t?.id || typeof t.title !== "string") continue;
        const item = { id: t.id, type: "track" as const, title: t.title, artist: t.artistName, album: t.albumName, artistId: t.artistId, albumId: t.albumId };
        this.metadata.set(`track:${t.id}`, item);
        if (t.artistId) this.metadata.set(`artist:${t.artistId}`, { id: t.artistId, type: "artist", title: t.artistName, artist: t.artistName });
        if (t.albumId) this.metadata.set(`album:${t.albumId}`, { id: t.albumId, type: "album", title: t.albumName, album: t.albumName, artist: t.artistName });
      } catch { /* An unreadable catalog row cannot hide the feedback manager. */ }
    }
    this.metadataVersion = version;
  }
  resolve(target: TasteTarget): TasteTarget {
    this.loadMetadata(); const type = target.type ?? "track", known = this.metadata.get(`${type}:${target.id}`);
    if (known) return { ...known, ...Object.fromEntries(Object.entries(target).filter(([, value]) => value != null && value !== "")) } as TasteTarget;
    if (type === "track" && target.id.startsWith("external_lastfm_") && this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='similar_mix_external_tracks'").get()) {
      const row = this.db.prepare("SELECT title,artist FROM similar_mix_external_tracks WHERE id=?").get(target.id) as { title: string; artist: string } | undefined;
      if (row) return { ...row, ...target, title: target.title || row.title, artist: target.artist || row.artist };
    }
    return target;
  }
  private negativeRows(userId: string) {
    return (this.db.prepare(`SELECT item_type,item_id,action,updated_at,identity_title,identity_artist,identity_album FROM recommendation_feedback
      WHERE user_id=? AND action IN ('hide','not-interested','block-artist','block-album') ORDER BY updated_at DESC,item_type,item_id`).all(userId) as FeedbackRow[])
      .map(row => ({ row, target: this.resolve({ id: row.item_id, type: row.item_type, title: row.identity_title ?? undefined, artist: row.identity_artist ?? undefined, album: row.identity_album ?? undefined }) }));
  }
  private identity(target: TasteTarget) {
    if (target.type === "artist") return normalizeMusicText(target.artist || target.title) || null;
    if (target.type === "album") return target.artist && (target.album || target.title) ? tasteRecordingKey(target.album || target.title!, target.artist) : null;
    return target.title && target.artist ? tasteRecordingKey(target.title, target.artist) : null;
  }
  feedbackFilter(userId: string, catalog: readonly TasteTarget[] = []) {
    const rows = this.negativeRows(userId);
    if (!rows.length) return (_target: TasteTarget) => true;
    const ids = new Set<string>(), tracks = new Set<string>(), artists = new Set<string>(), albums = new Set<string>();
    const supplied = new Map(catalog.map(item => [`${item.type ?? "track"}:${item.id}`, item]));
    for (const { row, target: stored } of rows) {
      const target = { ...supplied.get(`${row.item_type}:${row.item_id}`), ...Object.fromEntries(Object.entries(stored).filter(([, value]) => value != null && value !== "")) } as TasteTarget;
      ids.add(`${row.item_type}:${row.item_id}`);
      const identity = this.identity(target); if (identity) (row.item_type === "artist" ? artists : row.item_type === "album" ? albums : tracks).add(identity);
      if (row.item_type === "artist" && !identity) {
        for (const item of catalog) if (item.artistId === row.item_id && item.artist) artists.add(normalizeMusicText(item.artist));
      }
      if (row.item_type === "album" && !identity) for (const item of catalog) if (item.albumId === row.item_id && item.album && item.artist) albums.add(tasteRecordingKey(item.album, item.artist));
    }
    return (target: TasteTarget) => {
      const type = target.type ?? "track";
      return !ids.has(`${type}:${target.id}`) && !(artists.size && artists.has(normalizeMusicText(target.artist || (type === "artist" ? target.title : "")))) && !(target.artistId && ids.has(`artist:${target.artistId}`)) &&
        !(target.albumId && ids.has(`album:${target.albumId}`)) && !(tracks.size && type === "track" && target.title && target.artist && tracks.has(tasteRecordingKey(target.title, target.artist))) &&
        !(albums.size && type !== "artist" && (target.album || (type === "album" && target.title)) && target.artist && albums.has(tasteRecordingKey(target.album || target.title!, target.artist)));
    };
  }
  hidden(userId: string) {
    const groups = new Map<string, { id: string; type: string; title: string; artist: string; album: string; aliases: number; updatedAt: string }>();
    for (const { row, target } of this.negativeRows(userId)) {
      const key = `${row.item_type}:${this.identity(target) ?? row.item_id}`, previous = groups.get(key);
      if (previous) { previous.aliases++; continue; }
      groups.set(key, { id: row.item_id, type: row.item_type, title: (row.item_type === "artist" ? target.artist || target.title : row.item_type === "album" ? target.album || target.title : target.title) || row.item_id,
        artist: target.artist || "", album: target.album || "", aliases: 1, updatedAt: row.updated_at });
    }
    return [...groups.values()];
  }
  restore(userId: string, type: "track" | "artist" | "album", id: string) {
    this.db.transaction(() => {
      const rows = this.negativeRows(userId), selected = rows.find(item => item.row.item_type === type && item.row.item_id === id);
      if (!selected) throw new TasteProfileError("This item is already restored. Refresh the list.", 404);
      const identity = this.identity(selected.target), remove = this.db.prepare("DELETE FROM recommendation_feedback WHERE user_id=? AND item_type=? AND item_id=? AND action IN ('hide','not-interested','block-artist','block-album')");
      for (const item of rows) if (item.row.item_type === type && (item.row.item_id === id || (identity && this.identity(item.target) === identity))) remove.run(userId, type, item.row.item_id);
    })();
  }
  overview(userId: string) {
    return { ...this.state(userId), hidden: this.hidden(userId), trackExclusions: this.db.prepare("SELECT track_id AS id,title,artist FROM taste_track_exclusions WHERE user_id=? ORDER BY title,track_id").all(userId),
      playlistExclusions: this.db.prepare(`SELECT id,name FROM playlists p WHERE ${playlistReadPredicate()} AND deleted_at IS NULL AND exclude_from_taste=1 ORDER BY name,id`).all({ viewer: userId, isAdmin: 0 }),
      eligibleListens: (this.db.prepare("SELECT COUNT(*) AS n FROM taste_listening_events WHERE user_id=? AND counted=1").get(userId) as { n: number }).n };
  }
}
const managers = new WeakMap<Db, TasteProfileManager>();
export function tasteProfile(db: Db) { let manager = managers.get(db); if (!manager) { manager = new TasteProfileManager(db); managers.set(db, manager); } return manager; }
export function tasteTarget(input: object): TasteTarget {
  const t = input as Record<string, any>, type = ["track", "artist", "album"].includes(t.type) ? t.type : "track";
  return { id: String(t.id), type, title: t.title ?? t.name, artist: t.artistName ?? (typeof t.artist === "string" ? t.artist : type === "artist" ? t.name ?? t.title : undefined),
    album: t.albumName ?? t.album, artistId: t.artistId ?? t.metadata?.artistId, albumId: t.albumId ?? t.metadata?.albumId };
}
