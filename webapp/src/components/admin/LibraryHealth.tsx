import { useCallback, useEffect, useRef, useState } from "react";

import {
  getAdminHealthScan,
  pruneOrphanedTracks,
  rescanLibraryArtwork,
  startAdminHealthScan,
} from "../../api/musicdeck";

type ScanState = "idle" | "running" | "completed" | "failed";
type ScanPhase = "listing" | "catalog" | "records" | "pruning";

type HealthIssue = {
  type: string;
  itemType: "track" | "album" | "artist";
  itemId: string;
  title: string;
  detail: string;
};

type HealthSummary = {
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

type PruneResult = {
  prunedTracks: number;
  keptInPlaylists: number;
  removedFavorites: number;
  removedRatings: number;
  skippedReason: string | null;
};

export type HealthScanStatus = {
  id: string | null;
  state: ScanState;
  phase: ScanPhase | null;
  processed: number;
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  warnings: string[];
  staleReason: string | null;
  report: null | {
    completedAt: string;
    degraded: boolean;
    summary: HealthSummary;
    issues: HealthIssue[];
    issueTotal: number;
    prune: PruneResult | null;
  };
};

type ScanResponse = { started?: boolean; alreadyRunning?: boolean; status?: HealthScanStatus };

const POLL_MS = 1000;
const POLL_MAX_MS = 10000;

const PHASE_LABELS: Record<ScanPhase, string> = {
  listing: "Reading the library from your media servers…",
  catalog: "Checking artwork, metadata and album sync…",
  records: "Looking for orphaned MusicDeck records…",
  pruning: "Pruning orphaned records…",
};

const ISSUE_LABELS: Record<string, string> = {
  "missing-artwork": "Missing artwork",
  "missing-metadata": "Missing metadata",
  "missing-artist": "Missing artist",
  "missing-album": "Missing album",
  "duplicate-track": "Duplicate",
  "duplicate-album": "Duplicate",
  unavailable: "Unavailable",
  "incomplete-album": "Incomplete album",
  "album-not-listed": "Sync mismatch",
  "orphaned-track": "Orphaned record",
};

const SUMMARY_CARDS: Array<[keyof HealthSummary, string]> = [
  ["tracks", "Tracks"],
  ["albums", "Albums"],
  ["artists", "Artists"],
  ["missingArtwork", "Missing artwork"],
  ["metadataIssues", "Metadata issues"],
  ["duplicates", "Possible duplicates"],
  ["unavailable", "Unavailable"],
  ["syncMismatches", "Sync mismatches"],
  ["orphanedTracks", "Orphaned track records"],
  ["danglingReferences", "Unlinked favorites & ratings"],
];

const messageOf = (error: unknown, fallback: string) => {
  if (error instanceof TypeError) return "Can't reach MusicDeck. Check your connection and try again.";
  return error instanceof Error && error.message ? error.message : fallback;
};

function formatTime(iso: string | null | undefined) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function pruneSummary(prune: PruneResult) {
  if (prune.skippedReason) return prune.skippedReason;
  const parts = [`Removed ${prune.prunedTracks} orphaned track record${prune.prunedTracks === 1 ? "" : "s"}`];
  if (prune.removedFavorites || prune.removedRatings) {
    parts.push(`${prune.removedFavorites} favorite${prune.removedFavorites === 1 ? "" : "s"} and ${prune.removedRatings} rating${prune.removedRatings === 1 ? "" : "s"} that pointed to them`);
  }
  const kept = prune.keptInPlaylists
    ? ` Kept ${prune.keptInPlaylists} record${prune.keptInPlaylists === 1 ? "" : "s"} still used by playlists.`
    : "";
  return `${parts.join(", plus ")}.${kept}`;
}

/**
 * Admin Library Health dashboard. The server runs the check in the
 * background; this view polls its status while it runs (backing off on
 * connection errors) and exposes the repair actions the report supports.
 */
export default function LibraryHealth() {
  const [status, setStatus] = useState<HealthScanStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pollWarning, setPollWarning] = useState<string | null>(null);
  const [pending, setPending] = useState<"scan" | "artwork" | "prune" | null>(null);
  const [confirmingPrune, setConfirmingPrune] = useState(false);
  const mounted = useRef(true);
  const autoStarted = useRef(false);
  const lastPruneScan = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applyResponse = useCallback((response: ScanResponse | null | undefined) => {
    if (mounted.current && response?.status) setStatus(response.status);
  }, []);

  const startScan = useCallback(async () => {
    setPending("scan");
    setActionError(null);
    setNotice(null);
    try {
      const response = (await startAdminHealthScan()) as ScanResponse;
      applyResponse(response);
      if (mounted.current && response?.alreadyRunning) setNotice("A health check is already running.");
    } catch (error) {
      if (mounted.current) setActionError(messageOf(error, "Couldn't start the health check."));
    } finally {
      if (mounted.current) setPending(null);
    }
  }, [applyResponse]);

  // Initial load. A server that never ran a check starts one automatically.
  useEffect(() => {
    let cancelled = false;
    getAdminHealthScan().then(
      (next: HealthScanStatus) => {
        if (cancelled) return;
        setStatus(next);
        setLoadError(null);
        // Don't re-announce a prune that finished before this visit.
        lastPruneScan.current = next?.id ?? null;
        if (next?.state === "idle" && !next.report && !autoStarted.current) {
          autoStarted.current = true;
          void startScan();
        }
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(messageOf(error, "Couldn't load library health."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [startScan]);

  const running = status?.state === "running";
  const scanId = status?.id ?? null;

  // Poll only while a check runs; back off when the connection drops.
  useEffect(() => {
    if (!running) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_MS;
    const tick = () => {
      getAdminHealthScan().then(
        (next: HealthScanStatus) => {
          if (cancelled) return;
          delay = POLL_MS;
          setPollWarning(null);
          setStatus(next);
          if (next?.state === "running") timer = setTimeout(tick, delay);
        },
        (error: unknown) => {
          if (cancelled) return;
          delay = Math.min(POLL_MAX_MS, delay * 2);
          setPollWarning(`${messageOf(error, "Lost contact with the server.")} The check continues on the server; retrying…`);
          timer = setTimeout(tick, delay);
        },
      );
    };
    timer = setTimeout(tick, delay);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [running, scanId]);

  // Announce the prune outcome once the pruning check finishes.
  useEffect(() => {
    const prune = status?.report?.prune;
    if (status?.state !== "completed" || !prune || !status.id || lastPruneScan.current === status.id) return;
    lastPruneScan.current = status.id;
    setNotice(pruneSummary(prune));
  }, [status]);

  async function handleArtwork() {
    setPending("artwork");
    setActionError(null);
    setNotice(null);
    try {
      const response = (await rescanLibraryArtwork()) as ScanResponse;
      applyResponse(response);
      if (mounted.current) {
        setNotice(response?.alreadyRunning
          ? "A media server scan is already running. Run the health check again once it finishes."
          : "Media server rescan started. Artwork is re-read from your files; run the health check again once the scan finishes.");
      }
    } catch (error) {
      if (mounted.current) setActionError(messageOf(error, "Couldn't start the artwork rescan."));
    } finally {
      if (mounted.current) setPending(null);
    }
  }

  async function handlePrune() {
    setConfirmingPrune(false);
    setPending("prune");
    setActionError(null);
    setNotice(null);
    try {
      applyResponse((await pruneOrphanedTracks()) as ScanResponse);
    } catch (error) {
      if (mounted.current) setActionError(messageOf(error, "Couldn't prune orphaned tracks."));
    } finally {
      if (mounted.current) setPending(null);
    }
  }

  if (!status) {
    return loadError
      ? <div className="admin-section">
          <div className="error" role="alert">{loadError}</div>
        </div>
      : <div className="loading" role="status">Loading library health…</div>;
  }

  const report = status.report;
  const summary = report?.summary;
  const percent = status.total > 0 ? Math.min(100, Math.round((status.processed / status.total) * 100)) : 0;
  const orphanCount = summary?.orphanedTracks ?? 0;
  const busy = running || pending !== null;
  const canPrune = Boolean(report) && orphanCount > 0 && !report?.degraded && !busy;
  const completedAt = formatTime(report?.completedAt);

  return <div className="library-health-admin">
    <section className="admin-section" aria-labelledby="library-health-scan-heading">
      <h2 id="library-health-scan-heading">Library health check</h2>
      <p className="account-meta">
        Checks artwork, metadata, album sync with your media servers and MusicDeck records that no longer point at a file.
        {completedAt && !running ? ` Last completed ${completedAt}.` : ""}
      </p>

      <div className="admin-actions">
        <button type="button" className="account-primary" onClick={() => { void startScan(); }} disabled={busy}>
          {running ? "Checking…" : pending === "scan" ? "Starting…" : "Run health check"}
        </button>
      </div>

      {running && <div className="library-health-progress">
        <div
          className="library-health-progress__track"
          role="progressbar"
          aria-label="Health check progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${percent}% · ${status.phase ? PHASE_LABELS[status.phase] : "Working…"}`}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        <p className="account-meta" role="status" aria-live="polite">
          {status.phase ? PHASE_LABELS[status.phase] : "Working…"} {percent}%
        </p>
      </div>}

      {pollWarning && <div className="library-health-warning" role="status">{pollWarning}</div>}
      {status.state === "failed" && status.error && <div className="error" role="alert">{status.error}</div>}
      {actionError && <div className="error" role="alert">{actionError}</div>}
      {notice && <div className="success" role="status">{notice}</div>}
      {status.staleReason && <div className="library-health-warning" role="status">{status.staleReason}</div>}
      {status.warnings.map((warning) => <div key={warning} className="library-health-warning">{warning}</div>)}
    </section>

    {summary && <section className="admin-section" aria-labelledby="library-health-summary-heading">
      <h2 id="library-health-summary-heading">Summary</h2>
      <div className="admin-grid">
        {SUMMARY_CARDS.map(([key, label]) => <div className={`admin-card${summary[key] > 0 && key !== "tracks" && key !== "albums" && key !== "artists" ? " has-issues" : ""}`} key={key}>
          <span>{label}</span>
          <strong>{summary[key]}</strong>
        </div>)}
      </div>
    </section>}

    {report && <section className="admin-section" aria-labelledby="library-health-repair-heading">
      <h2 id="library-health-repair-heading">Repairs</h2>
      <div className="library-health-repair">
        <div>
          <strong>Re-scan Artwork</strong>
          <p className="account-meta">Asks your media server to rescan so new or fixed cover art is picked up. {summary?.missingArtwork ?? 0} item(s) currently lack artwork.</p>
        </div>
        <button type="button" className="library-health-action" onClick={() => { void handleArtwork(); }} disabled={busy}>
          {pending === "artwork" ? "Requesting…" : "Re-scan Artwork"}
        </button>
      </div>
      <div className="library-health-repair">
        <div>
          <strong>Prune Orphaned Tracks</strong>
          <p className="account-meta">
            Removes MusicDeck records (and their favorites and ratings) for tracks your media server no longer lists.
            Files on the media server are never deleted, and records still used by playlists are kept.
            {report.degraded ? " Unavailable until every media server responds to a health check." : ""}
          </p>
        </div>
        {!confirmingPrune
          ? <button type="button" className="library-health-action library-health-action--danger" onClick={() => setConfirmingPrune(true)} disabled={!canPrune}>
              {pending === "prune" ? "Pruning…" : `Prune Orphaned Tracks (${orphanCount})`}
            </button>
          : <div className="library-health-confirm" role="group" aria-label="Confirm pruning">
              <span>Prune {orphanCount} record{orphanCount === 1 ? "" : "s"}?</span>
              <button type="button" className="library-health-action library-health-action--danger" onClick={() => { void handlePrune(); }} disabled={busy}>Confirm prune</button>
              <button type="button" className="library-health-action" onClick={() => setConfirmingPrune(false)}>Cancel</button>
            </div>}
      </div>
    </section>}

    {report && <section className="admin-section" aria-labelledby="library-health-issues-heading">
      <h2 id="library-health-issues-heading">Issues</h2>
      {report.issues.length === 0
        ? <div className="library-empty">No library issues detected.</div>
        : <>
            {report.issueTotal > report.issues.length && <p className="account-meta">Showing {report.issues.length} of {report.issueTotal} issues.</p>}
            <div className="admin-table" role="table" aria-label="Library issues">
              {report.issues.map((issue) => <div className="admin-row" key={`${issue.type}:${issue.itemType}:${issue.itemId}`} role="row">
                <div role="cell">
                  <strong>{issue.title}</strong>
                  <span>{issue.detail}</span>
                </div>
                <span className="admin-provider-kind" role="cell">{ISSUE_LABELS[issue.type] || issue.type}</span>
              </div>)}
            </div>
          </>}
    </section>}
  </div>;
}
