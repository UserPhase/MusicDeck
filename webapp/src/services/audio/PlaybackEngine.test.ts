import { PlaybackEngine } from "./PlaybackEngine";
import { offlineDownloadEngine } from "../storage/OfflineDownloadEngine";
import type { PlaybackEngineOptions } from "./PlaybackEngine";
import type { PlaybackEngineEvent, PlaybackEngineEventMap } from "./types";
import type { RemoteAudioOutput, RemoteAudioSnapshot } from "./remoteOutput";

class FakeAudio extends EventTarget {
  preload = "";
  volume = 1;
  crossOrigin: string | null = null;
  playbackRate = 1;
  currentTime = 0;
  duration = Number.NaN;
  readyState = 0;
  paused = true;
  ended = false;
  error: { code: number } | null = null;
  seekableEnd = 0;
  src = "";
  playResult: () => Promise<void> = () => Promise.resolve();
  load = jest.fn(() => {
    this.readyState = 0;
    this.currentTime = 0;
    this.paused = true;
    this.ended = false;
    this.error = null;
  });
  play = jest.fn(() => {
    this.paused = false;
    return this.playResult();
  });
  pause = jest.fn(() => {
    this.paused = true;
  });

  get seekable() {
    const end = this.seekableEnd;
    return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end };
  }

  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }

  fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }

  loaded(duration: number, seekable = true): void {
    this.duration = duration;
    this.readyState = 4;
    this.seekableEnd = seekable && Number.isFinite(duration) ? duration : 0;
    this.fire("loadedmetadata");
  }

  progress(seconds: number): void {
    this.currentTime = seconds;
    this.readyState = 4;
    this.fire("timeupdate");
  }

  finish(): void {
    this.ended = true;
    this.paused = true;
    this.fire("ended");
  }
}

class FakeParam {
  value = 1;
  readonly calls: Array<[string, number, number?]> = [];
  setValueAtTime(value: number, time: number) {
    this.calls.push(["set", value, time]);
    this.value = value;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.calls.push(["linear", value, time]);
  }
  setValueCurveAtTime(_values: Float32Array, time: number, duration: number) {
    this.calls.push(["curve", time, duration]);
  }
  cancelScheduledValues(time: number) {
    this.calls.push(["cancel", time]);
  }
}

