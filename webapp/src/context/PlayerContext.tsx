import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getVisualActivity, startVisualPolling } from "../services/visualActivity";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { PlayerItemStateProvider } from "./PlayerItemState";
import { RemoteSessionContext } from "./RemoteSessionContext";
import { CastContext } from "./CastContext";
import { useCastSession } from "../hooks/useCastSession";
import {
  DESKTOP_CONFIG_CHANGED_EVENT,
  isDesktopRuntime,
  resolveDesktopApiUrl,
} from "../services/desktop/desktopRuntime";
import { usePrivacy } from "./PrivacyContext";
import { useRemoteSession } from "../hooks/useRemoteSession";
import type { RemotePlaybackSnapshot, RemotePlayerAdapter } from "../types/remoteSession";
import type { LibraryPlaybackSelection } from "../types/libraryTracks";
import { playlistOrder, playlistPlaybackContext, playlistViewTracks, type PlaylistPlaybackView } from "../utils/playlistPlayback";
import {
  getStreamUrl,
  getListeningTrack,
  prepareNormalizedPlayback,
  getRecentlyPlayed,
  getStarred,
  reportPlaybackSession,
  getListeningConfig,
  LISTENING_ACTIVITY_CHANGED_EVENT,
  starSong,
  unstarSong,
  getAutoplayTracks,
  getPlaylist,
  getRandomSongs,
  getTrackCollection,
  RECOMMENDATION_FEEDBACK_CHANGED_EVENT,
  getUserSettings,
  updateUserSettings,
  getSilenceAnalysis,
  SILENCE_ANALYZED_EVENT,
  analyzeSilence,
  USER_SETTINGS_CHANGED_EVENT,
  saveMediaCheckpoint,
} from "../api/musicdeck";
import { createMediaSessionTracker, isMediaResumeContext, MEDIA_CHECKPOINT_CHANGED } from "../services/mediaSessions";
import { useStreamQualityDetails } from "../hooks/useStreamQualityDetails";
import type { StreamQualityDetails } from "../hooks/useStreamQualityDetails";
import type { MediaCheckpoint, MediaCheckpointInput } from "../services/mediaSessions";
import { useAuth } from "./AuthContext";
import { tasteProfileStore, TASTE_CHANGED } from "../services/TasteProfileStore";
import { DEFAULT_ACCENT_COLOR, normalizeAccentColor } from "../utils/accentColors";
import { trustedPreviewUrl } from "../utils/previewPlayback";
import { initialPlaybackUrl } from "../utils/streamRecovery";
import { queueDeviceId, queueSyncClient } from "../services/QueueSyncClient";
import { playbackFeatureEnabled } from "../services/playbackFeatures";
import type { AccountQueueSource } from "../services/QueueSyncClient";
import { newestPeerQueue, useAccountQueue } from "../hooks/useAccountQueue";
import type { QueueCheckpoint, QueueContent } from "../services/storage/QueueDatabase";
import { sanitizeQueueTrack } from "../services/storage/QueueDatabase";
import { createListeningTracker } from "../utils/listeningTracker";
import { gainToPerceptualVolume, perceptualVolumeToGain } from "../utils/volume";
import { isShuffleMode, smartShuffle, SMART_SHUFFLE_WINDOW_MS } from "../utils/shuffle";
import type { ShuffleMode, ShufflePlay, SmartShuffleOptions } from "../utils/shuffle";
import {
  DEFAULT_LOUDNESS_TARGET,
  LOUDNESS_TARGETS,
  loudnessGainDb,
  preparedPlaybackGainDb,
  replayGainMetadata,
  trackGainDb,
  validLoudness,
} from "../utils/loudness";
import { usePlaybackEngine } from "../hooks/usePlaybackEngine";
import { useBrowserMediaSession } from "../hooks/useBrowserMediaSession";
import { currentEntryOf, QUEUE_PREVIEW_SIZE, repeatModeOf, shuffleUpcoming, upcomingEntryOf, useQueueStore, usePersistentQueue } from "../hooks/useQueueStore";
import type { PlaybackStatus, QueueEntry, QueueState, QueueStore, RepeatMode, SetQueueOptions } from "../hooks/useQueueStore";
import { PLAYBACK_BLOCKED_MESSAGE } from "../services/audio/PlaybackEngine";
import type { PlaybackEngine } from "../services/audio/PlaybackEngine";
import { replayGainLevel } from "../services/audio/outputs";
import { offlineDownloadEngine } from "../services/storage/OfflineDownloadEngine";
import {
  CROSSFADE_MAX_SECONDS,
  CROSSFADE_MIN_SECONDS,
  DEFAULT_CROSSFADE_SECONDS,
} from "../services/audio/crossfadeTransition";
import type { EngineState, PlayableTrack, SilenceTrim, TransitionMode as EngineTransitionMode } from "../services/audio/types";

/*
 * PlayerProvider binds the app to the playback engine.
 *
 *   PlaybackEngine (services/audio)  — owns every <audio> deck, Web Audio node,
 *                                      gapless/crossfade transition and stall recovery.
 *   useQueueStore (hooks)            — pure queue state machine; turns queue
 *                                      changes into engine loads.
 *   PlayerProvider (this file)       — product behaviour around them: settings,
 *                                      normalization/ReplayGain, silence trim,
 *                                      scrobbling, auto-refill, persistence, likes.
 *
 * The provider never touches an audio element directly: it passes per-track
 * gain/trim through `toPlayable` and `engine.updateTrack`, and reads time and
 * state from engine events.
 */

// ---------------------------------------------------------------- types

// `any` keeps the shape compatible with the JS pages that build song objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Song = { id: string | number; [key: string]: any };

export interface PlaybackContextInfo {
  type: string;
  id: string;
  name: string;
  coverArt: string | null;
  [key: string]: unknown;
}

export type PlayableSourceRef = string | { id: string; [key: string]: unknown };
export type Sidebar = "none" | "now-playing" | "queue";
export type StreamQuality = "128" | "256" | "320" | "original" | "direct";
export type DownloadQuality = "lossless" | "320kbps" | "256kbps" | "192kbps" | "128kbps";
export type LayoutDensity = "comfortable" | "compact";

export const TRANSITION_MODES = ["none", "gapless", "crossfade"] as const;
export type TransitionMode = (typeof TRANSITION_MODES)[number];
export { CROSSFADE_MAX_SECONDS, CROSSFADE_MIN_SECONDS, DEFAULT_CROSSFADE_SECONDS };

export interface PlayerContextValue {
  flushQueuePersistence: () => Promise<unknown>;
  restoreSavedQueue: (content: QueueContent, checkpoint: QueueCheckpoint) => void;
  accountQueueSource?: AccountQueueSource;
  queuePersistenceError: string;
  currentSong: Song | null;
  activeSidebar: Sidebar;
  setActiveSidebar: (next: Sidebar | ((current: Sidebar) => Sidebar)) => void;
  autoOpenSidebar: boolean;
  isEndlessPlaybackEnabled: boolean;
  autoDownloadLiked: boolean;
  isPlaying: boolean;
  isRemotePlayback: boolean;
  isCasting: boolean;
  /** Fine-grained queue status: PLAYING, PAUSED, BUFFERING, STALLED or TRANSITIONING. */
  playbackStatus: PlaybackStatus;
  isBuffering: boolean;
  /** The last explicit desktop position or the latest sample for browser and remote playback. */
  currentTime: number;
  playbackPositionKey?: string;
  readPlaybackPosition?: () => number;
  duration: number;
  queue: Song[];
  queueIndex: number;
  recentlyPlayed: Song[];
  playHistory: Song[];
  likedSongIds: Set<string>;
  isCurrentSongLiked: boolean;
  playbackContext: PlaybackContextInfo | null;
  isPreview: boolean;
  isShuffleEnabled: boolean;
  shuffleMode: ShuffleMode;
  changeShuffleMode: (mode: ShuffleMode) => void;
  isAlbumAware: boolean;
  changeAlbumAware: (enabled: boolean) => void;
  isLooping: boolean;
  repeatMode: RepeatMode;
  previewDurationSeconds: number | null;
  playbackUnavailable: boolean;
  playbackMessage: string;
  isPreparingPlayback: boolean;
  volume: number;
  transitionMode: TransitionMode;
  crossfadeDuration: number;
  streamQuality: StreamQuality;
  streamQualityDetails: StreamQualityDetails;
  applyStreamQuality: (quality: StreamQuality) => Promise<void>;
  downloadQuality: DownloadQuality;
  isReplayGainEnabled: boolean;
  normalizationTarget: number;
  layoutDensity: LayoutDensity;
  accentColor: string;
  playSong: (song: Song) => Promise<void>;
  addToQueue: (song: Song) => void;
  queueTracks: (tracks: Song[]) => void;
  playTracksNext: (tracks: Song[]) => void;
  playSongFromSource: (song: Song, source: PlayableSourceRef) => Promise<void>;
  playContext: (tracks: Song[], startIndex?: number, context?: PlaybackContextInfo | null, playlistView?: PlaylistPlaybackView) => Promise<void>;
  playLibraryTracks: (selection: LibraryPlaybackSelection, signal: AbortSignal, excluded?: ReadonlySet<string>) => Promise<void>;
  playQueue: (songs: Song[], startIndex?: number, context?: PlaybackContextInfo | null, playlistView?: PlaylistPlaybackView) => Promise<void>;
  resumeMedia: (songs: Song[], index: number, context: PlaybackContextInfo, positionSeconds: number) => Promise<void>;
  playQueueSong: (index: number) => Promise<void>;
  moveQueueItem: (from: number, to: number) => void;
  nextSong: () => Promise<void>;
  previousSong: () => Promise<void>;
  toggleShuffle: () => void;
  toggleLoop: () => void;
  loopPlaylistId: string | null;
  togglePlaylistLoop: (playlistId: string) => void;
  togglePlay: () => void;
  toggleLike: () => Promise<void>;
  toggleLikeSong: (song: Song | null | undefined) => Promise<void>;
  setTrackFavorite: (song: Song, liked: boolean) => Promise<void>;
  seek: (percent: number) => void;
  seekToSeconds: (seconds: number) => void;
  changeVolume: (value: number) => void;
  changeTransitionMode: (value: TransitionMode) => void;
  changeCrossfadeDuration: (value: number) => void;
  changeStreamQuality: (value: string) => void;
  changeDownloadQuality: (value: string) => void;
  changeReplayGainEnabled: (value: boolean) => void;
  changeNormalizationTarget: (value: number | string) => void;
  changeLayoutDensity: (value: string) => void;
  changeAccentColor: (value: string) => void;
  changeAutoOpenSidebar: (value: boolean) => void;
  changeEndlessPlaybackEnabled: (value: boolean) => void;
  changeAutoDownloadLiked: (value: boolean) => void;
  resetPlayer: () => void;
  audioEngine?: PlaybackEngine | null;
  sleepAlbumKeys?: readonly string[];
}

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  session: { id: string } | null;
}

interface ListeningTracker {
  markTaste(): void;
  begin(song: Song, audio: ListeningClock, resume?: boolean): void;
  finish(): void;
  flush(): void;
  suspend(): void;
  setThreshold(value: number): void;
}

interface NormalizationResult {
  status: string;
  gainDb?: number;
  streamUrl?: string;
  loudness?: unknown;
  [key: string]: unknown;
}

interface NormalizationRequest {
  listeners: Set<(result: NormalizationResult) => void>;
  controller: AbortController;
  wake: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  promise: Promise<NormalizationResult | undefined>;
}

interface ResolvedAudio {
  url: string;
  normalized: boolean;
  loudness?: unknown;
  originalLoudness?: unknown;
  gainDb?: number;
}

/** What a queue entry's gain was derived from; replaced when anything it depends on changes. */
interface NormalizationBinding {
  song: Song;
  source: unknown;
  previewUrl: string | null;
  normalized: boolean;
  measurement: unknown;
}

interface SilenceTrimSettings {
  enabled: boolean;
  thresholdDb: number;
  minSilenceSeconds: number;
}

interface SilenceAnalysis {
  status?: string;
  leadingSilenceSeconds?: number;
  trailingSilenceSeconds?: number;
  durationSeconds?: number | null;
  thresholdDb?: number;
  minSilenceSeconds?: number;
}

function matchesSilenceProfile(analysis: SilenceAnalysis | null, params: Pick<SilenceTrimSettings, "thresholdDb" | "minSilenceSeconds">): analysis is SilenceAnalysis {
  return analysis?.status === "completed" &&
    (analysis.thresholdDb === undefined || analysis.thresholdDb === params.thresholdDb) &&
    (analysis.minSilenceSeconds === undefined || analysis.minSilenceSeconds === params.minSilenceSeconds);
}

interface RestoreRequest {
  trackId: string;
  attempted: boolean;
  blocked: boolean;
}

// ---------------------------------------------------------------- constants

const RECONNECTING_MESSAGE = "Connection interrupted. Reconnecting…";
const RESTARTED_MESSAGE = "Reconnected. This stream can't resume mid-track, so it restarted.";
const PREVIEW_UNAVAILABLE_MESSAGE = "Preview unavailable for this track";
const PREVIEW_DURATION_SECONDS = 30;
const MESSAGE_TIMEOUT_MS = 4200;
const MAX_RECENTLY_PLAYED = 50;
const RESTART_THRESHOLD_SECONDS = 3;
/** Auto-refill starts once this many (or fewer) tracks remain after the current one. */
export const REFILL_TRIGGER_UPCOMING = 2;
const ENDLESS_LOOKUP_TIMEOUT_MS = 2500;
const NORMALIZED_STREAM = /^\/api\/playback\/normalized\/[a-f0-9]{64}$/;
const NORMALIZATION_POLL_MS = 1500;
const NORMALIZATION_DEADLINE_MS = 195_000;
const NORMALIZATION_CACHE_LIMIT = 50;
const NORMALIZATION_CACHE_TTL_MS = 10 * 60_000;
const NORMALIZATION_UNAVAILABLE_TTL_MS = 60_000;
const NORMALIZATION_PREWARM_COUNT = 2;
const STREAM_QUALITIES: readonly StreamQuality[] = ["128", "256", "320", "original", "direct"];
const DOWNLOAD_QUALITIES: readonly DownloadQuality[] = ["lossless", "320kbps", "256kbps", "192kbps", "128kbps"];
const VALID_SIDEBARS: ReadonlySet<string> = new Set(["none", "now-playing", "queue"]);

const STATE_CLOCK_EVENTS: Readonly<Partial<Record<EngineState, string>>> = {
  playing: "playing",
  paused: "pause",
  idle: "pause",
  error: "pause",
  buffering: "waiting",
  stalled: "waiting",
};

// ---------------------------------------------------------------- helpers

function normalizeSidebar(value: unknown): Sidebar {
  return typeof value === "string" && VALID_SIDEBARS.has(value) ? (value as Sidebar) : "none";
}

function normalizeRecentlyPlayed(value: unknown): Song[] {
  return Array.isArray(value)
    ? value.filter((song) => Number.isFinite(Date.parse(song?.playedAt))).slice(0, MAX_RECENTLY_PLAYED)
    : [];
}

function readStored(key: string, label: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.error(`Could not load ${label}:`, error);
    return null;
  }
}

function writeStored(key: string, value: string, label: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.error(`Could not save ${label}:`, error);
  }
}

export function isTransitionMode(value: unknown): value is TransitionMode {
  return typeof value === "string" && (TRANSITION_MODES as readonly string[]).includes(value);
}

/** Whole seconds within the engine's 1–10 s crossfade window. */
export function clampCrossfadeDuration(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return DEFAULT_CROSSFADE_SECONDS;
  return Math.min(CROSSFADE_MAX_SECONDS, Math.max(CROSSFADE_MIN_SECONDS, Math.round(seconds)));
}

function engineTransitionMode(mode: TransitionMode): EngineTransitionMode {
  return mode === "none" ? "off" : mode;
}

/**
 * Before transition modes existed a crossfade of 0 s meant "no crossfade".
 * A saved positive duration therefore migrates to crossfade mode; everything
 * else starts gapless, which never alters audio.
 */
function initialTransitionSettings(): { mode: TransitionMode; seconds: number } {
  const savedMode = readStored("playerTransitionMode", "transition mode");
  const savedRaw = readStored("playerCrossfadeDuration", "crossfade duration");
  const savedSeconds = savedRaw === null ? Number.NaN : Number(savedRaw);
  const legacyCrossfade = Number.isFinite(savedSeconds) && savedSeconds > 0;
  return {
    mode: isTransitionMode(savedMode) ? savedMode : legacyCrossfade ? "crossfade" : "gapless",
    seconds: legacyCrossfade ? clampCrossfadeDuration(savedSeconds) : DEFAULT_CROSSFADE_SECONDS,
  };
}

/** Whether the song can stream straight from the local library. */
function isLibraryPlayable(song: Song | null | undefined): boolean {
  if (!song) return false;
  if (song.availability && typeof song.availability.libraryAvailable === "boolean") {
    return song.availability.libraryAvailable;
  }
  const kind = song.source && song.source.kind;
  return !kind || kind === "library" || kind === "musicdeck";
}

/** Library tracks stream in full; catalog-only tracks may only use a trusted provider preview. */
function songSource(song: Song): { library: boolean; source: unknown; previewUrl: string | null } {
  const library = isLibraryPlayable(song);
  return {
    library,
    source: library ? song.playableSource || song.sourceId || null : null,
    previewUrl: library ? null : trustedPreviewUrl(song.previewUrl) || null,
  };
}

function unplayableReasonFor(song: Song): string | null {
  const { library, previewUrl } = songSource(song);
  return library || previewUrl ? null : PREVIEW_UNAVAILABLE_MESSAGE;
}

function songDurationHint(song: Song | null | undefined): number | null {
  const value = Number(song?.duration ?? song?.metadata?.durationSeconds);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function decibelsToLevel(gainDb: number): number {
  return 10 ** (Math.max(-60, Math.min(12, gainDb)) / 20);
}

function randomValues(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, () => Math.random());
}

function sameSongId(a: Song | null | undefined, b: Song | null | undefined): boolean {
  return a?.id != null && b?.id != null && String(a.id) === String(b.id);
}
function playlistIdFor(context: PlaybackContextInfo | null, track?: Song): string | null {
  if (context?.type === "playlist") return context.id ? String(context.id) : null;
  if (context?.type === "collection" && context.id && context.playlistLoopId === String(context.id)) return String(context.id);
  // A filtered playlist's queue checkpoint retains its collection ID and track attribution.
  return context?.type === "collection" && track?.tastePlaylistId === context.id ? context.id : null;
}

function serializePlaybackContext(context: PlaybackContextInfo | null): QueueCheckpoint["context"] {
  if (!context) return null;
  const id = String(context.id ?? "").slice(0, 1024);
  return { type: String(context.type ?? "").slice(0, 80), id, name: String(context.name ?? "").slice(0, 500),
    coverArt: typeof context.coverArt === "string" ? context.coverArt.slice(0, 2048) : null,
    ...(context.type === "collection" && id && context.playlistLoopId === String(context.id) ? { playlistLoopId: id } : {}) };
}

function playlistTracksIn(state: QueueState<Song>, playlistId: string): Song[] {
  return state.entries.map(({ track }) => track).filter((track) => track.tastePlaylistId === playlistId ||
    (isMediaResumeContext(track.mediaResume) && track.mediaResume.type === "playlist" && track.mediaResume.mediaId === playlistId));
}

function mediaTracks(tracks: Song[], context: PlaybackContextInfo | null): Song[] {
  const playlistId = playlistIdFor(context);
  return tracks.map((track, trackIndex) => ({
    ...track,
    ...(playlistId ? { tastePlaylistId: playlistId } : {}),
    mediaResume: context?.id && (context.type === "album" || context.type === "playlist") && isLibraryPlayable(track) ? {
      type: context.type, mediaId: String(context.id), title: context.name,
      trackIndex, trackCount: tracks.length, occurrenceId: typeof track.playlistItemId === "string" ? track.playlistItemId : null,
    } : undefined,
  }));
}

