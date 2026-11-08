import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteCommand, RemoteDevice, RemotePlaybackSnapshot, RemotePlayerAdapter, RemoteSessionValue } from "../types/remoteSession";
import { isMediaResumeContext } from "../services/mediaSessions";
import { getVisualActivity, subscribeVisualActivity } from "../services/visualActivity";
import { queueDeviceId, queueSyncClient } from "../services/QueueSyncClient";
import { DESKTOP_CONFIG_CHANGED_EVENT, resolveRemoteSocketUrl } from "../services/desktop/desktopRuntime";

function deviceKind(): RemoteDevice["device_type"] {
  if (/iPad|Tablet/i.test(navigator.userAgent)) return "tablet";
  if (/Mobi|iPhone|Android/i.test(navigator.userAgent)) return "phone";
  return "computer";
}
let identitySequence = 0;
function identity(): string {
  // Per-tab identity prevents two browser tabs from replacing each other's sockets.
  if (typeof crypto !== "undefined") {
    return typeof crypto.randomUUID === "function" ? crypto.randomUUID() :
      Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16).padStart(8, "0")).join("-");
  }
  // Device/request IDs are correlation keys, never authentication credentials.
  return `remote-${Date.now().toString(36)}-${++identitySequence}-${Math.random().toString(36).slice(2, 12)}`;
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object"); }
function device(value: unknown): value is RemoteDevice {
  return object(value) && typeof value.device_id === "string" && typeof value.device_name === "string" &&
    ["computer", "phone", "tablet", "web"].includes(String(value.device_type)) &&
    typeof value.is_active_player === "boolean" && typeof value.can_receive === "boolean" &&
    typeof value.position_ms === "number" && Number.isFinite(value.position_ms) && value.position_ms >= 0 &&
    typeof value.duration_ms === "number" && Number.isFinite(value.duration_ms) && value.duration_ms >= 0 &&
    typeof value.volume === "number" && value.volume >= 0 && value.volume <= 1 && typeof value.playing === "boolean" &&
    (value.current_track === null || (object(value.current_track) && typeof value.current_track.id === "string" && typeof value.current_track.title === "string"));
}
function snapshot(value: unknown): value is RemotePlaybackSnapshot {
  if (!object(value) || !object(value.queueState)) return false;
  const queue = value.queueState;
  return Array.isArray(queue.entries) && queue.entries.length > 0 && queue.entries.length <= 5000 &&
    queue.entries.every((entry) => object(entry) && typeof entry.trackId === "string" && typeof entry.occurrenceId === "string" &&
      typeof entry.title === "string" && typeof entry.artist === "string" && typeof entry.album === "string" &&
      typeof entry.duration === "number" && Number.isFinite(entry.duration) && entry.duration >= 0 &&
      (entry.resume === undefined || isMediaResumeContext(entry.resume))) &&
    typeof queue.index === "number" && Number.isInteger(queue.index) && queue.index >= 0 && queue.index < queue.entries.length &&
    new Set(queue.entries.map((entry) => entry.occurrenceId)).size === queue.entries.length &&
    queue.entries[queue.index].trackId === value.trackId &&
    (queue.shuffleSeed === null || (typeof queue.shuffleSeed === "number" && Number.isInteger(queue.shuffleSeed))) &&
    typeof value.trackId === "string" && typeof value.exactPositionMs === "number" && Number.isFinite(value.exactPositionMs) &&
    value.exactPositionMs >= 0 && typeof value.playing === "boolean" && typeof value.volume === "number" && value.volume >= 0 && value.volume <= 1 &&
    typeof queue.repeatOne === "boolean" && typeof queue.shuffle === "boolean" && typeof queue.albumAware === "boolean" &&
    (queue.shuffleMode === "standard" || queue.shuffleMode === "smart") &&
    (queue.context === null || (object(queue.context) && typeof queue.context.id === "string" && typeof queue.context.type === "string" && typeof queue.context.name === "string"));
}
function remoteCommand(value: unknown): value is RemoteCommand {
  if (!object(value)) return false;
  const occurrence = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 160;
  return value.type === "PLAY" || value.type === "PAUSE" ||
    value.type === "TOGGLE_SHUFFLE" || value.type === "TOGGLE_REPEAT" ||
    (value.type === "PLAY_QUEUE_ENTRY" && occurrence(value.entry_id)) ||
    (value.type === "MOVE_QUEUE_ENTRY" && occurrence(value.entry_id) && occurrence(value.target_id)) ||
    (value.type === "ENQUEUE" && typeof value.next === "boolean" && typeof value.dedupe === "boolean" &&
      Array.isArray(value.tracks) && value.tracks.length > 0 && value.tracks.length <= 1000 &&
      value.tracks.every(track => object(track) && typeof track.id === "string" && track.id.length > 0 && track.id.length <= 1024)) ||
    (value.type === "SKIP" && (value.direction === "next" || value.direction === "previous")) ||
    (value.type === "SEEK" && typeof value.position_ms === "number" && Number.isFinite(value.position_ms) && value.position_ms >= 0) ||
    (value.type === "SET_VOLUME" && typeof value.volume === "number" && value.volume >= 0 && value.volume <= 1);
}
export function useRemoteSession(userId: string | null, adapter: RemotePlayerAdapter): RemoteSessionValue {
  const [deviceId] = useState(identity);
  const [name, setName] = useState(() => `This ${deviceKind() === "computer" ? "Computer" : deviceKind() === "phone" ? "Phone" : "Web Player"}`);
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<RemoteSessionValue["status"]>("unavailable");
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const adapterRef = useRef(adapter); adapterRef.current = adapter;
  const metadata = useRef({ name, enabled }); metadata.current = { name, enabled };
  const pending = useRef(new Map<string, { resolve(): void; reject(error: Error): void; timer: number }>());
  const continuous = useRef(new Map<string, { command: RemoteCommand; timer: number;
    waiters: Array<{ resolve(): void; reject(error: unknown): void }> }>());
  const prepared = useRef<{ id: string; controller: AbortController; role: "source" | "target"; paused: boolean } | null>(null);
  const send = useCallback((payload: object) => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("Device control is disconnected. Reconnect and retry.");
    if (ws.bufferedAmount > 1024 * 1024) throw new Error("Device control is congested. Wait and retry.");
    const encoded = JSON.stringify(payload);
    if (new Blob([encoded]).size > 1024 * 1024) throw new Error("This queue is too large to transfer. Use a smaller library queue.");
    ws.send(encoded);
  }, []);
  const registration = useCallback(() => send({ type: "REGISTER", device_id: deviceId, device_name: metadata.current.name,
    queue_device_id: queueDeviceId(),
    device_type: deviceKind(), can_receive: metadata.current.enabled, state: adapterRef.current.state() }), [deviceId, send]);
  const request = useCallback((type: "COMMAND" | "TRANSFER_PLAYBACK", payload: object): Promise<void> => new Promise((resolve, reject) => {
    const requestId = identity();
    const timer = window.setTimeout(() => {
      pending.current.delete(requestId); const failure = new Error("The device did not finish this request. Check both devices before retrying.");
      setError(failure.message); reject(failure);
    }, type === "COMMAND" ? 10000 : 25000);
    pending.current.set(requestId, { resolve, reject, timer });
    try { send({ type, requestId, ...payload }); }
    catch (failure) { window.clearTimeout(timer); pending.current.delete(requestId); reject(failure); }
  }), [send]);
  useEffect(() => {
    const operations = pending.current;
    const controlWindows = continuous.current;
    if (!userId || typeof WebSocket === "undefined") { setStatus("unavailable"); setDevices([]); return; }
    let closed = false;
    let reconnect: number | undefined;
    let attempt = 0;
    let lastPlaying = false;
    let lastState = "";
    let commandChain: Promise<void> = Promise.resolve();
    const fail = (failure: unknown) => {
      if (closed) return;
      const message = failure instanceof Error ? failure.message : "Remote playback failed";
      console.error("Remote session:", failure); setError(message);
    };
    const cancelPreparation = () => {
      const transfer = prepared.current;
      if (!transfer) return;
      transfer.controller.abort();
      if (transfer.role === "target") adapterRef.current.pause();
      prepared.current = null;
    };
    const settle = (message: Record<string, unknown>) => {
      if (typeof message.requestId !== "string") return;
      const operation = pending.current.get(message.requestId);
      if (!operation) return;
      pending.current.delete(message.requestId); window.clearTimeout(operation.timer);
      if (message.ok === true) operation.resolve();
      else {
        const failure = new Error(typeof message.message === "string" ? message.message : "Remote request failed");
        fail(failure); operation.reject(failure);
      }
    };
    const handle = async (message: Record<string, unknown>) => {
      if (message.type === "QUEUE_CHANGED") {
        if (queueSyncClient.getSnapshot().owner === userId) queueSyncClient.invalidate();
        return;
      }
      if (message.type === "DEVICES") {
        if (!Array.isArray(message.devices) || !message.devices.every(device)) throw new Error("Invalid remote device registry");
        setDevices(message.devices); return;
      }
      if (message.type === "ERROR") {
        if (typeof message.requestId === "string") settle({ ...message, ok: false });
        else fail(new Error(typeof message.message === "string" ? message.message : "Remote protocol error"));
        return;
      }
      if (message.type === "COMMAND_RESULT" || message.type === "TRANSFER_RESULT") { settle(message); return; }
      if (message.type === "DEACTIVATE") { adapterRef.current.pause(); return; }
      if (message.type === "EXECUTE" && typeof message.requestId === "string" && remoteCommand(message.command)) {
        const requestId = message.requestId, command = message.command;
        commandChain = commandChain.then(async () => {
          if (closed || socket.current?.readyState !== WebSocket.OPEN) return;
          try { await adapterRef.current.command(command); send({ type: "COMMAND_RESULT", requestId, ok: true }); }
          catch (failure) {
            fail(failure); send({ type: "COMMAND_RESULT", requestId, ok: false, message: failure instanceof Error ? failure.message : "Player command failed" });
          }
        }).catch(fail);
        return;
      }
      if (typeof message.transferId !== "string") throw new Error("Invalid remote protocol message");
      const transferId = message.transferId;
      if (message.type === "REQUEST_SNAPSHOT") {
        cancelPreparation();
        prepared.current = { id: transferId, controller: new AbortController(), role: "source", paused: false };
        try { send({ type: "SNAPSHOT", transferId, snapshot: adapterRef.current.capture() }); }
        catch (failure) { send({ type: "TRANSFER_FAILED", transferId, message: failure instanceof Error ? failure.message : "Could not capture playback" }); }
      } else if (message.type === "INITIALIZE_PLAYER" && snapshot(message.snapshot)) {
        cancelPreparation();
        const controller = new AbortController();
        prepared.current = { id: transferId, controller, role: "target", paused: false };
        try {
          if (!metadata.current.enabled) throw new Error("Enable playback on the target device first");
          await adapterRef.current.prepare(message.snapshot, controller.signal);
          if (!controller.signal.aborted && prepared.current?.id === transferId) send({ type: "READY", transferId });
        } catch (failure) {
          if (controller.signal.aborted) return;
          adapterRef.current.pause(); fail(failure);
          send({ type: "TRANSFER_FAILED", transferId, message: failure instanceof Error ? failure.message : "Target preparation failed" });
        }
      } else if (message.type === "PAUSE_FOR_TRANSFER" && prepared.current?.id === transferId && prepared.current.role === "source") {
        try {
          const captured = adapterRef.current.capture();
          adapterRef.current.pause(); prepared.current.paused = true;
          send({ type: "SOURCE_PAUSED", transferId, snapshot: captured });
        } catch (failure) {
          fail(failure);
          send({ type: "TRANSFER_FAILED", transferId, message: failure instanceof Error ? failure.message : "Could not pause the source" });
        }
      } else if (message.type === "START_TRANSFER" && prepared.current?.id === transferId && prepared.current.role === "target" && snapshot(message.snapshot)) {
        try {
          await adapterRef.current.start(message.snapshot);
          if (prepared.current?.id !== transferId) { adapterRef.current.pause(); return; }
          send({ type: "STARTED", transferId });
        } catch (failure) {
          adapterRef.current.pause(); fail(failure);
          send({ type: "TRANSFER_FAILED", transferId, message: failure instanceof Error ? failure.message : "Target playback failed" });
        }
      } else if (message.type === "ABORT_TRANSFER" && prepared.current?.id === transferId) {
        const resume = message.resume === true && prepared.current.role === "source" && prepared.current.paused;
        cancelPreparation();
        if (resume) await adapterRef.current.command({ type: "PLAY" });
      } else if (message.type === "TRANSFER_COMPLETE" && prepared.current?.id === transferId) {
        prepared.current.controller.abort(); prepared.current = null;
      } else throw new Error("Invalid or stale playback transfer message");
    };
    const connect = () => {
      if (closed) return;
      setStatus(attempt ? "reconnecting" : "connecting");
      const url = resolveRemoteSocketUrl();
      if (!url) {
        reconnect = window.setTimeout(connect, 1000);
        return;
      }
      const ws = new WebSocket(url); socket.current = ws;
      ws.onopen = () => {
        if (closed) { ws.close(); return; }
        attempt = 0; setStatus("connected"); lastState = ""; lastPlaying = false;
        try { registration(); } catch (failure) { fail(failure); ws.close(); }
      };
      ws.onmessage = (event) => {
        if (closed || socket.current !== ws) return;
        try {
          const message: unknown = JSON.parse(String(event.data));
          if (!object(message)) throw new Error("Invalid remote payload");
          void handle(message).catch(fail);
        } catch (failure) { fail(failure); }
      };
      ws.onerror = () => { if (!closed) setError("Device control connection failed. Reconnecting automatically."); };
      ws.onclose = (event) => {
        if (closed || socket.current !== ws) return;
        socket.current = null;
        cancelPreparation();
        for (const operation of operations.values()) {
          window.clearTimeout(operation.timer); operation.reject(new Error("Device control disconnected. Check playback before retrying."));
        }
        pending.current.clear();
        if (closed) return;
        setError("Device control disconnected. Check playback before retrying.");
        setDevices([]);
        if (event.code === 4001 || event.code === 4009) { setStatus("unavailable"); setError(event.reason || "Remote session ended"); return; }
        setStatus("reconnecting");
        reconnect = window.setTimeout(connect, Math.min(30000, 500 * 2 ** Math.min(attempt++, 6)) + Math.random() * 200);
      };
    };
    connect();
    const reconnectForServerChange = () => {
      window.clearTimeout(reconnect);
      if (socket.current) socket.current.close(1000, "Server connection changed");
      else connect();
    };
    window.addEventListener(DESKTOP_CONFIG_CHANGED_EVENT, reconnectForServerChange);
    const publishState = () => {
      if (socket.current?.readyState !== WebSocket.OPEN) return;
      const state = adapterRef.current.state();
      const claim = state.playing && !lastPlaying && !prepared.current;
      if (!prepared.current) lastPlaying = state.playing;
      const serialized = JSON.stringify(state);
      if (serialized === lastState && !claim) return;
      lastState = serialized;
      try { send({ type: "STATE", state, claim }); } catch (failure) { fail(failure); }
    };
    let heartbeat: number | undefined;
    let interval = 0;
    const updateHeartbeat = () => {
      // The socket still carries commands and transfers while backgrounded.
      const nextInterval = getVisualActivity() ? 500 : 2000;
      if (interval === nextInterval) return;
      window.clearInterval(heartbeat);
      heartbeat = window.setInterval(publishState, nextInterval);
      if (interval && nextInterval < interval) publishState();
      interval = nextInterval;
    };
    const unsubscribeVisibility = subscribeVisualActivity(updateHeartbeat);
    updateHeartbeat();
    return () => {
      closed = true; window.clearTimeout(reconnect); window.clearInterval(heartbeat); unsubscribeVisibility();
      window.removeEventListener(DESKTOP_CONFIG_CHANGED_EVENT, reconnectForServerChange);
      cancelPreparation(); socket.current?.close(1000, "Account or view closed"); socket.current = null;
      for (const operation of operations.values()) {
        window.clearTimeout(operation.timer); operation.reject(new Error("Remote session closed"));
      }
      operations.clear(); setDevices([]); setEnabled(false);
      for (const operation of controlWindows.values()) {
        window.clearTimeout(operation.timer);
        operation.waiters.forEach((waiter) => waiter.reject(new Error("Remote session closed")));
      }
      controlWindows.clear();
    };
  }, [userId, deviceId, registration, send]);
  useEffect(() => {
    if (socket.current?.readyState === WebSocket.OPEN) registration();
  }, [name, enabled, registration]);
  const command = useCallback(async (command: RemoteCommand, targetId?: string) => {
    try {
      if (command.type !== "SEEK" && command.type !== "SET_VOLUME") { await request("COMMAND", { command, targetId }); return; }
      // Continuous controls keep only the latest value in each 80 ms window.
      await new Promise<void>((resolve, reject) => {
        const key = `${targetId || "active"}:${command.type}`;
        const queued = continuous.current.get(key);
        if (queued) { queued.command = command; queued.waiters.push({ resolve, reject }); return; }
        const group = { command, waiters: [{ resolve, reject }], timer: window.setTimeout(() => {
          continuous.current.delete(key);
          void request("COMMAND", { command: group.command, targetId }).then(
            () => group.waiters.forEach((waiter) => waiter.resolve()),
            (failure: unknown) => group.waiters.forEach((waiter) => waiter.reject(failure)),
          );
        }, 80) };
        continuous.current.set(key, group);
      });
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Remote command failed"); throw failure; }
  }, [request]);
  const transfer = useCallback(async (targetId: string) => {
    setBusy(true); setError("");
    try { await request("TRANSFER_PLAYBACK", { targetId }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Playback transfer failed"); throw failure; }
    finally { setBusy(false); }
  }, [request]);
  const enable = useCallback(async () => {
    setError("");
    try { await adapterRef.current.enable(); setEnabled(true); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not enable playback"); throw failure; }
  }, []);
  const activeDevice = devices.find((item) => item.is_active_player) ?? null;
  return { status, deviceId, devices, activeDevice, isRemote: Boolean(activeDevice && activeDevice.device_id !== deviceId), enabled, busy, error, name,
    enable, command, transfer, rename: (next) => { const value = next.trim(); if (value && value.length <= 80) setName(value); },
    clearError: () => setError("") };
}