class FakeNode {
  channelCount = 2;
  connect = jest.fn();
  disconnect = jest.fn();
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

class FakeBufferSource extends FakeNode {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  when: number | null = null;
  offset = 0;
  stopped = false;
  constructor(private readonly ctx: FakeAudioContext) {
    super();
  }
  start(when: number, offset: number) {
    this.when = when;
    this.offset = offset;
    this.ctx.started.push(this);
  }
  stopAt: number | null = null;
  stop(when?: number) {
    this.stopped = true;
    this.stopAt = when ?? null;
  }
}

class FakeAudioContext {
  sampleRate = 48000;
  currentTime = 0;
  state = "running";
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly started: FakeBufferSource[] = [];
  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createBufferSource() {
    return new FakeBufferSource(this);
  }
  createMediaElementSource() {
    return new FakeNode();
  }
  decodeAudioData(bytes: ArrayBuffer) {
    return Promise.resolve({ duration: bytes.byteLength / 10 });
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

const track = (name: string, durationHint?: number) => ({ key: name, src: `/stream/${name}`, durationHint });

describe("sleep automation", () => {
  test("schedules the five-second master fade on the audio clock and pauses at the deadline", async () => {
    jest.useFakeTimers();
    const context = new FakeAudioContext();
    const { engine, audios, of } = setup({ audioContext: context as unknown as AudioContext });
    try {
      await engine.load(track("a", 1800));
      engine.setVolume(0.65);
      engine.startSleepTimer(15);
      expect(context.gains[1].gain.calls).toContainEqual(["set", 1, 895]);
      expect(context.gains[1].gain.calls).toContainEqual(["linear", 0, 900]);
      jest.advanceTimersByTime(895_000);
      expect(engine.sleepTimer.getSnapshot().status).toBe("fading");
      expect(audios[0].paused).toBe(false);
      jest.advanceTimersByTime(5000);
      expect(audios[0].paused).toBe(true);
      expect(context.gains[0].gain.value).toBe(0.65);
      expect(of("sleepStop")).toEqual([{ key: "a" }]);
    } finally {
      engine.destroy();
      jest.useRealTimers();
    }
  });

  test("an album boundary preserves earlier endings and suppresses transitions and autoplay at its last track", async () => {
    jest.useFakeTimers();
    const { engine, audios, of } = setup({ transitionMode: "crossfade" });
    try {
      await engine.load(track("first", 60));
      engine.startSleepTimer("album", ["first", "last"]);
      audios[0].finish();
      expect(of("trackEnd")).toEqual([{ key: "first" }]);
      await engine.load(track("last", 60));
      engine.setUpcoming(track("outside", 60));
      audios[1].loaded(60);
      audios[1].progress(55);
      jest.advanceTimersByTime(2500);
      expect(audios[1].volume).toBeCloseTo(0.5, 1);
      audios[1].finish();
      audios[1].finish();
      expect(of("trackEnd")).toEqual([{ key: "first" }]);
      expect(of("transitionStart")).toEqual([]);
      expect(of("sleepStop")).toEqual([{ key: "last" }]);
    } finally {
      engine.destroy();
      jest.useRealTimers();
    }
  });
});

describe("album-aware transitions", () => {
  const albumTrack = (key: string, albumTrackIndex: number, albumPlaybackId = "album") => ({
    ...track(key), albumPlaybackId, albumTrackIndex, trimStart: 2, trimEnd: 190,
  });

  test("album playback ignores trim and crossfade, including late silence results, on the media fallback", async () => {
    const { engine, audios, of } = setup({ albumAware: true, transitionMode: "crossfade", crossfadeSeconds: 10 });
    await engine.load(albumTrack("a", 0));
    audios[0].loaded(200);
    expect(audios[0].currentTime).toBe(0);
    engine.setUpcoming(albumTrack("b", 1));
    engine.updateTrack("a", { trimStart: 3, trimEnd: 180 });
    audios[0].progress(195);
    await flush();
    expect(of("transitionStart")).toEqual([]);
    expect(of("trackEnd")).toEqual([]);
    expect(audios[0].paused).toBe(false);
    audios[0].finish();
    await flush();
    expect(of("transitionCommit")).toEqual([{ kind: "gapless", fromKey: "a", toKey: "b" }]);
    audios[1].loaded(200);
    expect(audios[1].currentTime).toBe(0);
    expect(engine.getSnapshot().mode).toBe("crossfade");
    engine.destroy();
  });

  test("decoded album buffers keep full pauses and stitch at the exact boundary without fades", async () => {
    const ctx = new FakeAudioContext();
    const fetchImpl = jest.fn(async () => ({
      status: 200, headers: { get: (name: string) => name === "Content-Length" ? "500" : null },
      body: { getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new Uint8Array(500) };
          },
          cancel: async () => {},
        };
      } },
    } as unknown as Response));
    const { engine, audios, of } = setup({
      albumAware: true, transitionMode: "crossfade", crossfadeSeconds: 10,
      audioContext: ctx as unknown as AudioContext, fetchImpl,
    });
    await engine.load(albumTrack("a", 0));
    audios[0].loaded(200);
    engine.setUpcoming(albumTrack("b", 1));
    audios[0].progress(179);
    expect(fetchImpl).not.toHaveBeenCalled();
    audios[0].progress(180);
    await flush();
    ctx.currentTime = 50;
    audios[0].progress(198.6);
    expect(of("transitionStart")).toEqual([{ kind: "gapless", fromKey: "a", toKey: "b" }]);
    const voice = ctx.started[0];
    expect(voice.when).toBeCloseTo(51.4, 6);
    expect(voice.offset).toBe(0);
    expect(voice.stopAt).toBeNull();
    expect(ctx.gains.flatMap((gain) => gain.gain.calls).filter(([kind]) => kind === "linear" || kind === "curve")).toEqual([]);
    engine.updateTrack("b", { trimStart: 10, trimEnd: 20 });
    engine.updateTrack("b", { gain: .5 });
    expect(of("transitionCancel")).toEqual([]);
    expect(voice.stopAt).toBeNull();
    engine.destroy();
  });

  test.each(["different album", "reordered album", "disabled"])("%s uses ordinary crossfade settings", async (scenario) => {
    const { engine, audios, of } = setup({ albumAware: scenario !== "disabled", transitionMode: "crossfade", crossfadeSeconds: 10 });
    await engine.load(albumTrack("a", 0));
    audios[0].loaded(200);
    engine.setUpcoming(albumTrack("b", scenario === "reordered album" ? 2 : 1, scenario === "different album" ? "other" : "album"));
    audios[0].progress(scenario === "disabled" ? 180 : 190);
    await flush();
    expect(of("transitionStart")[0]?.kind).toBe("crossfade");
    engine.destroy();
  });

  test("changing album policy cancels an existing fade and releases its incoming deck", async () => {
    const { engine, audios, of } = setup({ transitionMode: "crossfade", crossfadeSeconds: 10 });
    await engine.load(albumTrack("a", 0));
    audios[0].loaded(200);
    engine.setUpcoming(albumTrack("b", 1));
    audios[0].progress(180);
    await flush();
    expect(of("transitionStart")[0]?.kind).toBe("crossfade");
    engine.setAlbumAware(true);
    expect(of("transitionCancel")[0]?.reason).toBe("album-mode-changed");
    expect(audios[1].src).toBe("");
    engine.destroy();
  });

