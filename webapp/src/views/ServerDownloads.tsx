import { useEffect, useState } from "react";
import { getAcquisitions } from "../api/musicdeck";
import { formatStorageSize } from "../utils/browserCache";

const statusLabels = {
  queued: "Queued", discovering: "Finding a source", downloading: "Downloading",
  processing: "Processing", importing: "Importing", completed: "Completed", failed: "Failed", cancelled: "Cancelled",
} as const;

type ServerJob = {
  id: string;
  status: keyof typeof statusLabels;
  requestedTitle?: string;
  requestedArtist?: string;
  requestedAlbumId?: string;
  files?: { title?: string; artist?: string }[];
  errorMessage?: string;
  progress?: { percent?: number; bytesDownloaded?: number; totalBytes?: number; speedBytesPerSecond?: number };
};

const isActive = ({ status }: ServerJob) => status !== "completed" && status !== "failed" && status !== "cancelled";

function ServerDownloadRow({ job }: { job: ServerJob }) {
  const title = job.requestedTitle || job.files?.[0]?.title || (job.requestedAlbumId ? "Album download" : "Server download");
  const artist = job.requestedArtist || job.files?.[0]?.artist;
  const progress = job.progress;
  const received = progress?.bytesDownloaded ?? 0;
  const total = progress?.totalBytes ?? 0;
  const percent = progress?.percent ?? (total > 0 ? received / total * 100 : undefined);
  const value = typeof percent === "number" && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : undefined;
  return <li className="server-download-row">
    <div className="server-download-heading"><strong>{title}</strong><span>{statusLabels[job.status]}</span></div>
    {artist && <p>{artist}</p>}
    {job.status === "downloading" && <>
      <progress max={100} value={value} aria-label={`${title} download progress`} />
      <p className="server-download-transfer">
        {value !== undefined && <span>{Math.round(value)}%</span>}
        {(received > 0 || total > 0) && <span>{formatStorageSize(received)}{total > 0 && ` / ${formatStorageSize(total)}`}</span>}
        {Boolean(progress?.speedBytesPerSecond) && <span>{formatStorageSize(progress?.speedBytesPerSecond)}/s</span>}
      </p>
    </>}
    {job.status === "failed" && job.errorMessage && <p className="downloads-error">{job.errorMessage}</p>}
  </li>;
}

export default function ServerDownloads({ online }: { online: boolean }) {
  const [jobs, setJobs] = useState<ServerJob[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!online) return;
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
  }, [online]);

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
      {[...active, ...recent].map((job) => <ServerDownloadRow key={job.id} job={job} />)}
    </ul>}
  </section>;
}
