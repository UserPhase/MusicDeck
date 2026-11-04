import { getPlaylist, getStarred } from "../../api/musicdeck";
import { downloadKey, downloadTransaction, listDownloads, readDownload } from "./offlineDatabase";
import { offlineDownloadEngine, permitsAutomaticDownload, type DownloadTrack, type OfflineCollection } from "./OfflineDownloadEngine";

export interface AutoDownloadPolicy {
  key: string; owner: string; id: string; kind: "favorites" | "playlist"; name: string;
  enabled: boolean; quality: string;
}
interface NetworkPreference { key: string; owner: string; allowUnknown: boolean }
export const AUTO_POLICIES_CHANGED = "musicdeck:auto-policies-changed";

export class AutoDownloadPolicyManager {
  private inflight: Promise<void> | null = null;
  async list(): Promise<AutoDownloadPolicy[]> {
    const owner = offlineDownloadEngine.getOwner();
    return owner ? listDownloads("policies", owner) : [];
  }
  async setPolicy(input: Omit<AutoDownloadPolicy, "key" | "owner" | "quality"> & { quality?: string }): Promise<void> {
    const owner = offlineDownloadEngine.getOwner();
    if (!owner) throw new Error("Sign in to configure auto-downloads.");
    if (input.kind === "favorites" && input.id !== "favorites") throw new Error("Invalid favorites rule.");
    const policy: AutoDownloadPolicy = { ...input, owner, key: downloadKey(owner, `${input.kind}:${input.id}`), quality: input.quality || "320kbps" };
    await downloadTransaction<void>(["policies"], "readwrite", (tx) => { tx.objectStore("policies").put(policy); });
    if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTO_POLICIES_CHANGED));
  }
  async allowsUnknownNetwork(): Promise<boolean> {
    const owner = offlineDownloadEngine.getOwner();
    return owner ? Boolean((await readDownload<NetworkPreference>("settings", downloadKey(owner, "auto-network")))?.allowUnknown) : false;
  }
  async setAllowUnknownNetwork(allowUnknown: boolean): Promise<void> {
    const owner = offlineDownloadEngine.getOwner();
    if (!owner) throw new Error("Sign in to configure auto-downloads.");
    await downloadTransaction<void>(["settings"], "readwrite", (tx) => {
      tx.objectStore("settings").put({ key: downloadKey(owner, "auto-network"), owner, allowUnknown } satisfies NetworkPreference);
    });
    offlineDownloadEngine.setAutomaticGate(() => offlineDownloadEngine.getOwner() === owner && permitsAutomaticDownload(allowUnknown));
    if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTO_POLICIES_CHANGED));
  }
  async reconcile(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run().finally(() => { this.inflight = null; });
    return this.inflight;
  }
  private async run(): Promise<void> {
    const owner = offlineDownloadEngine.getOwner();
    if (!owner) return;
    const allowUnknown = await this.allowsUnknownNetwork();
    const permitted = () => offlineDownloadEngine.getOwner() === owner && permitsAutomaticDownload(allowUnknown);
    offlineDownloadEngine.setAutomaticGate(permitted);
    if (!permitted()) return;
    const policies = await this.list();
    const errors: string[] = [];
    for (const policy of policies.filter((rule) => rule.enabled)) {
      if (!permitted()) break;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const collection = policy.kind === "favorites" ? null : await getPlaylist(policy.id, controller.signal);
        if (policy.kind === "playlist" && !collection) throw new Error(`${policy.name} is unavailable on the server.`);
        const tracks: DownloadTrack[] = policy.kind === "favorites" ? await getStarred(controller.signal) : collection!.entry;
        clearTimeout(timeout);
        // Re-read after the network round trip: a disabled rule must not enqueue new work.
        const current = await readDownload<AutoDownloadPolicy>("policies", policy.key);
        if (!current?.enabled || !permitted()) continue;
        const eligible = tracks.filter(isDownloadableTrack);
        const record: Omit<OfflineCollection, "key" | "owner"> = { id: policy.id, kind: policy.kind,
          name: policy.kind === "favorites" ? "Favorites" : collection!.name, trackIds: tracks.filter((track) => track.id != null).map((track) => String(track.id)) };
        await offlineDownloadEngine.saveCollection(record);
        for (const track of eligible) {
          if (!permitted()) break;
          const latest = await readDownload<AutoDownloadPolicy>("policies", policy.key);
          if (!latest?.enabled) break;
          await offlineDownloadEngine.enqueueDownload(track, policy.quality, true);
        }
      } catch (error) { errors.push(error instanceof Error ? error.message : `Could not sync ${policy.name}.`); }
      finally { clearTimeout(timeout); }
    }
    await offlineDownloadEngine.drain();
    if (errors.length) throw new Error(errors.join(" "));
  }
}
export function isDownloadableTrack(track: DownloadTrack): boolean {
  const availability = track.availability as { libraryAvailable?: boolean } | undefined;
  const source = track.source as { kind?: string } | undefined;
  return Boolean(track.id !== undefined && (availability?.libraryAvailable || source?.kind === "library" || track.isDownloaded || track.inLibrary));
}
export const autoDownloadPolicies = new AutoDownloadPolicyManager();
