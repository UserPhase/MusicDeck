function normalized(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isTrustedPreviewUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (
      url.hostname === "itunes.apple.com" ||
      url.hostname.endsWith(".itunes.apple.com") ||
      url.hostname === "dzcdn.net" ||
      url.hostname.endsWith(".dzcdn.net")
    );
  } catch {
    return false;
  }
}

const ITUNES_PREVIEW_TIMEOUT_MS = 5000;

export async function findItunesPreview(
  track,
  fetchImpl = typeof window !== "undefined" && typeof window.fetch === "function"
    ? window.fetch.bind(window)
    : null,
  timeoutMs = ITUNES_PREVIEW_TIMEOUT_MS,
) {
  const term = `${track?.artist || ""} ${track?.title || ""}`.trim();
  if (!term) return null;

  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", term);
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "1");

  let timeoutId = null;
  let timedOut = false;
  const controller =
    typeof AbortController === "function"
      ? new AbortController()
      : null;

  try {
    if (typeof fetchImpl !== "function") return null;

    const timeout = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller?.abort();
        reject(new Error("iTunes preview lookup timed out."));
      }, timeoutMs);
    });

    const response = await Promise.race([
      fetchImpl(
        url.toString(),
        controller ? { signal: controller.signal } : undefined
      ),
      timeout,
    ]);

    if (!response.ok) return null;
    const payload = await response.json();
    const match = Array.isArray(payload.results) ? payload.results[0] : null;
    if (!match || !isTrustedPreviewUrl(match.previewUrl)) return null;

    // A single-result lookup should still reject a plainly unrelated track.
    const wantedTitle = normalized(track.title);
    const resultTitle = normalized(match.trackName);
    return wantedTitle && resultTitle && wantedTitle !== resultTitle
      ? null
      : match.previewUrl;
  } catch (error) {
    console.warn(
      timedOut
        ? "iTunes preview lookup timed out."
        : "iTunes preview lookup failed.",
      error
    );
    return null;
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

export function trustedPreviewUrl(value) {
  return isTrustedPreviewUrl(value) ? value : null;
}