  test("turning album policy off restores saved trim bounds, including late analysis", async () => {
    const { engine, audios, of } = setup({ albumAware: true });
    await engine.load(albumTrack("a", 0));
    audios[0].loaded(200);
    audios[0].progress(100);
    engine.updateTrack("a", { trimEnd: 150 });
    audios[0].progress(160);
    expect(of("trackEnd")).toEqual([]);
    engine.setAlbumAware(false);
    audios[0].progress(161);
    expect(of("trackEnd")).toEqual([{ key: "a" }]);
    engine.destroy();
  });
});

async function flush(): Promise<void> {
  for (let index = 0; index < 100; index += 1) await Promise.resolve();
}

function setup(options: PlaybackEngineOptions = {}) {
  const audios: FakeAudio[] = [];
  const engine = new PlaybackEngine({
    audioContext: null,
    createAudioElement: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      return audio as unknown as HTMLAudioElement;
    },
    ...options,
  });
  const events: Array<[PlaybackEngineEvent, unknown]> = [];
  const names: PlaybackEngineEvent[] = [
    "stateChange", "trackEnd", "sleepStop", "bufferStall", "streamRecovered", "recoveryFailed",
    "transitionStart", "transitionCommit", "transitionCancel", "error",
  ];
  names.forEach((name) => engine.on(name, (payload) => events.push([name, payload])));
  const of = <K extends PlaybackEngineEvent>(name: K) =>
    events.filter(([event]) => event === name).map(([, payload]) => payload as PlaybackEngineEventMap[K]);
  return { engine, audios, events, of };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("verified offline sources", () => {
  test("starts saved audio with navigator.onLine false and never loads the server stream", async () => {
    const snapshot = offlineDownloadEngine.getSnapshot();
    jest.spyOn(offlineDownloadEngine, "getSnapshot").mockReturnValue({ ...snapshot, tracks: [{ track_id: "one", status: "verified" }] as any });
    jest.spyOn(offlineDownloadEngine, "localPlaybackUrl").mockResolvedValue("blob:saved-audio");
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const { engine, audios } = setup();
    try {
      await engine.load({ key: "entry", src: "/server-stream", offlineTrackId: "one", offlineOnly: true });
      expect(audios.some((audio) => audio.src === "blob:saved-audio")).toBe(true);
      expect(audios.some((audio) => audio.src === "/server-stream")).toBe(false);
    } finally { engine.destroy(); Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); }
  });
  test("a pause while reading IndexedDB remains effective when the read completes", async () => {
    jest.spyOn(offlineDownloadEngine, "getSnapshot").mockReturnValue({ tracks: [{ track_id: "one", status: "verified" }] as any, jobs: [], collections: [], error: null });
    let finish!: (url: string) => void;
    jest.spyOn(offlineDownloadEngine, "localPlaybackUrl").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { engine, audios } = setup();
    const loading = engine.load({ key: "entry", src: "/server-stream", offlineTrackId: "one", offlineOnly: true });
    engine.pause(); finish("blob:saved-audio"); await loading;
    expect(audios.every((audio) => audio.paused)).toBe(true);
    engine.destroy();
  });
});

