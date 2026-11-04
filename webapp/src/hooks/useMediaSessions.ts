import { useCallback, useEffect, useState } from "react";
import { getMediaCheckpoints } from "../api/musicdeck";
import { useAuth } from "../context/AuthContext";
import { MEDIA_CHECKPOINT_CHANGED } from "../services/mediaSessions";
import type { MediaCheckpoint, MediaCheckpointInput } from "../services/mediaSessions";

export function useMediaSessions() {
  const auth = useAuth() as { session?: { id?: string } | null } | null;
  const userId = auth?.session?.id ?? null;
  const [state, setState] = useState<{ owner: string | null; items: MediaCheckpoint[]; loading: boolean; error: string }>({
    owner: userId, items: [], loading: Boolean(userId), error: "",
  });
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!userId) return;
    let request = 0;
    let changed = 0;
    const versions = new Map<string, number>();
    let controller: AbortController | null = null;
    const load = () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const sequence = ++request;
      const version = changed;
      setState((previous) => ({ owner: userId, items: previous.owner === userId ? previous.items : [], loading: true, error: "" }));
      getMediaCheckpoints(signal).then((data: { items: MediaCheckpoint[] }) => {
        if (signal.aborted || request !== sequence || version !== changed) return;
        data.items.forEach((item) => versions.set(`${item.type}:${item.mediaId}`, item.capturedAt));
        setState({ owner: userId, items: data.items, loading: false, error: "" });
      }).catch((error: Error) => {
        if (!signal.aborted && request === sequence) {
          console.error("Could not load listening checkpoints:", error);
          setState((previous) => ({ ...previous, loading: false, error: error.message || "Could not load listening progress." }));
        }
      });
    };
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ userId: string; checkpoint: MediaCheckpoint | null; input: MediaCheckpointInput }>).detail;
      if (detail.userId !== userId) return;
      const { checkpoint, input } = detail;
      const key = `${input.type}:${input.mediaId}`;
      const version = Math.max(input.capturedAt, checkpoint?.capturedAt ?? 0);
      if ((versions.get(key) ?? 0) > version) return;
      versions.set(key, version);
      changed++;
      setState((previous) => {
        const current = previous.items.find((item) => item.type === input.type && item.mediaId === input.mediaId);
        if (current && current.capturedAt > input.capturedAt) return previous;
        const items = (previous.owner === userId ? previous.items : []).filter((item) => item.type !== input.type || item.mediaId !== input.mediaId);
        return { owner: userId, items: checkpoint ? [checkpoint, ...items].slice(0, 100) : items, loading: false, error: "" };
      });
    };
    load();
    const poll = window.setInterval(() => { if (!document.hidden) load(); }, 30_000);
    window.addEventListener("focus", load);
    window.addEventListener(MEDIA_CHECKPOINT_CHANGED, update);
    return () => {
      controller?.abort();
      window.clearInterval(poll);
      window.removeEventListener("focus", load);
      window.removeEventListener(MEDIA_CHECKPOINT_CHANGED, update);
    };
  }, [userId, revision]);
  return state.owner === userId ? { ...state, retry } : { items: [], loading: Boolean(userId), error: "", retry };
}
