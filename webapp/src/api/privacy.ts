import { request } from "./musicdeck";

export interface PrivacySettings {
  localOnly: boolean;
  allowMetadata: boolean;
  allowImports: boolean;
  allowArtwork: boolean;
}
export interface PrivacySnapshot extends PrivacySettings {
  enforcedByEnvironment: boolean;
  effective: { metadata: boolean; imports: boolean; artwork: boolean; external: boolean };
}
async function requestPolicy(method: "GET" | "PATCH", signal?: AbortSignal, settings?: PrivacySettings): Promise<PrivacySnapshot> {
  const payload = await request("/api/v1/privacy", {
    method, cache: "no-store", signal,
    ...(settings ? { body: JSON.stringify(settings) } : {}),
  }).catch((error: unknown) => {
    if (error instanceof SyntaxError) throw new Error("Invalid privacy settings response");
    throw error;
  });
  if (!payload || ["localOnly", "allowMetadata", "allowImports", "allowArtwork", "enforcedByEnvironment"].some((key) => typeof payload[key] !== "boolean") ||
      !payload.effective || ["metadata", "imports", "artwork", "external"].some((key) => typeof payload.effective[key] !== "boolean")) {
    throw new Error("Invalid privacy settings response");
  }
  return payload;
}

function isTemporarilyUnavailable(error: unknown) {
  return error instanceof TypeError || (
    error instanceof Error && "status" in error &&
    (error.status === 502 || error.status === 503 || error.status === 504)
  );
}

export async function getPrivacySettings(signal?: AbortSignal, retryUnavailable = false) {
  try {
    return await requestPolicy("GET", signal);
  } catch (error) {
    if (!retryUnavailable || signal?.aborted || !isTemporarilyUnavailable(error)) throw error;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        window.clearTimeout(timer);
        reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      };
      const timer = window.setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, 1500);
      signal?.addEventListener("abort", abort, { once: true });
    });
    return requestPolicy("GET", signal);
  }
}

export const updatePrivacySettings = (settings: PrivacySettings, signal?: AbortSignal) => requestPolicy("PATCH", signal, settings);
