import { useEffect, useState } from "react";

import { createAcquisition } from "../api/musicdeck";
import { acquisitionPayload } from "../services/externalActions";
import { usePrivacy } from "../context/PrivacyContext";

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
  const { canImport } = usePrivacy();
  const [importState, setImportState] = useState("idle");

  useEffect(() => {
    setImportState("idle");
  }, [currentSong?.id]);

  async function importPreviewTrack() {
    if (!canImport || !currentSong || importState === "loading") return;
    setImportState("loading");
    try {
      await createAcquisition(acquisitionPayload("track", currentSong));
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
