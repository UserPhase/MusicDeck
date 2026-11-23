import { useEffect, useState } from "react";
import { useVisualActivity } from "../hooks/useVisualActivity";
import { cancelAcquisition, getAcquisitions, retryAcquisition } from "../api/musicdeck";
import { downloadPhaseLabels } from "../services/downloadStatus";
import { formatStorageSize } from "../utils/browserCache";

const statusLabels = {
  queued: "Queued", discovering: "Finding a source", downloading: "Downloading",
  processing: "Processing", importing: "Importing", completed: "Completed", partial: "Partially imported", failed: "Failed", cancelled: "Cancelled",
} as const;

type ServerJob = {
  id: string;
  status: keyof typeof statusLabels;
  sourceProvider?: string;
  stage?: string;
  downloadedCount?: number;
  importedCount?: number;
  expectedCount?: number;
  trackErrors?: { position: number; title?: string; message: string }[];
  requestedTitle?: string;
  requestedArtist?: string;
  requestedAlbumId?: string;
  files?: { title?: string; artist?: string }[];
  errorMessage?: string;
  progress?: { percent?: number; bytesDownloaded?: number; totalBytes?: number; speedBytesPerSecond?: number };
};

const isActive = ({ status }: ServerJob) => ["queued", "discovering", "downloading", "processing", "importing"].includes(status);
const phaseLabels: Record<string, string> = downloadPhaseLabels;

function ServerDownloadRow({ job, online, onUpdate }: { job: ServerJob; online: boolean; onUpdate: (job: ServerJob) => void }) {
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const title = job.requestedTitle || job.files?.[0]?.title || (job.requestedAlbumId ? "Album download" : "Server download");
  const artist = job.requestedArtist || job.files?.[0]?.artist;
  const downloader = job.sourceProvider === "deezer-ytdlp" ? "Deezer / yt-dlp" : job.sourceProvider === "spotdl" ? "spotDL" : undefined;
  const progress = job.progress;
  const received = progress?.bytesDownloaded ?? 0;
  const total = progress?.totalBytes ?? 0;
  const percent = progress?.percent ?? (total > 0 ? received / total * 100 : undefined);
  const value = typeof percent === "number" && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : undefined;
  const active = isActive(job);
  const canRetry = ["failed", "partial", "cancelled"].includes(job.status);
  const waiting = job.stage === "provider_cooldown" || job.stage === "retry_wait";
  async function updateJob() {
    setPending(true);
    setActionError("");
    try {
      const response = await (active ? cancelAcquisition(job.id) : retryAcquisition(job.id));
      if (!response?.job) throw new Error("The server did not confirm the update. Check the download status before trying again.");
      onUpdate(response.job);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update the download. Try again.");
    } finally {
      setPending(false);
    }
  }

  return <li className="server-download-row">
    <div className="server-download-heading"><strong>{title}</strong><span>{(active && phaseLabels[job.stage ?? ""]) || statusLabels[job.status]}</span></div>
    {artist && <p>{artist}</p>}
    {downloader && job.status !== "queued" && <p>{downloader}</p>}
    {(job.status === "completed" || job.status === "partial") && Boolean(job.importedCount) &&
      <p>{job.importedCount} {job.importedCount === 1 ? "track" : "tracks"} indexed in the library</p>}
    {job.status === "downloading" && !waiting && <>
      <progress max={100} value={value} aria-label={`${title} download progress`} />
      <p className="server-download-transfer">
        {value !== undefined && <span>{Math.round(value)}%</span>}
        {(received > 0 || total > 0) && <span>{formatStorageSize(received)}{total > 0 && ` / ${formatStorageSize(total)}`}</span>}
        {Boolean(progress?.speedBytesPerSecond) && <span>{formatStorageSize(progress?.speedBytesPerSecond)}/s</span>}
      </p>
    </>}
    {Boolean(job.expectedCount) && active && typeof job.downloadedCount === "number" && <p>{job.downloadedCount} / {job.expectedCount} tracks downloaded</p>}
    {(job.status === "failed" || job.status === "partial") && job.errorMessage && <p className="downloads-error">{job.errorMessage}</p>}
    {Boolean(job.trackErrors?.length) && <details>
      <summary>Track errors ({job.trackErrors?.length})</summary>
      <ul>{job.trackErrors?.map(({ position, title, message }) => <li key={position}>{title || `Track ${position}`} · {message}</li>)}</ul>
    </details>}
    {(active || canRetry) && <button type="button" disabled={pending || !online} onClick={updateJob}
      aria-label={`${active ? "Cancel" : "Retry"} download for ${title}`}>
      {active ? pending ? "Cancelling…" : "Cancel download" : pending ? "Retrying…" : "Retry download"}
    </button>}
    {actionError && <p className="downloads-error" role="alert">{actionError}</p>}
  </li>;
}

export default function ServerDownloads({ online }: { online: boolean }) {
  const [jobs, setJobs] = useState<ServerJob[] | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const visualActive = useVisualActivity();

  useEffect(() => {
    if (!online || !visualActive) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      let delay = 8000;
      try {
        const next: ServerJob[] = await getAcquisitions({ ownOnly: true, signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!Array.isArray(next)) throw new Error("Invalid server download list");
        setJobs(next);
        setError(false);
        if (next.some(isActive)) delay = 2000;
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, delay);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [online, revision, visualActive]);

  function updateJob(job: ServerJob) {
    setJobs((current) => current?.map((item) => item.id === job.id ? job : item) ?? [job]);
    setRevision((value) => value + 1);
  }

  const active = jobs?.filter(isActive) ?? [];
  const recent = jobs?.filter((job) => !isActive(job)).slice(0, 5) ?? [];
  return <section className="server-downloads" aria-labelledby="server-downloads-title">
    <header className="server-download-heading">
      <h2 id="server-downloads-title">Server downloads</h2>
      {jobs && <span>{active.length} active</span>}
    </header>
    <p>Follow imports into your server’s music library here.</p>
    {!online && <p role="status">Reconnect to see current server progress.</p>}
    {online && error && <p role="status">Couldn’t refresh server downloads. Retrying…</p>}
    {online && !jobs && !error && <p role="status">Checking server downloads…</p>}
    {jobs && !jobs.length && <p>No server downloads yet.</p>}
    {(active.length > 0 || recent.length > 0) && <ul className="server-download-list">
      {[...active, ...recent].map((job) => <ServerDownloadRow key={job.id} job={job} online={online} onUpdate={updateJob} />)}
    </ul>}
  </section>;
}
