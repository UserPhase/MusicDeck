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
async function request(method: "GET" | "PATCH", signal?: AbortSignal, settings?: PrivacySettings): Promise<PrivacySnapshot> {
  const response = await fetch("/api/v1/privacy", {
    method, credentials: "include", cache: "no-store", signal,
    ...(settings ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) } : {}),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `Privacy settings request failed (${response.status})`);
  if (!payload || ["localOnly", "allowMetadata", "allowImports", "allowArtwork", "enforcedByEnvironment"].some((key) => typeof payload[key] !== "boolean") ||
      !payload.effective || ["metadata", "imports", "artwork", "external"].some((key) => typeof payload.effective[key] !== "boolean")) {
    throw new Error("Invalid privacy settings response");
  }
  return payload;
}
export const getPrivacySettings = (signal?: AbortSignal) => request("GET", signal);
export const updatePrivacySettings = (settings: PrivacySettings, signal?: AbortSignal) => request("PATCH", signal, settings);
