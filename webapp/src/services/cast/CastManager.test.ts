import { CastManager, loadCastSdk, supportsCast } from "./CastManager";
import type { CastSdk, CastSession, CastMedia, CastContext, CastApi } from "./CastManager";
import type { PlayableTrack } from "../audio/types";
import type { RemoteAudioSnapshot } from "../audio/remoteOutput";
import { setBrowserPrivacy } from "../privacyPolicy";
import { act, renderHook, waitFor } from "@testing-library/react";
import { PlaybackEngine } from "../audio/PlaybackEngine";
import { useQueueStore } from "../../hooks/useQueueStore";

const track = (key: string): PlayableTrack & { id: string } => ({ id: key, key, src: "/private-browser-stream", durationHint: 180,
  cast: { trackId: key, title: `Song ${key}`, artist: "Artist", album: "Album" } });
function setup() {
  let sessionPresent = true;
  const events = new Map<string, () => void>();
  let media: CastMedia | null = null;
  class MediaInfo {
    metadata?: object; streamType?: string; duration?: number;
    constructor(public url: string, public contentType: string) {}
  }
  class LoadRequest {
    autoplay = true; currentTime = 0;
    constructor(public info: MediaInfo) {}
  }
  const load = jest.fn(async (request: object) => {
    if (!(request instanceof LoadRequest)) throw new Error("Invalid load request");
    media = { media: { contentId: request.info.url, duration: request.info.duration }, playerState: request.autoplay ? "PLAYING" : "PAUSED",
      getEstimatedTime: jest.fn(() => request.currentTime),
      play: (_request, ok) => { if (media) media.playerState = "PLAYING"; ok(); },
      pause: (_request, ok) => { if (media) media.playerState = "PAUSED"; ok(); },
      seek: (seek, ok) => { if (media) media.getEstimatedTime = () => seek.currentTime; ok(); },
    };
  });
  const session: CastSession = { getCastDevice: () => ({ friendlyName: "Living Room" }),
    getMediaSession: () => media, getVolume: () => .5, loadMedia: load, setVolume: jest.fn(async () => {}) };
  const context: CastContext = { setOptions: jest.fn(), requestSession: jest.fn(async () => {}),
    getCurrentSession: () => sessionPresent ? session : null, getCastState: () => "CONNECTED",
    endCurrentSession: jest.fn(() => { sessionPresent = false; }),
    addEventListener: (event, listener) => { events.set(event, listener); },
    removeEventListener: (event) => { events.delete(event); },
  };
  const sdk: CastSdk = { framework: { CastContext: { getInstance: () => context },
    CastContextEventType: { CAST_STATE_CHANGED: "cast", SESSION_STATE_CHANGED: "session" } },
    chrome: { AutoJoinPolicy: { ORIGIN_SCOPED: "origin" }, media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: "default", StreamType: { BUFFERED: "buffered" },
      MediaInfo, MusicTrackMediaMetadata: class {}, LoadRequest: class extends LoadRequest {
        constructor(info: object) { if (!(info instanceof MediaInfo)) throw new Error("Invalid media"); super(info); }
      }, SeekRequest: class { currentTime = 0; },
    } } };
  const api: CastApi = { issue: jest.fn(async (id) => ({ token: id, url: `https://music.test/stream?token=${id}`, expiresAt: "future", contentType: "audio/flac" })),
    revoke: jest.fn(async () => {}) };
  const loader = jest.fn(async () => sdk);
  const manager = new CastManager(api, loader);
  return { manager, api, load, session, loader, context, events,
    getMedia: () => { if (!media) throw new Error("Missing media"); return media; },
    lose: () => { sessionPresent = false; events.get("session")?.(); } };
}
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); setBrowserPrivacy(undefined); });

test("SDK stays unloaded until connect, then casts capability URL and music metadata at the exact fractional position", async () => {
  const { manager, loader, load, api, context } = setup();
  expect(loader).not.toHaveBeenCalled();
  await manager.connect();
  expect(context.setOptions).toHaveBeenCalledWith(expect.objectContaining({ resumeSavedSession: false }));
  await manager.load(track("a"), { startAt: 101.375, autoplay: true });
  expect(api.issue).toHaveBeenCalledWith("a", undefined);
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ autoplay: true, currentTime: 101.375,
    info: expect.objectContaining({ url: "https://music.test/stream?token=a", contentType: "audio/flac",
      metadata: expect.objectContaining({ title: "Song a", artist: "Artist", albumName: "Album" }) }) }));
  expect(manager.getSnapshot()).toMatchObject({ key: "a", state: "playing", position: 101.375 });
  expect(manager.getState()).toMatchObject({ device: "Living Room", connected: true });
  await manager.destroy();
});

test("receiver pause/play/seek/volume stay remote, and finished is emitted exactly once per queue occurrence", async () => {
  const { manager, session, getMedia } = setup();
  const events: RemoteAudioSnapshot[] = [];
  manager.subscribe((snapshot) => events.push(snapshot));
  await manager.connect(); await manager.load(track("a"), { autoplay: false });
  await manager.play(); expect(manager.getSnapshot().state).toBe("playing");
  await manager.pause(); expect(manager.getSnapshot().state).toBe("paused");
  await manager.seek(42.125); expect(manager.getSnapshot().position).toBe(42.125);
  await manager.setVolume(.34); expect(session.setVolume).toHaveBeenCalledWith(.34);
  getMedia().playerState = "IDLE"; getMedia().idleReason = "FINISHED";
  jest.advanceTimersByTime(1000);
  expect(events.filter((event) => event.ended)).toHaveLength(1);
  await manager.load(track("b"), { autoplay: true });
  expect(manager.getSnapshot().key).toBe("b");
  await manager.destroy();
});