describe("PlaybackEngine basics", () => {
  test("remote readiness requires actual decoded data and a completed exact seek, never duration hints", async () => {
    const { engine, audios } = setup();
    await engine.load({ ...track("resume"), durationHint: 600 }, { autoplay: false, startAt: 123.456789 });
    expect(engine.isReadyForResume()).toBe(false);
    const deck = audios[0];
    deck.duration = 600; deck.readyState = 1; deck.fire("loadedmetadata");
    expect(deck.currentTime).toBe(123.456789);
    expect(engine.isReadyForResume()).toBe(false);
    deck.readyState = 3;
    expect(engine.isReadyForResume()).toBe(true);
    deck.duration = Infinity;
    expect(engine.isReadyForResume()).toBe(false);
    engine.destroy();
  });

  describe("exclusive remote audio output", () => {
    function remoteFixture() {
      let snapshot: RemoteAudioSnapshot = { key: null, state: "idle", position: 0, duration: 200 };
      const listeners = new Set<(value: RemoteAudioSnapshot) => void>();
      const publish = (patch: Partial<RemoteAudioSnapshot>) => {
        snapshot = { ...snapshot, ended: false, ...patch };
        listeners.forEach((listener) => listener(snapshot));
      };
      const output: RemoteAudioOutput = {
        load: jest.fn(async (item, options) => { publish({ key: item.key, state: options.autoplay === false ? "paused" : "playing", position: options.startAt ?? 0 }); }),
        play: jest.fn(async () => { publish({ state: "playing" }); }),
        pause: jest.fn(async () => { publish({ state: "paused" }); }),
        seek: jest.fn(async (position) => { publish({ position }); }),
        setVolume: jest.fn(async () => {}),
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      };
      return { output, publish, listeners };
    }
    test("handoff silences all local decks, preserves exact position, and never prefetches crossfade or gapless audio", async () => {
      const { engine, audios, of } = setup({ transitionMode: "crossfade" });
      const { output, publish } = remoteFixture();
      await engine.load(track("a"));
      audios[0].loaded(200); audios[0].progress(101.375); audios[0].fire("playing");
      await engine.setRemoteOutput(output);
      expect(output.load).toHaveBeenCalledWith(track("a"), { startAt: 101.375, autoplay: true });
      expect(audios.every((audio) => audio.paused && audio.src === "")).toBe(true);
      expect(engine.getSnapshot()).toMatchObject({ key: "a", position: 101.375, state: "playing", mode: "off" });
      engine.setUpcoming(track("b"));
      engine.setTransitionMode("gapless");
      publish({ position: 199 });
      jest.advanceTimersByTime(1000);
      expect(audios.every((audio) => audio.src === "")).toBe(true);
      expect(of("transitionStart")).toHaveLength(0);
      publish({ ended: true, state: "paused" });
      expect(of("trackEnd")).toEqual([{ key: "a" }]);
      engine.destroy();
    });
    test("pause, seek and volume route remotely; stale occurrence events cannot move the active queue", async () => {
      const { engine, audios, of } = setup();
      const { output, publish } = remoteFixture();
      await engine.load(track("a"));
      await engine.setRemoteOutput(output);
      engine.pause(); engine.seek(42.125); engine.setVolume(.25);
      await flush();
      expect(output.pause).toHaveBeenCalledTimes(1);
      expect(output.seek).toHaveBeenCalledWith(42.125);
      expect(output.setVolume).toHaveBeenLastCalledWith(.25);
      await engine.load(track("b"));
      publish({ key: "a", ended: true });
      expect(of("trackEnd")).toHaveLength(0);
      expect(engine.getSnapshot().key).toBe("b");
      expect(audios.every((audio) => audio.paused)).toBe(true);
      engine.destroy();
    });
    test("receiver loss cannot cause overlapping local playback, and explicit release restores a paused exact-position deck", async () => {
      const { engine, audios } = setup();
      const { output, publish, listeners } = remoteFixture();
      await engine.load(track("a")); await engine.setRemoteOutput(output);
      publish({ position: 87.625, disconnected: true });
      expect(engine.getSnapshot().state).toBe("paused");
      expect(audios.every((audio) => audio.paused && audio.src === "")).toBe(true);
      await engine.releaseRemoteOutput(output);
      audios[0].loaded(200);
      expect(engine.getPosition()).toBe(87.625);
      expect(engine.getSnapshot().state).toBe("paused");
      expect(audios.every((audio) => audio.paused)).toBe(true);
      expect(listeners.size).toBe(0);
      engine.destroy();
    });
  });
  test("loads and starts a track on a media deck", async () => {
    const { engine, audios, of } = setup();
    await engine.load(track("a"));
    const [deck] = audios;
    expect(deck.src).toBe("/stream/a");
    expect(deck.play).toHaveBeenCalledTimes(1);
    deck.fire("playing");
    expect(of("stateChange").at(-1)).toEqual({ key: "a", state: "playing" });
    engine.destroy();
  });

  test("ignores late events from a track the user already skipped", async () => {
    const { engine, audios, of } = setup();
    await engine.load(track("a"));
    await engine.load(track("b"));
    const [first, second] = audios;
    expect(first.src).toBe("");
    first.finish();
    expect(of("trackEnd")).toEqual([]);
    second.finish();
    expect(of("trackEnd")).toEqual([{ key: "b" }]);
    engine.destroy();
  });

  test("applies a resume position once metadata is available", async () => {
    const { engine, audios } = setup();
    await engine.load(track("a"), { startAt: 42 });
    audios[0].loaded(200);
    expect(audios[0].currentTime).toBe(42);
    engine.destroy();
  });
});

describe("crossfade path", () => {
  test("ramps both decks over the configured window and commits the incoming track", async () => {
    const { engine, audios, of } = setup({ transitionMode: "crossfade", crossfadeSeconds: 2 });
    await engine.load(track("a"));
    const [outgoing, incoming] = audios;
    outgoing.loaded(100);
    outgoing.fire("playing");
    engine.setUpcoming(track("b"));

    outgoing.progress(91);
    expect(incoming.src).toBe("/stream/b");
    expect(incoming.volume).toBe(0);
    expect(incoming.play).not.toHaveBeenCalled();

    outgoing.progress(98);
    expect(of("transitionStart")).toEqual([{ kind: "crossfade", fromKey: "a", toKey: "b" }]);
    await flush();
    engine.setTransitionMode("gapless");
    expect(engine.getSnapshot()).toEqual(expect.objectContaining({ mode: "gapless", transition: "crossfade" }));

    jest.advanceTimersByTime(1000);
    expect(outgoing.volume).toBeCloseTo(Math.SQRT1_2, 1);
    expect(incoming.volume).toBeCloseTo(Math.SQRT1_2, 1);

    jest.advanceTimersByTime(1000);
    expect(of("transitionCommit")).toEqual([{ kind: "crossfade", fromKey: "a", toKey: "b" }]);
    expect(incoming.volume).toBe(1);
    expect(outgoing.src).toBe("");
    expect(engine.getSnapshot()).toEqual(expect.objectContaining({ key: "b", mode: "gapless", transition: null }));
    expect(of("trackEnd")).toEqual([]);
    engine.destroy();
  });

  test("pausing mid-fade cancels it and restores the outgoing level", async () => {
    const { engine, audios, of } = setup({ transitionMode: "crossfade", crossfadeSeconds: 4 });
    await engine.load(track("a"));
    const [outgoing, incoming] = audios;
    outgoing.loaded(100);
    outgoing.fire("playing");
    engine.setUpcoming(track("b"));
    outgoing.progress(96);
    await flush();
    jest.advanceTimersByTime(1000);

    engine.pause();

    expect(of("transitionCancel")).toEqual([
      { kind: "crossfade", fromKey: "a", toKey: "b", reason: "paused" },
    ]);
    expect(incoming.src).toBe("");
    expect(outgoing.volume).toBe(1);
    jest.advanceTimersByTime(5000);
    expect(of("transitionCommit")).toEqual([]);
    engine.destroy();
  });
});

