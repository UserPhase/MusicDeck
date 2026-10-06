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

/** Fingerprints are learned from this server, never inferred from image dimensions/colors. */
export class NavidromeArtwork {
  private readonly defaults = new Map<string, { expiresAt: number; value: Promise<string | null> }>();

  private defaultHash(size: number | undefined, fetchDefault: () => Promise<Response>) {
    const key = String(size ?? "original");
    const existing = this.defaults.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.value;
    const entry = {
      expiresAt: Date.now() + 5 * 60_000,
      value: fetchDefault().then(async (response) => {
        if (response.status === 404 || response.status === 400) {
          await response.body?.cancel();
          return null;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Navidrome default artwork returned ${response.status}`);
        }
        if (!response.headers.get("content-type")?.startsWith("image/")) {
          await response.body?.cancel();
          return null; // Some Subsonic servers return an API error document for al-0.
        }
        return createHash("sha256").update(await imageBytes(response)).digest("hex");
      }),
    };
    entry.value = entry.value.catch((error: unknown) => {
      if (this.defaults.get(key) === entry) this.defaults.delete(key);
      throw error;
    });
    this.defaults.set(key, entry);
    if (this.defaults.size > 8) this.defaults.delete(this.defaults.keys().next().value!);
    return entry.value;
  }

  async read(id: string, size: number | undefined, fetchImage: () => Promise<Response>,
    fetchDefault: () => Promise<Response>): Promise<StreamResult> {
    if (isDefaultPlaceholder(id)) return { status: 404, headers: new Headers(), body: null };
    const response = await fetchImage();
    if (!response.ok) return { status: response.status, headers: response.headers, body: response.body };
    const bytes = await imageBytes(response);
    const defaultHash = await this.defaultHash(size, fetchDefault);
    if (defaultHash && createHash("sha256").update(bytes).digest("hex") === defaultHash) {
      return { status: 404, headers: new Headers(), body: null };
    }
    return { status: response.status, headers: response.headers,
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  }
}
