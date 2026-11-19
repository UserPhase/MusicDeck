// Network-stall recovery policy for the HTML audio decks owned by PlayerProvider.

export const STALL_RECOVERY_DELAY_MS = 3500;
export const RECOVERY_LOAD_TIMEOUT_MS = 15_000;
export const MAX_STREAM_RECOVERY_ATTEMPTS = 5;

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 16_000;
const PROGRESS_EPSILON_SECONDS = 0.25;
const HAVE_FUTURE_DATA = 3;

function createPlaybackSessionId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function parsePlaybackUrl(source) {
  if (!source) return null;
  try {
    const url = new URL(source, "https://musicdeck.invalid");
    return /\/api\/(?:tracks\/[^/]+\/stream|stream\/[^/]+)$/.test(url.pathname) ? url : null;
  } catch {
    return null;
  }
}

export function initialPlaybackUrl(source, inspect = false) {
  const url = parsePlaybackUrl(source);
  if (!url) return source;
  // The server's existing inspectionId parameter also identifies the playback attempt.
  url.searchParams.set("inspectionId", createPlaybackSessionId());
  if (!inspect) url.searchParams.set("inspect", "false");
  return source.split(/[?#]/, 1)[0] + url.search;
}

export function replacementPlaybackUrl(source) {
  const url = parsePlaybackUrl(source);
  if (!url) return null;
  const session = url.searchParams.get("inspectionId");
  if (!session) return null;
  url.searchParams.set("inspectionId", createPlaybackSessionId());
  url.searchParams.set("retryFrom", session);
  // Keep the desktop proxy prefix and origin, when present.
  return source.split(/[?#]/, 1)[0] + url.search;
}

// The first reload runs as soon as a stall is confirmed; later attempts back off.
export function streamRecoveryBackoffMs(attempt) {
  if (!Number.isFinite(attempt) || attempt <= 1) return 0;
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 2));
}

export function hasPlaybackProgressed(audio, sincePosition) {
  return Boolean(audio) &&
    audio.readyState >= HAVE_FUTURE_DATA &&
    audio.currentTime > sincePosition + PROGRESS_EPSILON_SECONDS;
}