describe("gapless path", () => {
  test("without Web Audio, preloads at 90% and switches on ended with no gain ramp", async () => {
    const { engine, audios, of } = setup({ transitionMode: "gapless", crossfadeSeconds: 10 });
    await engine.load(track("a"));
    const [outgoing, incoming] = audios;
    outgoing.loaded(100);
    outgoing.fire("playing");
    engine.setUpcoming(track("b"));

    outgoing.progress(89);
    expect(incoming.src).toBe("");
    outgoing.progress(90);
    expect(incoming.src).toBe("/stream/b");
    expect(incoming.play).not.toHaveBeenCalled();

    outgoing.progress(99.9);
    expect(of("transitionStart")).toEqual([]);
    outgoing.finish();

    expect(of("transitionCommit")).toEqual([{ kind: "gapless", fromKey: "a", toKey: "b" }]);
    expect(incoming.play).toHaveBeenCalledTimes(1);
    expect(incoming.volume).toBe(1);
    expect(of("trackEnd")).toEqual([]);
    engine.destroy();
  });

  test("decodes the next track and stitches buffers at the exact boundary", async () => {
    const ctx = new FakeAudioContext();
    const fetchCalls: Array<Record<string, string> | undefined> = [];
    const body = (sizes: number[], fail = false) => {
      const queue = sizes.map((size) => new Uint8Array(size));
      return {
        getReader: () => ({
          read: () => {
            const value = queue.shift();
            if (value) return Promise.resolve({ done: false, value });
            return fail
              ? Promise.reject(new TypeError("network"))
              : Promise.resolve({ done: true, value: undefined });
          },
          cancel: () => Promise.resolve(),
        }),
      };
    };
    const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
    const fetchImpl = jest.fn((url: string, init?: RequestInit) => {
      fetchCalls.push(init?.headers as Record<string, string> | undefined);
      if (url === "/stream/b" && fetchCalls.length === 1) {
        return Promise.resolve({ status: 200, headers: headers({ "Content-Length": "1000", ETag: "b1" }), body: body([400], true) } as unknown as Response);
      }
      if (url === "/stream/b") {
        return Promise.resolve({ status: 206, headers: headers({ "Content-Range": "bytes 400-999/1000" }), body: body([600]) } as unknown as Response);
      }
      return Promise.resolve({ status: 200, headers: headers({ "Content-Length": "500" }), body: body([500]) } as unknown as Response);
    });

    const { engine, audios, of } = setup({
      audioContext: ctx as unknown as AudioContext,
      transitionMode: "gapless",
      crossfadeSeconds: 10,
      fetchImpl,
    });
    await engine.load(track("a"));
    const [outgoing] = audios;
    outgoing.loaded(200);
    outgoing.fire("playing");
    engine.setUpcoming(track("b"));

    outgoing.progress(179);
    expect(fetchImpl).not.toHaveBeenCalled();
    outgoing.progress(180);
    await flush();
    expect(fetchCalls[1]).toEqual(expect.objectContaining({ Range: "bytes=400-", "If-Range": "b1" }));

    ctx.currentTime = 50;
    outgoing.progress(198.6);
    expect(of("transitionStart")).toEqual([{ kind: "gapless", fromKey: "a", toKey: "b" }]);
    const first = ctx.started[0];
    expect(first.when).toBeCloseTo(51.4, 6);
    expect(first.offset).toBe(0);

    ctx.currentTime = 51.4;
    jest.advanceTimersByTime(1401);
    expect(of("transitionCommit")).toEqual([{ kind: "gapless", fromKey: "a", toKey: "b" }]);
    expect(outgoing.src).toBe("");
    expect(engine.getSnapshot().key).toBe("b");

    // Buffer → buffer: the next voice must start on the exact sample the previous one ends.
    engine.setUpcoming(track("c"));
    ctx.currentTime = 51.4 + 91;
    jest.advanceTimersByTime(250);
    await flush();
    expect(ctx.started).toHaveLength(1);
    ctx.currentTime = 150;
    jest.advanceTimersByTime(250);
    const second = ctx.started[1];
    expect(second.when).toBe((first.when as number) + 100);
    expect(second.offset).toBe(0);

    const ramps = ctx.gains.flatMap((gain) => gain.gain.calls).filter(([kind]) => kind === "linear" || kind === "curve");
    expect(ramps).toEqual([]);
    engine.destroy();
  });
});

