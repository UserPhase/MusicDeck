// One tracker per player, not per view. Each report replaces a cumulative
// duration on the server, so retries cannot create another statistical play.
export function createListeningTracker({ report, onCounted, now = () => Date.now(), storage, userId, thresholdSeconds = 30 }) {
  let active = null;
  let cleanup = null;
  const key = `musicdeck:listening-session:${userId}`;
  const pendingKey = `musicdeck:listening-pending:${userId}`;
  const pending = new Map();
  const inFlight = new Set();
  let lastReport = 0;
  let lastRetry = now();
  try {
    for (const payload of JSON.parse(storage?.getItem(pendingKey) || "[]")) {
      if (payload?.playbackSessionId && typeof payload.listenedSeconds === "number") pending.set(payload.playbackSessionId, payload);
    }
  } catch (error) {
    console.error("Could not restore pending listening reports:", error);
  }

  function persistPending() {
    try { storage?.setItem(pendingKey, JSON.stringify([...pending.values()])); }
    catch (error) { console.error("Could not preserve pending listening reports:", error); }
  }

  function transmit(payload) {
    const id = payload.playbackSessionId;
    inFlight.add(id);
    Promise.resolve().then(() => report({ ...payload, ownerUserId: userId })).then((result) => {
      const latest = pending.get(id);
      if (latest && latest.listenedSeconds <= payload.listenedSeconds && (!latest.finished || payload.finished)) {
        pending.delete(id);
        persistPending();
      }
      if (result?.counted && !active?.announced && active?.payload.playbackSessionId === id) {
        active.announced = true;
        onCounted?.(active.song, payload.startedAt);
      }
    }).catch((error) => console.error("Could not record listening activity; next report will retry:", error))
      .finally(() => inFlight.delete(id));
  }

  function persist() {
    try {
      if (active) storage?.setItem(key, JSON.stringify(active.payload));
      else storage?.removeItem(key);
    } catch (error) {
      console.error("Could not preserve interrupted listening session:", error);
    }
  }

  function send(finished = false) {
    if (!active) return;
    active.payload.finished = finished;
    active.lastSentSeconds = active.payload.listenedSeconds;
    const payload = { ...active.payload, track: { ...active.payload.track } };
    lastReport = now();
    persist();
    pending.set(payload.playbackSessionId, payload);
    if (pending.size > 100) {
      console.error("Listening report outbox is full: the oldest offline session could not be retained.");
      pending.delete(pending.keys().next().value);
    }
    persistPending();
    if (!inFlight.has(payload.playbackSessionId)) transmit(payload);
  }

  function sample() {
    if (!active) return;
    const audio = active.audio;
    const time = now();
    const position = Number(audio.currentTime) || 0;
    const wall = Math.max(0, (time - active.lastTime) / 1000);
    const delta = position - active.lastPosition;
    const rate = Number(audio.playbackRate) || 1;
    if (!active.seeking && delta >= 0 && delta <= wall * rate + 1) {
      active.payload.listenedSeconds += Math.min(wall, delta / rate);
    }
    const duration = Number(audio.duration);
    const wrapDistance = duration - active.lastPosition + position;
    // Credit the tail before a native loop wraps, including subsecond tracks.
    const wrapped = !active.seeking && audio.loop && delta < 0 && !audio.seeking &&
      Number.isFinite(duration) && duration > 0 && wrapDistance >= 0 && wrapDistance <= wall * rate + 1;
    const tailSeconds = wrapped ? Math.min(wall, Math.max(0, duration - active.lastPosition) / rate) : 0;
    if (wrapped) active.payload.listenedSeconds += tailSeconds;
    active.lastTime = time;
    active.lastPosition = position;
    if (Number.isFinite(audio.duration) && audio.duration > 0) active.payload.durationSeconds = audio.duration;
    if (wrapped) {
      const song = active.song;
      closeActive();
      const initialSeconds = Math.min(Math.max(0, wall - tailSeconds), position / rate);
      begin(song, audio, false, initialSeconds, time - initialSeconds * 1000);
      return;
    }
    const threshold = Math.min(thresholdSeconds, active.payload.durationSeconds || Infinity);
    if ((time - lastReport >= 10_000 && active.payload.listenedSeconds > active.lastSentSeconds) ||
        (!active.announced && active.payload.listenedSeconds >= threshold && !active.thresholdSent)) {
      active.thresholdSent = active.payload.listenedSeconds >= threshold;
      send();
    }
  }

  function closeActive() {
    if (!active) return;
    send(true);
    cleanup?.();
    cleanup = null;
    active = null;
    persist();
  }

  function finish() {
    sample();
    closeActive();
  }

  function begin(song, audio, resume = true, initialSeconds = 0, startedAt = now()) {
    if (active?.song.id === song.id && active.audio === audio) return;
    finish();
    let saved = null;
    if (resume) {
      try {
        saved = JSON.parse(storage?.getItem(key) || "null");
      } catch (error) {
        console.error("Could not restore interrupted listening session:", error);
      }
    }
    const reusable = saved && saved.trackId === String(song.id) && !saved.finished &&
      now() - Date.parse(saved.startedAt) < 30 * 86_400_000;
    active = {
      song, audio, lastTime: now(), lastPosition: Number(audio.currentTime) || 0, seeking: false,
      lastSentSeconds: reusable ? saved.listenedSeconds : initialSeconds,
      announced: Boolean(reusable && saved.listenedSeconds >= Math.min(thresholdSeconds, saved.durationSeconds || Infinity)),
      thresholdSent: false,
      payload: reusable ? saved : {
        playbackSessionId: typeof window.crypto?.randomUUID === "function" ? window.crypto.randomUUID() :
          `listen_${now()}_${Math.random().toString(36).slice(2)}`,
        trackId: String(song.id), startedAt: new Date(startedAt).toISOString(), listenedSeconds: initialSeconds,
        durationSeconds: Number(song.duration) > 0 ? Number(song.duration) : null, finished: false,
        track: { title: song.title || "", artist: song.artist || "", album: song.album || "",
          artistId: song.artistId || null, albumId: song.albumId || null,
          coverArt: song.coverArt || null, coverUrl: song.coverUrl || null },
      },
    };
    lastReport = now();
    const events = {
      timeupdate: sample,
      pause: () => { sample(); send(); },
      waiting: () => { sample(); send(); },
      seeking: () => { if (active) { active.seeking = true; active.lastTime = now(); active.lastPosition = audio.currentTime; } },
      seeked: () => { if (active) { active.seeking = false; active.lastTime = now(); active.lastPosition = audio.currentTime; } },
      playing: () => { if (active) { active.lastTime = now(); active.lastPosition = audio.currentTime; } },
    };
    Object.entries(events).forEach(([name, listener]) => audio.addEventListener(name, listener));
    cleanup = () => {
      Object.entries(events).forEach(([name, listener]) => audio.removeEventListener(name, listener));
    };
    persist();
  }

  function retry() {
    const retryable = [...pending.values()].filter((payload) => !inFlight.has(payload.playbackSessionId));
    retryable.slice(0, 5).forEach(transmit);
    lastRetry = now();
  }
  const timer = setInterval(() => {
    sample();
    if (now() - lastRetry >= 10_000) retry();
  }, 1000);
  if (pending.size) retry();

  return {
    begin, sample, finish,
    suspend() { sample(); send(); cleanup?.(); cleanup = null; active = null; clearInterval(timer); },
    flush() { sample(); send(); },
    isTracking(song) { return active?.song.id === song?.id; },
    setThreshold(value) { if (Number.isFinite(value) && value >= 1 && value <= 240) thresholdSeconds = value; },
  };
}
