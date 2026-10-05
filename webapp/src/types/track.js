import { normalizeTrackData } from "../utils/normalizeTrackData";

/**
 * @typedef {Object} UnifiedTrack
 * @property {string|null} id Stable library or provider ID.
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {number|null} duration Full recording duration supplied by metadata.
 * @property {number|null} metadataDuration Full recording duration, retained separately from audio duration.
 * @property {number|null} audioDuration Duration reported by the loaded audio element; a preview is normally ~30 seconds.
 * @property {string|null} coverUrl
 * @property {string|null} previewUrl A direct provider preview, when available.
 * @property {boolean} external True when the track still needs a library match.
 * @property {boolean} isDownloaded True when the track is present in the library.
 * @property {Object} metadata Provider specific data used by source resolution.
 */

/**
 * Creates the common track shape used by rows and the player. It retains the
 * source payload so external tracks can be resolved at playback time.
 */
export function toUnifiedTrack(track, origin = "unknown") {
  const normalized = normalizeTrackData(track, origin);
  const provider = String(normalized.provider || track?.provider || "").toLowerCase();
  const external = Boolean(
    track?.external || track?.sample || normalized.source?.kind === "external" ||
    ["external", "deezer", "itunes"].includes(provider)
  );

  return {
    ...track,
    ...normalized,
    external,
    isDownloaded: Boolean(normalized.isDownloaded || track?.inLibrary),
  };
}

export default toUnifiedTrack;