describe("stall recovery", () => {
  async function playing(options: PlaybackEngineOptions = {}, duration = 200) {
    const harness = setup(options);
    await harness.engine.load(track("a"));
    const deck = harness.audios[0];
    deck.loaded(duration, Number.isFinite(duration));
    deck.fire("playing");
    deck.progress(42);
    return { ...harness, deck };
  }

  test("switches a stalled stream to a newly downloaded verified file at the saved position", async () => {
    const { engine, audios, of } = setup();
    await engine.load({ ...track("a"), offlineTrackId: "one" });
    const deck = audios[0];
    deck.loaded(200); deck.fire("playing"); deck.progress(42);
    jest.spyOn(offlineDownloadEngine, "getSnapshot").mockReturnValue({ tracks: [{ track_id: "one", status: "verified" }] as any, jobs: [], collections: [], error: null });
    jest.spyOn(offlineDownloadEngine, "localPlaybackUrl").mockResolvedValue("blob:verified-download");
    deck.fire("waiting"); jest.advanceTimersByTime(3500); await flush();
    expect(deck.src).toBe("blob:verified-download");
    deck.loaded(200); await flush();
    expect(deck.currentTime).toBe(42);
    expect(of("streamRecovered")).toEqual([{ key: "a", position: 42, attempts: 1, restartedFromBeginning: false }]);
    engine.destroy();
  });

  test("a delayed offline lookup cannot replace the next track", async () => {
    const { engine, audios } = setup();
    await engine.load({ ...track("a"), offlineTrackId: "one" });
    const deck = audios[0];
    deck.loaded(200); deck.fire("playing"); deck.progress(42);
    const snapshot = jest.spyOn(offlineDownloadEngine, "getSnapshot").mockReturnValue({ tracks: [{ track_id: "one", status: "verified" }] as any, jobs: [], collections: [], error: null });
    let finish!: (value: string | null) => void;
    jest.spyOn(offlineDownloadEngine, "localPlaybackUrl").mockReturnValue(new Promise(resolve => { finish = resolve; }));
    deck.fire("waiting"); jest.advanceTimersByTime(3500);
    snapshot.mockReturnValue({ tracks: [], jobs: [], collections: [], error: null });
    await engine.load(track("b"));
    finish("blob:stale-download"); await flush();
    expect(audios.some(audio => audio.src === "blob:stale-download")).toBe(false);
    expect(engine.getSnapshot().key).toBe("b");
    engine.destroy();
  });

  test("reconnects after 3.5 s without progress and resumes at the saved position", async () => {
    const { engine, deck, of } = await playing();
    deck.readyState = 2;
    deck.fire("waiting");

    jest.advanceTimersByTime(3499);
    expect(of("bufferStall")).toEqual([]);
    const loadsBefore = deck.load.mock.calls.length;
    jest.advanceTimersByTime(1);
    expect(of("bufferStall")).toEqual([{ key: "a", position: 42, attempt: 1, maxAttempts: 5 }]);
    // The first attempt reloads immediately; later attempts back off.
    expect(deck.load.mock.calls.length).toBe(loadsBefore + 1);
    expect(deck.src).toBe("/stream/a");

    deck.loaded(200);
    expect(deck.currentTime).toBe(42);
    await flush();
    expect(of("streamRecovered")).toEqual([
      { key: "a", position: 42, attempts: 1, restartedFromBeginning: false },
    ]);
    expect(engine.getSnapshot()).toEqual(expect.objectContaining({ key: "a", state: "playing" }));
    engine.destroy();
  });

  test("a brief buffering blip that recovers on its own does not reconnect", async () => {
    const { engine, deck, of } = await playing();
    deck.fire("waiting");
    jest.advanceTimersByTime(1000);
    deck.progress(43);
    jest.advanceTimersByTime(5000);
    expect(of("bufferStall")).toEqual([]);
    engine.destroy();
  });

  test("unseekable live transcodes restart from the beginning", async () => {
    const { engine, deck, of } = await playing({}, Number.POSITIVE_INFINITY);
    deck.fire("waiting");
    jest.advanceTimersByTime(3500);
    deck.loaded(Number.POSITIVE_INFINITY, false);
    await flush();
    expect(deck.currentTime).toBe(0);
    expect(of("streamRecovered")).toEqual([
      { key: "a", position: 0, attempts: 1, restartedFromBeginning: true },
    ]);
    engine.destroy();
  });

  test("backs off exponentially, then waits for the user before retrying", async () => {
    const { engine, deck, of } = await playing({ maxRecoveryAttempts: 3 });
    const failReload = () => {
      deck.error = { code: 2 };
      deck.fire("error");
    };
    deck.fire("waiting");
    jest.advanceTimersByTime(3500);
    failReload();
    expect(of("bufferStall").map((stall) => stall.attempt)).toEqual([1, 2]);
    jest.advanceTimersByTime(999);
    const loads = deck.load.mock.calls.length;
    jest.advanceTimersByTime(1);
    expect(deck.load.mock.calls.length).toBe(loads + 1);
    failReload();
    jest.advanceTimersByTime(2000);
    failReload();

    expect(of("recoveryFailed")).toEqual([{ key: "a", position: 42, attempts: 3 }]);
    expect(engine.getSnapshot().state).toBe("error");
    expect(engine.getPosition()).toBe(42);

    await engine.play();
    jest.advanceTimersByTime(0);
    deck.loaded(200);
    await flush();
    expect(of("streamRecovered")).toEqual([
      { key: "a", position: 42, attempts: 1, restartedFromBeginning: false },
    ]);
    engine.destroy();
  });

  test("pausing during a reconnect restores the position without starting audio", async () => {
    const { engine, deck, of } = await playing();
    deck.fire("waiting");
    jest.advanceTimersByTime(3500);
    engine.pause();
    engine.seek(60);
    const plays = deck.play.mock.calls.length;
    deck.loaded(200);
    await flush();
    expect(deck.currentTime).toBe(60);
    expect(deck.play.mock.calls.length).toBe(plays);
    expect(of("streamRecovered")[0]).toEqual(expect.objectContaining({ position: 60 }));
    expect(engine.getSnapshot().state).toBe("paused");
    engine.destroy();
  });
});

