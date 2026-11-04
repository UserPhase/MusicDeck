import type { Db } from "../../db/database.js";
import type { CatalogService } from "../../domain/catalog.js";
import {
  LibraryHealthAuditCancelled,
  auditCatalog,
  catalogAuditWork,
  countIssues,
  yieldToEventLoop,
  type LibraryHealthIssue,
} from "../../domain/library-health.js";
import { createId } from "../../utils/ids.js";

export type LibraryHealthScanState = "idle" | "running" | "completed" | "failed";
export type LibraryHealthScanPhase = "listing" | "catalog" | "records" | "pruning";

export type LibraryHealthPruneResult = {
  prunedTracks: number;
  keptInPlaylists: number;
  removedFavorites: number;
  removedRatings: number;
  skippedReason: string | null;
};

export type LibraryHealthReport = {
  completedAt: string;
  degraded: boolean;
  summary: {
    albums: number;
    tracks: number;
    artists: number;
    trackRecords: number;
    missingArtwork: number;
    metadataIssues: number;
    duplicates: number;
    unavailable: number;
    incompleteAlbums: number;
    syncMismatches: number;
    orphanedTracks: number;
    danglingReferences: number;
  };
  issues: LibraryHealthIssue[];
  issueTotal: number;
  prune: LibraryHealthPruneResult | null;
};

export type LibraryHealthScanStatus = {
  id: string | null;
  state: LibraryHealthScanState;
  phase: LibraryHealthScanPhase | null;
  processed: number;
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  warnings: string[];
  /** Set when a repair changed the library after the report was produced. */
  staleReason: string | null;
  report: LibraryHealthReport | null;
};

export type LibraryRescanTrigger = () => { started: boolean };

export class LibraryHealthScanBusy extends Error {
  constructor() {
    super("A library health check is already running. Wait for it to finish first.");
  }
}

const ISSUE_LIMIT = 500;
const YIELD_EVERY = 500;
const DANGLING_TYPES = ["track", "album", "artist"] as const;

type Options = {
  /** Triggers a provider rescan (the media server re-reads files and artwork). */
  requestRescan: LibraryRescanTrigger;
  logger?: { error: (details: Record<string, unknown>, message: string) => void };
};

type ScanRun = {
  id: string;
  prune: boolean;
  status: LibraryHealthScanStatus;
};

/**
 * Runs the admin library health check off the request path: routes return
 * immediately and clients poll {@link status} for progress. Only one check
 * runs at a time, and it yields between batches so large libraries never
 * monopolize the event loop.
 */
export class LibraryHealthScanService {
  private current: LibraryHealthScanStatus = idleStatus();
  private worker: Promise<void> | null = null;
  private closing = false;

  constructor(
    private readonly db: Db,
    private readonly catalog: CatalogService,
    private readonly options: Options,
  ) {}

  status(): LibraryHealthScanStatus {
    return { ...this.current, warnings: [...this.current.warnings] };
  }

  /** Starts a check, or reports the one already running. */
  start(): { started: boolean; status: LibraryHealthScanStatus } {
    if (this.worker) return { started: false, status: this.status() };
    this.launch(false);
    return { started: true, status: this.status() };
  }

  /**
   * Re-lists the library and prunes the orphaned track records that the fresh
   * listing proves are gone. Only MusicDeck's own records are touched; media
   * files on Navidrome/Jellyfin are never deleted.
   */
  startPrune(): LibraryHealthScanStatus {
    if (this.worker) throw new LibraryHealthScanBusy();
    this.launch(true);
    return this.status();
  }

  /** Asks the media server to rescan; the current report becomes stale. */
  requestArtworkRescan(): { started: boolean; status: LibraryHealthScanStatus } {
    const { started } = this.options.requestRescan();
    if (this.current.report) {
      this.current = {
        ...this.current,
        staleReason: "A media server rescan was requested. Run the health check again once it finishes.",
      };
    }
    return { started, status: this.status() };
  }

  async close() {
    this.closing = true;
    await this.worker;
  }

