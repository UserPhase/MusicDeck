import Menu, { MenuItem } from "./ui/Menu";
import { useState } from "react";
import { createAcquisition, getAcquisition, getPlayableSources } from "../api/musicdeck";

/*
 * Secondary "Play from another source" control.
 *
 * Renders only when a track has more than one playable source. The primary
 * Play action is unchanged; this exposes alternative sources using friendly
 * connection names only — never provider IDs, connection IDs, or
 * credentials. Selecting a source plays the track through the existing
 * MusicDeck stream endpoint via `onSelect(song, sourceId)`.
 */
function sourceLabel(source) {
  const quality = [
    source.quality?.codec,
    source.quality?.bitrate ? `${source.quality.bitrate} kbps` : null,
    source.quality?.sampleRate ? `${source.quality.sampleRate / 1000} kHz` : null,
  ].filter(Boolean).join(" · ");

  const typeSuffix = source.type === "preview" ? " (Preview)" : "";
  const base = `${source.label}${typeSuffix}`;
  return quality ? `${base} · ${quality}` : base;
}

function SourceMenu({ song, sources, onSelect }) {
  const [resolvedSources, setResolvedSources] = useState(null);
  const [selectedSourceId, setSelectedSourceId] = useState(null);
  const [acquisitionJob, setAcquisitionJob] = useState(null);
  const [acquiring, setAcquiring] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const canResolve = (
    (Array.isArray(sources) && sources.length > 1)
    || song.source?.kind === "external"
    || song.source?.externalAvailable
  );

  if (!canResolve) {
    return null;
  }

  async function loadSources(force = false) {
    if (loading || (!force && resolvedSources)) {
      return;
    }

    try {
      setLoading(true);
      setError(false);
      const resolved = await getPlayableSources(song);
      setResolvedSources(resolved.sources);
      setSelectedSourceId(resolved.selectedSource?.id || null);

      if (resolved.selectedSource && resolved.sources.length > 1) {
        onSelect(song, resolved.selectedSource);
      }
    } catch {
      setError(true);
      setResolvedSources([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleAcquire() {
    try {
      setAcquiring(true);
      const res = await createAcquisition({
        result: {
          id: song.id,
          type: "track",
          title: song.title,
          artist: song.artist,
          album: song.album,
          provider: song.provider || "external",
          source: song.source || { kind: "external", count: 1 },
          metadata: song.metadata || {},
        },
        trackId: song.id,
      });

      setAcquisitionJob(res.job || { id: res.jobId, status: res.status });

      if (res.status === "completed") {
        setAcquiring(false);
        return;
      }

      const jobId = res.jobId || res.job?.id;
      if (!jobId) return;

      const pollInterval = setInterval(async () => {
        try {
          const job = await getAcquisition(jobId);
          setAcquisitionJob(job);
          if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
            clearInterval(pollInterval);
            setAcquiring(false);
          }
        } catch {
          clearInterval(pollInterval);
          setAcquiring(false);
        }
      }, 1000);
    } catch (err) {
      setAcquiring(false);
      setAcquisitionJob({ status: "failed", errorMessage: err.message });
    }
  }

  const acquisitionLabel = () => {
    if (!acquisitionJob) return "Download to Library";
    switch (acquisitionJob.status) {
      case "queued": return "Queued";
      case "discovering": return "Discovering...";
      case "downloading": {
        const pct = acquisitionJob.progress?.percent;
        return pct !== undefined ? `Downloading ${pct}%` : "Downloading...";
      }
      case "processing": return "Processing...";
      case "importing": return "Importing...";
      case "completed": return "✓ Downloaded to Library";
      case "failed": return "Download Failed";
      case "cancelled": return "Cancelled";
      default: return "Download to Library";
    }
  };

  return (
    <Menu
      label={`Play ${song.title} from another source`}
      icon="⇄"
      title="Play from"
      className="source-menu-container"
      toggleClassName="source-menu-toggle"
      menuClassName="source-menu"
      onOpenChange={(open) => {
        if (open) {
          loadSources();
        }
      }}
    >
      {({ close }) => (
        loading ? (
          <div className="source-menu-status">Finding sources...</div>
        ) : (
          <>
            {error || resolvedSources?.length === 0 ? (
              <div className="source-menu-status">
                <span>No playable sources found.</span>
                <button
                  type="button"
                  className="source-menu-retry"
                  onClick={(event) => {
                    event.stopPropagation();
                    loadSources(true);
                  }}
                >
                  Retry
                </button>
              </div>
            ) : (
              (resolvedSources || []).map((source) => (
                <MenuItem
                  key={source.id}
                  className="source-menu-item"
                  disabled={source.availability !== "available"}
                  onSelect={() => {
                    setSelectedSourceId(source.id);
                    close();
                    onSelect(song, source);
                  }}
                >
                  {selectedSourceId === source.id ? "✓ " : ""}{sourceLabel(source)}
                </MenuItem>
              ))
            )}
            <MenuItem
              className="source-menu-item source-menu-acquire"
              disabled={acquiring || acquisitionJob?.status === "completed"}
              onSelect={handleAcquire}
            >
              📥 {acquisitionLabel()}
            </MenuItem>
          </>
        )
      )}
    </Menu>
  );
}

export default SourceMenu;