describe("cleanup", () => {
  test("destroy releases elements, audio nodes and the owned context", async () => {
    const ctx = new FakeAudioContext();
    const { engine, audios } = setup({ audioContext: ctx as unknown as AudioContext });
    await engine.load(track("a"));
    engine.destroy();
    expect(audios.every((audio) => audio.src === "")).toBe(true);
    expect(ctx.gains.every((gain) => gain.disconnect.mock.calls.length > 0)).toBe(true);
    // A shared context is not closed by the engine.
    expect(ctx.state).toBe("running");
  });
});

describe("per-track gain and silence trimming", () => {
  const withSettings = (name: string, settings: { gain?: number; trimStart?: number; trimEnd?: number | null }) => ({
    ...track(name),
    ...settings,
  });

  test("diagnostics expose graph rate, not source/hardware rate, and sample the applied gain ramp", async () => {
    const ctx = new FakeAudioContext();
    const { engine } = setup({ audioContext: ctx as unknown as AudioContext });
    await engine.load(withSettings("a", { gain: .5 }));
    expect(engine.getAudioDiagnostics()).toMatchObject({ path: "Web Audio", sampleRateHz: 48000, outputChannels: 2, outputDeviceType: "Not exposed by browser" });
    expect(engine.getAudioDiagnostics().gainDb).toBeCloseTo(-6.0206);
    engine.updateTrack("a", { gain: .25 });
    expect(engine.getAudioDiagnostics().gainDb).toBeCloseTo(-6.0206);
    ctx.currentTime += 20;
    expect(engine.getAudioDiagnostics().gainDb).toBeCloseTo(-12.0412);
    engine.destroy();
  });

  test("track level multiplies the crossfade envelope instead of being overwritten", async () => {
    const { engine, audios, of } = setup({ transitionMode: "crossfade", crossfadeSeconds: 2 });
    await engine.load(withSettings("a", { gain: 0.5 }));
    const [outgoing, incoming] = audios;
    expect(outgoing.volume).toBe(0.5);
    engine.updateTrack("a", { gain: 0.25 });
    // A late correction eases in (6 dB at ≤0.75 dB/s with easing → ~12 s) instead of jumping.
    expect(outgoing.volume).toBe(0.5);
    jest.advanceTimersByTime(6000);
    expect(outgoing.volume).toBeLessThan(0.5);
    expect(outgoing.volume).toBeGreaterThan(0.25);
    jest.advanceTimersByTime(7000);
    expect(outgoing.volume).toBe(0.25);

    outgoing.loaded(100);
    outgoing.fire("playing");
    engine.setUpcoming(withSettings("b", { gain: 0.8 }));
    outgoing.progress(91);
    expect(incoming.volume).toBe(0);
    outgoing.progress(98);
    await flush();
    jest.advanceTimersByTime(1000);
    expect(outgoing.volume).toBeCloseTo(0.25 * Math.SQRT1_2, 1);
    expect(incoming.volume).toBeCloseTo(0.8 * Math.SQRT1_2, 1);
    jest.advanceTimersByTime(1000);
    expect(of("transitionCommit")).toHaveLength(1);
    expect(incoming.volume).toBeCloseTo(0.8, 6);
    engine.destroy();
  });

  test("skips leading silence and ends a stream at its trimmed end", async () => {
    const { engine, audios, of } = setup();
    await engine.load(withSettings("a", { trimStart: 2, trimEnd: 90 }));
    const [deck] = audios;
    deck.loaded(100);
    expect(deck.currentTime).toBe(2);
    deck.fire("playing");
    deck.progress(89.9);
    expect(of("trackEnd")).toEqual([]);
    deck.progress(90);
    expect(of("trackEnd")).toEqual([{ key: "a" }]);
    expect(deck.pause).toHaveBeenCalled();
    deck.progress(90.2);
    expect(of("trackEnd")).toHaveLength(1);
    engine.destroy();
  });

  test("an explicit resume position wins over the trimmed start", async () => {
    const { engine, audios } = setup();
    await engine.load(withSettings("a", { trimStart: 2 }), { startAt: 42 });
    audios[0].loaded(100);
    expect(audios[0].currentTime).toBe(42);
    engine.destroy();
  });

  test("silence analysis that resolves late moves the start and the end", async () => {
    const { engine, audios, of } = setup();
    await engine.load(track("a"));
    const [deck] = audios;
    deck.loaded(100);
    deck.fire("playing");
    deck.progress(0.5);
    engine.updateTrack("a", { trimStart: 3, trimEnd: 50 });
    expect(deck.currentTime).toBe(3);
    deck.progress(50);
    expect(of("trackEnd")).toEqual([{ key: "a" }]);
    engine.destroy();
  });

  test("late analysis never jumps over a position the listener chose", async () => {
    const { engine, audios } = setup();
    await engine.load(track("a"));
    const [deck] = audios;
    deck.loaded(100);
    engine.seek(1);
    engine.updateTrack("a", { trimStart: 3 });
    expect(deck.currentTime).toBe(1);
    engine.destroy();
  });

  test("crossfade measures its window against the trimmed end", async () => {
    const { engine, audios, of } = setup({ transitionMode: "crossfade", crossfadeSeconds: 2 });
    await engine.load(withSettings("a", { trimEnd: 80 }));
    const [outgoing] = audios;
    outgoing.loaded(100);
    outgoing.fire("playing");
    engine.setUpcoming(track("b"));
    outgoing.progress(77.9);
    expect(of("transitionStart")).toEqual([]);
    outgoing.progress(78);
    expect(of("transitionStart")).toEqual([{ kind: "crossfade", fromKey: "a", toKey: "b" }]);
    engine.destroy();
  });

  test("a trim change during a transition cancels it so it is re-planned", async () => {
    const { engine, audios, of } = setup({ transitionMode: "crossfade", crossfadeSeconds: 2 });
    await engine.load(track("a"));
    const [outgoing] = audios;
    outgoing.loaded(100);
    outgoing.fire("playing");
    engine.setUpcoming(track("b"));
    outgoing.progress(98);
    engine.updateTrack("b", { gain: 0.5 });
    expect(of("transitionCancel")).toEqual([]);
    engine.updateTrack("a", { trimEnd: 99.5 });
    expect(of("transitionCancel")).toEqual([
      { kind: "crossfade", fromKey: "a", toKey: "b", reason: "track-updated" },
    ]);
    engine.destroy();
  });

  test("gapless schedules against the trimmed end and starts the next voice after its silence", async () => {
    const ctx = new FakeAudioContext();
    const fetchImpl = jest.fn(() => Promise.resolve({
      status: 200,
      headers: { get: (name: string) => (name === "Content-Length" ? "500" : null) },
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: () => {
              if (sent) return Promise.resolve({ done: true, value: undefined });
              sent = true;
              return Promise.resolve({ done: false, value: new Uint8Array(500) });
            },
            cancel: () => Promise.resolve(),
          };
        },
      },
    } as unknown as Response));
    const { engine, audios, of } = setup({
      audioContext: ctx as unknown as AudioContext,
      transitionMode: "gapless",
      fetchImpl,
    });
    await engine.load(withSettings("a", { trimEnd: 190 }));
    const [outgoing] = audios;
    outgoing.loaded(200);
    outgoing.fire("playing");
    engine.setUpcoming(withSettings("b", { gain: 0.5, trimStart: 1.5, trimEnd: 40 }));

    outgoing.progress(171);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    ctx.currentTime = 50;
    outgoing.progress(188.6);
    expect(of("transitionStart")).toEqual([{ kind: "gapless", fromKey: "a", toKey: "b" }]);
    const voice = ctx.started[0];
    expect(voice.when).toBeCloseTo(51.4, 6);
    expect(voice.offset).toBe(1.5);
    // The decoded buffer is 50 s; the trimmed end stops it on the audio clock.
    expect(voice.stopAt).toBeCloseTo(51.4 + 38.5, 6);
    expect(ctx.gains.some((gain) => gain.gain.value === 0.5)).toBe(true);
    const ramps = ctx.gains.flatMap((gain) => gain.gain.calls).filter(([kind]) => kind === "linear" || kind === "curve");
    expect(ramps).toEqual([]);
    engine.destroy();
  });
});
