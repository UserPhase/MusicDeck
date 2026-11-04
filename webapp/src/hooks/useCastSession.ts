import { useEffect, useRef, useState } from "react";
import { CastManager, supportsCast } from "../services/cast/CastManager";
import type { CastState } from "../services/cast/CastManager";
import type { PlaybackEngine } from "../services/audio/PlaybackEngine";
import type { CastControl } from "../context/CastContext";

const initial: CastState = { available: false, connected: false, device: "", loading: false, error: "", volume: null };
export function useCastSession(engine: PlaybackEngine | null, userId: string | null, allowed: boolean): CastControl {
  const manager = useRef<CastManager | null>(null);
  const operation = useRef(false);
  const policyAllowed = useRef(allowed);
  policyAllowed.current = allowed;
  const [state, setState] = useState(initial);
  useEffect(() => {
    if (!engine || !userId) return;
    const instance = new CastManager();
    setState(initial);
    manager.current = instance;
    let disposed = false;
    const unsubscribe = instance.subscribeState(() => { if (!disposed) setState(instance.getState()); });
    return () => {
      disposed = true; unsubscribe();
      if (manager.current === instance) manager.current = null;
      void instance.destroy().then(() => engine.releaseRemoteOutput(instance)).catch((error) => {
        console.error("Could not release the Cast playback output:", error);
      });
    };
  }, [engine, userId]);
  useEffect(() => {
    if (!allowed && manager.current?.initialized) {
      const instance = manager.current;
      void instance.disconnect().then(async () => {
        await engine?.releaseRemoteOutput(instance);
        if (manager.current === instance) setState((current) => ({ ...current, error: "Cast stopped by privacy policy. Reload this page to unload the already-loaded Google SDK." }));
      }).catch((error) => {
        console.error("Could not stop Cast after privacy policy changed:", error);
        if (manager.current === instance) setState((current) => ({ ...current, error: "Could not stop the Cast receiver. Stop it on the receiver before resuming locally." }));
      });
    }
  }, [allowed, engine]);
  return { ...state, supported: supportsCast(), allowed,
    async connect() {
      if (!allowed) throw new Error("Google Cast is disabled by the server privacy policy.");
      if (operation.current) return;
      if (!engine || !manager.current || !userId) throw new Error("Sign in and wait for the player to become ready.");
      const instance = manager.current;
      operation.current = true;
      try {
        await instance.connect();
        if (!policyAllowed.current || manager.current !== instance) {
          await instance.disconnect();
          throw new Error("Cast was cancelled because the session or privacy policy changed. Reload this page to unload the Google SDK.");
        }
        await engine.setRemoteOutput(instance);
      } finally { operation.current = false; }
    },
    async disconnect() {
      if (operation.current) return;
      operation.current = true;
      try {
        await manager.current?.disconnect();
        await engine?.releaseRemoteOutput();
      } finally { operation.current = false; }
    },
  };
}