  private launch(prune: boolean) {
    const id = createId("health");
    const run: ScanRun = {
      id,
      prune,
      status: {
        ...idleStatus(),
        id,
        state: "running",
        phase: "listing",
        startedAt: new Date().toISOString(),
        // The previous report stays visible while the new check runs.
        report: this.current.report,
        staleReason: this.current.staleReason,
      },
    };
    this.current = run.status;
    this.worker = this.execute(run)
      .catch((error: unknown) => {
        const cancelled = error instanceof LibraryHealthAuditCancelled;
        if (!cancelled) this.options.logger?.error({ err: error }, "Library health check failed");
        this.update(run, {
          state: "failed",
          phase: null,
          finishedAt: new Date().toISOString(),
          error: cancelled
            ? "The health check stopped because the server is shutting down."
            : `The health check could not finish: ${error instanceof Error ? error.message : "unknown error"}. Check the media server connection and try again.`,
        });
      })
      .finally(() => {
        this.worker = null;
      });
  }

  private update(run: ScanRun, patch: Partial<LibraryHealthScanStatus>) {
    run.status = { ...run.status, ...patch };
    if (this.current.id === run.id) this.current = run.status;
  }

  private checkCancelled() {
    if (this.closing) throw new LibraryHealthAuditCancelled();
  }

  private async execute(run: ScanRun) {
    await yieldToEventLoop();
    this.checkCancelled();

    const snapshot = await this.catalog.auditSnapshot();
    this.checkCancelled();
    const tracks = snapshot.tracks.items;
    const albums = snapshot.albums.items;
    const degraded = snapshot.tracks.degraded || snapshot.albums.degraded || snapshot.artists.degraded;
    const warnings: string[] = [];
    if (degraded) {
      warnings.push("Some media servers did not respond. Their records were not checked for orphans.");
    }
    if (!snapshot.albumsComplete) {
      warnings.push("The full album list was unavailable, so missing-album checks were skipped.");
    }

    const trackRecordCount = (this.db
      .prepare("SELECT COUNT(*) AS count FROM library_items WHERE type = 'track'")
      .get() as { count: number }).count;
    const catalogWork = catalogAuditWork(tracks.length, albums.length);
    this.update(run, { phase: "catalog", processed: 0, total: catalogWork + trackRecordCount, warnings });

    const catalogIssues = await auditCatalog(tracks, albums, {
      yieldEvery: YIELD_EVERY,
      albumsComplete: snapshot.albumsComplete,
      isCancelled: () => this.closing,
      onProgress: (processed) => this.update(run, { processed }),
    });

    this.update(run, { phase: "records", processed: catalogWork });
    let orphans = await this.findOrphanedTracks(
      run,
      new Set(tracks.map((track) => track.id)),
      new Set(snapshot.listedConnectionIds),
      catalogWork,
    );

    let prune: LibraryHealthPruneResult | null = null;
    if (run.prune) {
      this.update(run, { phase: "pruning" });
      if (degraded) {
        prune = { ...emptyPrune(), skippedReason: "Pruning was skipped because a media server did not respond. Nothing was removed." };
      } else {
        const result = this.pruneTracks(orphans);
        prune = result.summary;
        orphans = result.kept;
      }
    }

    const issues = catalogIssues.concat(orphans.slice(0, ISSUE_LIMIT).map((id) => ({
      type: "orphaned-track" as const,
      itemType: "track" as const,
      itemId: id,
      title: "Unknown track",
      detail: "MusicDeck still has a record for this track, but the media server no longer lists it",
    })));
    const counts = countIssues(catalogIssues);
    const finishedAt = new Date().toISOString();

    this.update(run, {
      state: "completed",
      phase: null,
      processed: run.status.total,
      finishedAt,
      staleReason: null,
      report: {
        completedAt: finishedAt,
        degraded,
        summary: {
          albums: albums.length,
          tracks: tracks.length,
          artists: snapshot.artists.items.length,
          trackRecords: trackRecordCount - (prune?.prunedTracks ?? 0),
          missingArtwork: counts.missingArtwork,
          metadataIssues: counts.metadataIssues,
          duplicates: counts.duplicates,
          unavailable: counts.unavailable,
          incompleteAlbums: counts.incompleteAlbums,
          syncMismatches: counts.syncMismatches,
          orphanedTracks: orphans.length,
          danglingReferences: this.countDanglingReferences(),
        },
        issues: issues.slice(0, ISSUE_LIMIT),
        issueTotal: catalogIssues.length + orphans.length,
        prune,
      },
    });
  }

