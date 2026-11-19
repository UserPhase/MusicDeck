// Network-stall recovery policy for the HTML audio decks owned by PlayerProvider.

export const STALL_RECOVERY_DELAY_MS = 3500;
export const RECOVERY_LOAD_TIMEOUT_MS = 15_000;
export const MAX_STREAM_RECOVERY_ATTEMPTS = 5;

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 16_000;
const PROGRESS_EPSILON_SECONDS = 0.25;
const HAVE_FUTURE_DATA = 3;

export function createPlaybackSessionId() {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function replacementPlaybackUrl(source) {
  if (!source) return null;
  let url;
  try {
    url = new URL(source, "https://musicdeck.invalid");
  } catch {
    return null;
  }
  const session = url.searchParams.get("inspectionId");
  if (!session || !/\/api\/(?:tracks\/[^/]+\/stream|stream\/[^/]+)$/.test(url.pathname)) return null;
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

