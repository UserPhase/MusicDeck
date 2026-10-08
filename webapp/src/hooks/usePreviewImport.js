import { useEffect, useState } from "react";

import { createAcquisition } from "../api/musicdeck";

const LABELS = {
  idle: "Import full song",
  loading: "Adding…",
  queued: "Import queued",
  error: "Retry import",
};

/**
 * "Import full song" action for preview playback, shared by every player
 * surface (bottom bar, Apple header player, drawer player).
 */
export function usePreviewImport(currentSong) {
  const [importState, setImportState] = useState("idle");

  useEffect(() => {
    setImportState("idle");
  }, [currentSong?.id]);

  async function importPreviewTrack() {
    if (!currentSong || importState === "loading") return;
    setImportState("loading");
    try {
      await createAcquisition({
        result: {
          id: currentSong.id,
          type: "track",
          title: currentSong.title || "",
          artist: currentSong.artist || "",
          album: currentSong.album || "",
          provider: currentSong.provider || "external",
          source: currentSong.source || { kind: "external", count: 0 },
          metadata: currentSong.metadata || {},
        },
        trackId: currentSong.id,
        sourceProvider: "spotdl",
      });
      setImportState("queued");
    } catch {
      setImportState("error");
    }
  }

  return {
    importState,
    importLabel: LABELS[importState],
    isImportDisabled: importState === "loading" || importState === "queued",
    importPreviewTrack,
  };
}