test("rapid skips discard stale authorizations and only load the latest queued selection", async () => {
  const { manager, api, load } = setup();
  await manager.connect();
  const a = manager.load(track("a"), { autoplay: true });
  const b = manager.load(track("b"), { autoplay: true });
  const c = manager.load(track("c"), { autoplay: true });
  await Promise.all([a, b, c]);
  expect(api.issue).toHaveBeenCalledTimes(1);
  expect(api.issue).toHaveBeenCalledWith("c", undefined);
  expect(load).toHaveBeenCalledTimes(1);
  expect(manager.getSnapshot().key).toBe("c");
  await manager.destroy();
});

test("an older in-flight receiver load cannot publish progress under the newly selected queue key", async () => {
  const { manager, load, api } = setup();
  await manager.connect();
  const normalLoad = load.getMockImplementation()!;
  let complete: (() => void) | undefined;
  load.mockImplementationOnce(async (request) => {
    await new Promise<void>((resolve) => { complete = resolve; });
    await normalLoad(request);
  });
  const first = manager.load(track("a"), { startAt: 40 });
  for (let count = 0; count < 10; count++) await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(1);
  const last = manager.load(track("b"), { startAt: 0 });
  complete?.();
  for (let count = 0; count < 6; count++) await Promise.resolve();
  jest.advanceTimersByTime(250);
  expect(manager.getSnapshot()).not.toMatchObject({ key: "b", position: 40 });
  await Promise.all([first, last]);
  expect(manager.getSnapshot()).toMatchObject({ key: "b", position: 0, state: "playing" });
  expect(api.revoke).toHaveBeenCalledWith("a");
  await manager.destroy();
});

test("switching tracks revokes the old capability; disconnect stops the receiver, revokes and removes listeners", async () => {
  const { manager, api, context, events } = setup();
  await manager.connect(); await manager.load(track("a"), {}); await manager.load(track("b"), {});
  expect(api.revoke).toHaveBeenCalledWith("a");
  await manager.destroy();
  expect(api.revoke).toHaveBeenCalledWith("b");
  expect(context.endCurrentSession).toHaveBeenCalledWith(true);
  expect(events.size).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});

test("receiver loss preserves position and emits disconnection without automatically playing locally", async () => {
  const { manager, lose, api } = setup();
  await manager.connect(); await manager.load(track("a"), { startAt: 32.5 });
  lose();
  expect(manager.getState().connected).toBe(false);
  expect(manager.getSnapshot()).toMatchObject({ disconnected: true, state: "paused", position: 32.5 });
  expect(api.revoke).toHaveBeenCalledWith("a");
  await manager.destroy();
});

test("previews are rejected and receiver load errors revoke the ticket instead of pretending to play", async () => {
  const { manager, load, api } = setup();
  await manager.connect();
  await expect(manager.load({ key: "preview", src: "https://preview.test" }, {})).rejects.toThrow("Only local library");
  load.mockRejectedValueOnce(new Error("Unsupported format"));
  await expect(manager.load(track("a"), {})).rejects.toThrow("Unsupported format");
  expect(api.revoke).toHaveBeenCalledWith("a");
  expect(manager.getSnapshot().state).toBe("error");
  await manager.destroy();
});

test("unsupported browsers fail clearly without adding an external script", async () => {
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
  expect(supportsCast()).toBe(false);
  await expect(loadCastSdk()).rejects.toThrow("supported Chromium browser");
  expect(document.querySelector('script[src*="cast_sender"]')).toBeNull();
});

test("Local-Only denies SDK initialization before a script or Google request can be created", async () => {
  setBrowserPrivacy({ localOnly: true, enforcedByEnvironment: false, allowMetadata: true, allowArtwork: true, allowImports: true,
    effective: { external: false, metadata: false, artwork: false, imports: false } });
  await expect(loadCastSdk()).rejects.toThrow("privacy policy");
  expect(document.querySelector('script[src*="cast_sender"]')).toBeNull();
});

test("the real CastManager feeds receiver completion into the existing queue store without starting local audio", async () => {
  const localPlay = jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const localPause = jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const localLoad = jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  const { manager, getMedia } = setup();
  const engine = new PlaybackEngine({ audioContext: null, transitionMode: "crossfade" });
  const queue = renderHook(() => useQueueStore<PlayableTrack & { id: string }>(engine, {
    toPlayable: (entry) => ({ ...entry.track, key: entry.entryId }),
  }));
  try {
    await manager.connect();
    await engine.setRemoteOutput(manager);
    act(() => { queue.result.current.setQueue([track("a"), track("b")], 0, { autoplay: true }); });
    await waitFor(() => expect(getMedia().media.contentId).toContain("token=a"));
    const firstOccurrence = queue.result.current.state.entries[0].entryId;
    getMedia().playerState = "IDLE"; getMedia().idleReason = "FINISHED";
    await act(async () => { jest.advanceTimersByTime(250); });
    await waitFor(() => expect(getMedia().media.contentId).toContain("token=b"));
    expect(queue.result.current.state.currentIndex).toBe(1);
    expect(engine.getSnapshot().key).not.toBe(firstOccurrence);
    expect(engine.getSnapshot().mode).toBe("off");
    expect(localPlay).not.toHaveBeenCalled();
  } finally {
    queue.unmount(); engine.destroy(); await manager.destroy();
    localPlay.mockRestore(); localPause.mockRestore(); localLoad.mockRestore();
  }
});
