import { request } from "./musicdeck";

export interface ServerExtension {
  apiVersion: 1; id: string; name: string; version: string; description: string; entry: "index.mjs";
  enabled: boolean; status: "disabled" | "starting" | "enabled" | "stopping" | "error"; error: string | null;
}
export interface ExtensionInventory { extensions: ServerExtension[]; issues: string[]; }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object"); }
function extension(value: unknown): value is ServerExtension {
  return object(value) && value.apiVersion === 1 && value.entry === "index.mjs" &&
    typeof value.id === "string" && typeof value.name === "string" && typeof value.version === "string" &&
    typeof value.description === "string" && typeof value.enabled === "boolean" &&
    ["disabled", "starting", "enabled", "stopping", "error"].includes(String(value.status)) &&
    (value.error === null || typeof value.error === "string");
}
function inventory(value: unknown): ExtensionInventory {
  if (!object(value) || !Array.isArray(value.extensions) || !value.extensions.every(extension) ||
      !Array.isArray(value.issues) || !value.issues.every((issue) => typeof issue === "string")) {
    throw new Error("MusicDeck returned an invalid extension inventory");
  }
  return { extensions: value.extensions, issues: value.issues };
}
export async function getExtensions(): Promise<ExtensionInventory> {
  return inventory(await request("/api/v1/admin/extensions"));
}
export async function discoverExtensions(): Promise<ExtensionInventory> {
  return inventory(await request("/api/v1/admin/extensions/discover", { method: "POST" }));
}
export async function setExtensionEnabled(id: string, enabled: boolean): Promise<ServerExtension> {
  const result: unknown = await request(`/api/v1/admin/extensions/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify({ enabled }),
  });
  if (!object(result) || !extension(result.extension)) throw new Error("MusicDeck returned an invalid extension update");
  return result.extension;
}
