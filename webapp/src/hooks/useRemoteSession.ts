import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackState, RemoteCommand, RemoteDevice, RemotePlaybackSnapshot, RemotePlayerAdapter, RemoteSessionValue } from "../types/remoteSession";
import { isMediaResumeContext } from "../services/mediaSessions";
import { getVisualActivity, subscribeVisualActivity } from "../services/visualActivity";
import { queueDeviceId, queueSyncClient } from "../services/QueueSyncClient";
import { DESKTOP_CONFIG_CHANGED_EVENT, isDesktopRuntime, resolveRemoteSocketUrl } from "../services/desktop/desktopRuntime";

function deviceKind(): RemoteDevice["device_type"] {
  if (/iPad|Tablet/i.test(navigator.userAgent)) return "tablet";
  if (/Mobi|iPhone|Android/i.test(navigator.userAgent)) return "phone";
  return "computer";
}
function defaultDeviceName(): string {
  if (isDesktopRuntime()) return "MusicDeck Desktop";
  const kind = deviceKind();
  return kind === "phone" ? "Phone" : kind === "tablet" ? "Tablet" : "Computer Browser";
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
function livePlayback(value: unknown): value is Omit<PlaybackState, "queue"> {
  if (!object(value)) return false;
  return (value.device_id === null || typeof value.device_id === "string") &&
    typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision > 0 &&
    typeof value.updated_at === "number" && Number.isFinite(value.updated_at) &&
    device({ ...value, device_id: "active", device_name: "", device_type: "web", is_active_player: true,
      can_receive: false, current_track: value.track, playing: value.is_playing });
}
function liveQueue(value: unknown): value is NonNullable<PlaybackState["queue"]> {
  return object(value) && Array.isArray(value.entries) && value.entries.length <= 5000 &&
    typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0 &&
    (value.entries.length === 0 || value.index < value.entries.length) &&
    typeof value.repeatOne === "boolean" && typeof value.shuffle === "boolean" && typeof value.albumAware === "boolean" &&
    (value.shuffleMode === "standard" || value.shuffleMode === "smart") &&
    (value.context === null || (object(value.context) && typeof value.context.type === "string" &&
      typeof value.context.id === "string" && typeof value.context.name === "string")) &&
    value.entries.every(entry => object(entry) && typeof entry.occurrenceId === "string" && typeof entry.trackId === "string" &&
      typeof entry.title === "string" && typeof entry.artist === "string" && typeof entry.album === "string" &&
      typeof entry.duration === "number" && Number.isFinite(entry.duration) && entry.duration >= 0);
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
  const tracks = (items: unknown): items is unknown[] => Array.isArray(items) && items.length > 0 && items.length <= 1000 &&
    items.every(track => object(track) && typeof track.id === "string" && track.id.length > 0 && track.id.length <= 1024);
  const context = value.context;
  return value.type === "PLAY" || value.type === "PAUSE" ||
    value.type === "TOGGLE_SHUFFLE" || value.type === "TOGGLE_REPEAT" ||
    (value.type === "PLAY_QUEUE_ENTRY" && occurrence(value.entry_id)) ||
    (value.type === "MOVE_QUEUE_ENTRY" && occurrence(value.entry_id) && occurrence(value.target_id)) ||
    (value.type === "ENQUEUE" && typeof value.next === "boolean" && typeof value.dedupe === "boolean" && tracks(value.tracks)) ||
    (value.type === "PLAY_SELECTION" && tracks(value.tracks) && typeof value.from_here === "boolean" &&
      typeof value.start_index === "number" && Number.isInteger(value.start_index) &&
      value.start_index >= 0 && value.start_index < value.tracks.length &&
      (context === null || (object(context) && typeof context.type === "string" && typeof context.id === "string" &&
        typeof context.name === "string" && (context.coverArt === null || typeof context.coverArt === "string")))) ||
    (value.type === "SKIP" && (value.direction === "next" || value.direction === "previous")) ||
    (value.type === "SEEK" && typeof value.position_ms === "number" && Number.isFinite(value.position_ms) && value.position_ms >= 0) ||
    (value.type === "SET_VOLUME" && typeof value.volume === "number" && value.volume >= 0 && value.volume <= 1);
}
export function useRemoteSession(userId: string | null, adapter: RemotePlayerAdapter): RemoteSessionValue {
  const [deviceId] = useState(identity);
  const [name, setName] = useState(defaultDeviceName);
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<RemoteSessionValue["status"]>("unavailable");
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const selectedDevice = useRef<string | undefined>(undefined);
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const playbackClock = useRef({ position: 0, sampledAt: 0, duration: 0, playing: false });
  const readPosition = useCallback(() => {
    const { position, sampledAt, duration, playing } = playbackClock.current;
    const estimate = position + (playing ? Math.max(0, performance.now() - sampledAt) / 1000 : 0);
    return duration > 0 ? Math.min(estimate, duration) : estimate;
  }, []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const publish = useRef<(() => void) | null>(null);
  const publishPosition = useCallback(() => publish.current?.(), []);
  const queueDirty = useRef(true);
  const adapterRef = useRef(adapter); adapterRef.current = adapter;
  const metadata = useRef({ name, enabled }); metadata.current = { name, enabled };
  const pending = useRef(new Map<string, { resolve(): void; reject(error: Error): void; timer: number; deadline: number }>());
  const clockOffset = useRef<number | null>(null);
  const timeOrigin = useRef(Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : Date.now() - performance.now());
  const continuous = useRef(new Map<string, { command: RemoteCommand; timer: number; send(): void;
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
  const registration = useCallback(() => {
    const state = adapterRef.current.state();
    send({ type: "REGISTER", device_id: deviceId, device_name: metadata.current.name, queue_device_id: queueDeviceId(),
      device_type: deviceKind(), can_receive: metadata.current.enabled, state, live_sync: true, command_deadlines: true });
    return state;
  }, [deviceId, send]);
  const request = useCallback((type: "COMMAND" | "TRANSFER_PLAYBACK", payload: object): Promise<void> => new Promise((resolve, reject) => {
    const requestId = identity();
    const timeout = type === "COMMAND" ? 10_000 : 25_000;
    const deadline = performance.now() + timeout;
    const expiresAt = Math.floor(timeOrigin.current + deadline + (clockOffset.current ?? 0));
    const timer = window.setTimeout(() => {
      pending.current.delete(requestId); const failure = new Error("The device did not finish this request. Check both devices before retrying.");
      setError(failure.message); reject(failure);
    }, timeout);
    pending.current.set(requestId, { resolve, reject, timer, deadline });
    try { send({ type, requestId, ...(type === "COMMAND" ? { expiresAt } : {}), ...payload }); }
    catch (failure) { window.clearTimeout(timer); pending.current.delete(requestId); reject(failure); }
  }), [send]);
  useEffect(() => {
    const operations = pending.current;
    const controlWindows = continuous.current;
    if (!userId || typeof WebSocket === "undefined") { setStatus("unavailable"); setDevices([]); setPlayback(null); return; }
    let closed = false;
    let reconnect: number | undefined;
    let handshake: number | undefined;
    let watchdog: number | undefined;
    let controlTimeout = 0;
    let executing: AbortController | null = null;
    let connectionLifetime = new AbortController();
    let attempt = 0;
    let lastPlaying = false;
    let lastState = "";
    let localPlaying = false;
    let positionTimer: number | undefined;
    let retryState = false;
    let liveSync = false;
    let synced: PlaybackState | null = null;
    let reportedQueue: ReturnType<NonNullable<RemotePlayerAdapter["queue"]>> | undefined;
    let clockSamples: { offset: number; sampledAt: number }[] = [];
    const observeClock = (serverTime: number) => {
      const sampledAt = performance.now();
      const offset = serverTime - (timeOrigin.current + sampledAt);
      clockSamples = [...clockSamples.filter(sample => sampledAt - sample.sampledAt < 60_000), { offset, sampledAt }].slice(-7);
      const sorted = clockSamples.map(sample => sample.offset).sort((a, b) => a - b);
      clockOffset.current = sorted[Math.floor(sorted.length / 2)];
      return { sampledAt, transit: Math.max(0, Math.min(2000, clockOffset.current - offset)) };
    };
    const resetPlayback = () => {
      window.clearTimeout(positionTimer);
      positionTimer = undefined;
      localPlaying = false;
      retryState = false;
      synced = null;
      liveSync = false;
      window.clearTimeout(handshake);
      window.clearTimeout(watchdog);
      controlTimeout = 0;
      clockOffset.current = null;
      clockSamples = [];
      playbackClock.current.playing = false;
      setPlayback(null);
    };
    let commandChain: Promise<void> = Promise.resolve();
    const fail = (failure: unknown) => {
      if (closed) return;
      const message = failure instanceof Error ? failure.message : "Remote playback failed";
      console.error("Remote session:", failure); setError(message);
    };
    const cancelPreparation = () => {
      const transfer = prepared.current;
      if (!transfer) return;
      prepared.current = null;
      transfer.controller.abort();
      if (transfer.role === "target") adapterRef.current.pause();
    };
    const stopControlledPlayback = () => {
      if (connectionLifetime.signal.aborted) return;
      try {
        if (executing || synced?.device_id === deviceId || selectedDevice.current === deviceId || localPlaying) {
          adapterRef.current.pause();
        }
      } catch (failure) {
        fail(failure);
      } finally {
        executing?.abort();
        connectionLifetime.abort();
        try { cancelPreparation(); } catch (failure) { fail(failure); }
      }
    };
    const armWatchdog = () => {
      window.clearTimeout(watchdog);
      if (!controlTimeout) return;
      watchdog = window.setTimeout(() => {
        stopControlledPlayback();
        socket.current?.close(4003, "Device control heartbeat timed out");
      }, controlTimeout);
    };
    const settle = (message: Record<string, unknown>) => {
      if (typeof message.requestId !== "string") return;
      const operation = pending.current.get(message.requestId);
      if (!operation) return;
      pending.current.delete(message.requestId); window.clearTimeout(operation.timer);
      if (performance.now() >= operation.deadline) {
        operation.reject(new Error("The device did not finish this request in time."));
      } else if (message.ok === true) operation.resolve();
      else {
        const failure = new Error(typeof message.message === "string" ? message.message : "Remote request failed");
        fail(failure); operation.reject(failure);
      }
    };
    const handle = async (message: Record<string, unknown>) => {
      if (message.type === "REMOTE_HEARTBEAT" && typeof message.server_time === "number" && Number.isFinite(message.server_time)) {
        observeClock(message.server_time);
        armWatchdog();
        return;
      }
      if (message.type === "INITIAL_STATE" || message.type === "STATE_SYNC") {
        const state = message.state;
        const incomingQueue = message.queue;
        if (!livePlayback(state) || typeof message.server_time !== "number" || !Number.isFinite(message.server_time) ||
            (incomingQueue != null && !liveQueue(incomingQueue))) {
          throw new Error("Invalid account playback state");
        }
        if (synced && state.revision <= synced.revision) return;
        const samplingChanged = !liveSync || synced?.device_id !== state.device_id ||
          synced?.is_playing !== state.is_playing;
        liveSync = true;
        const queue = "queue" in message
          ? incomingQueue ?? null
          : synced?.queue ?? null;
        synced = { ...state, queue };
        const { sampledAt, transit } = observeClock(message.server_time);
        const age = Math.max(0, message.server_time - state.updated_at + transit);
        playbackClock.current = { position: state.position_ms / 1000, sampledAt: sampledAt - age,
          duration: state.duration_ms / 1000, playing: state.is_playing };
        setPlayback(synced);
        if (message.type === "INITIAL_STATE") {
          window.clearTimeout(handshake);
          attempt = 0;
          setError("");
          controlTimeout = message.controlTimeoutMs === 25_000 ? 25_000 : 0;
          armWatchdog();
          setStatus("connected");
          publish.current?.();
        } else if (samplingChanged) {
          schedulePositionSample();
        }
        return;
      }
      if (message.type === "QUEUE_CHANGED") {
        if (queueSyncClient.getSnapshot().owner === userId) queueSyncClient.invalidate();
        return;
      }
      if (message.type === "DEVICES") {
        if (!Array.isArray(message.devices) || !message.devices.every(device)) throw new Error("Invalid remote device registry");
        selectedDevice.current = message.devices.find(item => item.is_active_player)?.device_id;
        setDevices(message.devices);
        if (message.live_state_protocol !== true) {
          window.clearTimeout(handshake);
          setError("");
          setStatus("connected");
        }
        return;
      }
      if (message.type === "ERROR") {
        if (typeof message.requestId === "string") settle({ ...message, ok: false });
        else fail(new Error(typeof message.message === "string" ? message.message : "Remote protocol error"));
        return;
      }
      if (message.type === "COMMAND_RESULT" || message.type === "TRANSFER_RESULT") { settle(message); return; }
      if (message.type === "DEACTIVATE") {
        executing?.abort();
        cancelPreparation();
        adapterRef.current.pause();
        return;
      }
      if (message.type === "EXECUTE" && typeof message.requestId === "string" && remoteCommand(message.command)) {
        const requestId = message.requestId, command = message.command;
        const commandSocket = socket.current;
        const expiresAt = typeof message.expiresAt === "number" ? message.expiresAt : undefined;
        const serverNow = clockOffset.current === null ? null : timeOrigin.current + performance.now() + clockOffset.current;
        const budget = Math.min(typeof message.timeoutMs === "number" ? message.timeoutMs : 8000,
          typeof message.deadlineAt === "number" && serverNow !== null ? message.deadlineAt - serverNow : Infinity);
        const deadline = performance.now() + budget;
        commandChain = commandChain.then(async () => {
          if (closed || socket.current !== commandSocket || commandSocket?.readyState !== WebSocket.OPEN) return;
          const remaining = deadline - performance.now();
          if (!(remaining > 0) || connectionLifetime.signal.aborted) {
            send({ type: "COMMAND_RESULT", requestId, expiresAt, ok: false, message: "Playback command expired before execution" });
            return;
          }
          const controller = new AbortController();
          executing = controller;
          const timeout = window.setTimeout(() => {
            if (socket.current !== commandSocket || controller.signal.aborted) return;
            controller.abort();
            adapterRef.current.pause();
          }, remaining);
          try {
            await adapterRef.current.command(command, controller.signal);
            if (socket.current === commandSocket && !controller.signal.aborted) {
              if (performance.now() >= deadline) {
                controller.abort();
                adapterRef.current.pause();
              } else {
                send({ type: "COMMAND_RESULT", requestId, expiresAt, ok: true, state: adapterRef.current.state() });
              }
            }
          }
          catch (failure) {
            if (socket.current !== commandSocket || controller.signal.aborted) return;
            fail(failure); send({ type: "COMMAND_RESULT", requestId, expiresAt, ok: false, message: failure instanceof Error ? failure.message : "Player command failed" });
          } finally {
            window.clearTimeout(timeout);
            if (executing === controller) executing = null;
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
        const signal = prepared.current.controller.signal;
        try {
          await adapterRef.current.start(message.snapshot, signal);
          if (signal.aborted || prepared.current?.id !== transferId) return;
          const queue = adapterRef.current.queue?.();
          send({ type: "STARTED", transferId,
            queue: queue && new Blob([JSON.stringify(queue)]).size < 1000 * 1024 ? queue : undefined });
        } catch (failure) {
          if (signal.aborted || prepared.current?.id !== transferId) return;
          adapterRef.current.pause(); fail(failure);
          prepared.current.controller.abort();
          send({ type: "TRANSFER_FAILED", transferId, message: failure instanceof Error ? failure.message : "Target playback failed" });
        }
      } else if (message.type === "ABORT_TRANSFER" && prepared.current?.id === transferId) {
        const target = prepared.current.role === "target";
        const resume = message.resume === true && prepared.current.role === "source" && prepared.current.paused;
        cancelPreparation();
        if (target) send({ type: "TRANSFER_ROLLED_BACK", transferId });
        if (resume && !connectionLifetime.signal.aborted) await adapterRef.current.command({ type: "PLAY" }, connectionLifetime.signal);
      } else if (message.type === "TRANSFER_COMPLETE" && prepared.current?.id === transferId) {
        adapterRef.current.commitTransfer?.(prepared.current.controller.signal);
        prepared.current.controller.abort(); prepared.current = null;
      } else throw new Error("Invalid or stale playback transfer message");
    };
    const scheduleReconnect = () => {
      if (!closed) reconnect = window.setTimeout(connect, Math.min(30000, 500 * 2 ** Math.min(attempt++, 6)) + Math.random() * 200);
    };
    const connect = () => {
      if (closed) return;
      setStatus(attempt ? "reconnecting" : "connecting");
      const url = resolveRemoteSocketUrl();
      if (!url) {
        scheduleReconnect();
        return;
      }
      const ws = new WebSocket(url); socket.current = ws;
      commandChain = Promise.resolve();
      connectionLifetime = new AbortController();
      handshake = window.setTimeout(() => {
        if (socket.current === ws) ws.close(4000, "Device control handshake timed out");
      }, 12_000);
      ws.onopen = () => {
        if (closed) { ws.close(); return; }
        if (socket.current !== ws) return;
        queueDirty.current = true;
        reportedQueue = undefined;
        try {
          const state = registration();
          lastPlaying = state.playing;
          lastState = JSON.stringify(state);
          publishState();
        } catch (failure) { fail(failure); ws.close(); }
      };
      ws.onmessage = (event) => {
        if (closed || socket.current !== ws) return;
        try {
          const message: unknown = JSON.parse(String(event.data));
          if (!object(message)) throw new Error("Invalid remote payload");
          void handle(message).catch(fail);
        } catch (failure) { fail(failure); }
      };
      ws.onerror = () => {
        if (!closed && socket.current === ws) {
          stopControlledPlayback();
          setError("Device control connection failed. Reconnecting automatically.");
        }
      };
      ws.onclose = (event) => {
        if (closed || socket.current !== ws) return;
        stopControlledPlayback();
        socket.current = null;
        selectedDevice.current = undefined;
        resetPlayback();
        for (const operation of operations.values()) {
          window.clearTimeout(operation.timer); operation.reject(new Error("Device control disconnected. Check playback before retrying."));
        }
        pending.current.clear();
        for (const operation of controlWindows.values()) {
          window.clearTimeout(operation.timer);
          operation.waiters.forEach(waiter => waiter.reject(new Error("Device control disconnected")));
        }
        controlWindows.clear();
        if (closed) return;
        setError("Device control disconnected. Check playback before retrying.");
        setDevices([]);
        if (event.code === 4001 || event.code === 4009) { setStatus("unavailable"); setError(event.reason || "Remote session ended"); return; }
        setStatus("reconnecting");
        scheduleReconnect();
      };
    };
    const reconnectForServerChange = () => {
      window.clearTimeout(reconnect);
      if (socket.current) socket.current.close(1000, "Server connection changed");
      else connect();
    };
    window.addEventListener(DESKTOP_CONFIG_CHANGED_EVENT, reconnectForServerChange);
    const pageHidden = () => {
      stopControlledPlayback();
      socket.current?.close(1000, "Player view closed");
    };
    window.addEventListener("pagehide", pageHidden);
    const publishState = () => {
      if (socket.current?.readyState !== WebSocket.OPEN) return;
      const state = adapterRef.current.state();
      localPlaying = state.playing;
      const claim = state.playing && !lastPlaying && !prepared.current;
      const serialized = JSON.stringify(state);
      const queue = queueDirty.current ? adapterRef.current.queue?.() : undefined;
      const updatedQueue = queue !== reportedQueue ? queue : undefined;
      if (serialized === lastState && !claim && !updatedQueue) {
        queueDirty.current = false;
        retryState = false;
        schedulePositionSample();
        return;
      }
      try {
        const payload = { type: "STATE", state, claim };
        // Very large queues can still be followed through the saved account queue.
        const fits = updatedQueue && new Blob([JSON.stringify(updatedQueue)]).size < 1000 * 1024;
        send(fits ? { ...payload, queue: updatedQueue } : updatedQueue ? { ...payload, clear_queue: true } : payload);
        if (updatedQueue) reportedQueue = updatedQueue;
        queueDirty.current = false;
        lastState = serialized;
        retryState = false;
        if (!prepared.current) lastPlaying = state.playing;
      } catch (failure) {
        retryState = (socket.current?.bufferedAmount ?? 0) > 1024 * 1024;
        fail(failure);
      }
      schedulePositionSample();
    };
    publish.current = publishState;
    const ownsPlayingOutput = () => localPlaying &&
      (!liveSync || (synced?.device_id === deviceId && synced.is_playing));
    const schedulePositionSample = () => {
      window.clearTimeout(positionTimer);
      positionTimer = undefined;
      if (closed || socket.current?.readyState !== WebSocket.OPEN ||
          (!retryState && !ownsPlayingOutput())) return;
      const active = getVisualActivity();
      const delay = retryState || !liveSync
        ? (active ? 1000 : 5000)
        : (active ? 10_000 : 20_000);
      positionTimer = window.setTimeout(publishState, delay);
    };
    // Server WebSocket pings and remote commands are independent of position samples.
    const unsubscribeVisibility = subscribeVisualActivity(() => {
      if (getVisualActivity() && ownsPlayingOutput()) publishState();
      else schedulePositionSample();
    });
    // Let an immediately cleaned-up effect cancel startup before opening a socket.
    reconnect = window.setTimeout(connect, 0);
    return () => {
      closed = true; window.clearTimeout(reconnect); unsubscribeVisibility();
      publish.current = null;
      window.removeEventListener(DESKTOP_CONFIG_CHANGED_EVENT, reconnectForServerChange);
      window.removeEventListener("pagehide", pageHidden);
      stopControlledPlayback(); socket.current?.close(1000, "Account or view closed"); socket.current = null;
      for (const operation of operations.values()) {
        window.clearTimeout(operation.timer); operation.reject(new Error("Remote session closed"));
      }
      operations.clear(); setDevices([]); setEnabled(false);
      selectedDevice.current = undefined;
      resetPlayback();
      for (const operation of controlWindows.values()) {
        window.clearTimeout(operation.timer);
        operation.waiters.forEach((waiter) => waiter.reject(new Error("Remote session closed")));
      }
      controlWindows.clear();
    };
  }, [userId, deviceId, registration, send]);
  useEffect(() => {
    if (socket.current?.readyState === WebSocket.OPEN) registration();
  }, [name, registration]);
  const { current_track, playing, volume, duration_ms } = adapter.state();
  // Track and transport changes are immediate. Only the playing output samples position.
  const transportKey = JSON.stringify([current_track, playing, volume, duration_ms]);
  useEffect(() => { queueDirty.current = true; publish.current?.(); }, [adapter.queue]);
  useEffect(() => { publish.current?.(); }, [transportKey]);
  const command = useCallback(async (command: RemoteCommand, targetId?: string) => {
    try {
      targetId ??= selectedDevice.current;
      const key = `${targetId || "active"}:${command.type}`;
      for (const [queuedKey, operation] of continuous.current) {
        if (queuedKey !== key) operation.send();
      }
      if (command.type !== "SEEK" && command.type !== "SET_VOLUME") { await request("COMMAND", { command, targetId }); return; }
      // Continuous controls keep only the latest value in each 80 ms window.
      await new Promise<void>((resolve, reject) => {
        const queued = continuous.current.get(key);
        if (queued) { queued.command = command; queued.waiters.push({ resolve, reject }); return; }
        const dispatch = () => {
          window.clearTimeout(group.timer);
          continuous.current.delete(key);
          void request("COMMAND", { command: group.command, targetId }).then(
            () => group.waiters.forEach((waiter) => waiter.resolve()),
            (failure: unknown) => group.waiters.forEach((waiter) => waiter.reject(failure)),
          );
        };
        const group = { command, waiters: [{ resolve, reject }], send: dispatch, timer: window.setTimeout(dispatch, 80) };
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
    try {
      await adapterRef.current.enable();
      metadata.current.enabled = true;
      setEnabled(true);
      if (socket.current?.readyState === WebSocket.OPEN) registration();
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not enable playback"); throw failure; }
  }, [registration]);
  const activeDevice = devices.find((item) => item.is_active_player) ?? null;
  return { status, deviceId, devices, activeDevice, playback, readPosition, publishPosition,
    ordersCommands: playback !== null,
    isRemote: Boolean(activeDevice && activeDevice.device_id !== deviceId), enabled, busy, error, name,
    enable, command, transfer, rename: (next) => { const value = next.trim(); if (value && value.length <= 80) setName(value); },
    clearError: () => setError("") };
}
