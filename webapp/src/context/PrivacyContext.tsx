import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "./AuthContext";
import { getPrivacySettings, updatePrivacySettings, type PrivacySettings, type PrivacySnapshot } from "../api/privacy";
import { setBrowserPrivacy } from "../services/privacyPolicy";
import { sendCachePolicy } from "../services/serviceWorkerRegistration";

interface PrivacyContextValue {
  policy: PrivacySnapshot | null;
  error: string;
  loading: boolean;
  busy: boolean;
  save(settings: PrivacySettings): Promise<void>;
  refresh(): void;
  canMetadata: boolean;
  canImport: boolean;
  canArtwork: boolean;
}
const PrivacyContext = createContext<PrivacyContextValue>({
  policy: null, error: "", loading: false, busy: false, save: async () => { throw new Error("Privacy provider is unavailable"); },
  refresh: () => {}, canMetadata: true, canImport: true, canArtwork: true,
});
export const usePrivacy = () => useContext(PrivacyContext);
export function PrivacyProvider({ children }: { children: ReactNode }) {
  const userId: string | null = useAuth()?.session?.id ?? null;
  const [state, setState] = useState<{ owner: string | null; policy: PrivacySnapshot | null; error: string }>({ owner: null, policy: null, error: "" });
  const [busy, setBusy] = useState(false);
  const owner = useRef(userId);
  owner.current = userId;
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const saving = useRef<symbol | null>(null);
  const refresh = useCallback(() => {
    if (!userId || controller.current || saving.current) return;
    const active = new AbortController();
    const version = generation.current;
    controller.current = active;
    void getPrivacySettings(active.signal).then((policy) => {
      if (active.signal.aborted || owner.current !== userId || version !== generation.current) return;
      setBrowserPrivacy(policy);
      setState((old) => JSON.stringify(old.policy) === JSON.stringify(policy) && !old.error && old.owner === userId
        ? old : { owner: userId, policy, error: "" });
    }).catch((failure: unknown) => {
      if (active.signal.aborted || owner.current !== userId || version !== generation.current) return;
      console.error("Could not synchronize privacy policy:", failure);
      setBrowserPrivacy(null);
      setState((old) => ({ owner: userId, policy: old.owner === userId ? old.policy : null,
        error: failure instanceof Error ? failure.message : "Could not synchronize privacy policy." }));
    }).finally(() => { if (controller.current === active) controller.current = null; });
  }, [userId]);
  useEffect(() => {
    setBrowserPrivacy(null);
    setBusy(false);
    if (!userId) return;
    refresh();
    const interval = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      controller.current?.abort(); controller.current = null; generation.current += 1;
      saving.current = null;
      window.clearInterval(interval); window.removeEventListener("focus", refresh); setBrowserPrivacy(null);
    };
  }, [refresh, userId]);
  const save = async (settings: PrivacySettings) => {
    if (saving.current || !userId) throw new Error("Privacy settings are busy or authentication is unavailable");
    const operation = Symbol("privacy-save");
    saving.current = operation;
    setBusy(true);
    generation.current++;
    controller.current?.abort(); controller.current = null;
    try {
      const policy = await updatePrivacySettings(settings);
      if (owner.current !== userId || saving.current !== operation) throw new Error("Signed-in account changed while saving privacy policy");
      setBrowserPrivacy(policy); setState({ owner: userId, policy, error: "" });
    } catch (failure) {
      if (owner.current === userId && saving.current === operation) {
        setBrowserPrivacy(null);
        setState((old) => ({ owner: userId, policy: old.owner === userId ? old.policy : null,
          error: failure instanceof Error ? failure.message : "Could not save privacy policy." }));
      }
      throw failure;
    } finally {
      if (saving.current === operation) { saving.current = null; setBusy(false); }
    }
  };
  const policy = state.owner === userId ? state.policy : null;
  const value = { policy, error: state.owner === userId ? state.error : "", loading: Boolean(userId && !policy && !state.error),
    busy, refresh, save, canMetadata: Boolean(policy?.effective.metadata && !state.error),
    canImport: Boolean(policy?.effective.imports && !state.error), canArtwork: Boolean(policy?.effective.artwork && !state.error) };
  const cacheOwner = userId;
  const cacheArtwork = value.canArtwork;
  const cacheMetadata = policy && !value.error ? value.canMetadata : null;
  useEffect(() => {
    const synchronize = () => sendCachePolicy(cacheOwner, cacheArtwork, cacheMetadata);
    const requested = (event: MessageEvent<unknown>) => {
      if (event.data && typeof event.data === "object" && "type" in event.data &&
          event.data.type === "MUSICDECK_REQUEST_CACHE_POLICY") synchronize();
    };
    synchronize();
    navigator.serviceWorker?.addEventListener("controllerchange", synchronize);
    navigator.serviceWorker?.addEventListener("message", requested);
    return () => {
      navigator.serviceWorker?.removeEventListener("controllerchange", synchronize);
      navigator.serviceWorker?.removeEventListener("message", requested);
    };
  }, [cacheOwner, cacheArtwork, cacheMetadata]);
  return <PrivacyContext.Provider value={value}>
    {userId && !policy ? <div className="page-state" role={value.error ? "alert" : "status"}>
      {value.error ? <>Privacy policy unavailable. External features remain blocked. <button type="button" onClick={refresh}>Retry</button></> : "Loading server privacy policy..."}
    </div> : <>{userId && value.error && <div className="privacy-sync-warning" role="alert">
      Privacy policy synchronization failed. Local playback remains available; external features are blocked until synchronization succeeds.
      <button type="button" onClick={refresh}>Retry privacy sync</button>
    </div>}{children}</>}
  </PrivacyContext.Provider>;
}
