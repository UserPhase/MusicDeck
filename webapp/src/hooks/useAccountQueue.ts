import { useEffect, useMemo, useState } from "react";
import { queueDeviceId, queueSyncClient, useQueueSync, type QueueSessionSummary } from "../services/QueueSyncClient";
import { validateCheckpoint, type QueueContent } from "../services/storage/QueueDatabase";
import { startVisualPolling } from "../services/visualActivity";
import type { RemoteDevice, RemoteSessionValue } from "../types/remoteSession";

export function newestPeerQueue(sessions: QueueSessionSummary[], localDevice: string): QueueSessionSummary | undefined {
  return sessions.reduce<QueueSessionSummary | undefined>((latest, row) => {
    if (row.deviceId === localDevice) return latest;
    if (!latest || row.checkpoint.capturedAt > latest.checkpoint.capturedAt ||
      (row.checkpoint.capturedAt === latest.checkpoint.capturedAt && row.updatedAt > latest.updatedAt)) return row;
    return latest;
  }, undefined);
}

/** Keep a server queue as a read-only mirror until this device explicitly takes over. */
export function useAccountQueue({ owner, localCapturedAt, followPaused, activeDevice, status }: {
  owner: string | null;
  localCapturedAt: number;
  followPaused: boolean;
  activeDevice: RemoteDevice | null;
  status: RemoteSessionValue["status"];
}) {
  const snapshot = useQueueSync();
  const activeQueueDeviceId = activeDevice?.queue_device_id;
  const hasActiveDevice = Boolean(activeDevice);
  const row = useMemo(() => {
    if (!owner || snapshot.owner !== owner) return undefined;
    if (activeQueueDeviceId) return snapshot.sessions.find(session => session.deviceId === activeQueueDeviceId);
    if (hasActiveDevice || !followPaused) return undefined;
    const latest = newestPeerQueue(snapshot.sessions, queueDeviceId());
    return latest && latest.checkpoint.capturedAt > localCapturedAt ? latest : undefined;
  }, [owner, snapshot.owner, snapshot.sessions, activeQueueDeviceId, hasActiveDevice, followPaused, localCapturedAt]);
  const contentId = row?.contentId;
  const [cached, setCached] = useState<{ owner: string; contentId: string; content: QueueContent } | null>(null);

  useEffect(() => {
    if (!owner) return;
    const refresh = () => queueSyncClient.invalidate();
    refresh();
    return startVisualPolling(refresh, status === "connected" ? 60_000 : 5000, { immediate: false, refreshOnWindowFocus: true });
  }, [owner, status]);

  useEffect(() => {
    if (!owner || !contentId) return;
    const controller = new AbortController();
    let retry: number | undefined;
    let delay = 1000;
    const load = () => {
      void queueSyncClient.loadContent(contentId, controller.signal).then(content => {
        if (!controller.signal.aborted) setCached({ owner, contentId, content });
      }).catch(() => {
        if (controller.signal.aborted) return;
        retry = window.setTimeout(load, delay);
        delay = Math.min(30_000, delay * 2);
      });
    };
    load();
    return () => { controller.abort(); window.clearTimeout(retry); };
  }, [owner, contentId]);

  if (!row || !cached || cached.owner !== owner || cached.contentId !== row.contentId) return null;
  try {
    const checkpoint = validateCheckpoint(row.checkpoint, cached.content.entries.length);
    const entry = cached.content.entries[checkpoint.index];
    if (activeDevice && activeDevice.current_track?.id !== entry?.track.id) return null;
    return { contentId: row.contentId, content: cached.content, checkpoint };
  } catch {
    return null;
  }
}