  /**
   * A record is orphaned when every connection that sources it listed its
   * tracks successfully and none returned it. Records tied to a connection
   * that failed to list are never judged.
   */
  private async findOrphanedTracks(run: ScanRun, listed: Set<string>, listedConnections: Set<string>, offset: number) {
    if (!listedConnections.size) return [];
    const rows = this.db.prepare(`
      SELECT i.id AS id, s.connection_id AS connection_id
      FROM library_items i
      LEFT JOIN library_item_sources s ON s.library_item_id = i.id AND s.item_type = 'track'
      WHERE i.type = 'track'
    `).all() as Array<{ id: string; connection_id: string | null }>;

    const judged = new Map<string, boolean>();
    let processed = 0;
    for (const row of rows) {
      if (!listed.has(row.id)) {
        const verifiable = row.connection_id === null || listedConnections.has(row.connection_id);
        judged.set(row.id, (judged.get(row.id) ?? true) && verifiable);
      }
      processed += 1;
      if (processed % YIELD_EVERY === 0) {
        this.update(run, { processed: offset + Math.min(processed, run.status.total - offset) });
        await yieldToEventLoop();
        this.checkCancelled();
      }
    }
    return [...judged].filter(([, verifiable]) => verifiable).map(([id]) => id);
  }

  private pruneTracks(orphans: string[]): { summary: LibraryHealthPruneResult; kept: string[] } {
    const summary = emptyPrune();
    const kept: string[] = [];
    if (!orphans.length) return { summary, kept };

    const inPlaylist = this.db.prepare("SELECT 1 FROM playlist_items WHERE library_track_id = ? LIMIT 1");
    const deleteFavorites = this.db.prepare("DELETE FROM favorites WHERE track_id = ?");
    const deleteMediaFavorites = this.db.prepare("DELETE FROM media_favorites WHERE item_type = 'track' AND item_id = ?");
    const deleteRatings = this.db.prepare("DELETE FROM media_ratings WHERE item_type = 'track' AND item_id = ?");
    const deleteItem = this.db.prepare("DELETE FROM library_items WHERE id = ? AND type = 'track'");

    this.db.transaction(() => {
      for (const id of orphans) {
        // Playlist entries cascade from library_items, so keep those records.
        if (inPlaylist.get(id)) {
          summary.keptInPlaylists += 1;
          kept.push(id);
          continue;
        }
        summary.removedFavorites += deleteFavorites.run(id).changes + deleteMediaFavorites.run(id).changes;
        summary.removedRatings += deleteRatings.run(id).changes;
        summary.prunedTracks += deleteItem.run(id).changes;
      }
    })();
    return { summary, kept };
  }

  /** Favorites and ratings that point at IDs MusicDeck no longer knows. */
  private countDanglingReferences() {
    const placeholders = DANGLING_TYPES.map(() => "?").join(", ");
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM favorites f
          WHERE NOT EXISTS (SELECT 1 FROM library_items i WHERE i.id = f.track_id)) +
        (SELECT COUNT(*) FROM media_favorites m WHERE m.item_type IN (${placeholders})
          AND NOT EXISTS (SELECT 1 FROM library_items i WHERE i.id = m.item_id)) +
        (SELECT COUNT(*) FROM media_ratings r WHERE r.item_type IN (${placeholders})
          AND NOT EXISTS (SELECT 1 FROM library_items i WHERE i.id = r.item_id)) AS count
    `).get(...DANGLING_TYPES, ...DANGLING_TYPES) as { count: number };
    return row.count;
  }
}

function idleStatus(): LibraryHealthScanStatus {
  return {
    id: null,
    state: "idle",
    phase: null,
    processed: 0,
    total: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
    warnings: [],
    staleReason: null,
    report: null,
  };
}

function emptyPrune(): LibraryHealthPruneResult {
  return { prunedTracks: 0, keptInPlaylists: 0, removedFavorites: 0, removedRatings: 0, skippedReason: null };
}