async function lookupEndlessTracks<T>(load: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const controller = new AbortController();
  let timer: number | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => load(controller.signal)).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = window.setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, ENDLESS_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    window.clearTimeout(timer);
  }
}

function asEndlessTrack(track: Song): Song {
  return { ...track, autoplayGenerated: true, albumPlaybackId: undefined, albumTrackIndex: undefined, mediaResume: undefined };
}

function reshuffledPlaylistOrder(tracks: Song[], previous: Song[]): number[] {
  const shuffled = shuffleUpcoming(tracks.map((_, index) => index), -1, randomValues(tracks.length - 1));
  const occurrence = (track: Song) => track.playlistItemId ?? track.mediaResume?.occurrenceId ?? track.id;
  if (shuffled.length > 1 && previous.length === shuffled.length &&
      shuffled.every((trackIndex, index) => occurrence(tracks[trackIndex]) === occurrence(previous[index]))) {
    return [...shuffled.slice(1), shuffled[0]];
  }
  return shuffled;
}

/**
 * The listening tracker was written against an audio element: it reads
 * `currentTime`/`duration` and listens for media events. One clock per queue
 * entry adapts engine events to that contract, so a gapless or crossfade
 * hand-over (where the audible element changes) never confuses it.
 */
class ListeningClock extends EventTarget {
  readonly playbackRate = 1;
  readonly loop = false;
  seeking = false;
  duration = Number.NaN;
  private lastPosition = 0;

  constructor(private readonly livePosition: () => number | null) {
    super();
  }

  get currentTime(): number {
    const live = this.livePosition();
    if (live !== null) this.lastPosition = live;
    return this.lastPosition;
  }

  emit(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

// ---------------------------------------------------------------- context

const PlayerContext = createContext<PlayerContextValue | null>(null);
// Never provided: lets PlayerItemState read "no player" without a conditional hook call.
const InactivePlayerContext = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({ children }: { children?: ReactNode }) {
  const [features] = useState(() => ({
    remoteControl: playbackFeatureEnabled("remoteControl"),
    streamInspection: playbackFeatureEnabled("streamInspection"),
    serverNormalization: playbackFeatureEnabled("serverNormalization"),
    queueCloudSync: playbackFeatureEnabled("queueCloudSync"),
    mediaSessions: playbackFeatureEnabled("mediaSessions"),
    listeningEvents: playbackFeatureEnabled("listeningEvents"),
    silenceTrimming: playbackFeatureEnabled("silenceTrimming"),
    autoplayRecommendations: playbackFeatureEnabled("autoplayRecommendations"),
    audioEffects: playbackFeatureEnabled("audioEffects"),
  }));
  const { isAuthenticated, isLoading: authIsLoading, session } = useAuth() as unknown as AuthState;
  const sessionId = session?.id ?? null;
  // The remembered collection permits local reads without granting server access.
  const localQueueOwner = isAuthenticated ? sessionId : authIsLoading ? null : offlineDownloadEngine.getOwner?.() ?? null;
  const [preferLocalQueue, setPreferLocalQueue] = useState(false);
  useEffect(() => { setPreferLocalQueue(false); }, [sessionId]);

  // ------------------------------------------------------------ preferences

  const [initialTransition] = useState(initialTransitionSettings);
  const [transitionMode, setTransitionMode] = useState<TransitionMode>(initialTransition.mode);
  const [crossfadeDuration, setCrossfadeDuration] = useState(initialTransition.seconds);
  const [isAlbumAware, setIsAlbumAware] = useState(() => readStored("playerAlbumAware", "album-aware mode") === "true");
  const albumAwareRef = useRef(isAlbumAware);
  const albumPreferenceVersionRef = useRef(0);

  const [volume, setVolume] = useState(() => {
    const saved = readStored("playerVolume", "volume");
    const value = Number(saved);
    return saved !== null && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
  });

  const [streamQuality, setStreamQuality] = useState<StreamQuality>(() => {
    const saved = readStored("playerStreamQuality", "streaming quality");
    return STREAM_QUALITIES.includes(saved as StreamQuality) ? (saved as StreamQuality) : "original";
  });

  const [downloadQuality, setDownloadQuality] = useState<DownloadQuality>(() => {
    const saved = readStored("playerDownloadQuality", "download quality");
    return DOWNLOAD_QUALITIES.includes(saved as DownloadQuality) ? (saved as DownloadQuality) : "320kbps";
  });

  const [isReplayGainEnabled, setIsReplayGainEnabled] = useState(
    () => readStored("playerNormalizationEnabled", "ReplayGain preference") !== "false"
  );
  const replayGainActive = (features.audioEffects || features.serverNormalization) && isReplayGainEnabled;
  const [normalizationTarget, setNormalizationTarget] = useState<number>(DEFAULT_LOUDNESS_TARGET);

  const [layoutDensity, setLayoutDensity] = useState<LayoutDensity>(() =>
    readStored("playerLayoutDensity", "layout density") === "compact" ? "compact" : "comfortable"
  );
  const [accentColor, setAccentColor] = useState<string>(() =>
    normalizeAccentColor(readStored("playerAccentColor", "accent color")) || DEFAULT_ACCENT_COLOR
  );
  const [autoOpenSidebar, setAutoOpenSidebar] = useState(
    () => readStored("playerAutoOpenSidebar", "auto-open sidebar preference") === "true"
  );
  const [isEndlessPlaybackEnabled, setIsEndlessPlaybackEnabled] = useState(
    () => readStored("playerAutoplayEnabled", "endless playback preference") === "true"
  );
  const endlessRef = useRef(isEndlessPlaybackEnabled);
  const endlessVersionRef = useRef(0);
  const [autoDownloadLiked, setAutoDownloadLiked] = useState(
    () => readStored("playerAutoDownloadLiked", "auto-download preference") === "true"
  );
  const [silenceTrimSettings, setSilenceTrimSettings] = useState<SilenceTrimSettings>({
    enabled: false,
    thresholdDb: -35,
    minSilenceSeconds: 0.5,
  });

  // Refs give engine callbacks and async work the latest values without re-subscribing.
  const transitionModeRef = useRef(transitionMode);
  const crossfadeDurationRef = useRef(crossfadeDuration);
  const streamQualityRef = useRef(streamQuality);
  const replayGainEnabledRef = useRef(replayGainActive);
  const normalizationTargetRef = useRef<number>(DEFAULT_LOUDNESS_TARGET);

  // ------------------------------------------------------------ UI state

  const [activeSidebar, setActiveSidebarState] = useState<Sidebar>("none");
  const setActiveSidebar = useCallback((next: Sidebar | ((current: Sidebar) => Sidebar)) => {
    setActiveSidebarState((current) => normalizeSidebar(typeof next === "function" ? next(current) : next));
  }, []);

  const desktop = isDesktopRuntime();
  const [currentTime, setTimeState] = useState(0);
  const currentTimeRef = useRef(0);
  const setCurrentTime = useCallback((position: number) => {
    currentTimeRef.current = position;
    setTimeState(position);
  }, []);
  const [duration, setDuration] = useState(0);
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const [audioDurationInfo, setAudioDurationInfo] = useState<{ entryId: string; audioDuration: number } | null>(null);
  const [isShuffleEnabled, setIsShuffleEnabled] = useState(false);
  const [shuffleMode, setShuffleMode] = useState<ShuffleMode>(() => {
    const stored = readStored("playerShuffleMode", "shuffle mode");
    return isShuffleMode(stored) ? stored : "standard";
  });
  const shuffleModeRef = useRef(shuffleMode);
  const shuffleEnabledRef = useRef(isShuffleEnabled);
  shuffleEnabledRef.current = isShuffleEnabled;
  const shufflePreferenceVersionRef = useRef(0);
  const shuffleSaveRef = useRef<Promise<void>>(Promise.resolve());
  const shuffleHistoryRef = useRef<{ userId: string | null; plays: ShufflePlay[]; entryId: string | null }>({
    userId: null, plays: [], entryId: null,
  });
  const [recentlyPlayed, setRecentlyPlayed] = useState<Song[]>([]);
  const [likedSongIds, setLikedSongIds] = useState<Set<string>>(() => new Set());
  const shuffleDataOwnerRef = useRef<{ recent: string | null; favorites: string | null }>({ recent: null, favorites: null });
  const [playbackContext, setPlaybackContext] = useState<PlaybackContextInfo | null>(null);
  const playbackContextRef = useRef(playbackContext);
  playbackContextRef.current = playbackContext;
  const [loopPlaylistId, setLoopPlaylistId] = useState<string | null>(null);
  const loopPlaylistRef = useRef<string | null>(null);
  const [playbackUnavailable, setPlaybackUnavailable] = useState(false);
  const [playbackMessage, setPlaybackMessage] = useState("");
  const [hydratedQueueUserId, setHydratedQueueUserId] = useState<string | null>(null);
  const [queuePersistenceError, setQueuePersistenceError] = useState("");
  const [restorePending, setRestorePending] = useState(false);

  function smartShuffleOptions(): SmartShuffleOptions {
    const now = Date.now();
    const local = shuffleHistoryRef.current.userId === sessionId ? shuffleHistoryRef.current.plays : [];
    const localIds = new Set(local.filter((play) => play.playedAt <= now && now - play.playedAt < SMART_SHUFFLE_WINDOW_MS).map((play) => String(play.id)));
    const remote = (shuffleDataOwnerRef.current.recent === sessionId ? recentlyPlayed : [])
      .filter((song) => !localIds.has(String(song.id))).map((song): ShufflePlay => ({
        id: song.id, artist: song.artist, artistId: song.artistId, playedAt: Date.parse(song.playedAt),
      }));
    return {
      seed: Math.floor(Math.random() * 0x100000000),
      now,
      recentPlays: [...remote, ...local],
      favoriteIds: shuffleDataOwnerRef.current.favorites === sessionId ? [...likedSongIds] : [],
    };
  }
  const smartShuffleOptionsRef = useRef(smartShuffleOptions);
  smartShuffleOptionsRef.current = smartShuffleOptions;

  useEffect(() => {
    const now = Date.now();
    const history = { userId: sessionId, plays: [] as ShufflePlay[], entryId: null as string | null };
    if (sessionId) {
      const raw = readStored(`musicdeck:shuffle-history:v1:${encodeURIComponent(sessionId)}`, "shuffle listening history");
      if (raw) {
        try {
          const data: unknown = JSON.parse(raw);
          if (!Array.isArray(data)) throw new Error("Invalid shuffle listening history.");
          for (const item of data) {
            if (!item || typeof item !== "object" || !["string", "number"].includes(typeof item.id) ||
              typeof item.playedAt !== "number" || !Number.isFinite(item.playedAt) ||
              (item.artist !== undefined && typeof item.artist !== "string") ||
              (item.artistId != null && !["string", "number"].includes(typeof item.artistId))) {
              throw new Error("Invalid shuffle listening history entry.");
            }
            if (item.playedAt <= now && now - item.playedAt < SMART_SHUFFLE_WINDOW_MS) history.plays.push(item);
          }
        } catch (error) { console.error("Could not restore shuffle listening history:", error); }
      }
    }
    shuffleHistoryRef.current = history;
    return () => { shuffleHistoryRef.current = { userId: null, plays: [], entryId: null }; };
  }, [sessionId]);

  const transferTransaction = useRef<{ signal: AbortSignal; rollback: () => void } | null>(null);
  const [stagingTransfer, setStagingTransfer] = useState(false);
  const mediaTrackerRef = useRef<ReturnType<typeof createMediaSessionTracker> | null>(null);
  const recordShufflePlay = useCallback((entry: QueueEntry<Song>) => {
    if (transferTransaction.current) return;
    const history = shuffleHistoryRef.current;
    if (!history.userId || history.entryId === entry.entryId) return;
    const now = Date.now();
    history.entryId = entry.entryId;
    const taste = tasteProfileStore.getSnapshot();
    if ((taste.owner === history.userId && taste.privateListening) || tasteProfileStore.excludes(entry.track)) { tasteExcludedEntriesRef.current.add(entry.entryId); return; }
    const recent = history.plays.filter((play) => play.playedAt <= now && now - play.playedAt < SMART_SHUFFLE_WINDOW_MS);
    // Keep the last five actual play events plus the last timestamp per track.
    const seen = new Set([String(entry.track.id)]);
    const retained: ShufflePlay[] = [];
    for (let index = recent.length - 1; index >= 0; index--) {
      const play = recent[index];
      const id = String(play.id);
      if (index >= recent.length - 4 || !seen.has(id)) retained.push(play);
      seen.add(id);
    }
    history.plays = retained.reverse();
    history.plays.push({
      id: entry.track.id, artist: typeof entry.track.artist === "string" ? entry.track.artist : undefined,
      artistId: typeof entry.track.artistId === "string" || typeof entry.track.artistId === "number" ? entry.track.artistId : undefined,
      playedAt: now,
    });
    writeStored(`musicdeck:shuffle-history:v1:${encodeURIComponent(history.userId)}`, JSON.stringify(history.plays), "shuffle listening history");
  }, []);

  // ------------------------------------------------------------ engine + queue

  const audioHostRef = useRef<HTMLDivElement | null>(null);
  const createAudioElement = useCallback(() => {
    const element = document.createElement("audio");
    audioHostRef.current?.appendChild(element);
    return element;
  }, []);

  const engine = usePlaybackEngine({
    transitionMode: features.audioEffects ? engineTransitionMode(transitionMode) : "off",
    albumAware: features.audioEffects && isAlbumAware,
    crossfadeSeconds: crossfadeDuration,
    volume: perceptualVolumeToGain(volume),
    createAudioElement,
    ...(desktop || !features.audioEffects ? { audioContext: null } : {}),
  });
  const engineRef = useRef<PlaybackEngine | null>(engine);
  engineRef.current = engine;
  const privacy = usePrivacy();
  const cast = useCastSession(engine, isAuthenticated ? sessionId : null, Boolean(privacy.policy?.effective.external));

  /** Resolved stream per entry, so the prepared upcoming track and its later load agree. */
  const sourceCacheRef = useRef(new Map<string, ResolvedAudio>());
  /** Latest linear level per entry; reloads (repeat, normalization toggle) reuse it. */
  const gainByEntryRef = useRef(new Map<string, number>());
  const trimByEntryRef = useRef(new Map<string, SilenceTrim>());
  const bindingsRef = useRef(new Map<string, NormalizationBinding>());
  const normalizationRequestsRef = useRef(new Map<string, NormalizationRequest>());
  const normalizationControllersRef = useRef(new Set<AbortController>());
  const normalizationCacheRef = useRef(new Map<string, { result: NormalizationResult; expires: number }>());

  useEffect(() => {
    if (!isDesktopRuntime()) return undefined;
    function handleDesktopConfigChanged() {
      sourceCacheRef.current.clear();
    }
    window.addEventListener(DESKTOP_CONFIG_CHANGED_EVENT, handleDesktopConfigChanged);
    return () => window.removeEventListener(DESKTOP_CONFIG_CHANGED_EVENT, handleDesktopConfigChanged);
  }, []);

  function albumPlayback(song: Song): boolean {
    return albumAwareRef.current && !shuffleEnabledRef.current && isLibraryPlayable(song) &&
      typeof song.albumPlaybackId === "string";
  }

  function normalizationKey(song: Song, source: unknown, previewUrl: string | null): string {
    return JSON.stringify([song.id, source, previewUrl, streamQualityRef.current, normalizationTargetRef.current]);
  }

  function cachedNormalization(key: string): NormalizationResult | null {
    const cached = normalizationCacheRef.current.get(key);
    return cached && cached.expires > Date.now() ? cached.result : null;
  }

  /** Normalization state for a song from the cache alone; never builds a stream URL. */
  function normalizationInfo(song: Song, source: unknown, previewUrl: string | null): Omit<ResolvedAudio, "url"> & {
    streamUrl?: string;
  } {
    if (!features.serverNormalization) return { normalized: false };
    if (offlineDownloadEngine.getSnapshot().tracks.some((track) => track.track_id === String(song.id) && track.status === "verified")) return { normalized: false };
    if (!replayGainEnabledRef.current || albumPlayback(song) || streamQualityRef.current === "direct") return { normalized: false };
    const result = cachedNormalization(normalizationKey(song, source, previewUrl));
    if (result?.status === "ready" && typeof result.streamUrl === "string" && NORMALIZED_STREAM.test(result.streamUrl)) {
      return { normalized: true, loudness: validLoudness(result), originalLoudness: validLoudness(result.loudness),
        gainDb: result.gainDb, streamUrl: result.streamUrl };
    }
    return { normalized: false, gainDb: result?.gainDb, originalLoudness: validLoudness(result) };
  }

  function originalPlaybackUrl(song: Song, source: unknown, previewUrl: string | null): string {
    return previewUrl
      ? `/api/playback/preview?url=${encodeURIComponent(previewUrl)}`
      : initialPlaybackUrl(String(getStreamUrl(song.id, source, streamQualityRef.current)), features.streamInspection);
  }

  function resolvePlaybackAudio(song: Song, source: unknown, previewUrl: string | null): ResolvedAudio {
    const { streamUrl, ...info } = normalizationInfo(song, source, previewUrl);
    return { ...info, url: streamUrl ?? originalPlaybackUrl(song, source, previewUrl) };
  }

  /**
   * An entry's stream and level are pinned when first handed to the engine,
   * so a normalized stream never also receives a measured gain (double gain).
   */
  function resolvedFor(entry: QueueEntry<Song>): ResolvedAudio {
    let resolved = sourceCacheRef.current.get(entry.entryId);
    if (resolved) return resolved;
    const { source, previewUrl } = songSource(entry.track);
    resolved = resolvePlaybackAudio(entry.track, source, previewUrl);
    sourceCacheRef.current.set(entry.entryId, resolved);
    const binding = bindingsRef.current.get(entry.entryId);
    if (resolved.normalized) {
      gainByEntryRef.current.set(entry.entryId, 1);
      if (binding) {
        binding.normalized = true;
        binding.measurement = resolved.loudness ?? binding.measurement;
      }
    } else if (binding?.normalized) {
      // The normalized stream expired between binding and loading.
      binding.normalized = false;
      gainByEntryRef.current.set(entry.entryId, initialLevel(entry, resolved));
      requestEntryNormalization(entry.entryId, binding);
    }
    return resolved;
  }

  function importedGainDb(song: Song, previewUrl: string | null): number | undefined {
    if (!replayGainEnabledRef.current || previewUrl) return undefined;
    const gain = trackGainDb(song, normalizationTargetRef.current);
    return Number.isFinite(gain) ? gain : undefined;
  }

  /** The level an entry starts at: imported/cached loudness, else tag ReplayGain, else unity. */
  function initialLevel(entry: QueueEntry<Song>, resolved: { normalized: boolean; gainDb?: number }): number {
    if (!replayGainEnabledRef.current || resolved.normalized) return 1;
    if (albumPlayback(entry.track)) return replayGainLevel(replayGainMetadata(entry.track), true);
    const { previewUrl } = songSource(entry.track);
    const known = importedGainDb(entry.track, previewUrl) ?? resolved.gainDb;
    return typeof known === "number" && Number.isFinite(known)
      ? decibelsToLevel(known)
      : replayGainLevel(replayGainMetadata(entry.track));
  }

  function recoverOriginal(entry: QueueEntry<Song>, prepared: ResolvedAudio): { src: string; gain: number } {
    const { source, previewUrl } = songSource(entry.track);
    const key = normalizationKey(entry.track, source, previewUrl);
    if (cachedNormalization(key)?.streamUrl === prepared.url) normalizationCacheRef.current.delete(key);
    const original = {
      url: originalPlaybackUrl(entry.track, source, previewUrl),
      normalized: false,
      gainDb: loudnessGainDb(prepared.originalLoudness, normalizationTargetRef.current) ?? prepared.gainDb,
    };
    const binding = bindingsRef.current.get(entry.entryId);
    if (binding) {
      binding.normalized = false;
      binding.measurement = prepared.originalLoudness;
    }
    const gain = initialLevel(entry, original);
    sourceCacheRef.current.set(entry.entryId, original);
    gainByEntryRef.current.set(entry.entryId, gain);
    return { src: resolveDesktopApiUrl(original.url), gain };
  }

  const toPlayable = (entry: QueueEntry<Song>): PlayableTrack => {
    const resolved = resolvedFor(entry);
    const gain = gainByEntryRef.current.get(entry.entryId) ?? initialLevel(entry, resolved);
    gainByEntryRef.current.set(entry.entryId, gain);
    const trim = trimByEntryRef.current.get(entry.entryId);
    const preview = Boolean(songSource(entry.track).previewUrl);
    return {
      key: entry.entryId,
      ...(!preview && isLibraryPlayable(entry.track) ? { offlineTrackId: String(entry.track.id), offlineOnly: Boolean(entry.track.offlineOnly) } : {}),
      ...(isLibraryPlayable(entry.track) && !preview ? { cast: {
        trackId: String(entry.track.id), title: String(entry.track.title || ""),
        artist: String(entry.track.artist || ""), album: String(entry.track.album || ""),
        ...(["128", "256", "320"].includes(streamQualityRef.current) ? { maxBitRate: Number(streamQualityRef.current) } : {}),
      } } : {}),
      albumPlaybackId: albumPlayback(entry.track) ? entry.track.albumPlaybackId : undefined,
      albumTrackIndex: albumPlayback(entry.track) ? entry.track.albumTrackIndex : undefined,
      src: resolveDesktopApiUrl(resolved.url),
      ...(resolved.normalized ? { normalizedFallback: () => recoverOriginal(entry, resolved) } : {}),
      gain,
      // A preview is only a fragment of the recording: the engine ends it here.
      trimEnd: preview ? PREVIEW_DURATION_SECONDS : null,
      silenceTrim: preview || albumPlayback(entry.track) ? null : trim ?? null,
      durationHint: songDurationHint(entry.track),
    };
  };

  const unplayableReason = (entry: QueueEntry<Song>) => unplayableReasonFor(entry.track);

  const store = useQueueStore<Song>(engine, {
    toPlayable,
    unplayableReason,
    restartThresholdSeconds: RESTART_THRESHOLD_SECONDS,
  });
  const queueState = store.state;
  const storeRef = useRef<QueueStore<Song>>(store);
  storeRef.current = store;
  const stateRef = useRef<QueueState<Song>>(queueState);
  stateRef.current = queueState;

  const currentEntry = store.currentEntry;
  const upcomingEntry = store.upcomingEntry;
  const currentEntryId = currentEntry?.entryId ?? null;
  const { loadRequest, loadSequence, lastError, generation, currentIndex, entries } = queueState;
  const isPlaying = queueState.status !== "PAUSED";
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const isPreview = Boolean(currentEntry && songSource(currentEntry.track).previewUrl);
  const isPreviewRef = useRef(isPreview);
  isPreviewRef.current = isPreview;

  const queue = useMemo(() => entries.map((entry) => entry.track), [entries]);

  const currentSong = useMemo<Song | null>(() => {
    if (!currentEntry) return null;
    const track = currentEntry.track;
    if (audioDurationInfo?.entryId !== currentEntry.entryId) return track;
    return {
      ...track,
      metadataDuration: track.metadataDuration ?? track.duration ?? track.metadata?.durationSeconds ?? null,
      audioDuration: audioDurationInfo.audioDuration,
    };
  }, [currentEntry, audioDurationInfo]);
  const resolvedCurrentAudio = currentEntryId ? sourceCacheRef.current.get(currentEntryId) : undefined;
  const streamQualityDetails = useStreamQualityDetails({
    engine, trackId: currentSong ? String(currentSong.id) : null,
    streamUrl: resolvedCurrentAudio?.url ?? null, userId: isAuthenticated ? sessionId : null,
    preview: isPreview, serverNormalized: resolvedCurrentAudio?.normalized ?? false,
    enabled: features.streamInspection,
  });

  /** Engine position when it is playing this entry; otherwise the last known UI position. */
  const positionOf = useCallback((entryId: string | null): number => {
    const activeEngine = engineRef.current;
    const snapshot = entryId ? activeEngine?.getSnapshot() : undefined;
    if (snapshot && snapshot.key === entryId) return snapshot.position;
    return currentTimeRef.current;
  }, []);
  const readPlaybackPosition = useCallback(() => positionOf(currentEntryOf(stateRef.current)?.entryId ?? null), [positionOf]);

  function engineHasLoaded(entryId: string | null): boolean {
    return Boolean(entryId && engineRef.current && engineRef.current.getSnapshot().key === entryId);
  }

  const checkpointOwnerRef = useRef(sessionId);
  checkpointOwnerRef.current = isAuthenticated ? sessionId : null;
  useEffect(() => {
    if (!features.mediaSessions || !engine || !isAuthenticated || !sessionId) return;
    const controllers = new Set<AbortController>();
    const tracker = createMediaSessionTracker({
      engine,
      getTrack: (key) => transferTransaction.current ? undefined
        : stateRef.current.entries.find((entry) => entry.entryId === key)?.track,
      save: async (input: MediaCheckpointInput) => {
        if (checkpointOwnerRef.current !== sessionId) return;
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 15_000);
        controllers.add(controller);
        try {
          const result: { checkpoint: MediaCheckpoint | null } = await saveMediaCheckpoint(input, controller.signal);
          if (checkpointOwnerRef.current === sessionId && !controller.signal.aborted) {
            window.dispatchEvent(new CustomEvent(MEDIA_CHECKPOINT_CHANGED, { detail: { userId: sessionId, checkpoint: result.checkpoint, input } }));
          }
        } finally { window.clearTimeout(timeout); controllers.delete(controller); }
      },
    });
    mediaTrackerRef.current = tracker;
    return () => {
      if (mediaTrackerRef.current === tracker) mediaTrackerRef.current = null;
      const sameAccount = checkpointOwnerRef.current === sessionId;
      if (!sameAccount) controllers.forEach((controller) => controller.abort());
      tracker.destroy({ flushPending: sameAccount });
    };
  }, [engine, features.mediaSessions, isAuthenticated, sessionId]);

  // ------------------------------------------------------------ listening tracker

  const listeningSessionRef = useRef<ListeningTracker | null>(null);
  const tasteExcludedEntriesRef = useRef(new Set<string>());
  useEffect(() => {
    tasteExcludedEntriesRef.current.clear(); let resetBefore = tasteProfileStore.getSnapshot().resetBefore;
    const changed = () => {
      const state = tasteProfileStore.getSnapshot(); if (state.owner !== sessionId) return;
      const entry = currentEntryOf(stateRef.current), resetChanged = state.resetBefore !== resetBefore; resetBefore = state.resetBefore;
      if (entry && (state.privateListening || tasteProfileStore.excludes(entry.track) || resetChanged)) {
        listeningSessionRef.current?.markTaste();
        if (!tasteExcludedEntriesRef.current.has(entry.entryId)) {
          tasteExcludedEntriesRef.current.add(entry.entryId);
          const history = shuffleHistoryRef.current, index = history.plays.map(play => String(play.id)).lastIndexOf(String(entry.track.id));
          if (index >= 0 && history.entryId === entry.entryId) history.plays.splice(index, 1);
        }
      }
      const history = shuffleHistoryRef.current;
      history.plays = history.plays.filter(play => (!state.resetBefore || play.playedAt > Date.parse(state.resetBefore)) && !(state.excludedTrackIds ?? []).includes(String(play.id)));
      if (history.userId === sessionId && sessionId) writeStored(`musicdeck:shuffle-history:v1:${encodeURIComponent(sessionId)}`, JSON.stringify(history.plays), "shuffle listening history");
      feedbackVersionRef.current++;
      window.dispatchEvent(new Event(LISTENING_ACTIVITY_CHANGED_EVENT));
    };
    window.addEventListener(TASTE_CHANGED, changed); return () => window.removeEventListener(TASTE_CHANGED, changed);
  }, [sessionId]);
  const trackingUserRef = useRef<string | null>(null);
  trackingUserRef.current = isAuthenticated ? sessionId : null;
  const clocksRef = useRef(new Map<string, ListeningClock>());

  function clockFor(entryId: string): ListeningClock {
    let clock = clocksRef.current.get(entryId);
    if (!clock) {
      clock = new ListeningClock(() => {
        const activeEngine = engineRef.current;
        return activeEngine && activeEngine.getSnapshot().key === entryId ? activeEngine.getPosition() : null;
      });
      clocksRef.current.set(entryId, clock);
    }
    return clock;
  }

  useEffect(() => {
    if (!features.listeningEvents || !isAuthenticated || !sessionId) return undefined;
    let storage: Storage | undefined;
    try { storage = window.sessionStorage; } catch { /* Reporting can use its in-memory outbox. */ }
    const tracker = createListeningTracker({
      userId: sessionId,
      storage,
      report: reportPlaybackSession,
      onCounted: undefined,
      onTasteExcluded: (payload: { trackId: string; startedAt: string; reportedAt?: string }, isActive: boolean) => {
        if (!mountedRef.current || trackingUserRef.current !== sessionId) return;
        const history = shuffleHistoryRef.current, started = Date.parse(payload.startedAt), ended = Date.parse(payload.reportedAt || new Date().toISOString());
        history.plays = history.plays.filter(play => String(play.id) !== payload.trackId || play.playedAt < started - 1000 || play.playedAt > ended + 1000);
        if (isActive) { const entry = currentEntryOf(stateRef.current); if (entry) tasteExcludedEntriesRef.current.add(entry.entryId); }
        if (history.userId === sessionId) writeStored(`musicdeck:shuffle-history:v1:${encodeURIComponent(sessionId)}`, JSON.stringify(history.plays), "shuffle listening history");
      },
      getTasteContext: (song: Song) => ({ privateListening: tasteProfileStore.getSnapshot().owner === sessionId && tasteProfileStore.getSnapshot().privateListening,
        excludeFromTaste: tasteProfileStore.excludes(song), playlistId: typeof song.tastePlaylistId === "string" ? song.tastePlaylistId : null }),
    }) as ListeningTracker;
    listeningSessionRef.current = tracker;
    Promise.resolve().then(() => getListeningConfig())
      .then((config: { thresholdSeconds: number }) => tracker.setThreshold(config.thresholdSeconds))
      .catch(() => undefined);
    const flush = () => tracker.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      if (trackingUserRef.current !== sessionId) tracker.finish();
      tracker.suspend();
      window.removeEventListener("pagehide", flush);
      if (listeningSessionRef.current === tracker) listeningSessionRef.current = null;
    };
  }, [features.listeningEvents, isAuthenticated, sessionId]);

