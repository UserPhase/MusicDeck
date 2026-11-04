import { createHash } from "node:crypto";
import type { StreamResult } from "../../backends/stream-provider.js";
import { isDefaultPlaceholder } from "./placeholderDetector.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function imageBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new Error("Artwork response has no body");
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
    await response.body.cancel();
    throw new Error("Artwork exceeds 5 MB limit");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new Error("Artwork exceeds 5 MB limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    // Cancellation is cleanup; its failure must not mask the original read/size error.
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

/**
 * Header set on a 200 artwork response when the server could not prove the
 * image is genuine (no placeholder fingerprint available and the image has not
 * been seen often enough to self-identify as the default). Lets the album
 * resolver prefer a track's distinct embedded cover over a suspect album cover.
 */
export const ARTWORK_VERDICT_HEADER = "x-musicdeck-artwork";

/**
 * Reference IDs probed to learn the server's default placeholder bytes. Some
 * Subsonic servers answer a nonexistent album (al-0) with an error document but
 * still serve the placeholder for an existing entity that has no art, so a
 * single reference is not reliable across servers.
 */
const REFERENCE_IDS = ["al-0", "ar-0", "mf-0"];

/** Fingerprints are learned from this server, never inferred from image dimensions/colors. */
export class NavidromeArtwork {
  private readonly defaults = new Map<string, { expiresAt: number; value: Promise<string | null> }>();
  /**
   * Self-calibrating fallback for servers whose reference IDs all error: the
   * default image is, by definition, the one returned for many distinct
   * entities that have no art. Keyed by `${size}:${hash}`.
   */
  private readonly observed = new Map<string, Set<string>>();
  private readonly calibrated = new Set<string>();

  private defaultHash(size: number | undefined, fetchReference: (id: string) => Promise<Response>) {
    const key = String(size ?? "original");
    const existing = this.defaults.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.value;
    const entry = {
      expiresAt: Date.now() + 5 * 60_000,
      value: (async () => {
        for (const referenceId of REFERENCE_IDS) {
          const response = await fetchReference(referenceId);
          if (response.status === 404 || response.status === 400) {
            await response.body?.cancel();
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Navidrome default artwork returned ${response.status}`);
          }
          if (!response.headers.get("content-type")?.startsWith("image/")) {
            await response.body?.cancel();
            continue; // Some Subsonic servers return an API error document for a missing reference.
          }
          return createHash("sha256").update(await imageBytes(response)).digest("hex");
        }
        return null;
      })(),
    };
    entry.value = entry.value.catch((error: unknown) => {
      if (this.defaults.get(key) === entry) this.defaults.delete(key);
      throw error;
    });
    this.defaults.set(key, entry);
    if (this.defaults.size > 8) this.defaults.delete(this.defaults.keys().next().value!);
    return entry.value;
  }

  /** Records an observed image; returns true once the same image has served 2+ distinct entities. */
  private observe(sizeKey: string, id: string, hash: string): boolean {
    const key = `${sizeKey}:${hash}`;
    if (this.calibrated.has(key)) return true;
    let ids = this.observed.get(key);
    if (!ids) {
      ids = new Set();
      this.observed.set(key, ids);
      if (this.observed.size > 512) this.observed.delete(this.observed.keys().next().value!);
    }
    ids.add(id);
    if (ids.size < 2) return false;
    this.calibrated.add(key);
    if (this.calibrated.size > 128) this.calibrated.delete(this.calibrated.keys().next().value!);
    return true;
  }

  async read(id: string, size: number | undefined, fetchImage: () => Promise<Response>,
    fetchReference: (id: string) => Promise<Response>): Promise<StreamResult> {
    if (isDefaultPlaceholder(id)) return { status: 404, headers: new Headers(), body: null };
    const response = await fetchImage();
    if (!response.ok) return { status: response.status, headers: response.headers, body: response.body };
    const bytes = await imageBytes(response);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const body = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });

    const defaultHash = await this.defaultHash(size, fetchReference);
    if (defaultHash) {
      return hash === defaultHash
        ? { status: 404, headers: new Headers(), body: null }
        : { status: response.status, headers: response.headers, body: body() };
    }

    // No reference fingerprint: fall back to frequency-based self-calibration.
    const sizeKey = String(size ?? "original");
    if (this.calibrated.has(`${sizeKey}:${hash}`) || this.observe(sizeKey, id, hash)) {
      return { status: 404, headers: new Headers(), body: null };
    }
    const headers = new Headers(response.headers);
    headers.set(ARTWORK_VERDICT_HEADER, "uncertain");
    return { status: response.status, headers, body: body() };
  }
}
