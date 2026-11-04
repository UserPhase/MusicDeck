import { useCallback, useEffect, useRef, useState } from "react";
import { downloadUserData, getDataExportSummary } from "../../api/musicdeck";
import "../../styles/data-export.css";

interface ExportSummary {
  playlists: { id: string; name: string; tracks: number; estimatedBytes: { m3u8: number; xspf: number } }[];
  counts: { playlists: number; playlistTracks: number; history: number; favorites: number; feedback: number; ratings: number; settings: number; smartPlaylists: number; savedDiscoveries: number };
  estimatedBytes: { history: number; favorites: number; settings: number; json: number; zip: number };
  notes: string[];
}
type ExportKind = "playlists" | "history" | "favorites" | "settings" | "bundle";
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DataExportPanel() {
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [playlistId, setPlaylistId] = useState("");
  const [playlistFormat, setPlaylistFormat] = useState<"m3u8" | "xspf">("m3u8");
  const [bundleFormat, setBundleFormat] = useState<"zip" | "json">("zip");
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const result: ExportSummary = await getDataExportSummary(controller.signal);
      if (mounted.current && !controller.signal.aborted) {
        setSummary(result);
        setPlaylistId((current) => result.playlists.some((item) => item.id === current) ? current : "");
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        console.error("Could not load data export estimates:", failure);
        if (mounted.current) setError(failure instanceof Error ? failure.message : "Could not load export details.");
      }
    } finally {
      if (mounted.current && !controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; request.current?.abort(); };
  }, [load]);

  async function download(kind: ExportKind, format: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(kind); setError(""); setMessage("");
    const controller = new AbortController();
    request.current = controller;
    try {
      // Recheck authentication/connectivity before handing large transfers to the
      // browser download manager. Never fetch the archive into a Blob in memory.
      const current: ExportSummary = await getDataExportSummary(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setSummary(current);
      if (kind === "playlists" && playlistId && !current.playlists.some((item) => item.id === playlistId)) {
        throw new Error("This playlist is no longer available. Refresh and choose another playlist.");
      }
      downloadUserData(kind, format, kind === "playlists" ? playlistId || undefined : undefined);
      setMessage("Download requested. Check your browser downloads for progress and any transfer errors.");
    } catch (failure) {
      if (!controller.signal.aborted) {
        console.error("Could not start user data export:", failure);
        if (mounted.current) setError(failure instanceof Error ? failure.message : "Could not start the download.");
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  const selectedPlaylist = summary?.playlists.find((item) => item.id === playlistId);
  const playlistBytes = selectedPlaylist?.estimatedBytes[playlistFormat]
    ?? summary?.playlists.reduce((sum, item) => sum + item.estimatedBytes[playlistFormat], 0) ?? 0;
  const disabled = loading || Boolean(busy) || !summary;
  const metric = (count: number, bytes: number, label = "records") =>
    <p className="data-export-metric"><strong>{count.toLocaleString()}</strong> {label}<span>~{size(bytes)}</span></p>;
  const button = (kind: ExportKind, format: string, label: string, empty = false) =>
    <button type="button" className="settings-storage-refresh data-export-download" disabled={disabled || empty}
      onClick={() => { void download(kind, format); }}>{busy === kind ? "Preparing download..." : label}</button>;

  return <section className="settings-section data-export-panel" aria-labelledby="data-export-title" aria-busy={loading || Boolean(busy)}>
    <div className="data-export-heading">
      <div><span className="data-export-eyebrow">PORTABLE BY DESIGN</span><h2 id="data-export-title">Your data, on your terms</h2>
        <p>Open formats for another player, a fresh start, or a copy you control.</p></div>
      <button type="button" className="settings-storage-refresh" disabled={loading || Boolean(busy)} onClick={() => { void load(); }}>Refresh counts</button>
    </div>
    {loading && <p role="status">Counting your saved data...</p>}
    {error && <div className="data-export-error" role="alert"><span>{error}</span>
      <button type="button" className="settings-storage-refresh" disabled={loading || Boolean(busy)} onClick={() => { void load(); }}>Retry export details</button></div>}
    {summary && <div className="data-export-grid">
      <article className="data-export-card">
        <span className="data-export-index" aria-hidden="true">01 / COLLECTIONS</span><h3>Playlists</h3>
        <p>Keep the sequence, track lengths, and credits. Individual files or all playlists in a ZIP.</p>
        <div className="data-export-selects">
          <label>Playlist<select disabled={disabled} value={playlistId} onChange={(event) => setPlaylistId(event.target.value)}>
            <option value="">All accessible playlists (ZIP)</option>
            {summary.playlists.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <label>Playlist format<select disabled={disabled} value={playlistFormat} onChange={(event) => setPlaylistFormat(event.target.value === "xspf" ? "xspf" : "m3u8")}>
            <option value="m3u8">M3U8</option><option value="xspf">XSPF</option>
          </select></label>
        </div>
        {metric(selectedPlaylist?.tracks ?? summary.counts.playlistTracks, playlistBytes, "tracks")}
        {!playlistId && <small>{summary.counts.playlists.toLocaleString()} owned/shared playlists; compressed size varies.</small>}
        {button("playlists", playlistFormat, "Download playlists", summary.counts.playlists === 0)}
      </article>
      <article className="data-export-card">
        <span className="data-export-index" aria-hidden="true">02 / LISTENING</span><h3>Listening history</h3>
        <p>A CSV of every recorded listen, including partial listens, timestamps, credits, listening time and client names.</p>
        {metric(summary.counts.history, summary.estimatedBytes.history)}
        {button("history", "csv", "Download history CSV", summary.counts.history === 0)}
      </article>
      <article className="data-export-card">
        <span className="data-export-index" aria-hidden="true">03 / YOUR TASTE</span><h3>Favorites &amp; scores</h3>
        <p>Favorites, recommendation feedback, hidden items, and any legacy ratings in structured JSON.</p>
        {metric(summary.counts.favorites + summary.counts.feedback + summary.counts.ratings, summary.estimatedBytes.favorites)}
        {button("favorites", "json", "Download favorites JSON")}
      </article>
      <article className="data-export-card data-export-bundle">
        <span className="data-export-index" aria-hidden="true">04 / THE COMPLETE SET</span><h3>Full account bundle</h3>
        <p>Playlists, history, favorites, scores, saved account settings, smart playlist rules and saved discoveries. No audio files or login secrets.</p>
        <label>Bundle format<select disabled={disabled} value={bundleFormat} onChange={(event) => setBundleFormat(event.target.value === "json" ? "json" : "zip")}>
          <option value="zip">ZIP archive + individual open-format files</option><option value="json">Unified JSON</option>
        </select></label>
        {metric(summary.counts.playlists + summary.counts.playlistTracks + summary.counts.history + summary.counts.favorites
          + summary.counts.feedback + summary.counts.ratings + summary.counts.settings + summary.counts.smartPlaylists + summary.counts.savedDiscoveries,
        summary.estimatedBytes[bundleFormat])}
        {button("bundle", bundleFormat, "Download full bundle")}
        <button type="button" className="data-export-settings-link" disabled={disabled} onClick={() => { void download("settings", "json"); }}>
          Or download saved account settings only
        </button>
      </article>
    </div>}
    {message && <p className="data-export-message" role="status">{message}</p>}
    {summary && <details className="data-export-notes"><summary>Portability &amp; what is included</summary>
      <ul>{summary.notes.map((note) => <li key={note}>{note}</li>)}</ul>
      <p>CSV text cells are protected against spreadsheet formulas. Save settings before exporting; use the existing preference backup for device-only values.</p>
    </details>}
  </section>;
}