  // A new load or a new entry closes the previous listening session; playing a
  // library track (never a preview) opens one. The tracker reports the moment
  // 50% of the track or 20 s has been heard, which is when the server scrobbles.
  const trackedLoadRef = useRef<{ entryId: string | null; sequence: number }>({ entryId: null, sequence: 0 });
  useEffect(() => {
    const tracker = listeningSessionRef.current;
    const tracked = trackedLoadRef.current;
    const sequence = loadRequest?.entryId === currentEntryId ? loadSequence : tracked.sequence;
    if (tracked.entryId !== currentEntryId || tracked.sequence !== sequence) {
      if (tracked.entryId !== null) tracker?.finish();
      trackedLoadRef.current = { entryId: currentEntryId, sequence };
    }
    if (!tracker || stagingTransfer || transferTransaction.current || !isPlaying || !currentEntry || isPreview || !isLibraryPlayable(currentEntry.track)) return;
    tracker.begin(currentEntry.track, clockFor(currentEntry.entryId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, currentEntryId, loadSequence, isPreview, isAuthenticated, sessionId, stagingTransfer]);

  // ------------------------------------------------------------ restore helpers

  const restoreRef = useRef<RestoreRequest | null>(null);
  const resumeListenerCleanupRef = useRef<(() => void) | null>(null);
  /** Position for an entry that was selected without loading (a restored, paused queue). */
  const cuedPositionRef = useRef<{ trackId: string; seconds: number } | null>(null);

  const automaticallyResuming = useRef(false);
  const cancelRestoreResume = useCallback(() => {
    automaticallyResuming.current = false;
    resumeListenerCleanupRef.current?.();
    resumeListenerCleanupRef.current = null;
    restoreRef.current = null;
    setRestorePending(false);
  }, []);

  const attemptRestoredPlaybackRef = useRef<(restore: RestoreRequest) => void>(() => undefined);
  const restoredCheckpointTime = useRef(0);
  const remotePlayingElsewhere = useRef(false);
  const suppressedRestoreRevision = useRef<number | null>(null);
  const followingAccountQueue = useRef(false);
  attemptRestoredPlaybackRef.current = (restore: RestoreRequest) => {
    const activeEngine = engineRef.current;
    if (!activeEngine || restoreRef.current !== restore || remotePlayingElsewhere.current) return;
    automaticallyResuming.current = true;
    restore.blocked = false;
    // Called synchronously from click/keydown handlers so user activation is kept.
    activeEngine.play().catch(() => undefined).then(() => {
      if (restoreRef.current !== restore) return;
      setRestorePending(false);
      if (!restore.blocked) {
        resumeListenerCleanupRef.current?.();
        resumeListenerCleanupRef.current = null;
        restoreRef.current = null;
        return;
      }
      if (resumeListenerCleanupRef.current) return;
      const retry = () => {
        resumeListenerCleanupRef.current?.();
        resumeListenerCleanupRef.current = null;
        attemptRestoredPlaybackRef.current(restore);
      };
      window.addEventListener("click", retry, { once: true });
      window.addEventListener("keydown", retry, { once: true });
      resumeListenerCleanupRef.current = () => {
        window.removeEventListener("click", retry);
        window.removeEventListener("keydown", retry);
      };
    });
  };

  useEffect(() => () => {
    resumeListenerCleanupRef.current?.();
    resumeListenerCleanupRef.current = null;
    restoreRef.current = null;
  }, []);

  // ------------------------------------------------------------ engine → UI sync

  /** Reads duration/position after the engine handled `loadedmetadata` (including any resume seek). */
  const syncFromEngineRef = useRef<() => void>(() => undefined);
  syncFromEngineRef.current = () => {
    const activeEngine = engineRef.current;
    const entry = currentEntryOf(stateRef.current);
    if (!activeEngine || !entry) return;
    const snapshot = activeEngine.getSnapshot();
    if (snapshot.key !== entry.entryId) return;
    if (snapshot.duration > 0) {
      setDuration(snapshot.duration);
      setAudioDurationInfo((previous) =>
        previous?.entryId === entry.entryId && previous.audioDuration === snapshot.duration
          ? previous
          : { entryId: entry.entryId, audioDuration: snapshot.duration }
      );
      if (features.listeningEvents) clockFor(entry.entryId).duration = snapshot.duration;
    }
    setCurrentTime(snapshot.position);
    const restore = restoreRef.current;
    if (restore && !restore.attempted && String(entry.track.id) === restore.trackId) {
      restore.attempted = true;
      const account = queueSyncClient.getSnapshot();
      const peer = features.queueCloudSync && account.owner === checkpointOwnerRef.current
        ? newestPeerQueue(account.sessions, queueDeviceId()) : undefined;
      if (remotePlayingElsewhere.current || (peer && peer.checkpoint.capturedAt > restoredCheckpointTime.current)) {
        suppressedRestoreRevision.current = stateRef.current.revision;
        followingAccountQueue.current = true;
        cancelRestoreResume();
      } else attemptRestoredPlaybackRef.current(restore);
    }
  };

  useEffect(() => {
    const host = audioHostRef.current;
    if (!host) return undefined;
    // Media events do not bubble, but they do pass ancestors in the capture phase.
    // The microtask runs after the engine's own listeners on the element.
    const sync = () => queueMicrotask(() => syncFromEngineRef.current());
    const forward = (type: "seeking" | "seeked") => () => {
      const entryId = engineRef.current?.getSnapshot().key;
      const clock = entryId ? clocksRef.current.get(entryId) : undefined;
      if (!clock) return;
      clock.seeking = type === "seeking";
      clock.emit(type);
    };
    const onSeeking = forward("seeking");
    const onSeeked = forward("seeked");
    host.addEventListener("loadedmetadata", sync, true);
    host.addEventListener("durationchange", sync, true);
    host.addEventListener("seeking", onSeeking, true);
    host.addEventListener("seeked", onSeeked, true);
    return () => {
      host.removeEventListener("loadedmetadata", sync, true);
      host.removeEventListener("durationchange", sync, true);
      host.removeEventListener("seeking", onSeeking, true);
      host.removeEventListener("seeked", onSeeked, true);
    };
  }, []);

  // Each new entry or load starts from its requested position and known
  // duration. Adjusted during render so the new track never shows the old time.
  const positionKey = `${currentEntryId}:${loadSequence}`;
  const [renderedPositionKey, setRenderedPositionKey] = useState(positionKey);
  if (renderedPositionKey !== positionKey) {
    setRenderedPositionKey(positionKey);
    const cued = cuedPositionRef.current;
    let position = 0;
    if (loadRequest && loadRequest.entryId === currentEntryId && loadRequest.sequence === loadSequence) {
      position = loadRequest.startAt;
    } else if (cued && currentEntry && String(currentEntry.track.id) === cued.trackId) {
      position = cued.seconds;
    }
    setCurrentTime(position);
    setDuration(songDurationHint(currentEntry?.track) ?? 0);
  }

  // A cued (unloaded) position is consumed by the first real load.
  useEffect(() => {
    if (loadRequest) cuedPositionRef.current = null;
  }, [loadRequest]);

  const queueEndPendingRef = useRef<{ generation: number; loadSequence: number } | null>(null);
  const feedbackVersionRef = useRef(0);
  const playlistPassRef = useRef<{ context: PlaybackContextInfo; tracks: Song[] | null; pending?: Promise<Song[]> } | null>(null);
  const refillAttemptRef = useRef<{
    generation: number; entryId: string; version: number; claimedAtEnd: boolean; pending: Promise<Song[]>;
  } | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const stopAtQueueEnd = useCallback(() => {
    cancelRestoreResume();
    listeningSessionRef.current?.finish();
    engineRef.current?.pause();
    storeRef.current.stop();
    cuedPositionRef.current = null;
    playlistPassRef.current = null;
    setPlaybackContext(null);
    setPlaybackUnavailable(false);
  }, [cancelRestoreResume]);

  const preparePlaylistPass = useCallback((context: PlaybackContextInfo, playlistId: string) => {
    const previous = playlistPassRef.current;
    if (previous?.context === context) return previous;
    const pass: NonNullable<typeof playlistPassRef.current> = { context, tracks: null };
    pass.pending = lookupEndlessTracks(async (signal) => {
      const playlist = await getPlaylist(playlistId, signal);
      return mediaTracks(playlist?.entry ?? [], { ...context, type: "playlist", id: playlistId });
    }).then((tracks) => {
      pass.tracks = tracks ?? [];
      return pass.tracks;
    });
    playlistPassRef.current = pass;
    return pass;
  }, []);

  const prepareEndlessRefill = useCallback((state: QueueState<Song>, entry: QueueEntry<Song>) => {
    const version = endlessVersionRef.current;
    const previous = refillAttemptRef.current;
    if (previous?.generation === state.generation && previous.entryId === entry.entryId && previous.version === version) return previous;
    const isCurrent = () => mountedRef.current && endlessRef.current && endlessVersionRef.current === version &&
      stateRef.current.generation === state.generation && currentEntryOf(stateRef.current)?.entryId === entry.entryId;
    const refillCapacity = (current: QueueState<Song>, scheduled: readonly Song[] = []) => {
      const queued = new Set(current.entries.map(({ track }) => String(track.id)));
      // The recommendation append may still be waiting for a React render.
      const pendingCount = scheduled.filter((track) => !queued.has(String(track.id))).length;
      for (const track of scheduled) queued.add(String(track.id));
      const upcoming = current.entries.length - current.currentIndex - 1;
      return { queued, needed: Math.max(0, QUEUE_PREVIEW_SIZE - upcoming - pendingCount) };
    };
    const select = (results: unknown, libraryOnly: boolean, scheduled: readonly Song[] = []) => {
      if (!Array.isArray(results)) return [];
      const { queued, needed } = refillCapacity(stateRef.current, scheduled);
      const candidates = results.filter((song: Song) => {
        if (song?.id == null || queued.has(String(song.id)) ||
            (libraryOnly ? !isLibraryPlayable(song) : unplayableReasonFor(song))) return false;
        queued.add(String(song.id));
        return true;
      });
      const ordered = shuffleEnabledRef.current && shuffleModeRef.current === "smart"
        ? smartShuffle(candidates, { ...smartShuffleOptionsRef.current(), currentTrack: entry.track }).tracks : candidates;
      const available = libraryOnly && !ordered.length ? candidates : ordered;
      return available.slice(0, needed).map(asEndlessTrack);
    };
    const canRecommend = () => features.autoplayRecommendations && isLibraryPlayable(entry.track) &&
      !tasteExcludedEntriesRef.current.has(entry.entryId) && !tasteProfileStore.getSnapshot().privateListening &&
      !tasteProfileStore.excludes(entry.track);
    const attempt = { generation: state.generation, entryId: entry.entryId, version,
      claimedAtEnd: false, pending: Promise.resolve<Song[]>([]) };
    refillAttemptRef.current = attempt;
    attempt.pending = (async () => {
      let recommendations: Song[] = [];
      if (canRecommend()) {
        const limit = refillCapacity(state).needed + 5;
        const feedbackVersion = feedbackVersionRef.current;
        const excludeIds = state.entries.map(({ track }) => track.id);
        const taste = entry.track.tastePlaylistId ? { playlistId: String(entry.track.tastePlaylistId) } : {};
        const results = await lookupEndlessTracks((signal) => getAutoplayTracks(entry.track.id, limit, excludeIds, taste, signal));
        if (!isCurrent() || feedbackVersionRef.current !== feedbackVersion) return [];
        recommendations = canRecommend() ? select(results, false) : [];
        if (recommendations.length) {
          if (attempt.claimedAtEnd || stateRef.current.repeatOne) return recommendations;
          storeRef.current.append(recommendations, { dedupe: true, generation: attempt.generation });
        }
      }
      if (!isCurrent()) return [];
      const { queued, needed } = refillCapacity(stateRef.current, recommendations);
      if (!needed) return [];
      // Ask for extra candidates so queued tracks don't consume the remaining slots.
      const limit = Math.min(100, needed + Math.max(5, queued.size));
      const library = await lookupEndlessTracks((signal) => getRandomSongs(limit, signal));
      return isCurrent() ? select(library, true, recommendations) : [];
    })().catch(() => []);
    return attempt;
  }, [features.autoplayRecommendations]);

  const continueAfterQueueEnd = useCallback(async (signal?: AbortSignal, manual = false) => {
    const state = stateRef.current;
    const pending = queueEndPendingRef.current;
    if (signal?.aborted || (pending?.generation === state.generation && pending.loadSequence === state.loadSequence)) return;
    const entry = currentEntryOf(state);
    const context = playbackContextRef.current;
    const playlistId = playlistIdFor(context, entry?.track);
    const finishNormally = () => {
      if (stateRef.current.repeatAll) storeRef.current.jumpToIndex(0);
      else stopAtQueueEnd();
    };
    const playlistLoopActive = () => Boolean(playlistId && playlistId === loopPlaylistRef.current);
    if ((!endlessRef.current && !playlistLoopActive()) || !entry || (state.repeatAll && !playlistId)) {
      finishNormally();
      return;
    }

    const continuation = { generation: state.generation, loadSequence: state.loadSequence };
    queueEndPendingRef.current = continuation;
    const version = endlessVersionRef.current;
    const stillAtEnd = () => !signal?.aborted && mountedRef.current && stateRef.current.generation === state.generation &&
      currentEntryOf(stateRef.current)?.entryId === entry.entryId && stateRef.current.loadSequence === state.loadSequence;
    const advance = (action: () => void) => signal ? flushSync(action) : action();
    try {
      let tracks: Song[];
      let shuffleOrder: number[] | undefined;
      if (context && playlistId) {
        const pass = preparePlaylistPass(context, playlistId);
        const fullPlaylist = pass.tracks ?? await pass.pending ?? [];
        if (!stillAtEnd()) return;
        const previous = playlistTracksIn(stateRef.current, playlistId);
        if (!fullPlaylist.length) playlistPassRef.current = null;
        const canonical = fullPlaylist.length ? fullPlaylist : [...previous].sort((a, b) =>
          (a.mediaResume?.trackIndex ?? 0) - (b.mediaResume?.trackIndex ?? 0));
        tracks = canonical.filter((track) => !unplayableReasonFor(track));
        if (shuffleEnabledRef.current) shuffleOrder = reshuffledPlaylistOrder(tracks, previous);
      } else {
        const local = state.entries.find(({ track }) => !sameSongId(track, entry.track) && isLibraryPlayable(track))?.track
          ?? (isLibraryPlayable(entry.track) ? entry.track : null);
        let attempt = refillAttemptRef.current;
        if (attempt?.entryId !== entry.entryId || attempt.generation !== state.generation) attempt = null;
        if (!local) attempt = prepareEndlessRefill(state, entry);
        if (attempt) attempt.claimedAtEnd = true;
        // Reuse a library track immediately if the network refill is still waiting.
        tracks = local ? [asEndlessTrack(local)] : await attempt?.pending ?? [];
      }

      if (!stillAtEnd()) return;
      if (!manual && stateRef.current.repeatOne) { advance(() => storeRef.current.loadCurrent()); return; }
      if (stateRef.current.repeatAll && !playlistId) { advance(finishNormally); return; }
      if (!playlistLoopActive() && (!endlessRef.current || version !== endlessVersionRef.current)) { advance(finishNormally); return; }
      if (upcomingEntryOf(stateRef.current)) { advance(() => storeRef.current.playNext()); return; }
      if (!tracks.length) { advance(finishNormally); return; }
      advance(() => {
        if (playlistId) storeRef.current.setQueue(tracks, 0, { shuffleOrder });
        else {
          storeRef.current.append(tracks, { generation: state.generation });
          storeRef.current.playNext();
        }
      });
    } catch {
      if (stillAtEnd()) advance(finishNormally);
    } finally {
      if (queueEndPendingRef.current === continuation) queueEndPendingRef.current = null;
    }
  }, [prepareEndlessRefill, preparePlaylistPass, stopAtQueueEnd]);

  useEffect(() => {
    if (!engine) return undefined;
    const currentKey = () => currentEntryOf(stateRef.current)?.entryId ?? null;
    const unsubscribers = [
      engine.on("silenceSkipped", ({ key }) => clocksRef.current.get(key)?.emit("seeked")),
      engine.on("timeUpdate", ({ key, position, duration: total }) => {
        const clock = clocksRef.current.get(key);
        if (clock) {
          if (total > 0) clock.duration = total;
          clock.emit("timeupdate");
        }
        if (key !== currentKey()) return;
        if (desktop && !engine.isRemoteOutput) currentTimeRef.current = position;
        else setCurrentTime(position);
        if (total > 0 && total !== durationRef.current) setDuration(total);
      }),
      engine.on("stateChange", ({ key, state }) => {
        const type = STATE_CLOCK_EVENTS[state];
        const clock = key ? clocksRef.current.get(key) : undefined;
        if (type && clock) clock.emit(type);
        if (state === "playing" && key === currentKey() && stateRef.current.lastError) {
          setPlaybackUnavailable(false);
          setPlaybackMessage("");
        }
        const entry = state === "playing" ? stateRef.current.entries.find((candidate) => candidate.entryId === key) : null;
        if (entry) recordShufflePlay(entry);
      }),
      engine.on("transitionCommit", ({ fromKey, toKey }) => {
        if (trackedLoadRef.current.entryId === fromKey) listeningSessionRef.current?.finish();
        const entry = stateRef.current.entries.find((candidate) => candidate.entryId === toKey);
        if (entry) recordShufflePlay(entry);
      }),
      engine.on("trackEnd", ({ key }) => {
        if (trackedLoadRef.current.entryId === key) listeningSessionRef.current?.finish();
        const state = stateRef.current;
        const entry = currentEntryOf(state);
        if (!entry || entry.entryId !== key || state.repeatOne) return;
        if (state.currentIndex + 1 < state.entries.length) return;
        void continueAfterQueueEnd();
      }),
      engine.on("sleepStop", () => listeningSessionRef.current?.finish()),
      engine.on("bufferStall", ({ key }) => {
        if (key !== currentKey()) return;
        setPlaybackUnavailable(false);
        setPlaybackMessage(RECONNECTING_MESSAGE);
      }),
      engine.on("streamRecovered", ({ key, restartedFromBeginning, streamUrl }) => {
        if (key !== currentKey()) return;
        const resolved = sourceCacheRef.current.get(key);
        if (streamUrl && resolved) {
          const query = new URL(streamUrl, window.location.origin).search;
          sourceCacheRef.current.set(key, { ...resolved, url: resolved.url.split("?")[0] + query });
        }
        setPlaybackUnavailable(false);
        if (restartedFromBeginning) {
          // Unseekable streams (live transcodes) cannot resume mid-track.
          setPlaybackMessage(RESTARTED_MESSAGE);
          return;
        }
        setPlaybackMessage((message) => (message === RECONNECTING_MESSAGE ? "" : message));
      }),
      engine.on("error", ({ message }) => {
        if (restoreRef.current && message === PLAYBACK_BLOCKED_MESSAGE) restoreRef.current.blocked = true;
      }),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [desktop, engine, continueAfterQueueEnd, recordShufflePlay, setCurrentTime]);

  // Engine errors surface once per new message; any new load clears the previous one.
  const messageLoadRef = useRef(0);
  useEffect(() => {
    if (messageLoadRef.current !== loadSequence) {
      messageLoadRef.current = loadSequence;
      setPlaybackMessage("");
      setPlaybackUnavailable(false);
    }
    if (!lastError) return;
    // A blocked restore waits silently for the next click or key press.
    if (restoreRef.current && lastError === PLAYBACK_BLOCKED_MESSAGE) return;
    setPlaybackMessage(lastError);
    setPlaybackUnavailable(lastError !== PLAYBACK_BLOCKED_MESSAGE);
  }, [loadSequence, lastError]);

  useEffect(() => {
    if (queueState.shuffleExcludedCount > 0) {
      setPlaybackMessage(`Smart Shuffle left out ${queueState.shuffleExcludedCount} recent or duplicate upcoming tracks. The current track and playback history were kept.`);
    }
  }, [queueState.shuffleSeed, queueState.shuffleExcludedCount]);

  useEffect(() => {
    if (!playbackMessage) return undefined;
    const timeout = window.setTimeout(() => setPlaybackMessage(""), MESSAGE_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [playbackMessage]);

  // Forget per-entry state for entries that left the queue.
  useEffect(() => {
    const live = new Set(entries.map((entry) => entry.entryId));
    for (const map of [
      sourceCacheRef.current,
      gainByEntryRef.current,
      trimByEntryRef.current,
      bindingsRef.current,
      clocksRef.current,
    ] as Map<string, unknown>[]) {
      for (const entryId of Array.from(map.keys())) if (!live.has(entryId)) map.delete(entryId);
    }
    for (const entryId of Array.from(trimRequestsRef.current.keys())) {
      if (!live.has(entryId)) trimRequestsRef.current.delete(entryId);
    }
  }, [entries]);

  // ------------------------------------------------------------ normalization

  function requestNormalization(
    song: Song,
    source: unknown,
    previewUrl: string | null,
    listener?: (result: NormalizationResult) => void
  ): Promise<NormalizationResult | undefined> {
    if (!features.serverNormalization || streamQualityRef.current === "direct") return Promise.resolve(undefined);
    const key = normalizationKey(song, source, previewUrl);
    const target = normalizationTargetRef.current;
    const cached = cachedNormalization(key);
    if (cached && ["ready", "measured", "unavailable"].includes(cached.status)) {
      listener?.(cached);
      return Promise.resolve(cached);
    }
    let entry = normalizationRequestsRef.current.get(key);
    if (!entry) {
      const controller = new AbortController();
      const quality = streamQualityRef.current;
      const request: NormalizationRequest = {
        listeners: new Set(),
        controller,
        wake: null,
        timer: undefined,
        promise: Promise.resolve(undefined),
      };
      entry = request;
      normalizationRequestsRef.current.set(key, request);
      normalizationControllersRef.current.add(controller);
      const deadline = setTimeout(() => controller.abort(), NORMALIZATION_DEADLINE_MS);
      controller.signal.addEventListener("abort", () => request.wake?.(), { once: true });
      request.promise = (async () => {
        try {
          while (!controller.signal.aborted) {
            const result = (await prepareNormalizedPlayback(
              song.id, source, previewUrl, controller.signal, quality, target
            )) as NormalizationResult | null;
            if (controller.signal.aborted) return undefined;
            const valid: NormalizationResult =
              result && ["ready", "measured", "processing", "unavailable"].includes(result.status)
                ? result
                : { status: "unavailable" };
            const ttl = valid.status === "unavailable" ? NORMALIZATION_UNAVAILABLE_TTL_MS : NORMALIZATION_CACHE_TTL_MS;
            const cache = normalizationCacheRef.current;
            cache.set(key, { result: valid, expires: Date.now() + ttl });
            if (cache.size > NORMALIZATION_CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
            request.listeners.forEach((update) => update(valid));
            if (valid.status !== "processing") return valid;
            await new Promise<void>((resolve) => {
              request.wake = resolve;
              request.timer = setTimeout(resolve, NORMALIZATION_POLL_MS);
            });
          }
        } catch {
          // Analysis is optional background work; a failure never stops audio.
        } finally {
          clearTimeout(deadline);
          clearTimeout(request.timer);
          normalizationControllersRef.current.delete(controller);
          if (normalizationRequestsRef.current.get(key) === request) normalizationRequestsRef.current.delete(key);
        }
        return undefined;
      })();
    }
    if (listener) entry.listeners.add(listener);
    return entry.promise;
  }

  /** Sends a late level to the engine, which eases it in instead of jumping. */
  function applyLevel(entryId: string, level: number): void {
    const previous = gainByEntryRef.current.get(entryId);
    if (previous !== undefined && Math.abs(previous - level) < 0.0001) return;
    gainByEntryRef.current.set(entryId, level);
    engineRef.current?.updateTrack(entryId, { gain: level });
  }

  function requestEntryNormalization(entryId: string, binding: NormalizationBinding): void {
    if (binding.song.offlineOnly || navigator.onLine === false || offlineDownloadEngine.getSnapshot().tracks.some((track) => track.track_id === String(binding.song.id) && track.status === "verified")) return;
    const target = normalizationTargetRef.current;
    void requestNormalization(binding.song, binding.source, binding.previewUrl, (result) => {
      if (
        bindingsRef.current.get(entryId) !== binding ||
        !replayGainEnabledRef.current ||
        streamQualityRef.current === "direct" ||
        albumPlayback(binding.song) ||
        target !== normalizationTargetRef.current ||
        sourceCacheRef.current.get(entryId)?.normalized
      ) {
        return;
      }
      binding.measurement =
        validLoudness(result.loudness) ??
        (result.status !== "ready" ? validLoudness(result) : undefined) ?? binding.measurement;
      if (result.status === "ready" && typeof result.streamUrl === "string" && NORMALIZED_STREAM.test(result.streamUrl)) {
        if (!sourceCacheRef.current.has(entryId)) {
          // Not handed to the engine yet: its load will pick the normalized stream at unity gain.
          binding.normalized = true;
          gainByEntryRef.current.set(entryId, 1);
          return;
        }
        if (upgradeUpcomingStream(entryId, binding, result, result.streamUrl)) return;
      }
      if (typeof result.gainDb === "number" && Number.isFinite(result.gainDb)) {
        applyLevel(entryId, decibelsToLevel(result.gainDb));
      }
    });
  }

  /**
   * Swaps the upcoming entry to its normalized stream while it is still silent.
   * The engine receives stream and unity level together, replacing anything it
   * prepared; once a transition into the entry has begun, the measured gain is
   * applied to the original stream instead.
   */
  function upgradeUpcomingStream(entryId: string, binding: NormalizationBinding, result: NormalizationResult, streamUrl: string): boolean {
    const activeEngine = engineRef.current;
    const upcoming = upcomingEntryOf(stateRef.current);
    if (!activeEngine || upcoming?.entryId !== entryId) return false;
    const snapshot = activeEngine.getSnapshot();
    if (snapshot.key === entryId || snapshot.transition !== null) return false;
    const loudness = validLoudness(result);
    sourceCacheRef.current.set(entryId, { url: streamUrl, normalized: true, loudness,
      originalLoudness: validLoudness(result.loudness), gainDb: result.gainDb });
    gainByEntryRef.current.set(entryId, 1);
    binding.normalized = true;
    binding.measurement = loudness;
    activeEngine.setUpcoming(toPlayable(upcoming));
    return true;
  }

  function bindNormalization(entry: QueueEntry<Song>): void {
    if (bindingsRef.current.has(entry.entryId)) return;
    const { source, previewUrl } = songSource(entry.track);
    // Binding must not build a stream URL: a restored, unloaded entry stays untouched until Play.
    const info = sourceCacheRef.current.get(entry.entryId) ?? normalizationInfo(entry.track, source, previewUrl);
    const binding: NormalizationBinding = {
      song: entry.track,
      source,
      previewUrl,
      normalized: info.normalized,
      measurement: info.normalized
        ? info.loudness
        : previewUrl
          ? undefined
          : info.originalLoudness ?? validLoudness(entry.track.loudness ?? entry.track.metadata?.loudness),
    };
    bindingsRef.current.set(entry.entryId, binding);
    applyLevel(entry.entryId, gainByEntryRef.current.get(entry.entryId) ?? initialLevel(entry, info));
    if (!replayGainEnabledRef.current || albumPlayback(entry.track) || info.normalized || importedGainDb(entry.track, previewUrl) !== undefined) {
      return;
    }
    requestEntryNormalization(entry.entryId, binding);
  }

  const abortNormalization = useCallback(() => {
    normalizationControllersRef.current.forEach((controller) => controller.abort());
    normalizationRequestsRef.current.clear();
  }, []);

  const changeNormalizationTarget = useCallback((value: number | string) => {
    const target = Number(value);
    if (!LOUDNESS_TARGETS.includes(target) || target === normalizationTargetRef.current) return;
    normalizationTargetRef.current = target;
    setNormalizationTarget(target);
    if (!replayGainEnabledRef.current) return;
    abortNormalization();
    const state = stateRef.current;
    const live = [currentEntryOf(state), upcomingEntryOf(state)];
    const liveIds = new Set(live.map(entry => entry?.entryId));
    for (const cache of [bindingsRef.current, sourceCacheRef.current, gainByEntryRef.current]) {
      for (const entryId of cache.keys()) if (!liveIds.has(entryId)) cache.delete(entryId);
    }
    for (const entry of live) {
      if (!entry) continue;
      const { entryId } = entry;
      const binding = bindingsRef.current.get(entryId);
      if (!binding) continue;
      if (albumPlayback(binding.song)) continue;
      const resolved = sourceCacheRef.current.get(entryId);
      if (resolved?.normalized) {
        const gain = preparedPlaybackGainDb(resolved.loudness, resolved.originalLoudness, target);
        if (typeof gain === "number" && Number.isFinite(gain)) applyLevel(entryId, decibelsToLevel(gain));
        continue;
      }
      binding.normalized = false;
      const gain = loudnessGainDb(binding.measurement, target) ?? importedGainDb(binding.song, binding.previewUrl);
      if (typeof gain === "number" && Number.isFinite(gain)) applyLevel(entryId, decibelsToLevel(gain));
      else {
        applyLevel(entryId, initialLevel(entry, { normalized: false }));
        requestEntryNormalization(entryId, binding);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abortNormalization]);

  useEffect(() => () => abortNormalization(), [abortNormalization]);

  // Source and gain policy change together, preserving the live position and pause state.
  const previousProcessingRef = useRef({ normalization: replayGainActive, album: isAlbumAware, shuffle: isShuffleEnabled });
  useEffect(() => {
    replayGainEnabledRef.current = replayGainActive;
    const previous = previousProcessingRef.current;
    previousProcessingRef.current = { normalization: replayGainActive, album: isAlbumAware, shuffle: isShuffleEnabled };
    const normalizationChanged = previous.normalization !== replayGainActive;
    const albumChanged = (features.audioEffects || features.serverNormalization) && (previous.album !== isAlbumAware ||
      ((previous.album || isAlbumAware) && previous.shuffle !== isShuffleEnabled));
    if (!normalizationChanged && !albumChanged) return;
    if (!normalizationChanged &&
      !stateRef.current.entries.some((entry) => typeof entry.track.albumPlaybackId === "string")) return;
    abortNormalization();
    sourceCacheRef.current.clear();
    gainByEntryRef.current.clear();
    bindingsRef.current.clear();
    const entry = currentEntryOf(stateRef.current);
    if (entry && engineHasLoaded(entry.entryId)) {
      storeRef.current.loadCurrent({ startAt: positionOf(entry.entryId), autoplay: isPlayingRef.current });
      const upcoming = upcomingEntryOf(stateRef.current);
      engineRef.current?.setUpcoming(upcoming ? toPlayable(upcoming) : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayGainActive, isAlbumAware, isShuffleEnabled, abortNormalization]);

  useEffect(() => {
    for (const entry of [currentEntry, upcomingEntry]) if (entry) bindNormalization(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEntry, upcomingEntry, replayGainActive, isAlbumAware, isShuffleEnabled, streamQuality]);

  // Warm the next tracks while playing so their loudness is ready in time.
  useEffect(() => {
    if (!features.serverNormalization || !isAuthenticated || !isPlaying || !isReplayGainEnabled || currentIndex < 0) return undefined;
    let cancelled = false;
    (async () => {
      for (const song of queue.slice(currentIndex + 1, currentIndex + 1 + NORMALIZATION_PREWARM_COUNT)) {
        if (cancelled) break;
        const { library, source, previewUrl } = songSource(song);
        if (albumPlayback(song)) continue;
        if (!library && !previewUrl) continue;
        if (importedGainDb(song, previewUrl) !== undefined) continue;
        await requestNormalization(song, source, previewUrl);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, isPlaying, isReplayGainEnabled, isAlbumAware, isShuffleEnabled, streamQuality, normalizationTarget, queue, currentIndex]);

  // ------------------------------------------------------------ silence trimming

  const silenceAnalysisRequestsRef = useRef(new Map<string, Promise<unknown>>());
  /** entryId → analysis parameters it was requested with. */
  const trimRequestsRef = useRef(new Map<string, { parametersKey: string }>());

  function getOrAnalyzeSilence(song: Song, parameters: { thresholdDb: number; minSilenceSeconds: number }) {
    const trackId = String(song.id);
    const key = JSON.stringify([trackId, parameters]);
    const pending = silenceAnalysisRequestsRef.current.get(key);
    if (pending) return pending;
    const request = (async () => {
      const saved = await getSilenceAnalysis(trackId, parameters);
      if (matchesSilenceProfile(saved, parameters)) return saved;
      return analyzeSilence(trackId, parameters);
    })();
    silenceAnalysisRequestsRef.current.set(key, request);
    request
      .finally(() => {
        if (silenceAnalysisRequestsRef.current.get(key) === request) silenceAnalysisRequestsRef.current.delete(key);
      })
      .catch(() => undefined);
    return request;
  }

  useEffect(() => {
    const activeEngine = engineRef.current;
    if (!isAuthenticated || !features.silenceTrimming || !silenceTrimSettings.enabled) {
      for (const entryId of Array.from(trimByEntryRef.current.keys())) {
        activeEngine?.updateTrack(entryId, { silenceTrim: null });
      }
      trimByEntryRef.current.clear();
      trimRequestsRef.current.clear();
      return;
    }
    const parameters = {
      thresholdDb: silenceTrimSettings.thresholdDb,
      minSilenceSeconds: silenceTrimSettings.minSilenceSeconds,
    };
    const parametersKey = JSON.stringify(parameters);
    function applyTrim(entryId: string, result: SilenceAnalysis) {
      const leading = result.leadingSilenceSeconds ?? 0;
      const trailing = result.trailingSilenceSeconds ?? 0;
      if (!Number.isFinite(leading) || !Number.isFinite(trailing) || leading < 0 || trailing < 0) return;
      const duration = Number(result.durationSeconds);
      const silenceTrim = leading === 0 && trailing === 0 ? null : {
        leading, trailing, analyzedDuration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
      };
      if (silenceTrim) trimByEntryRef.current.set(entryId, silenceTrim);
      else trimByEntryRef.current.delete(entryId);
      engineRef.current?.updateTrack(entryId, { silenceTrim });
    }
    const eligibleEntries: Array<NonNullable<typeof currentEntry>> = [];
    for (const entry of [currentEntry, upcomingEntry]) {
      if (entry && albumPlayback(entry.track)) {
        if (trimByEntryRef.current.delete(entry.entryId)) {
          activeEngine?.updateTrack(entry.entryId, { silenceTrim: null });
        }
        trimRequestsRef.current.delete(entry.entryId);
        continue;
      }
      if (!entry) continue;
      const { library, previewUrl } = songSource(entry.track);
      if (!library || previewUrl) continue;
      eligibleEntries.push(entry);
      if (trimRequestsRef.current.get(entry.entryId)?.parametersKey === parametersKey) continue;
      if (trimByEntryRef.current.delete(entry.entryId)) {
        activeEngine?.updateTrack(entry.entryId, { silenceTrim: null });
      }
      const { entryId } = entry;
      const request = { parametersKey };
      trimRequestsRef.current.set(entryId, request);
      getOrAnalyzeSilence(entry.track, parameters)
        .then((analysis) => {
          if (!mountedRef.current || trimRequestsRef.current.get(entryId) !== request) return;
          const result = analysis as SilenceAnalysis | null;
          if (matchesSilenceProfile(result, parameters)) applyTrim(entryId, result);
        })
        .catch(() => undefined);
    }

    function handleSilenceAnalyzed(event: Event) {
      const detail = (event as CustomEvent<{ trackId: string; analysis: SilenceAnalysis }>).detail;
      if (!detail || !matchesSilenceProfile(detail.analysis, parameters)) return;
      for (const entry of eligibleEntries) {
        if (String(entry.track.id) !== String(detail.trackId)) continue;
        trimRequestsRef.current.set(entry.entryId, { parametersKey });
        applyTrim(entry.entryId, detail.analysis);
      }
    }
    window.addEventListener(SILENCE_ANALYZED_EVENT, handleSilenceAnalyzed);
    return () => window.removeEventListener(SILENCE_ANALYZED_EVENT, handleSilenceAnalyzed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, features.silenceTrimming, silenceTrimSettings, currentEntry, upcomingEntry, isAlbumAware, isShuffleEnabled]);

  // ------------------------------------------------------------ auto-refill

  // Prepare the next tracks before the active deck finishes.
  const upcomingCount = currentIndex < 0 ? 0 : entries.length - currentIndex - 1;
  useEffect(() => {
    if (!loopPlaylistId || playlistIdFor(playbackContext, currentEntry?.track) !== loopPlaylistId) return;
    const generated = entries.slice(currentIndex + 1).filter(({ track }) => track.autoplayGenerated).map(({ entryId }) => entryId);
    if (generated.length) storeRef.current.removeEntries(generated);
  }, [loopPlaylistId, playbackContext, currentEntry, entries, currentIndex]);
  useEffect(() => {
    if (!isAuthenticated || !isPlaying || !currentEntry || queueState.repeatOne) return;
    const playlistId = playlistIdFor(playbackContext, currentEntry.track);
    if (playlistId && playbackContext) {
      if (isEndlessPlaybackEnabled || loopPlaylistId === playlistId) preparePlaylistPass(playbackContext, playlistId);
      return;
    }
    if (!isEndlessPlaybackEnabled || queueState.repeatAll || upcomingCount > REFILL_TRIGGER_UPCOMING) return;
    const previous = refillAttemptRef.current;
    const attempt = prepareEndlessRefill(stateRef.current, currentEntry);
    if (attempt === previous) return;
    void attempt.pending.then((tracks) => {
      if (mountedRef.current && !attempt.claimedAtEnd && endlessRef.current && endlessVersionRef.current === attempt.version &&
          refillAttemptRef.current === attempt && !stateRef.current.repeatOne && !stateRef.current.repeatAll &&
          currentEntryOf(stateRef.current)?.entryId === attempt.entryId && tracks.length) {
        storeRef.current.append(tracks, { dedupe: true, generation: attempt.generation });
      }
    });
  }, [isAuthenticated, isEndlessPlaybackEnabled, isPlaying, currentEntry, upcomingCount, generation,
    queueState.repeatOne, queueState.repeatAll, loopPlaylistId, playbackContext, prepareEndlessRefill, preparePlaylistPass]);

  useEffect(() => {
    const handleFeedback = (event: Event) => {
      const detail = (event as CustomEvent<{ action: string; itemType: string; itemId: string }>).detail;
      if (!detail) return;
      feedbackVersionRef.current++;
      if (!["hide", "not-interested", "block-artist", "block-album", "less-like-this"].includes(detail.action)) return;
      const state = stateRef.current;
      const ids = state.entries.slice(state.currentIndex + 1).filter(({ track }) => {
        if (!track.recommendationGenerated) return false;
        const id = detail.itemType === "artist" ? track.artistId ?? track.metadata?.artistId
          : detail.itemType === "album" ? track.albumId ?? track.metadata?.albumId : track.id;
        return String(id) === detail.itemId;
      }).map(({ entryId }) => entryId);
      if (ids.length) storeRef.current.removeEntries(ids);
    };
    window.addEventListener(RECOMMENDATION_FEEDBACK_CHANGED_EVENT, handleFeedback);
    return () => window.removeEventListener(RECOMMENDATION_FEEDBACK_CHANGED_EVENT, handleFeedback);
  }, []);

  // ------------------------------------------------------------ server deletions

  useEffect(() => {
    const handleServerDeletion = (event: Event) => {
      const detail = (event as CustomEvent<{ trackIds?: unknown[] }>).detail;
      const ids = new Set((detail?.trackIds || []).map(String));
      const state = stateRef.current;
      const pass = playlistPassRef.current;
      if (ids.size && pass?.tracks) pass.tracks = pass.tracks.filter((track) => !ids.has(String(track.id)));
      if (!ids.size || !state.entries.some((entry) => ids.has(String(entry.track.id)))) return;
      const current = currentEntryOf(state);
      if (current && ids.has(String(current.track.id))) {
        cancelRestoreResume();
        engineRef.current?.pause();
        listeningSessionRef.current?.finish();
        setPlaybackContext(null);
      }
      storeRef.current.removeTracks(Array.from(ids));
    };
    window.addEventListener("musicdeck:server-deleted", handleServerDeletion);
    return () => window.removeEventListener("musicdeck:server-deleted", handleServerDeletion);
  }, [cancelRestoreResume]);

  // ------------------------------------------------------------ queue persistence

  const queueCheckpoint = (): QueueCheckpoint => ({ index: stateRef.current.currentIndex, position: Math.max(0,
    cuedPositionRef.current?.trackId === String(currentEntryOf(stateRef.current)?.track.id) ? cuedPositionRef.current.seconds : positionOf(currentEntryOf(stateRef.current)?.entryId ?? null)),
    repeatOne: stateRef.current.repeatOne, shuffle: shuffleEnabledRef.current, shuffleSeed: stateRef.current.shuffleSeed,
    ...(stateRef.current.repeatAll ? { repeatAll: true } : {}),
    ...(loopPlaylistRef.current ? { loopPlaylistId: loopPlaylistRef.current } : {}),
    shuffleMode: shuffleModeRef.current, albumAware: isAlbumAware, volume, wasPlaying: isPlayingRef.current || restorePending,
    context: serializePlaybackContext(playbackContext), capturedAt: Date.now() });
  const queueCheckpointRef = useRef(queueCheckpoint); queueCheckpointRef.current = queueCheckpoint;
  const applyQueuePreferences = (checkpoint: QueueCheckpoint) => {
    setIsShuffleEnabled(checkpoint.shuffle); shuffleEnabledRef.current = checkpoint.shuffle;
    shufflePreferenceVersionRef.current++; applyShuffleMode(checkpoint.shuffleMode);
    changeAlbumAware(checkpoint.albumAware); storeRef.current.setRepeatMode(repeatModeOf(checkpoint));
    loopPlaylistRef.current = checkpoint.loopPlaylistId ?? null; setLoopPlaylistId(loopPlaylistRef.current);
    changeVolume(checkpoint.volume); setPlaybackContext(checkpoint.context);
  };
  const persistedQueue = usePersistentQueue(store, { ownerId: localQueueOwner,
    canPersist: () => !transferTransaction.current,
    checkpointKey: `${Math.floor(currentTime)}:${volume}:${isShuffleEnabled}:${isAlbumAware}:${shuffleMode}:${restorePending}:${loopPlaylistId ?? ""}`,
    getCheckpoint: () => queueCheckpointRef.current(), onError: setQueuePersistenceError, onReady: setHydratedQueueUserId,
    onRestore: saved => {
      const checkpoint = saved.head.checkpoint, song = saved.content.entries[checkpoint.index]?.track as Song | undefined;
      suppressedRestoreRevision.current = null;
      restoredCheckpointTime.current = checkpoint.capturedAt;
      applyQueuePreferences(checkpoint);
      if (song && checkpoint.wasPlaying && !unplayableReasonFor(song)) {
        restoreRef.current = { trackId: String(song.id), attempted: false, blocked: false }; setRestorePending(true);
        return { autoplay: false, startAt: checkpoint.position, shuffleSeed: checkpoint.shuffleSeed };
      }
      cuedPositionRef.current = song ? { trackId: String(song.id), seconds: checkpoint.position } : null;
      return { deferLoad: true, shuffleSeed: checkpoint.shuffleSeed };
    },
  });
  const queuePersistenceRef = useRef(persistedQueue); queuePersistenceRef.current = persistedQueue;
  useEffect(() => {
    if (!desktop || !engine || !localQueueOwner || !persistedQueue.ready) return;
    const checkpointInterval = 5000;
    let nextCheckpoint = performance.now() + checkpointInterval;
    return engine.on("timeUpdate", ({ key }) => {
      if (key !== currentEntryOf(stateRef.current)?.entryId || !isPlayingRef.current) return;
      const now = performance.now();
      if (now < nextCheckpoint) return;
      nextCheckpoint = now + checkpointInterval;
      void queuePersistenceRef.current.flush().catch(() => undefined);
    });
  }, [desktop, engine, localQueueOwner, persistedQueue.ready]);
  useEffect(() => {
    const owner = isAuthenticated ? sessionId : null;
    queueSyncClient.activate(owner, features.queueCloudSync);
    queueSyncClient.bind(() => queuePersistenceRef.current.flush(), () => !followingAccountQueue.current && !transferTransaction.current);
    return () => { queueSyncClient.bind(null); queueSyncClient.activate(null); };
  }, [features.queueCloudSync, isAuthenticated, sessionId]);
  useEffect(() => {
    if (!features.queueCloudSync || !isAuthenticated || !sessionId || hydratedQueueUserId !== sessionId || restorePending) return;
    void queueSyncClient.sync({ ifChanged: true }).catch(() => undefined);
  }, [features.queueCloudSync, isAuthenticated, sessionId, hydratedQueueUserId, isPlaying, restorePending, currentEntryId, isShuffleEnabled, queueState.repeatOne, queueState.repeatAll, loopPlaylistId]);
  useEffect(() => {
    if (!features.queueCloudSync || !engine || !isAuthenticated || !sessionId || hydratedQueueUserId !== sessionId || restorePending) return;
    let nextSync = performance.now() + 10_000;
    return engine.on("timeUpdate", ({ key }) => {
      if (!isPlayingRef.current || key !== currentEntryOf(stateRef.current)?.entryId) return;
      const now = performance.now();
      if (now < nextSync) return;
      nextSync = now + 10_000;
      void queueSyncClient.sync({ ifChanged: true }).catch(() => undefined);
    });
  }, [engine, features.queueCloudSync, isAuthenticated, sessionId, hydratedQueueUserId, restorePending]);
  useEffect(() => {
    if (!localQueueOwner || hydratedQueueUserId !== localQueueOwner) return;
    const flush = () => {
      queueSyncClient.exitCheckpoint(queueCheckpointRef.current(), queuePersistenceRef.current.getHead());
      void queuePersistenceRef.current.flush().catch(() => undefined);
    };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush); document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", hidden); };
  }, [localQueueOwner, hydratedQueueUserId]);
  const restoreSavedQueue = (content: QueueContent, checkpoint: QueueCheckpoint) => {
    if (!isAuthenticated || !sessionId || hydratedQueueUserId !== sessionId) throw new Error("Wait for this account's queue to finish loading.");
    cancelRestoreResume(); engineRef.current?.pause(); listeningSessionRef.current?.finish(); applyQueuePreferences(checkpoint);
    setPreferLocalQueue(true);
    const song = content.entries[checkpoint.index]?.track;
    cuedPositionRef.current = song ? { trackId: song.id, seconds: checkpoint.position } : null;
    storeRef.current.hydrate(content.entries as QueueEntry<Song>[], checkpoint.index, { deferLoad: true, shuffleSeed: checkpoint.shuffleSeed });
    setPlaybackMessage(remotePlayingElsewhere.current
      ? "Local queue restored. The selected device still controls playback."
      : "Queue restored. Press Play when you're ready.");
  };

  // ------------------------------------------------------------ document preferences

  useEffect(() => {
    document.documentElement.style.setProperty("--color-accent", accentColor);
  }, [accentColor]);

  useEffect(() => {
    document.documentElement.dataset.layoutDensity = layoutDensity;
    return () => {
      delete document.documentElement.dataset.layoutDensity;
    };
  }, [layoutDensity]);

  // ------------------------------------------------------------ preference actions

  const applyShuffleMode = useCallback((mode: ShuffleMode) => {
    shuffleModeRef.current = mode;
    setShuffleMode(mode);
    writeStored("playerShuffleMode", mode, "shuffle mode");
  }, []);

  const changeAlbumAware = useCallback((enabled: boolean, persist = true) => {
    albumAwareRef.current = Boolean(enabled);
    albumPreferenceVersionRef.current++;
    setIsAlbumAware(Boolean(enabled));
    if (features.audioEffects) engineRef.current?.setAlbumAware(Boolean(enabled));
    if (persist) writeStored("playerAlbumAware", String(Boolean(enabled)), "album-aware mode");
  }, [features.audioEffects]);

  const changeShuffleMode = useCallback((mode: ShuffleMode) => {
    if (!isShuffleMode(mode) || mode === shuffleModeRef.current) return;
    applyShuffleMode(mode);
    const version = ++shufflePreferenceVersionRef.current;
    if (shuffleEnabledRef.current) {
      const state = stateRef.current;
      if (mode === "smart") storeRef.current.smartShuffleUpcoming(smartShuffleOptionsRef.current());
      else storeRef.current.shuffleUpcoming(randomValues(state.entries.length - state.currentIndex - 2));
    }
    if (!sessionId) return;
    shuffleSaveRef.current = shuffleSaveRef.current.then(async () => {
      if (shuffleHistoryRef.current.userId !== sessionId) return;
      await updateUserSettings({ "playback.shuffleMode": mode });
    }).catch((error: unknown) => {
      console.error("Could not sync shuffle mode:", error);
      if (mountedRef.current && shuffleHistoryRef.current.userId === sessionId && version === shufflePreferenceVersionRef.current) {
        setPlaybackMessage("Shuffle mode is saved on this device, but account sync failed. Save Settings to retry.");
      }
    });
  }, [applyShuffleMode, sessionId]);

  const changeTransitionMode = useCallback((value: TransitionMode) => {
    if (!isTransitionMode(value)) return;
    transitionModeRef.current = value;
    setTransitionMode(value);
    // Synchronous, so a transition planned on the next progress tick already uses it.
    if (features.audioEffects) engineRef.current?.setTransitionMode(engineTransitionMode(value));
    writeStored("playerTransitionMode", value, "transition mode");
  }, [features.audioEffects]);

  const changeCrossfadeDuration = useCallback((value: number) => {
    const seconds = clampCrossfadeDuration(value);
    crossfadeDurationRef.current = seconds;
    setCrossfadeDuration(seconds);
    engineRef.current?.setCrossfadeSeconds(seconds);
    writeStored("playerCrossfadeDuration", String(seconds), "crossfade duration");
  }, []);

  const changeStreamQuality = useCallback((value: string) => {
    const next = STREAM_QUALITIES.includes(value as StreamQuality) ? (value as StreamQuality) : "original";
    if (next !== streamQualityRef.current) {
      // Applies to newly loaded streams; the playing one keeps its source.
      const current = currentEntryOf(stateRef.current)?.entryId;
      for (const entryId of Array.from(sourceCacheRef.current.keys())) {
        if (entryId !== current) sourceCacheRef.current.delete(entryId);
      }
    }
    streamQualityRef.current = next;
    setStreamQuality(next);
    writeStored("playerStreamQuality", next, "streaming quality");
  }, []);
  async function applyStreamQuality(quality: StreamQuality) {
    if (!STREAM_QUALITIES.includes(quality)) throw new Error("Invalid streaming quality.");
    const owner = sessionId;
    if (sessionId) await updateUserSettings({ "playback.streamQuality": quality });
    if (!mountedRef.current || checkpointOwnerRef.current !== owner) throw new Error("The signed-in account changed. Reopen the inspector to try again.");
    changeStreamQuality(quality);
    abortNormalization();
    sourceCacheRef.current.clear();
    gainByEntryRef.current.clear();
    bindingsRef.current.clear();
    const entry = currentEntryOf(stateRef.current);
    if (entry) storeRef.current.loadCurrent({ startAt: positionOf(entry.entryId), autoplay: isPlayingRef.current });
  }

  const changeDownloadQuality = useCallback((value: string) => {
    const next = DOWNLOAD_QUALITIES.includes(value as DownloadQuality) ? (value as DownloadQuality) : "320kbps";
    setDownloadQuality(next);
    writeStored("playerDownloadQuality", next, "download quality");
  }, []);

  const changeReplayGainEnabled = useCallback((value: boolean) => {
    const next = Boolean(value);
    setIsReplayGainEnabled(next);
    writeStored("playerNormalizationEnabled", String(next), "ReplayGain preference");
  }, []);

  function changeVolume(value: number, persist = true) {
    if (!Number.isFinite(Number(value))) return;
    const next = Math.max(0, Math.min(1, Number(value)));
    setVolume(next);
    engineRef.current?.setVolume(perceptualVolumeToGain(next));
    if (persist) writeStored("playerVolume", String(next), "volume");
  }

  function changeLayoutDensity(value: string) {
    const next: LayoutDensity = value === "compact" ? "compact" : "comfortable";
    setLayoutDensity(next);
    writeStored("playerLayoutDensity", next, "layout density");
  }

  function changeAccentColor(value: string) {
    const next = normalizeAccentColor(value);
    setAccentColor(next);
    writeStored("playerAccentColor", next, "accent color");
  }

  function changeAutoOpenSidebar(value: boolean) {
    const next = Boolean(value);
    setAutoOpenSidebar(next);
    writeStored("playerAutoOpenSidebar", String(next), "auto-open sidebar preference");
  }

  function changeEndlessPlaybackEnabled(value: boolean) {
    const next = Boolean(value);
    if (endlessRef.current !== next) {
      endlessRef.current = next;
      endlessVersionRef.current++;
      setIsEndlessPlaybackEnabled(next);
      if (!next) {
        const state = stateRef.current;
        const generated = state.entries.slice(state.currentIndex + 1)
          .filter(({ track }) => track.autoplayGenerated).map(({ entryId }) => entryId);
        if (generated.length) storeRef.current.removeEntries(generated);
      }
    }
    writeStored("playerAutoplayEnabled", String(next), "endless playback preference");
  }

  function changeAutoDownloadLiked(value: boolean) {
    const next = Boolean(value);
    setAutoDownloadLiked(next);
    writeStored("playerAutoDownloadLiked", String(next), "auto-download preference");
  }

  // ------------------------------------------------------------ server settings

  const applySettingsRef = useRef<(settings: Record<string, unknown>, full: boolean) => void>(() => undefined);
  applySettingsRef.current = (settings, full) => {
    if (typeof settings["playback.albumAware"] === "boolean") changeAlbumAware(settings["playback.albumAware"]);
    if (isShuffleMode(settings["playback.shuffleMode"])) applyShuffleMode(settings["playback.shuffleMode"]);
    if (full || settings["playback.normalization.targetLufs"] !== undefined) {
      changeNormalizationTarget(Number(settings["playback.normalization.targetLufs"] ?? DEFAULT_LOUDNESS_TARGET));
    }
    const trimEnabled = settings["playback.silenceTrim.enabled"];
    const trimThreshold = settings["playback.silenceTrim.thresholdDb"];
    const trimMinimum = settings["playback.silenceTrim.minSilenceSeconds"];
    if (full || trimEnabled !== undefined || trimThreshold !== undefined || trimMinimum !== undefined) {
      setSilenceTrimSettings((current) => ({
        enabled: typeof trimEnabled === "boolean" ? trimEnabled : full ? false : current.enabled,
        thresholdDb: typeof trimThreshold === "number" && Number.isFinite(trimThreshold)
          ? Math.max(-100, Math.min(0, trimThreshold)) : full ? -35 : current.thresholdDb,
        minSilenceSeconds: typeof trimMinimum === "number" && Number.isFinite(trimMinimum)
          ? Math.max(0.1, Math.min(30, trimMinimum)) : full ? 0.5 : current.minSilenceSeconds,
      }));
    }
    const savedSeconds = settings["playback.crossfadeDuration"];
    const savedMode = settings["playback.transitionMode"];
    if (isTransitionMode(savedMode)) {
      changeTransitionMode(savedMode);
    } else if (typeof savedSeconds === "number" && savedSeconds > 0 && full && savedMode === undefined) {
      // Saved before transition modes existed: a positive duration meant crossfade.
      changeTransitionMode("crossfade");
    }
    if (typeof savedSeconds === "number" && savedSeconds > 0) changeCrossfadeDuration(savedSeconds);
    if (STREAM_QUALITIES.includes(settings["playback.streamQuality"] as StreamQuality)) {
      changeStreamQuality(settings["playback.streamQuality"] as string);
    }
    if (DOWNLOAD_QUALITIES.includes(settings["playback.downloadQuality"] as DownloadQuality)) {
      changeDownloadQuality(settings["playback.downloadQuality"] as string);
    }
    if (typeof settings["playback.normalization.enabled"] === "boolean") {
      changeReplayGainEnabled(settings["playback.normalization.enabled"] as boolean);
    }
    if (typeof settings["playback.autoplay.enabled"] === "boolean") {
      changeEndlessPlaybackEnabled(settings["playback.autoplay.enabled"] as boolean);
    }
    if (!full) return;
    if (settings["ui.layoutDensity"] === "comfortable" || settings["ui.layoutDensity"] === "compact") {
      changeLayoutDensity(settings["ui.layoutDensity"] as string);
    }
    if (typeof settings["ui.autoOpenSidebar"] === "boolean") {
      changeAutoOpenSidebar(settings["ui.autoOpenSidebar"] as boolean);
    }
    if (typeof settings["acquisition.autoDownloadLiked"] === "boolean") {
      changeAutoDownloadLiked(settings["acquisition.autoDownloadLiked"] as boolean);
    }
  };

  useEffect(() => {
    if (!isAuthenticated) return undefined;
    let cancelled = false;
    const shuffleVersion = shufflePreferenceVersionRef.current;
    const albumVersion = albumPreferenceVersionRef.current;
    const endlessVersion = endlessVersionRef.current;
    Promise.resolve(getUserSettings())
      .then((settings: unknown) => {
        if (cancelled || !Array.isArray(settings)) return;
        const map: Record<string, unknown> = {};
        for (const setting of settings as { key: string; value: string }[]) {
          try {
            map[setting.key] = JSON.parse(setting.value);
          } catch {
            map[setting.key] = setting.value;
          }
        }
        if (shuffleVersion !== shufflePreferenceVersionRef.current) delete map["playback.shuffleMode"];
        if (albumVersion !== albumPreferenceVersionRef.current) delete map["playback.albumAware"];
        if (endlessVersion !== endlessVersionRef.current) delete map["playback.autoplay.enabled"];
        applySettingsRef.current(map, true);
      })
      .catch(() => {
        // Local preferences stay in effect when server settings cannot be loaded.
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, sessionId]);

  useEffect(() => {
    const handleUserSettingsChanged = (event: Event) => {
      applySettingsRef.current((event as CustomEvent<Record<string, unknown>>).detail || {}, false);
    };
    window.addEventListener(USER_SETTINGS_CHANGED_EVENT, handleUserSettingsChanged);
    return () => window.removeEventListener(USER_SETTINGS_CHANGED_EVENT, handleUserSettingsChanged);
  }, []);

  // ------------------------------------------------------------ reset, likes, history

  const resetPlayer = useCallback(() => {
    cancelRestoreResume();
    setPlaybackMessage("");
    abortNormalization();
    normalizationCacheRef.current.clear();
    normalizationTargetRef.current = DEFAULT_LOUDNESS_TARGET;
    setNormalizationTarget(DEFAULT_LOUDNESS_TARGET);
    sourceCacheRef.current.clear();
    gainByEntryRef.current.clear();
    trimByEntryRef.current.clear();
    trimRequestsRef.current.clear();
    bindingsRef.current.clear();
    cuedPositionRef.current = null;
    playlistPassRef.current = null;
    setHydratedQueueUserId(null);
    listeningSessionRef.current?.finish();
    engineRef.current?.pause();
    storeRef.current.stop();
    storeRef.current.setRepeatMode("off");
    loopPlaylistRef.current = null;
    setLoopPlaylistId(null);
    setActiveSidebar("none");
    setCurrentTime(0);
    setDuration(0);
    setIsShuffleEnabled(false);
    shuffleEnabledRef.current = false;
    shufflePreferenceVersionRef.current++;
    setLikedSongIds(new Set());
    setRecentlyPlayed([]);
    setPlaybackContext(null);
    setPlaybackUnavailable(false);
    try {
      localStorage.removeItem("recentlyPlayed");
    } catch (error) {
      console.error("Could not clear recently played:", error);
    }
  }, [abortNormalization, cancelRestoreResume, setActiveSidebar, setCurrentTime]);

  useEffect(() => {
    if (!isAuthenticated) {
      if (authIsLoading || localQueueOwner) return undefined;
      resetPlayer();
      return undefined;
    }
    let cancelled = false;
    let recentRequest = 0;

    async function loadLikedSongs() {
      try {
        const starred = await getStarred();
        if (!cancelled) {
          shuffleDataOwnerRef.current.favorites = sessionId;
          setLikedSongIds(new Set(((starred || []) as Song[]).map((song) => String(song.id))));
        }
      } catch (error) {
        console.error("Could not load liked songs:", error);
      }
    }

    async function loadRecentlyPlayed() {
      const requestId = ++recentRequest;
      try {
        const recent = await getRecentlyPlayed({ tasteOnly: true });
        if (!cancelled && requestId === recentRequest) {
          shuffleDataOwnerRef.current.recent = sessionId;
          setRecentlyPlayed(normalizeRecentlyPlayed(recent));
        }
      } catch { /* The player can run without account listening history. */ }
    }

    void loadLikedSongs();
    if (!features.listeningEvents) return () => { cancelled = true; };
    const refreshRecent = () => {
      if (getVisualActivity()) void loadRecentlyPlayed();
    };
    window.addEventListener(LISTENING_ACTIVITY_CHANGED_EVENT, refreshRecent);
    const stopPolling = startVisualPolling(refreshRecent, 60_000, { refreshOnWindowFocus: true });
    return () => {
      cancelled = true;
      window.removeEventListener(LISTENING_ACTIVITY_CHANGED_EVENT, refreshRecent);
      stopPolling();
    };
  }, [features.listeningEvents, isAuthenticated, authIsLoading, sessionId, localQueueOwner, resetPlayer]);

  async function setTrackFavorite(song: Song, liked: boolean) {
    const songId = String(song.id);
    if (liked) await starSong(song.id); else await unstarSong(song.id);
    setLikedSongIds((current) => { const next = new Set(current); if (liked) next.add(songId); else next.delete(songId); return next; });
    window.dispatchEvent(new Event("favoritesChanged"));
  }
  async function toggleLikeSong(song: Song | null | undefined) {
    if (!song?.id) return;
    const songId = String(song.id);
    try {
      await setTrackFavorite(song, !likedSongIds.has(songId));
    } catch (error) {
      console.error("Could not change liked status:", error);
    }
  }

  function toggleLike() {
    return toggleLikeSong(currentSong);
  }

  // ------------------------------------------------------------ playback actions

  function startQueue(tracks: Song[], startIndex: number, context: PlaybackContextInfo | null, options?: SetQueueOptions) {
    cancelRestoreResume();
    cuedPositionRef.current = null;
    if (playlistPassRef.current?.context !== context) playlistPassRef.current = null;
    setPlaybackContext(context);
    const albumPlaybackId = context?.type === "album" && !shuffleEnabledRef.current
      ? String(context.id || context.name || "album") : undefined;
    const items = tracks.map((track, albumTrackIndex) => ({
      ...track, albumPlaybackId,
      albumTrackIndex: albumPlaybackId ? (isMediaResumeContext(track.mediaResume) ? track.mediaResume.trackIndex : albumTrackIndex) : undefined,
    }));
    storeRef.current.setQueue(items, startIndex, options);
  }

  function startSelection(tracks: Song[], startIndex: number, context: PlaybackContextInfo | null, fromHere: boolean) {
    const allTracks = mediaTracks(tracks, context);
    playlistPassRef.current = context?.type === "playlist" ? { context, tracks: allTracks } : null;
    const selected = fromHere ? allTracks.slice(startIndex) : allTracks;
    const index = fromHere ? 0 : startIndex;
    const options = shuffleEnabledRef.current ? shuffleModeRef.current === "smart"
      ? { smartShuffle: smartShuffleOptionsRef.current() }
      : { shuffleOrder: shuffleUpcoming(selected.map((_, position) => position), index, randomValues(selected.length - index - 2)) }
      : undefined;
    startQueue(selected, index, context, options);
  }

  function playOnActiveDevice(tracks: Song[], startIndex: number, context: PlaybackContextInfo | null,
    fromHere = false, playlistView?: PlaylistPlaybackView) {
    if (!remotePlayer) return null;
    if (tracks.some(track => track.offlineOnly || songSource(track).source)) {
      setPlaybackMessage("Choose this device in Devices to play a device-only track or source.");
      return Promise.resolve();
    }
    remote.clearError();
    if (context?.id && playlistView) {
      if ([...playlistView.query].length > 4096) {
        setPlaybackMessage("Shorten the playlist search before playing on another device.");
        return Promise.resolve();
      }
      return controlRemote({ type: "PLAY_PLAYLIST", selection: {
        playlistId: context.id, startIndex, fromHere, view: playlistView, order: playlistOrder(tracks),
      } });
    }
    return controlRemote({
      type: "PLAY_SELECTION",
      tracks: tracks.map(track => {
        const portableTrack: Song = {
          ...track,
          source: { kind: isLibraryPlayable(track) ? "library" : "external", count: track.source?.count ?? 0 },
        };
        return sanitizeQueueTrack(portableTrack);
      }),
      start_index: startIndex,
      from_here: fromHere,
      context: serializePlaybackContext(context),
    });
  }

  function togglePlay() {
    const activeEngine = engineRef.current;
    const entry = currentEntryOf(stateRef.current);
    if (!activeEngine || !entry) return;
    cancelRestoreResume();
    if (isPlayingRef.current) {
      activeEngine.pause();
      return;
    }
    if (!engineHasLoaded(entry.entryId)) {
      // A restored or cued entry has not been loaded yet: start it where the UI says.
      storeRef.current.loadCurrent({ startAt: currentTimeRef.current, autoplay: true });
      return;
    }
    void activeEngine.play();
  }

  async function playSong(song: Song) {
    if (!song) return;
    if (pausedAccountQueue && sameSongId(song, accountSong)) {
      takeAccountQueue(accountIndex, true);
      return;
    }
    if (!remotePlayingElsewhere.current && !pausedAccountQueue && sameSongId(song, currentSong)) {
      togglePlay();
      return;
    }
    const reason = unplayableReasonFor(song);
    if (reason) {
      // The current queue is left untouched.
      setPlaybackMessage(reason);
      setPlaybackUnavailable(true);
      return;
    }
    const remoteSelection = playOnActiveDevice([song], 0, null);
    if (remoteSelection) return remoteSelection;
    startQueue([song], 0, null);
  }

  async function playSongFromSource(song: Song, source: PlayableSourceRef) {
    if (!song) return;
    await playSong({
      ...song,
      ...(typeof source === "object" ? { playableSource: source } : { sourceId: source }),
    });
  }

  function addToQueue(song: Song) {
    if (!song) return;
    if (remotePlayer) { void enqueueOnActiveDevice([song], false, true); return; }
    if (pausedAccountQueue) takeAccountQueue();
    storeRef.current.append([song], { dedupe: true });
  }

  function queueTracks(tracks: Song[]) {
    if (remotePlayer) { void enqueueOnActiveDevice(tracks, false, false); return; }
    if (pausedAccountQueue) takeAccountQueue();
    storeRef.current.append(tracks);
  }

  function playTracksNext(tracks: Song[]) {
    if (remotePlayer) { void enqueueOnActiveDevice(tracks, true, false); return; }
    if (pausedAccountQueue) takeAccountQueue();
    storeRef.current.injectNextMany(tracks);
  }

  async function playContext(tracks: Song[], startIndex = 0, context: PlaybackContextInfo | null = null, playlistView?: PlaylistPlaybackView) {
    if (!Array.isArray(tracks) || tracks.length === 0) return;
    const safeStart = Number.isInteger(startIndex) && startIndex >= 0 && startIndex < tracks.length ? startIndex : 0;
    const remoteSelection = playOnActiveDevice(tracks, safeStart, context, true, playlistView);
    if (remoteSelection) return remoteSelection;
    startSelection(tracks, safeStart, context, true);
  }

  async function prepareLibrarySelection(selection: LibraryPlaybackSelection, signal?: AbortSignal, excluded?: ReadonlySet<string>) {
    const tracks: Song[] = (await getTrackCollection(selection.query, signal))
      .filter((track: Song) => !excluded?.has(String(track.id)));
    if (signal?.aborted) throw new DOMException("Loading playback was cancelled.", "AbortError");
    const index = selection.trackId !== null ? tracks.findIndex(track => String(track.id) === selection.trackId)
      : selection.shuffle ? Math.floor(Math.random() * tracks.length) : 0;
    if (!tracks[index]) throw new Error(selection.trackId ? "This track is no longer in the library view." : "There are no matching tracks to play.");
    const reason = unplayableReasonFor(tracks[index]);
    if (reason) throw new Error(reason);
    return () => {
      if (selection.shuffle !== undefined) {
        shuffleEnabledRef.current = selection.shuffle;
        setIsShuffleEnabled(selection.shuffle);
      }
      startSelection(tracks, index, { type: "collection", id: "library-tracks", name: "Library Tracks", coverArt: null }, selection.trackId !== null);
    };
  }

  async function playLibraryTracks(selection: LibraryPlaybackSelection, signal: AbortSignal, excluded?: ReadonlySet<string>) {
    if (remotePlayer) {
      await remote.command({ type: "PLAY_LIBRARY_TRACKS", selection });
      return;
    }
    const start = await prepareLibrarySelection(selection, signal, excluded);
    if (!signal.aborted) start();
  }

  async function playQueue(songs: Song[], startIndex = 0, context: PlaybackContextInfo | null = null, playlistView?: PlaylistPlaybackView) {
    if (!Array.isArray(songs) || songs.length === 0) return;
    const safeStart = Number.isInteger(startIndex) && startIndex >= 0 && startIndex < songs.length ? startIndex : 0;
    const remoteSelection = playOnActiveDevice(songs, safeStart, context, false, playlistView);
    if (remoteSelection) return remoteSelection;
    startSelection(songs, safeStart, context, false);
  }

  async function resumeMedia(songs: Song[], index: number, context: PlaybackContextInfo, positionSeconds: number) {
    if (!Number.isInteger(index) || index < 0 || index >= songs.length ||
      !Number.isFinite(positionSeconds) || positionSeconds < 0) throw new Error("This listening checkpoint is no longer valid.");
    const reason = unplayableReasonFor(songs[index]);
    if (reason) throw new Error(reason);
    // Resume is an explicit ordered-collection action, not a shuffled restart.
    shuffleEnabledRef.current = false;
    setIsShuffleEnabled(false);
    const tracks = mediaTracks(songs, context);
    playlistPassRef.current = context.type === "playlist" ? { context, tracks } : null;
    startQueue(tracks, index, context, { startAt: positionSeconds });
  }

  async function playQueueSong(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= stateRef.current.entries.length) return;
    cancelRestoreResume();
    storeRef.current.jumpToIndex(index);
  }

  function moveQueueItem(from: number, to: number) {
    // The reducer accepts only integer, in-range, upcoming positions; the engine
    // cancels any hand-over to an entry that is no longer next.
    storeRef.current.move(from, to);
  }

  async function nextSong(signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("Playback command cancelled.");
    const state = stateRef.current;
    if (state.currentIndex < 0) return;
    cancelRestoreResume();
    if (state.currentIndex + 1 < state.entries.length) {
      storeRef.current.playNext();
      return;
    }
    const pending = queueEndPendingRef.current;
    if (signal && pending?.generation === state.generation && pending.loadSequence === state.loadSequence) {
      throw new Error("The player is already finding the next track.");
    }
    listeningSessionRef.current?.finish();
    await continueAfterQueueEnd(signal, true);
  }

  /** Restarts the current entry; a restart is a new listening session. */
  function restartCurrent(entry: QueueEntry<Song>) {
    listeningSessionRef.current?.finish();
    const start = engineHasLoaded(entry.entryId) ? engineRef.current?.getTrimmedStart() ?? 0 : 0;
    if (engineHasLoaded(entry.entryId)) {
      const clock = clockFor(entry.entryId);
      clock.seeking = true;
      clock.emit("seeking");
      engineRef.current?.seek(start);
      clock.seeking = false;
      clock.emit("seeked");
    } else if (cuedPositionRef.current) {
      cuedPositionRef.current = { ...cuedPositionRef.current, seconds: start };
    }
    setCurrentTime(start);
    if (!transferTransaction.current && isPlayingRef.current && !isPreviewRef.current && isLibraryPlayable(entry.track)) {
      listeningSessionRef.current?.begin(entry.track, clockFor(entry.entryId), false);
    }
  }

  async function previousSong() {
    const state = stateRef.current;
    const entry = currentEntryOf(state);
    if (!entry) return;
    cancelRestoreResume();
    if (positionOf(entry.entryId) > RESTART_THRESHOLD_SECONDS || state.currentIndex <= 0) {
      restartCurrent(entry);
      return;
    }
    storeRef.current.jumpToIndex(state.currentIndex - 1);
  }

  function toggleShuffleForQueue(entryCount: number, index: number) {
    const enable = !shuffleEnabledRef.current;
    shuffleEnabledRef.current = enable;
    setIsShuffleEnabled(enable);
    if (!enable) { storeRef.current.unshuffleUpcoming(); return; }
    if (shuffleModeRef.current === "smart") storeRef.current.smartShuffleUpcoming(smartShuffleOptionsRef.current());
    else storeRef.current.shuffleUpcoming(randomValues(entryCount - index - 2));
  }

  function toggleShuffle() {
    const state = stateRef.current;
    toggleShuffleForQueue(state.entries.length, state.currentIndex);
  }

  function cycleRepeatMode(currentMode: RepeatMode) {
    const next = currentMode === "off" ? "all" : currentMode === "all" ? "one" : "off";
    if (next !== "off") {
      loopPlaylistRef.current = null;
      setLoopPlaylistId(null);
    }
    refillAttemptRef.current = null;
    storeRef.current.setRepeatMode(next);
  }

  function toggleLoop() { cycleRepeatMode(repeatModeOf(stateRef.current)); }

  function setPlaylistLoop(playlistId: string, enabled: boolean) {
    const next = enabled ? playlistId : loopPlaylistRef.current === playlistId ? null : loopPlaylistRef.current;
    if (next === loopPlaylistRef.current) return;
    if (next) {
      storeRef.current.setRepeatMode("off");
      const entry = currentEntryOf(stateRef.current);
      if (playlistIdFor(playbackContextRef.current, entry?.track) === next) refillAttemptRef.current = null;
    }
    loopPlaylistRef.current = next;
    setLoopPlaylistId(next);
  }

  function seek(percent: number) {
    if (!Number.isFinite(Number(percent))) return;
    seekToSeconds((Number(percent) / 100) * duration);
  }

  function seekToSeconds(target: number) {
    const entry = currentEntryOf(stateRef.current);
    if (!entry || !Number.isFinite(target)) return;
    target = Math.max(0, duration > 0 ? Math.min(target, duration) : target);
    if (engineHasLoaded(entry.entryId)) {
      const clock = clockFor(entry.entryId);
      clock.seeking = true;
      clock.emit("seeking");
      engineRef.current?.seek(target);
      clock.seeking = false;
      clock.emit("seeked");
    } else {
      cuedPositionRef.current = { trackId: String(entry.track.id), seconds: target };
    }
    setCurrentTime(target);
    remote.publishPosition?.();
    queueSyncClient.checkpointChanged();
  }

  // ------------------------------------------------------------ render

  const liveQueue = useCallback((): RemotePlaybackSnapshot["queueState"] => {
    const context = serializePlaybackContext(playbackContext);
    // Keep the current occurrence in the published window even for very large queues.
    const offset = Math.max(0, currentIndex - 4999);
    return {
      entries: entries.slice(offset, offset + 5000).map((item) => ({ occurrenceId: item.entryId, trackId: String(item.track.id),
          title: String(item.track.title || "").slice(0, 500), artist: String(item.track.artist || item.track.artistName || "").slice(0, 500), album: String(item.track.album || item.track.albumName || "").slice(0, 500),
          duration: songDurationHint(item.track) || 0,
          ...(item.unshuffledIndex === undefined ? {} : { unshuffledIndex: item.unshuffledIndex }),
          ...(item.track.albumPlaybackId ? { albumPlaybackId: String(item.track.albumPlaybackId), albumTrackIndex: Number(item.track.albumTrackIndex) || 0 } : {}),
          ...(isMediaResumeContext(item.track.mediaResume) ? { resume: {
            type: item.track.mediaResume.type, mediaId: item.track.mediaResume.mediaId, title: item.track.mediaResume.title,
            trackIndex: item.track.mediaResume.trackIndex, trackCount: item.track.mediaResume.trackCount, occurrenceId: item.track.mediaResume.occurrenceId,
          } } : {}),
        })),
      index: Math.max(0, currentIndex - offset), repeatOne: queueState.repeatOne, shuffle: isShuffleEnabled,
      ...(queueState.repeatAll ? { repeatAll: true } : {}),
      ...(loopPlaylistId ? { loopPlaylistId } : {}),
      shuffleMode, shuffleSeed: queueState.shuffleSeed, albumAware: isAlbumAware, context,
    };
  }, [entries, currentIndex, queueState.repeatOne, queueState.repeatAll, queueState.shuffleSeed, loopPlaylistId, isShuffleEnabled, shuffleMode, isAlbumAware, playbackContext]);

  function captureRemotePlayback(): RemotePlaybackSnapshot {
    if (engineRef.current?.isRemoteOutput) throw new Error("Stop Google Cast before transferring playback to another device.");
    const state = stateRef.current;
    const entry = currentEntryOf(state);
    if (state.entries.length > 5000) throw new Error("Playback transfer supports up to 5,000 tracks. Start a smaller queue and try again.");
    if (!entry || state.entries.some((item) => !isLibraryPlayable(item.track) ||
        songSource(item.track).source || item.track.offlineOnly)) {
      throw new Error("Only queues of local library tracks can be transferred. External previews and device-only sources cannot move between devices.");
    }
    return {
      trackId: String(entry.track.id), exactPositionMs: positionOf(entry.entryId) * 1000,
      playing: isPlayingRef.current, volume, queueState: liveQueue(),
    };
  }
  const remoteAdapter: RemotePlayerAdapter = {
    state: () => {
      const snapshot = engineRef.current?.getSnapshot();
      const active = snapshot?.key === currentEntryId ? snapshot : undefined;
      return {
        current_track: currentSong ? {
          id: String(currentSong.id), title: String(currentSong.title || "").slice(0, 500),
          artist: String(currentSong.artist || currentSong.artistName || "").slice(0, 500),
          album: String(currentSong.album || currentSong.albumName || "").slice(0, 500),
          cover_art: typeof currentSong.coverArt === "string" ? currentSong.coverArt.slice(0, 1000) : undefined,
        } : null,
        position_ms: Math.max(0, (active?.position ?? (
          cuedPositionRef.current?.trackId === String(currentSong?.id) ? cuedPositionRef.current?.seconds ?? 0 : 0
        )) * 1000),
        duration_ms: Math.max(0, (active?.duration || songDurationHint(currentSong) || 0) * 1000),
        playing: active?.state === "playing" || active?.state === "transitioning",
        volume,
      };
    },
    capture: captureRemotePlayback,
    queue: liveQueue,
    pause: () => {
      cancelRestoreResume();
      storeRef.current.cancelPendingLoad();
      engineRef.current?.pause();
    },
    command: async (command, signal) => {
      const activeEngine = engineRef.current;
      if (!activeEngine) throw new Error("The playback engine is not ready");
      if (activeEngine.isRemoteOutput) throw new Error("Control this receiver from its Google Cast sender, or stop Cast before using device control.");
      const checkCancellation = () => {
        if (signal?.aborted) throw new Error("Playback command cancelled.");
      };
      checkCancellation();
      if (command.type === "SET_PLAYLIST_LOOP") {
        flushSync(() => setPlaylistLoop(command.playlist_id, command.enabled));
        return;
      }
      if (command.type === "TOGGLE_SHUFFLE" || command.type === "TOGGLE_REPEAT") {
        if (!currentEntryOf(stateRef.current)) throw new Error("The selected device has no loaded queue");
        flushSync(command.type === "TOGGLE_SHUFFLE" ? toggleShuffle : toggleLoop);
        return;
      }
      if (command.type === "SET_VOLUME") { flushSync(() => changeVolume(command.volume)); return; }
      if (command.type === "PAUSE") {
        flushSync(() => { storeRef.current.cancelPendingLoad(); activeEngine.pause(); });
        return;
      }
      const load = stateRef.current.loadRequest;
      // A disconnected controller can cancel its wait, but it does not own this existing load.
      if (load) await storeRef.current.waitForLoad(load.sequence, signal, false).catch(() => {});
      checkCancellation();
      const applyAndWait = async (apply: () => void | Promise<void>) => {
        const previousSequence = stateRef.current.loadSequence;
        const result = flushSync(apply);
        if (result) {
          await result;
        }
        const next = stateRef.current.loadRequest;
        if (next && next.sequence > previousSequence) await storeRef.current.waitForLoad(next.sequence, signal);
        checkCancellation();
      };
      if (command.type === "PLAY_SELECTION") {
        if (remote.isRemote) throw new Error("The active player changed. Try playing the selection again.");
        const tracks = command.tracks.map(sanitizeQueueTrack);
        const selected = tracks[command.start_index];
        if (!selected) throw new Error("The selected track is missing from the queue.");
        const reason = unplayableReasonFor(selected);
        if (reason) throw new Error(reason);
        await applyAndWait(() => startSelection(tracks, command.start_index, command.context, command.from_here));
        return;
      }
      if (command.type === "PLAY_LIBRARY_TRACKS") {
        if (remote.isRemote) throw new Error("The active player changed. Try playing the library again.");
        const start = await prepareLibrarySelection(command.selection, signal);
        await applyAndWait(start);
        return;
      }
      if (command.type === "PLAY_PLAYLIST") {
        if (remote.isRemote) throw new Error("The active player changed. Try playing the playlist again.");
        const { playlistId, startIndex, fromHere, view, order } = command.selection;
        const playlist = await getPlaylist(playlistId, signal, { cache: "no-store" });
        checkCancellation();
        if (!playlist) throw new Error("This playlist is no longer available.");
        const tracks = playlistViewTracks(playlist.entry, view);
        if (!tracks.length) throw new Error("There are no matching playlist tracks to play.");
        if (!tracks[startIndex] || playlistOrder(tracks) !== order) {
          throw new Error("The playlist order changed. Refresh the playlist and try again.");
        }
        const reason = unplayableReasonFor(tracks[startIndex]);
        if (reason) throw new Error(reason);
        const context = playlistPlaybackContext(playlist, view);
        await applyAndWait(() => startSelection(tracks, startIndex, context, fromHere));
        return;
      }
      if (!currentEntryOf(stateRef.current)) throw new Error("The selected device has no loaded queue");
      if (command.type === "ENQUEUE") {
        const tracks = command.tracks.map(sanitizeQueueTrack) as Song[];
        flushSync(() => {
          if (command.next) storeRef.current.injectNextMany(tracks);
          else storeRef.current.append(tracks, { dedupe: command.dedupe });
        });
        return;
      }
      if (command.type === "MOVE_QUEUE_ENTRY" || command.type === "PLAY_QUEUE_ENTRY") {
        const state = stateRef.current;
        const index = state.entries.findIndex(entry => entry.entryId === command.entry_id);
        if (index < 0) throw new Error("The active queue changed. Try again after it syncs.");
        if (command.type === "PLAY_QUEUE_ENTRY") { await applyAndWait(() => playQueueSong(index)); return; }
        const target = state.entries.findIndex(entry => entry.entryId === command.target_id);
        if (index <= state.currentIndex || target <= state.currentIndex) throw new Error("Only upcoming tracks can be moved.");
        flushSync(() => moveQueueItem(index, target));
        return;
      }
      if (command.type === "PLAY") {
        const key = currentEntryOf(stateRef.current)?.entryId ?? null;
        if (!engineHasLoaded(key)) { await applyAndWait(togglePlay); return; }
        await activeEngine.play();
        checkCancellation();
        const state = activeEngine.getSnapshot().state;
        if (state !== "playing" && state !== "transitioning") throw new Error("The selected device could not start playback.");
      } else if (command.type === "SKIP") {
        await applyAndWait(command.direction === "next" ? () => nextSong(signal) : previousSong);
      } else if (command.type === "SEEK") {
        const total = activeEngine.getSnapshot().duration;
        if (total <= 0) throw new Error("The active stream is not seekable yet");
        flushSync(() => seekToSeconds(Math.min(total, command.position_ms / 1000)));
      }
    },
    enable: async () => {
      const activeEngine = engineRef.current;
      if (!activeEngine) throw new Error("The playback engine is not ready");
      // A silent, user-initiated media play unlocks HTML audio without starting a queued track.
      const permission = new Audio("data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==");
      const contextReady = activeEngine.unlock();
      try { await Promise.all([permission.play(), contextReady]); }
      finally { permission.pause(); permission.removeAttribute("src"); permission.load(); }
    },
    prepare: async (snapshot, signal) => {
      const activeEngine = engineRef.current;
      if (!activeEngine) throw new Error("The playback engine is not ready");
      if (activeEngine.isRemoteOutput) throw new Error("Stop Google Cast on the target before transferring playback.");
      const originalQueue = stateRef.current;
      const selected = await getListeningTrack(snapshot.trackId, signal);
      if (signal.aborted) throw new Error("Transfer cancelled");
      if (stateRef.current.generation !== originalQueue.generation ||
          stateRef.current.entries !== originalQueue.entries ||
          stateRef.current.currentIndex !== originalQueue.currentIndex || isPlayingRef.current ||
          activeEngine.isRemoteOutput) {
        throw new Error("Playback changed on the target. Try transferring again.");
      }
      if (!selected?.id || String(selected.id) !== snapshot.trackId || !isLibraryPlayable({ ...selected, id: selected.id })) {
        throw new Error("The target cannot access this library track");
      }
      const queue = snapshot.queueState;
      const tracks = queue.entries.map((item, index): Song => ({
        ...(index === queue.index ? selected : { id: item.trackId, title: item.title, artist: item.artist, album: item.album,
          duration: item.duration, source: { kind: "library", count: 1 }, availability: { libraryAvailable: true } }),
        id: item.trackId, remoteOccurrenceId: item.occurrenceId, albumPlaybackId: item.albumPlaybackId, albumTrackIndex: item.albumTrackIndex,
        mediaResume: item.resume || (queue.context && (queue.context.type === "album" || queue.context.type === "playlist") ? {
          type: queue.context.type, mediaId: queue.context.id, title: queue.context.name, trackIndex: index, trackCount: queue.entries.length,
          occurrenceId: null,
        } : undefined),
      }));
      const previous = stateRef.current;
      const previousCheckpoint = queueCheckpointRef.current();
      const previousContext = playbackContextRef.current;
      const owner = trackingUserRef.current;
      let staged: QueueState<Song> | undefined;
      const rollback = () => {
        if (transferTransaction.current?.signal !== signal) return;
        transferTransaction.current = null;
        if (mountedRef.current) setStagingTransfer(false);
        const current = stateRef.current;
        if (!mountedRef.current || !staged || trackingUserRef.current !== owner || current.generation !== staged.generation ||
            current.entries !== staged.entries || current.currentIndex !== staged.currentIndex) return;
        activeEngine.pause();
        flushSync(() => {
          storeRef.current.hydrate(previous.entries, previous.currentIndex, {
            autoplay: false, startAt: previousCheckpoint.position, shuffleSeed: previous.shuffleSeed,
            deferLoad: !previous.loadRequest,
          });
          applyQueuePreferences(previousCheckpoint);
          setPlaybackContext(previousContext);
          const entry = previous.entries[previous.currentIndex];
          cuedPositionRef.current = entry ? { trackId: String(entry.track.id), seconds: previousCheckpoint.position } : null;
          setCurrentTime(previousCheckpoint.position);
        });
      };
      transferTransaction.current = { signal, rollback };
      signal.addEventListener("abort", rollback, { once: true });
      activeEngine.pause();
      cancelRestoreResume();
      flushSync(() => {
        setStagingTransfer(true);
        shuffleEnabledRef.current = queue.shuffle; setIsShuffleEnabled(queue.shuffle);
        shuffleModeRef.current = queue.shuffleMode; setShuffleMode(queue.shuffleMode);
        changeAlbumAware(queue.albumAware, false);
        setPlaybackContext(queue.context);
        storeRef.current.setQueue(tracks, queue.index, { autoplay: false, startAt: snapshot.exactPositionMs / 1000,
          shuffleSeed: queue.shuffleSeed, unshuffledIndices: queue.entries.map(entry => entry.unshuffledIndex) });
        storeRef.current.setRepeatMode(repeatModeOf(queue));
        loopPlaylistRef.current = queue.loopPlaylistId ?? null; setLoopPlaylistId(loopPlaylistRef.current);
      });
      staged = stateRef.current;
      await new Promise<void>((resolve, reject) => {
        const started = performance.now();
        const finish = (error?: Error) => {
          window.clearInterval(timer);
          signal.removeEventListener("abort", abort);
          if (error) reject(error); else resolve();
        };
        const abort = () => finish(new Error("Transfer cancelled"));
        const timer = window.setInterval(() => {
          const entry = currentEntryOf(stateRef.current);
          const actual = activeEngine.getSnapshot();
          if (performance.now() - started > 12000) { finish(new Error("The target could not buffer this track in time")); return; }
          if (entry?.track.remoteOccurrenceId !== queue.entries[queue.index].occurrenceId ||
              stateRef.current.entries.length !== queue.entries.length ||
              stateRef.current.entries.some((item, index) => item.track.remoteOccurrenceId !== queue.entries[index].occurrenceId)) {
            finish(new Error("The target queue changed during preparation")); return;
          }
          if (actual.key !== entry.entryId) return;
          if (actual.state === "error" || stateRef.current.lastError) {
            finish(new Error(stateRef.current.lastError || "The target could not load this stream")); return;
          }
          if (activeEngine.isReadyForResume() && actual.duration > 0 && Math.abs(actual.position - snapshot.exactPositionMs / 1000) < .25) {
            finish();
          }
        }, 40);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    commitTransfer: (signal) => {
      const transaction = transferTransaction.current;
      if (transaction?.signal !== signal) return;
      signal.removeEventListener("abort", transaction.rollback);
      transferTransaction.current = null;
      setStagingTransfer(false);
      mediaTrackerRef.current?.captureCurrent();
      const current = currentEntryOf(stateRef.current);
      if (current && isPlayingRef.current) recordShufflePlay(current);
      writeStored("playerAlbumAware", String(albumAwareRef.current), "album-aware mode");
      writeStored("playerVolume", String(volume), "volume");
      void persistedQueue.flush().catch(() => {});
    },
    start: async (snapshot, signal) => {
      const activeEngine = engineRef.current;
      if (!activeEngine) throw new Error("The playback engine is not ready");
      if (signal?.aborted) throw new Error("Transfer cancelled");
      const entry = currentEntryOf(stateRef.current);
      if (entry?.track.remoteOccurrenceId !== snapshot.queueState.entries[snapshot.queueState.index].occurrenceId ||
          stateRef.current.entries.length !== snapshot.queueState.entries.length ||
          stateRef.current.entries.some((item, index) => item.track.remoteOccurrenceId !== snapshot.queueState.entries[index].occurrenceId) ||
          stateRef.current.currentIndex !== snapshot.queueState.index ||
          repeatModeOf(stateRef.current) !== repeatModeOf(snapshot.queueState)) throw new Error("The target queue changed during handoff");
      activeEngine.seek(snapshot.exactPositionMs / 1000);
      flushSync(() => {
        changeVolume(snapshot.volume, false);
        setCurrentTime(snapshot.exactPositionMs / 1000);
      });
      if (snapshot.playing) {
        await activeEngine.play();
        if (signal?.aborted) throw new Error("Transfer cancelled");
        if (activeEngine.getSnapshot().state !== "playing") { activeEngine.pause(); throw new Error(PLAYBACK_BLOCKED_MESSAGE); }
      }
    },
  };
  const remote = useRemoteSession(features.remoteControl && isAuthenticated ? sessionId : null, remoteAdapter);
  const controlRemote = async (command: Parameters<typeof remote.command>[0]): Promise<void> => {
    try { await remote.command(command); }
    catch (failure: unknown) {
      setPlaybackMessage(failure instanceof Error ? failure.message : "Remote playback command failed");
    }
  };
  const toggleSelectedPlayback = () => controlRemote({ type: (remotePlayer?.playing ?? isPlayingRef.current) ? "PAUSE" : "PLAY" });
  async function enqueueOnActiveDevice(tracks: Song[], next: boolean, dedupe: boolean) {
    if (!tracks.length) return;
    if (tracks.length > 1000) { setPlaybackMessage("Add up to 1,000 tracks at a time to the active device."); return; }
    await controlRemote({ type: "ENQUEUE", tracks: tracks.map(sanitizeQueueTrack), next, dedupe });
  }
  // A local saved queue stays cued while another device owns account playback.
  const live = remote.playback;
  const activeDevice = remote.activeDevice;
  const liveRemote = live?.device_id && live.device_id !== remote.deviceId && activeDevice?.device_id === live.device_id ? live : null;
  const remotePlayer = useMemo(() => {
    if (!live) return remote.isRemote ? activeDevice : null;
    if (activeDevice?.device_id !== live.device_id) return remote.isRemote ? activeDevice : null;
    if (!liveRemote || !activeDevice) return null;
    return { ...activeDevice, current_track: liveRemote.track, playing: liveRemote.is_playing,
      position_ms: liveRemote.position_ms, duration_ms: liveRemote.duration_ms, volume: liveRemote.volume };
  }, [live, liveRemote, activeDevice, remote.isRemote]);
  const remoteTrack = remotePlayer?.current_track;
  const castRendering = cast.connected || Boolean(engine?.isRemoteOutput);
  remotePlayingElsewhere.current = Boolean(remote.isRemote);
  useEffect(() => {
    if (remote.activeDevice?.device_id === remote.deviceId) {
      if (!restoreRef.current) automaticallyResuming.current = false;
      setPreferLocalQueue(false);
    } else if (remote.isRemote && (restoreRef.current || automaticallyResuming.current)) {
      suppressedRestoreRevision.current = stateRef.current.revision;
      followingAccountQueue.current = true;
      cancelRestoreResume();
      engineRef.current?.pause();
    }
  }, [cancelRestoreResume, remote.activeDevice?.device_id, remote.deviceId, remote.isRemote]);

  const localHead = persistedQueue.getHead();
  const suppressedRestore = suppressedRestoreRevision.current === queueState.revision;
  const accountQueue = useAccountQueue({
    owner: features.queueCloudSync && isAuthenticated && hydratedQueueUserId === sessionId ? sessionId : null,
    localCapturedAt: suppressedRestore ? restoredCheckpointTime.current : localHead?.checkpoint.capturedAt ?? 0,
    followPaused: !isPlaying && !castRendering && !restorePending && !preferLocalQueue && (!entries.length || Boolean(localHead)),
    activeDevice: remotePlayer,
    status: remote.status,
  });
  followingAccountQueue.current = !isPlaying && Boolean(remotePlayer || accountQueue || suppressedRestore);
  const accountTracks = useMemo(() => accountQueue?.content.entries.map(entry => entry.track as Song), [accountQueue?.content]);
  const accountIndex = accountQueue?.checkpoint.index ?? -1;
  const liveQueueState = liveRemote?.queue;
  const displayedQueue = liveQueueState ?? accountQueue?.checkpoint ?? (remotePlayer ? null : queueState);
  const repeatMode = displayedQueue ? repeatModeOf(displayedQueue) : "off";
  const liveTracks = useMemo(() => liveQueueState?.entries.map((entry): Song => ({
    id: entry.trackId, title: entry.title, artist: entry.artist, album: entry.album, duration: entry.duration,
    mediaResume: entry.resume, playlistItemId: entry.resume?.occurrenceId ?? undefined,
  })), [liveQueueState]);
  const liveSong = liveTracks?.[liveQueueState?.index ?? -1];
  const accountSong = accountTracks?.[accountIndex] ?? liveSong;
  const remoteOccurrence = liveQueueState ? liveSong : accountSong;
  const pausedAccountQueue = remotePlayer ? null : accountQueue;
  const displayedLoopPlaylist = remotePlayer
    ? (liveQueueState ? liveQueueState.loopPlaylistId : accountQueue?.checkpoint.loopPlaylistId) ?? null
    : pausedAccountQueue ? pausedAccountQueue.checkpoint.loopPlaylistId ?? null : loopPlaylistId;
  const queueOccurrenceAt = (index: number) => liveQueueState
    ? liveQueueState.entries[index]?.occurrenceId
    : accountQueue?.content.entries[index]?.entryId;
  const seekSelectedPlayer = (seconds: number) => {
    if (!Number.isFinite(seconds)) return;
    const total = remotePlayer?.duration_ms ?? duration * 1000;
    void controlRemote({ type: "SEEK", position_ms: Math.min(total, Math.max(0, Math.round(seconds * 1000))) });
  };
  const takeAccountQueue = (index = accountIndex, autoplay = false, position?: number) => {
    if (!pausedAccountQueue || index < 0 || index >= pausedAccountQueue.content.entries.length) return;
    const { content, checkpoint } = pausedAccountQueue;
    const startAt = position ?? (index === checkpoint.index ? checkpoint.position : 0);
    cancelRestoreResume();
    engineRef.current?.pause();
    listeningSessionRef.current?.finish();
    setPreferLocalQueue(true);
    applyQueuePreferences(checkpoint);
    cuedPositionRef.current = autoplay ? null : { trackId: content.entries[index].track.id, seconds: startAt };
    storeRef.current.hydrate(content.entries as QueueEntry<Song>[], index, {
      autoplay, startAt, deferLoad: !autoplay, shuffleSeed: checkpoint.shuffleSeed,
    });
  };

  const sleepAlbumKeys = useMemo(() => {
    const track = entries[currentIndex]?.track;
    const marker = track?.albumPlaybackId;
    const albumId = playbackContext?.type === "album" ? playbackContext.id : null;
    if (queueState.repeatOne || !track || (!marker && !albumId)) return [];
    const keys: string[] = [];
    for (let index = currentIndex; index < entries.length; index++) {
      const entry = entries[index];
      if (marker ? entry.track.albumPlaybackId !== marker : entry.track.albumId !== albumId) break;
      keys.push(entry.entryId);
    }
    return keys;
  }, [entries, currentIndex, playbackContext?.type, playbackContext?.id, queueState.repeatOne]);
  useEffect(() => { engine?.sleepTimer.validateAlbum(sleepAlbumKeys); }, [engine, sleepAlbumKeys]);
  useEffect(() => {
    if (remotePlayer || castRendering) engine?.sleepTimer.cancel();
  }, [engine, remotePlayer, castRendering]);
  useEffect(() => () => engine?.sleepTimer.cancel(), [engine, localQueueOwner]);
  const value: PlayerContextValue = {
    audioEngine: engine,
    sleepAlbumKeys,
    flushQueuePersistence: persistedQueue.flush,
    restoreSavedQueue,
    accountQueueSource: accountQueue ? { contentId: accountQueue.contentId, checkpoint: accountQueue.checkpoint } : undefined,
    queuePersistenceError,
    currentSong: remotePlayer ? (remoteTrack ? {
      ...accountSong, id: remoteTrack.id, title: remoteTrack.title || accountSong?.title,
      artist: remoteTrack.artist || accountSong?.artist, album: remoteTrack.album || accountSong?.album,
      coverArt: remoteTrack.cover_art || accountSong?.coverArt, source: accountSong?.source ?? { kind: "library" },
      playlistItemId: sameSongId(remoteOccurrence, remoteTrack) ? remoteOccurrence?.playlistItemId : undefined,
    } : null)
      : accountQueue ? accountSong ?? null : currentSong,
    activeSidebar,
    setActiveSidebar,
    autoOpenSidebar,
    isEndlessPlaybackEnabled,
    autoDownloadLiked,
    isPlaying: remotePlayer ? remotePlayer.playing : isPlaying,
    isRemotePlayback: Boolean(remotePlayer),
    isCasting: castRendering,
    playbackStatus: remotePlayer ? remotePlayer.playing ? "PLAYING" : "PAUSED" : queueState.status,
    isBuffering: !remotePlayer && (queueState.status === "BUFFERING" || queueState.status === "STALLED"),
    currentTime: remotePlayer ? remotePlayer.position_ms / 1000 : accountQueue?.checkpoint.position ?? currentTime,
    playbackPositionKey: liveRemote ? `${liveRemote.device_id}:${liveRemote.revision}` : positionKey,
    readPlaybackPosition: remotePlayer ? liveRemote ? remote.readPosition : undefined
      : castRendering || accountQueue ? undefined : readPlaybackPosition,
    duration: remotePlayer ? remotePlayer.duration_ms / 1000 : accountQueue ? songDurationHint(accountSong) ?? 0 : duration,
    queue: liveTracks ?? accountTracks ?? (remotePlayer ? [] : queue),
    queueIndex: liveQueueState?.index ?? (accountQueue ? accountIndex : remotePlayer ? -1 : currentIndex),
    recentlyPlayed,
    // QueueSidebar calls this play history; it is the same recently-played list.
    playHistory: recentlyPlayed,
    likedSongIds,
    isCurrentSongLiked: remoteTrack ? likedSongIds.has(remoteTrack.id) : accountSong ? likedSongIds.has(String(accountSong.id)) : Boolean(currentSong && likedSongIds.has(String(currentSong.id))),
    playbackContext: liveQueueState ? liveQueueState.context : accountQueue ? accountQueue.checkpoint.context : remotePlayer ? null : playbackContext,
    isAlbumAware: liveQueueState?.albumAware ?? accountQueue?.checkpoint.albumAware ?? isAlbumAware,
    changeAlbumAware,
    isPreview: !remotePlayer && isPreview,
    isShuffleEnabled: liveQueueState?.shuffle ?? accountQueue?.checkpoint.shuffle ?? (!remotePlayer && isShuffleEnabled),
    shuffleMode: liveQueueState?.shuffleMode ?? accountQueue?.checkpoint.shuffleMode ?? shuffleMode,
    changeShuffleMode,
    isLooping: repeatMode !== "off",
    repeatMode,
    previewDurationSeconds: !remotePlayer && isPreview ? PREVIEW_DURATION_SECONDS : null,
    playbackUnavailable: !remotePlayer && playbackUnavailable,
    playbackMessage: remotePlayer ? remote.error || playbackMessage : playbackMessage,
    // Retained for existing layouts; loudness analysis never blocks playback.
    isPreparingPlayback: false,
    volume: remotePlayer ? remotePlayer.volume : castRendering && cast.volume !== null ? gainToPerceptualVolume(cast.volume) : accountQueue?.checkpoint.volume ?? volume,
    transitionMode,
    crossfadeDuration,
    streamQuality,
    streamQualityDetails: remotePlayer || castRendering ? { source: null, output: null, pipeline: null, delivery: null,
      loading: false, error: "", note: `Audio is rendered on ${remotePlayer?.device_name || cast.device || "the Cast receiver"}. Receiver decoding and output properties are not exposed by this browser.`,
      preview: false, serverNormalized: false } : streamQualityDetails,
    applyStreamQuality,
    downloadQuality,
    isReplayGainEnabled,
    normalizationTarget,
    layoutDensity,
    accentColor,
    playSong,
    addToQueue,
    queueTracks,
    playTracksNext,
    playSongFromSource,
    playContext,
    playLibraryTracks,
    playQueue,
    resumeMedia,
    playQueueSong: remotePlayer ? async (index) => {
      const entry_id = queueOccurrenceAt(index);
      if (entry_id) await controlRemote({ type: "PLAY_QUEUE_ENTRY", entry_id });
    } : pausedAccountQueue ? async (index) => takeAccountQueue(index, true) : playQueueSong,
    moveQueueItem: remotePlayer ? (from, to) => {
      const entry_id = queueOccurrenceAt(from), target_id = queueOccurrenceAt(to);
      if (entry_id && target_id) void controlRemote({ type: "MOVE_QUEUE_ENTRY", entry_id, target_id });
    } : pausedAccountQueue ? (from, to) => { takeAccountQueue(); moveQueueItem(from, to); } : moveQueueItem,
    nextSong: remotePlayer ? () => controlRemote({ type: "SKIP", direction: "next" }) : pausedAccountQueue ? async () => takeAccountQueue(accountIndex + 1) : () => nextSong(),
    previousSong: remotePlayer ? () => controlRemote({ type: "SKIP", direction: "previous" }) : pausedAccountQueue ? async () => takeAccountQueue(accountIndex - 1) : previousSong,
    toggleShuffle: remotePlayer ? () => controlRemote({ type: "TOGGLE_SHUFFLE" }) : pausedAccountQueue ? () => {
      takeAccountQueue();
      toggleShuffleForQueue(pausedAccountQueue.content.entries.length, accountIndex);
    } : toggleShuffle,
    toggleLoop: remotePlayer ? () => controlRemote({ type: "TOGGLE_REPEAT" }) : pausedAccountQueue ? () => {
      takeAccountQueue();
      cycleRepeatMode(repeatModeOf(pausedAccountQueue.checkpoint));
    } : toggleLoop,
    loopPlaylistId: displayedLoopPlaylist,
    togglePlaylistLoop: (playlistId) => {
      const enabled = displayedLoopPlaylist !== playlistId;
      if (remotePlayer) { void controlRemote({ type: "SET_PLAYLIST_LOOP", playlist_id: playlistId, enabled }); return; }
      if (pausedAccountQueue) takeAccountQueue();
      setPlaylistLoop(playlistId, enabled);
    },
    togglePlay: remotePlayer ? toggleSelectedPlayback
      : pausedAccountQueue ? () => takeAccountQueue(accountIndex, true) : togglePlay,
    toggleLike: remoteTrack ? () => toggleLikeSong({ id: remoteTrack.id, title: remoteTrack.title }) : accountSong ? () => toggleLikeSong(accountSong) : toggleLike,
    toggleLikeSong,
    setTrackFavorite,
    seek: remotePlayer ? (percent) => seekSelectedPlayer(percent / 100 * (remotePlayer.duration_ms / 1000))
      : pausedAccountQueue ? (percent) => takeAccountQueue(accountIndex, false, percent / 100 * (songDurationHint(accountSong) ?? 0)) : seek,
    seekToSeconds: remotePlayer ? seekSelectedPlayer : pausedAccountQueue ? (seconds) => {
      if (Number.isFinite(seconds)) takeAccountQueue(accountIndex, false, Math.max(0, seconds));
    } : seekToSeconds,
    changeVolume: remotePlayer ? (value) => {
      if (Number.isFinite(value)) void controlRemote({ type: "SET_VOLUME", volume: Math.max(0, Math.min(1, value)) });
    }
      : pausedAccountQueue ? (value) => { takeAccountQueue(); changeVolume(value); } : changeVolume,
    changeTransitionMode,
    changeCrossfadeDuration,
    changeStreamQuality,
    changeDownloadQuality,
    changeReplayGainEnabled,
    changeNormalizationTarget,
    changeLayoutDensity,
    changeAccentColor,
    changeAutoOpenSidebar,
    changeEndlessPlaybackEnabled,
    changeAutoDownloadLiked,
    resetPlayer,
  };

  useBrowserMediaSession(value);

  return (
    <RemoteSessionContext.Provider value={{ ...remote,
      transfer: async targetId => { await remote.transfer(targetId); setPreferLocalQueue(false); } }}>
    <CastContext.Provider value={{ ...cast, connect: async () => {
      if (remote.isRemote) throw new Error("Select this device in Devices before starting Google Cast.");
      await cast.connect();
    } }}>
    <PlayerContext.Provider value={value}>
      <PlayerItemStateProvider
        value={{
          currentSong: value.currentSong, isPlaying: value.isPlaying, likedSongIds, downloadQuality,
          togglePlay: value.togglePlay, toggleLikeSong, playContext, playLibraryTracks, playSongFromSource,
        }}
      >
        {children}
      </PlayerItemStateProvider>
      {/* The engine appends its audio decks here; they stay mounted across route changes. */}
      <div ref={audioHostRef} hidden data-audio-decks="" />
    </PlayerContext.Provider>
    </CastContext.Provider>
    </RemoteSessionContext.Provider>
  );
}

export function usePlayer(inactive = false): PlayerContextValue | null {
  return useContext(inactive ? InactivePlayerContext : PlayerContext);
}
