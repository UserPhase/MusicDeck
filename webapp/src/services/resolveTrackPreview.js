import { externalDiscoveryService } from "./externalDiscovery";
import { canStreamPreview, findItunesPreview } from "../utils/previewPlayback";

export async function resolveTrackPreview(track, isCurrent = () => true) {
  if (await canStreamPreview(track.previewUrl)) return track.previewUrl;
  if (!isCurrent()) return null;
  const [resolved] = await externalDiscoveryService.hydrateMissingPreviews([{ ...track, previewUrl: null }]).catch(() => []);
  if (!isCurrent()) return null;
  const refreshed = resolved?.previewUrl;
  if (refreshed && refreshed !== track.previewUrl && await canStreamPreview(refreshed)) return refreshed;
  if (!isCurrent()) return null;
  const fallback = await findItunesPreview(track);
  return isCurrent() && await canStreamPreview(fallback) ? fallback : null;
}
