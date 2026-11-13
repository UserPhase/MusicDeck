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
  RECOMMENDATION_FEEDBACK_CHANGED_EVENT,
  getUserSettings,
  updateUserSettings,
  getSilenceAnalysis,
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
import { queueDeviceId, queueSyncClient } from "../services/QueueSyncClient";
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
  replayGainMetadata,
  trackGainDb,
  validLoudness,
} from "../utils/loudness";
import { usePlaybackEngine } from "../hooks/usePlaybackEngine";
import { useBrowserMediaSession } from "../hooks/useBrowserMediaSession";
import { currentEntryOf, shuffleUpcoming, upcomingEntryOf, useQueueStore, usePersistentQueue } from "../hooks/useQueueStore";
import type { PlaybackStatus, QueueEntry, QueueState, QueueStore } from "../hooks/useQueueStore";
import { PLAYBACK_BLOCKED_MESSAGE } from "../services/audio/PlaybackEngine";
import type { PlaybackEngine } from "../services/audio/PlaybackEngine";
import { replayGainLevel } from "../services/audio/outputs";
import { offlineDownloadEngine } from "../services/storage/OfflineDownloadEngine";
import {
  CROSSFADE_MAX_SECONDS,
  CROSSFADE_MIN_SECONDS,
  DEFAULT_CROSSFADE_SECONDS,
} from "../services/audio/crossfadeTransition";
import type { EngineState, PlayableTrack, TransitionMode as EngineTransitionMode } from "../services/audio/types";

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
  isAutoplayEnabled: boolean;
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
  playContext: (tracks: Song[], startIndex?: number, context?: PlaybackContextInfo | null) => Promise<void>;
  playQueue: (songs: Song[], startIndex?: number, context?: PlaybackContextInfo | null) => Promise<void>;
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
  changeAutoplayEnabled: (value: boolean) => void;
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

interface TrimBounds {
  leading: number;
  trailing: number;
  /** Absolute end of audible content; known once a duration is. */
  end: number | null;
}

interface SilenceTrimSettings {
  enabled: boolean;
  thresholdDb: number;
  minSilenceSeconds: number;
}

interface RestoreRequest {
  trackId: string;
  attempted: boolean;
  blocked: boolean;
  resumeWhenReady?: () => void;
  registryTimeout?: number;
}

// ---------------------------------------------------------------- constants

const RECONNECTING_MESSAGE = "Connection interrupted. Reconnecting…";
const CHECKPOINT_SYNC_MESSAGE = "Listening progress couldn’t sync. MusicDeck will try again when it saves your next position.";
const RESTARTED_MESSAGE = "Reconnected. This stream can't resume mid-track, so it restarted.";
const PREVIEW_UNAVAILABLE_MESSAGE = "Preview unavailable for this track";
const PREVIEW_DURATION_SECONDS = 30;
const MESSAGE_TIMEOUT_MS = 4200;
const MAX_RECENTLY_PLAYED = 50;
const RESTART_THRESHOLD_SECONDS = 3;
/** Auto-refill starts once this many (or fewer) tracks remain after the current one. */
export const REFILL_TRIGGER_UPCOMING = 2;
const REFILL_TARGET_UPCOMING = 10;
const QUEUE_END_AUTOPLAY_COUNT = 10;
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
function autoplayTracksFor(song: Song, limit: number, excludeIds: Array<string | number>) {
  return song.tastePlaylistId ? getAutoplayTracks(song.id, limit, excludeIds, { playlistId: String(song.tastePlaylistId), excludeFromTaste: Boolean(song.excludeFromTaste) })
    : getAutoplayTracks(song.id, limit, excludeIds);
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
  const [isAutoplayEnabled, setIsAutoplayEnabled] = useState(() => {
    const saved = readStored("playerAutoplayEnabled", "autoplay preference");
    return saved === null ? true : saved === "true";
  });
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
  const replayGainEnabledRef = useRef(isReplayGainEnabled);
  const normalizationTargetRef = useRef<number>(DEFAULT_LOUDNESS_TARGET);
  const autoplayRef = useRef(isAutoplayEnabled);
  autoplayRef.current = isAutoplayEnabled;

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

  const recordShufflePlay = useCallback((entry: QueueEntry<Song>) => {
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
    transitionMode: engineTransitionMode(transitionMode),
    albumAware: isAlbumAware,
    crossfadeSeconds: crossfadeDuration,
    volume: perceptualVolumeToGain(volume),
    createAudioElement,
    ...(desktop ? { audioContext: null } : {}),
  });
  const engineRef = useRef<PlaybackEngine | null>(engine);
  engineRef.current = engine;
  const privacy = usePrivacy();
  const cast = useCastSession(engine, isAuthenticated ? sessionId : null, Boolean(privacy.policy?.effective.external));

  /** Resolved stream per entry, so the prepared upcoming track and its later load agree. */
  const sourceCacheRef = useRef(new Map<string, ResolvedAudio>());
  /** Latest linear level per entry; reloads (repeat, normalization toggle) reuse it. */
  const gainByEntryRef = useRef(new Map<string, number>());
  const trimByEntryRef = useRef(new Map<string, TrimBounds>());
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
    if (offlineDownloadEngine.getSnapshot().tracks.some((track) => track.track_id === String(song.id) && track.status === "verified")) return { normalized: false };
    if (!replayGainEnabledRef.current || albumPlayback(song) || streamQualityRef.current === "direct") return { normalized: false };
    const result = cachedNormalization(normalizationKey(song, source, previewUrl));
    if (result?.status === "ready" && typeof result.streamUrl === "string" && NORMALIZED_STREAM.test(result.streamUrl)) {
      return { normalized: true, loudness: validLoudness(result), streamUrl: result.streamUrl };
    }
    return { normalized: false, gainDb: result?.gainDb };
  }

  function resolvePlaybackAudio(song: Song, source: unknown, previewUrl: string | null): ResolvedAudio {
    const { streamUrl, ...info } = normalizationInfo(song, source, previewUrl);
    if (streamUrl) return { ...info, url: streamUrl };
    const original = previewUrl
      ? `/api/playback/preview?url=${encodeURIComponent(previewUrl)}`
      : String(getStreamUrl(song.id, source, streamQualityRef.current));
    return { ...info, url: original };
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
    if (resolved.url.startsWith("/api/tracks/")) {
      const url = new URL(resolved.url, window.location.origin);
      url.searchParams.set("inspectionId", typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      resolved.url = url.pathname + url.search;
    }
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
      gain,
      trimStart: albumPlayback(entry.track) ? 0 : trim?.leading ?? 0,
      // A preview is only a fragment of the recording: the engine ends it here.
      trimEnd: preview ? PREVIEW_DURATION_SECONDS : albumPlayback(entry.track) ? null : trim?.end ?? null,
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
    if (!engine || !isAuthenticated || !sessionId) return;
    const controllers = new Set<AbortController>();
    const tracker = createMediaSessionTracker({
      engine,
      getTrack: (key) => stateRef.current.entries.find((entry) => entry.entryId === key)?.track,
      save: async (input: MediaCheckpointInput) => {
        if (checkpointOwnerRef.current !== sessionId) return;
        const controller = new AbortController();
        controllers.add(controller);
        try {
          const result: { checkpoint: MediaCheckpoint | null } = await saveMediaCheckpoint(input, controller.signal);
          if (checkpointOwnerRef.current === sessionId && !controller.signal.aborted) {
            setPlaybackMessage((message) => message === CHECKPOINT_SYNC_MESSAGE ? "" : message);
            window.dispatchEvent(new CustomEvent(MEDIA_CHECKPOINT_CHANGED, { detail: { userId: sessionId, checkpoint: result.checkpoint, input } }));
          }
        } finally { controllers.delete(controller); }
      },
      onError: (error) => {
        if (checkpointOwnerRef.current !== sessionId) return;
        console.error("Could not sync listening checkpoint:", error);
        setPlaybackMessage(CHECKPOINT_SYNC_MESSAGE);
      },
    });
    return () => {
      const sameAccount = checkpointOwnerRef.current === sessionId;
      if (!sameAccount) controllers.forEach((controller) => controller.abort());
      tracker.destroy({ flushPending: sameAccount });
    };
  }, [engine, isAuthenticated, sessionId]);

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
    if (!isAuthenticated || !sessionId) return undefined;
    const tracker = createListeningTracker({
      userId: sessionId,
      storage: window.sessionStorage,
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
    Promise.resolve(getListeningConfig())
      .then((config: { thresholdSeconds: number }) => tracker.setThreshold(config.thresholdSeconds))
      .catch((error: unknown) => console.error("Could not load listening threshold; using 30 seconds:", error));
    const flush = () => tracker.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      if (trackingUserRef.current !== sessionId) tracker.finish();
      tracker.suspend();
      window.removeEventListener("pagehide", flush);
      if (listeningSessionRef.current === tracker) listeningSessionRef.current = null;
    };
  }, [isAuthenticated, sessionId]);

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
    if (!tracker || !isPlaying || !currentEntry || isPreview || !isLibraryPlayable(currentEntry.track)) return;
    tracker.begin(currentEntry.track, clockFor(currentEntry.entryId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, currentEntryId, loadSequence, isPreview, isAuthenticated, sessionId]);

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
    window.clearTimeout(restoreRef.current?.registryTimeout);
    restoreRef.current = null;
    setRestorePending(false);
  }, []);

  const attemptRestoredPlaybackRef = useRef<(restore: RestoreRequest) => void>(() => undefined);
  const restoredCheckpointTime = useRef(0);
  const remotePlayingElsewhere = useRef(false);
  const remoteRegistryReady = useRef(false);
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
    window.clearTimeout(restoreRef.current?.registryTimeout);
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
      clockFor(entry.entryId).duration = snapshot.duration;
      applyTrailingTrim(entry.entryId, snapshot.duration);
    }
    setCurrentTime(snapshot.position);
    const restore = restoreRef.current;
    if (restore && !restore.attempted && String(entry.track.id) === restore.trackId) {
      restore.attempted = true;
      const owner = queueSyncClient.getSnapshot().owner;
      let queueChecked = false;
      const resume = (timedOut = false) => {
        if (!restore.resumeWhenReady || !mountedRef.current || restoreRef.current !== restore) return;
        if (!timedOut && (!queueChecked || !remoteRegistryReady.current)) return;
        restore.resumeWhenReady = undefined;
        window.clearTimeout(restore.registryTimeout);
        const account = queueSyncClient.getSnapshot();
        const peer = account.owner === owner && owner ? newestPeerQueue(account.sessions, queueDeviceId()) : undefined;
        if (remotePlayingElsewhere.current || (peer && peer.checkpoint.capturedAt > restoredCheckpointTime.current)) {
          suppressedRestoreRevision.current = stateRef.current.revision;
          followingAccountQueue.current = true;
          cancelRestoreResume();
        } else attemptRestoredPlaybackRef.current(restore);
      };
      restore.resumeWhenReady = resume;
      if (!owner || navigator.onLine === false) resume(true);
      else {
        restore.registryTimeout = window.setTimeout(() => resume(true), 2000);
        void queueSyncClient.refresh().then(() => {
          queueChecked = true;
          resume();
        });
      }
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

  const queueEndPendingRef = useRef(false);
  const feedbackVersionRef = useRef(0);
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
    setPlaybackContext(null);
    setPlaybackUnavailable(false);
  }, [cancelRestoreResume]);

  const continueAfterQueueEnd = useCallback(async () => {
    if (queueEndPendingRef.current) return;
    const context = playbackContextRef.current;
    const playlistId = context?.type === "playlist" ? String(context.id) : context?.playlistLoopId;
    if (playlistId && loopPlaylistRef.current === playlistId) {
      const index = stateRef.current.entries.findIndex(entry => entry.track.tastePlaylistId === playlistId);
      if (index >= 0) {
        storeRef.current.jumpToIndex(index);
        return;
      }
    }
    if (!autoplayRef.current || tasteExcludedEntriesRef.current.has(currentEntryOf(stateRef.current)?.entryId ?? "") || (tasteProfileStore.getSnapshot().owner === trackingUserRef.current && tasteProfileStore.getSnapshot().privateListening) || tasteProfileStore.excludes(currentEntryOf(stateRef.current)?.track)) {
      stopAtQueueEnd();
      return;
    }
    queueEndPendingRef.current = true;
    const queueGeneration = stateRef.current.generation;
    const feedbackVersion = feedbackVersionRef.current;
    try {
      const state = stateRef.current;
      const seed = currentEntryOf(state)?.track ?? state.entries[state.entries.length - 1]?.track;
      if (!seed) { stopAtQueueEnd(); return; }
      const nextSongs = await autoplayTracksFor(seed, QUEUE_END_AUTOPLAY_COUNT, state.entries.map((entry) => entry.track.id));
      if (!mountedRef.current || stateRef.current.generation !== queueGeneration) return;
      if (!autoplayRef.current || feedbackVersionRef.current !== feedbackVersion || tasteProfileStore.excludes(seed) || tasteProfileStore.getSnapshot().privateListening) { stopAtQueueEnd(); return; }
      if (!Array.isArray(nextSongs) || nextSongs.length === 0) {
        stopAtQueueEnd();
        return;
      }
      const generated = shuffleEnabledRef.current && shuffleModeRef.current === "smart"
        ? smartShuffle(nextSongs as Song[], smartShuffleOptionsRef.current()).tracks : nextSongs as Song[];
      if (!generated.length) {
        setPlaybackMessage("Smart Shuffle found no tracks outside the two-hour listening window.");
        stopAtQueueEnd();
        return;
      }
      storeRef.current.setQueue(generated, 0);
    } catch (error) {
      console.error("Could not generate local autoplay:", error);
      if (mountedRef.current && stateRef.current.generation === queueGeneration) {
        setPlaybackMessage("Autoplay is unavailable. Please try again.");
        stopAtQueueEnd();
      }
    } finally {
      queueEndPendingRef.current = false;
    }
  }, [stopAtQueueEnd]);

  useEffect(() => {
    if (!engine) return undefined;
    const currentKey = () => currentEntryOf(stateRef.current)?.entryId ?? null;
    const unsubscribers = [
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
        const entry = state === "playing" ? stateRef.current.entries.find((candidate) => candidate.entryId === key) : null;
        if (entry) recordShufflePlay(entry);
      }),
      engine.on("transitionCommit", ({ toKey }) => {
        const entry = stateRef.current.entries.find((candidate) => candidate.entryId === toKey);
        if (entry) recordShufflePlay(entry);
      }),
      engine.on("trackEnd", ({ key }) => {
        listeningSessionRef.current?.finish();
        const state = stateRef.current;
        const entry = currentEntryOf(state);
        if (!entry || entry.entryId !== key || state.repeatOne) return;
        if (state.currentIndex + 1 < state.entries.length) return;
        void continueAfterQueueEnd();
      }),
      engine.on("sleepStop", () => listeningSessionRef.current?.finish()),
      engine.on("bufferStall", ({ key }) => {
        if (key !== currentKey()) return;
        setPlaybackMessage(RECONNECTING_MESSAGE);
      }),
      engine.on("streamRecovered", ({ key, restartedFromBeginning }) => {
        if (key !== currentKey()) return;
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
    setPlaybackUnavailable(true);
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
    if (streamQualityRef.current === "direct") return Promise.resolve(undefined);
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
        typeof result.gainDb !== "number" ||
        !Number.isFinite(result.gainDb)
      ) {
        return;
      }
      binding.measurement =
        validLoudness(result.loudness) ??
        (result.status === "measured" ? validLoudness(result) : binding.measurement);
      if (result.status === "ready" && typeof result.streamUrl === "string" && NORMALIZED_STREAM.test(result.streamUrl)) {
        if (!sourceCacheRef.current.has(entryId)) {
          // Not handed to the engine yet: its load will pick the normalized stream at unity gain.
          binding.normalized = true;
          gainByEntryRef.current.set(entryId, 1);
          return;
        }
        if (upgradeUpcomingStream(entryId, binding, result.streamUrl)) return;
      }
      applyLevel(entryId, decibelsToLevel(result.gainDb));
    });
  }

  /**
   * Swaps the upcoming entry to its normalized stream while it is still silent.
   * The engine receives stream and unity level together, replacing anything it
   * prepared; once a transition into the entry has begun, the measured gain is
   * applied to the original stream instead.
   */
  function upgradeUpcomingStream(entryId: string, binding: NormalizationBinding, streamUrl: string): boolean {
    const activeEngine = engineRef.current;
    const upcoming = upcomingEntryOf(stateRef.current);
    if (!activeEngine || upcoming?.entryId !== entryId) return false;
    const snapshot = activeEngine.getSnapshot();
    if (snapshot.key === entryId || snapshot.transition !== null) return false;
    sourceCacheRef.current.set(entryId, { url: streamUrl, normalized: true, loudness: binding.measurement });
    gainByEntryRef.current.set(entryId, 1);
    binding.normalized = true;
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
          : validLoudness(entry.track.loudness ?? entry.track.metadata?.loudness),
    };
    bindingsRef.current.set(entry.entryId, binding);
    applyLevel(entry.entryId, gainByEntryRef.current.get(entry.entryId) ?? initialLevel(entry, info));
    if (!replayGainEnabledRef.current || albumPlayback(entry.track) || info.normalized || importedGainDb(entry.track, previewUrl) !== undefined) {
      return;
    }
    requestEntryNormalization(entry.entryId, binding);
  }

  const changeNormalizationTarget = useCallback((value: number | string) => {
    const target = Number(value);
    if (!LOUDNESS_TARGETS.includes(target) || target === normalizationTargetRef.current) return;
    normalizationTargetRef.current = target;
    setNormalizationTarget(target);
    if (!replayGainEnabledRef.current) return;
    for (const [entryId, binding] of Array.from(bindingsRef.current.entries())) {
      if (albumPlayback(binding.song)) continue;
      const gain = loudnessGainDb(binding.measurement, target);
      if (typeof gain === "number" && Number.isFinite(gain)) applyLevel(entryId, decibelsToLevel(gain));
      else if (!binding.normalized) requestEntryNormalization(entryId, binding);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const abortNormalization = useCallback(() => {
    normalizationControllersRef.current.forEach((controller) => controller.abort());
    normalizationRequestsRef.current.clear();
  }, []);

  useEffect(() => () => abortNormalization(), [abortNormalization]);

  // Source and gain policy change together, preserving the live position and pause state.
  const previousProcessingRef = useRef({ normalization: isReplayGainEnabled, album: isAlbumAware, shuffle: isShuffleEnabled });
  useEffect(() => {
    replayGainEnabledRef.current = isReplayGainEnabled;
    const previous = previousProcessingRef.current;
    previousProcessingRef.current = { normalization: isReplayGainEnabled, album: isAlbumAware, shuffle: isShuffleEnabled };
    const normalizationChanged = previous.normalization !== isReplayGainEnabled;
    const albumChanged = previous.album !== isAlbumAware ||
      ((previous.album || isAlbumAware) && previous.shuffle !== isShuffleEnabled);
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
  }, [isReplayGainEnabled, isAlbumAware, isShuffleEnabled, abortNormalization]);

  useEffect(() => {
    for (const entry of [currentEntry, upcomingEntry]) if (entry) bindNormalization(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEntry, upcomingEntry, isReplayGainEnabled, isAlbumAware, isShuffleEnabled, streamQuality]);

  // Warm the next tracks while playing so their loudness is ready in time.
  useEffect(() => {
    if (!isAuthenticated || !isPlaying || !isReplayGainEnabled || currentIndex < 0) return undefined;
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
  const trimRequestsRef = useRef(new Map<string, string>());

  function getOrAnalyzeSilence(song: Song, parameters: { thresholdDb: number; minSilenceSeconds: number }) {
    const trackId = String(song.id);
    const key = JSON.stringify([trackId, parameters]);
    const pending = silenceAnalysisRequestsRef.current.get(key);
    if (pending) return pending;
    const request = (async () => {
      const saved = await getSilenceAnalysis(trackId, parameters);
      if (saved?.status === "completed") return saved;
      return analyzeSilence(trackId, parameters);
    })();
    silenceAnalysisRequestsRef.current.set(key, request);
    request
      .finally(() => {
        if (silenceAnalysisRequestsRef.current.get(key) === request) silenceAnalysisRequestsRef.current.delete(key);
      })
      .catch(() => {
        // The caller logs analysis failures.
      });
    return request;
  }

  /** Trailing silence is stored as a length; it becomes an end point once the duration is known. */
  function applyTrailingTrim(entryId: string, knownDuration: number): void {
    const bounds = trimByEntryRef.current.get(entryId);
    if (!bounds || bounds.trailing <= 0 || bounds.end !== null || !(knownDuration > bounds.trailing)) return;
    const end = knownDuration - bounds.trailing;
    trimByEntryRef.current.set(entryId, { ...bounds, end });
    engineRef.current?.updateTrack(entryId, { trimEnd: end });
  }

  useEffect(() => {
    const activeEngine = engineRef.current;
    if (!silenceTrimSettings.enabled) {
      for (const entryId of Array.from(trimByEntryRef.current.keys())) {
        activeEngine?.updateTrack(entryId, { trimStart: 0, trimEnd: null });
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
    for (const entry of [currentEntry, upcomingEntry]) {
      if (entry && albumPlayback(entry.track)) {
        trimByEntryRef.current.delete(entry.entryId);
        trimRequestsRef.current.delete(entry.entryId);
        activeEngine?.updateTrack(entry.entryId, { trimStart: 0, trimEnd: null });
        continue;
      }
      if (!entry || trimRequestsRef.current.get(entry.entryId) === parametersKey) continue;
      const { library, previewUrl } = songSource(entry.track);
      if (!library || previewUrl) continue;
      trimRequestsRef.current.set(entry.entryId, parametersKey);
      const { entryId } = entry;
      getOrAnalyzeSilence(entry.track, parameters)
        .then((analysis) => {
          const result = analysis as {
            status?: string;
            leadingSilenceSeconds?: number;
            trailingSilenceSeconds?: number;
            durationSeconds?: number | null;
          } | null;
          if (!mountedRef.current || trimRequestsRef.current.get(entryId) !== parametersKey) return;
          if (!result || result.status !== "completed") return;
          const leading = Math.max(0, Number(result.leadingSilenceSeconds) || 0);
          const trailing = Math.max(0, Number(result.trailingSilenceSeconds) || 0);
          trimByEntryRef.current.set(entryId, { leading, trailing, end: null });
          // Arriving after playback started skips the leading silence immediately.
          engineRef.current?.updateTrack(entryId, { trimStart: leading });
          const snapshot = engineRef.current?.getSnapshot();
          const knownDuration =
            Number(result.durationSeconds) > 0
              ? Number(result.durationSeconds)
              : snapshot?.key === entryId && snapshot.duration > 0
                ? snapshot.duration
                : 0;
          if (knownDuration > 0) applyTrailingTrim(entryId, knownDuration);
        })
        .catch((error: unknown) => {
          console.warn("Could not analyze silence for track:", entry.track.id, error);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [silenceTrimSettings, currentEntry, upcomingEntry, isAlbumAware, isShuffleEnabled]);

  // ------------------------------------------------------------ auto-refill

  // Once two or fewer tracks remain after the current one, append related
  // tracks in the background. One attempt per queue generation and position,
  // and appends are dropped if the queue was replaced meanwhile.
  const upcomingCount = currentIndex < 0 ? 0 : entries.length - currentIndex - 1;
  const refillAttemptRef = useRef("");
  useEffect(() => {
    if (!isAuthenticated || !isAutoplayEnabled || !isPlaying || currentIndex < 0) return;
    if (tasteExcludedEntriesRef.current.has(currentEntryOf(stateRef.current)?.entryId ?? "") || tasteProfileStore.getSnapshot().privateListening || tasteProfileStore.excludes(currentEntryOf(stateRef.current)?.track)) return;
    if (upcomingCount > REFILL_TRIGGER_UPCOMING) return;
    const attempt = `${generation}:${currentIndex}`;
    if (refillAttemptRef.current === attempt) return;
    refillAttemptRef.current = attempt;
    const needed = REFILL_TARGET_UPCOMING - upcomingCount;
    const feedbackVersion = feedbackVersionRef.current;
    const snapshot = stateRef.current;
    const seed = currentEntryOf(snapshot)?.track;
    if (!seed) return;
    Promise.resolve(autoplayTracksFor(seed, needed + 5, snapshot.entries.map((entry) => entry.track.id)))
      .then((nextSongs: unknown) => {
        const latest = stateRef.current;
        if (!mountedRef.current || !autoplayRef.current || latest.generation !== generation || feedbackVersionRef.current !== feedbackVersion || tasteProfileStore.getSnapshot().privateListening || tasteProfileStore.excludes(seed) || !Array.isArray(nextSongs)) return;
        const existing = new Set(latest.entries.map((entry) => String(entry.track.id)));
        const candidates = (nextSongs as Song[]).filter((song) => song?.id != null && !existing.has(String(song.id)));
        const additions = (shuffleEnabledRef.current && shuffleModeRef.current === "smart"
          ? smartShuffle(candidates, { ...smartShuffleOptionsRef.current(), currentTrack: currentEntryOf(latest)?.track }).tracks
          : candidates).slice(0, needed);
        if (additions.length) storeRef.current.append(additions, { dedupe: true, generation });
      })
      .catch((error: unknown) => {
        console.error("Could not refill queue:", error);
        if (mountedRef.current && stateRef.current.generation === generation) {
          setPlaybackMessage("Autoplay is unavailable. Your existing queue will keep playing.");
        }
      });
  }, [isAuthenticated, isAutoplayEnabled, isPlaying, currentIndex, upcomingCount, generation]);

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
    shuffleMode: shuffleModeRef.current, albumAware: isAlbumAware, volume, wasPlaying: isPlayingRef.current || restorePending,
    context: playbackContext ? { type: playbackContext.type, id: playbackContext.id, name: playbackContext.name, coverArt: playbackContext.coverArt } : null, capturedAt: Date.now() });
  const queueCheckpointRef = useRef(queueCheckpoint); queueCheckpointRef.current = queueCheckpoint;
  const applyQueuePreferences = (checkpoint: QueueCheckpoint) => {
    setIsShuffleEnabled(checkpoint.shuffle); shuffleEnabledRef.current = checkpoint.shuffle;
    shufflePreferenceVersionRef.current++; applyShuffleMode(checkpoint.shuffleMode);
    changeAlbumAware(checkpoint.albumAware); storeRef.current.setRepeatOne(checkpoint.repeatOne);
    changeVolume(checkpoint.volume); setPlaybackContext(checkpoint.context);
  };
  const persistedQueue = usePersistentQueue(store, { ownerId: localQueueOwner,
    checkpointKey: `${Math.floor(currentTime)}:${volume}:${isShuffleEnabled}:${isAlbumAware}:${shuffleMode}:${restorePending}`,
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
    queueSyncClient.activate(owner);
    queueSyncClient.bind(() => queuePersistenceRef.current.flush(), () => !followingAccountQueue.current);
    return () => { queueSyncClient.bind(null); queueSyncClient.activate(null); };
  }, [isAuthenticated, sessionId]);
  useEffect(() => {
    if (!isAuthenticated || !sessionId || hydratedQueueUserId !== sessionId || restorePending) return;
    void queueSyncClient.sync({ ifChanged: true }).catch(() => undefined);
  }, [isAuthenticated, sessionId, hydratedQueueUserId, isPlaying, restorePending, currentEntryId, isShuffleEnabled, queueState.repeatOne]);
  useEffect(() => {
    if (!engine || !isAuthenticated || !sessionId || hydratedQueueUserId !== sessionId || restorePending) return;
    let nextSync = performance.now() + 10_000;
    return engine.on("timeUpdate", ({ key }) => {
      if (!isPlayingRef.current || key !== currentEntryOf(stateRef.current)?.entryId) return;
      const now = performance.now();
      if (now < nextSync) return;
      nextSync = now + 10_000;
      void queueSyncClient.sync({ ifChanged: true }).catch(() => undefined);
    });
  }, [engine, isAuthenticated, sessionId, hydratedQueueUserId, restorePending]);
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

  const changeAlbumAware = useCallback((enabled: boolean) => {
    albumAwareRef.current = Boolean(enabled);
    albumPreferenceVersionRef.current++;
    setIsAlbumAware(Boolean(enabled));
    engineRef.current?.setAlbumAware(Boolean(enabled));
    writeStored("playerAlbumAware", String(Boolean(enabled)), "album-aware mode");
  }, []);

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
    engineRef.current?.setTransitionMode(engineTransitionMode(value));
    writeStored("playerTransitionMode", value, "transition mode");
  }, []);

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

  function changeVolume(value: number) {
    if (!Number.isFinite(Number(value))) return;
    const next = Math.max(0, Math.min(1, Number(value)));
    setVolume(next);
    engineRef.current?.setVolume(perceptualVolumeToGain(next));
    writeStored("playerVolume", String(next), "volume");
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

  function changeAutoplayEnabled(value: boolean) {
    const next = Boolean(value);
    setIsAutoplayEnabled(next);
    writeStored("playerAutoplayEnabled", String(next), "autoplay preference");
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
    if (full) {
      setSilenceTrimSettings((current) => ({
        enabled: Boolean(settings["playback.silenceTrim.enabled"]),
        thresholdDb: typeof settings["playback.silenceTrim.thresholdDb"] === "number"
          ? settings["playback.silenceTrim.thresholdDb"] as number
          : current.thresholdDb,
        minSilenceSeconds: typeof settings["playback.silenceTrim.minSilenceSeconds"] === "number"
          ? settings["playback.silenceTrim.minSilenceSeconds"] as number
          : current.minSilenceSeconds,
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
    if (!full) return;
    if (settings["ui.layoutDensity"] === "comfortable" || settings["ui.layoutDensity"] === "compact") {
      changeLayoutDensity(settings["ui.layoutDensity"] as string);
    }
    if (typeof settings["ui.autoOpenSidebar"] === "boolean") {
      changeAutoOpenSidebar(settings["ui.autoOpenSidebar"] as boolean);
    }
    if (typeof settings["playback.autoplay.enabled"] === "boolean") {
      changeAutoplayEnabled(settings["playback.autoplay.enabled"] as boolean);
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
    setHydratedQueueUserId(null);
    listeningSessionRef.current?.finish();
    engineRef.current?.pause();
    storeRef.current.stop();
    storeRef.current.setRepeatOne(false);
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
      } catch (error) {
        console.error("Could not load recently played:", error);
      }
    }

    void loadLikedSongs();
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
  }, [isAuthenticated, authIsLoading, sessionId, localQueueOwner, resetPlayer]);

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

  function mediaTracks(tracks: Song[], context: PlaybackContextInfo | null): Song[] {
    return tracks.map((track, trackIndex) => ({
      ...track,
      ...(context?.type === "playlist" && context.id ? { tastePlaylistId: String(context.id) } : {}),
      mediaResume: context?.id && (context.type === "album" || context.type === "playlist") && isLibraryPlayable(track) ? {
        type: context.type, mediaId: String(context.id), title: context.name,
        trackIndex, trackCount: tracks.length, occurrenceId: typeof track.playlistItemId === "string" ? track.playlistItemId : null,
      } : undefined,
    }));
  }

  function startQueue(tracks: Song[], startIndex: number, context: PlaybackContextInfo | null, smart = false, startAt = 0) {
    cancelRestoreResume();
    cuedPositionRef.current = null;
    setPlaybackContext(context);
    const albumPlaybackId = context?.type === "album" && !shuffleEnabledRef.current
      ? String(context.id || context.name || "album") : undefined;
    const items = tracks.map((track, albumTrackIndex) => ({
      ...track, albumPlaybackId,
      albumTrackIndex: albumPlaybackId ? (isMediaResumeContext(track.mediaResume) ? track.mediaResume.trackIndex : albumTrackIndex) : undefined,
    }));
    storeRef.current.setQueue(items, startIndex, smart ? { smartShuffle: smartShuffleOptionsRef.current(), startAt } : { startAt });
  }

  function startSelection(tracks: Song[], startIndex: number, context: PlaybackContextInfo | null, fromHere: boolean) {
    const allTracks = mediaTracks(tracks, context);
    const selected = fromHere ? allTracks.slice(startIndex) : allTracks;
    const index = fromHere ? 0 : startIndex;
    const ordered = isShuffleEnabled && shuffleModeRef.current === "standard"
      ? shuffleUpcoming(selected, index, randomValues(selected.length - index - 2))
      : selected;
    startQueue(ordered, index, context, isShuffleEnabled && shuffleModeRef.current === "smart");
  }

  function playOnActiveDevice(tracks: Song[], startIndex: number, context: PlaybackContextInfo | null, fromHere = false) {
    if (!remotePlayer && (!orderedLocalControls || tracks.length > 1000)) return null;
    if (tracks.some(track => track.offlineOnly || songSource(track).source)) {
      if (!remotePlayer) return null;
      setPlaybackMessage("Choose this device in Devices to play a device-only track or source.");
      return Promise.resolve();
    }
    remote.clearError();
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
      context: context ? {
        type: String(context.type ?? "").slice(0, 80),
        id: String(context.id ?? "").slice(0, 1024),
        name: String(context.name ?? "").slice(0, 500),
        coverArt: typeof context.coverArt === "string" ? context.coverArt.slice(0, 2048) : null,
      } : null,
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
      if (orderedLocalControls) return toggleSelectedPlayback();
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

  async function playContext(tracks: Song[], startIndex = 0, context: PlaybackContextInfo | null = null) {
    if (!Array.isArray(tracks) || tracks.length === 0) return;
    const safeStart = Number.isInteger(startIndex) && startIndex >= 0 && startIndex < tracks.length ? startIndex : 0;
    const remoteSelection = playOnActiveDevice(tracks, safeStart, context, true);
    if (remoteSelection) return remoteSelection;
    startSelection(tracks, safeStart, context, true);
  }

  async function playQueue(songs: Song[], startIndex = 0, context: PlaybackContextInfo | null = null) {
    if (!Array.isArray(songs) || songs.length === 0) return;
    const safeStart = Number.isInteger(startIndex) && startIndex >= 0 && startIndex < songs.length ? startIndex : 0;
    const remoteSelection = playOnActiveDevice(songs, safeStart, context);
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
    startQueue(mediaTracks(songs, context), index, context, false, positionSeconds);
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

  async function nextSong() {
    const state = stateRef.current;
    if (state.currentIndex < 0) return;
    cancelRestoreResume();
    if (state.currentIndex + 1 < state.entries.length) {
      storeRef.current.playNext();
      return;
    }
    listeningSessionRef.current?.finish();
    await continueAfterQueueEnd();
  }

  /** Restarts the current entry; a restart is a new listening session. */
  function restartCurrent(entry: QueueEntry<Song>) {
    listeningSessionRef.current?.finish();
    const start = trimByEntryRef.current.get(entry.entryId)?.leading ?? 0;
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
    if (isPlayingRef.current && !isPreviewRef.current && isLibraryPlayable(entry.track)) {
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
    if (!enable) return;
    if (shuffleModeRef.current === "smart") storeRef.current.smartShuffleUpcoming(smartShuffleOptionsRef.current());
    else storeRef.current.shuffleUpcoming(randomValues(entryCount - index - 2));
  }

  function toggleShuffle() {
    const state = stateRef.current;
    toggleShuffleForQueue(state.entries.length, state.currentIndex);
  }

  function setRepeatOne(enabled: boolean) {
    if (enabled) {
      loopPlaylistRef.current = null;
      setLoopPlaylistId(null);
    }
    storeRef.current.setRepeatOne(enabled);
  }

  function toggleLoop() {
    setRepeatOne(!stateRef.current.repeatOne);
  }

  function togglePlaylistLoop(playlistId: string) {
    const next = loopPlaylistRef.current === playlistId ? null : playlistId;
    if (next) storeRef.current.setRepeatOne(false);
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
    const context = playbackContext ? { type: playbackContext.type, id: playbackContext.id,
      name: playbackContext.name.slice(0, 500), coverArt: playbackContext.coverArt } : null;
    // Keep the current occurrence in the published window even for very large queues.
    const offset = Math.max(0, currentIndex - 4999);
    return {
      entries: entries.slice(offset, offset + 5000).map((item) => ({ occurrenceId: item.entryId, trackId: String(item.track.id),
          title: String(item.track.title || "").slice(0, 500), artist: String(item.track.artist || item.track.artistName || "").slice(0, 500), album: String(item.track.album || item.track.albumName || "").slice(0, 500),
          duration: songDurationHint(item.track) || 0,
          ...(item.track.albumPlaybackId ? { albumPlaybackId: String(item.track.albumPlaybackId), albumTrackIndex: Number(item.track.albumTrackIndex) || 0 } : {}),
          ...(isMediaResumeContext(item.track.mediaResume) ? { resume: {
            type: item.track.mediaResume.type, mediaId: item.track.mediaResume.mediaId, title: item.track.mediaResume.title,
            trackIndex: item.track.mediaResume.trackIndex, trackCount: item.track.mediaResume.trackCount, occurrenceId: item.track.mediaResume.occurrenceId,
          } } : {}),
        })),
      index: Math.max(0, currentIndex - offset), repeatOne: queueState.repeatOne, shuffle: isShuffleEnabled,
      shuffleMode, shuffleSeed: queueState.shuffleSeed, albumAware: isAlbumAware, context,
    };
  }, [entries, currentIndex, queueState.repeatOne, queueState.shuffleSeed, isShuffleEnabled, shuffleMode, isAlbumAware, playbackContext]);

  function captureRemotePlayback(): RemotePlaybackSnapshot {
    if (engineRef.current?.isRemoteOutput) throw new Error("Stop Google Cast before transferring playback to another device.");
    const state = stateRef.current;
    const entry = currentEntryOf(state);
    if (!entry || state.entries.length > 5000 || state.entries.some((item) => !isLibraryPlayable(item.track) ||
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
      engineRef.current?.pause();
    },
    command: async (command) => {
      const activeEngine = engineRef.current;
      if (!activeEngine) throw new Error("The playback engine is not ready");
      if (activeEngine.isRemoteOutput) throw new Error("Control this receiver from its Google Cast sender, or stop Cast before using device control.");
      if (command.type === "SET_VOLUME") { flushSync(() => changeVolume(command.volume)); return; }
      if (command.type === "PLAY_SELECTION") {
        if (remote.isRemote) throw new Error("The active player changed. Try playing the selection again.");
        const tracks = command.tracks.map(sanitizeQueueTrack);
        const selected = tracks[command.start_index];
        if (!selected) throw new Error("The selected track is missing from the queue.");
        const reason = unplayableReasonFor(selected);
        if (reason) throw new Error(reason);
        flushSync(() => startSelection(tracks, command.start_index, command.context, command.from_here));
        return;
      }
      if (!currentEntryOf(stateRef.current)) throw new Error("The selected device has no loaded queue");
      if (command.type === "TOGGLE_SHUFFLE") { flushSync(toggleShuffle); return; }
      if (command.type === "TOGGLE_REPEAT") { flushSync(toggleLoop); return; }
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
        if (command.type === "PLAY_QUEUE_ENTRY") { await flushSync(() => playQueueSong(index)); return; }
        const target = state.entries.findIndex(entry => entry.entryId === command.target_id);
        if (index <= state.currentIndex || target <= state.currentIndex) throw new Error("Only upcoming tracks can be moved.");
        flushSync(() => moveQueueItem(index, target));
        return;
      }
      if (command.type === "PAUSE") flushSync(() => activeEngine.pause());
      else if (command.type === "PLAY") {
        if (!engineHasLoaded(currentEntryId)) { flushSync(togglePlay); return; }
        await activeEngine.play();
        if (activeEngine.getSnapshot().state !== "playing") throw new Error(PLAYBACK_BLOCKED_MESSAGE);
      } else if (command.type === "SKIP") {
        await flushSync(command.direction === "next" ? nextSong : previousSong);
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
      const selected = await getListeningTrack(snapshot.trackId);
      if (signal.aborted) throw new Error("Transfer cancelled");
      if (!selected?.id || String(selected.id) !== snapshot.trackId || !isLibraryPlayable({ ...selected, id: selected.id })) {
        throw new Error("The target cannot access this library track");
      }
      activeEngine.pause();
      cancelRestoreResume();
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
      shuffleEnabledRef.current = queue.shuffle; setIsShuffleEnabled(queue.shuffle);
      shuffleModeRef.current = queue.shuffleMode; setShuffleMode(queue.shuffleMode);
      changeAlbumAware(queue.albumAware);
      setPlaybackContext(queue.context);
      const previousGeneration = stateRef.current.generation;
      storeRef.current.setQueue(tracks, queue.index, { autoplay: false, startAt: snapshot.exactPositionMs / 1000, shuffleSeed: queue.shuffleSeed });
      storeRef.current.setRepeatOne(queue.repeatOne);
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const timer = window.setInterval(() => {
          const entry = currentEntryOf(stateRef.current);
          const actual = activeEngine.getSnapshot();
          if (signal.aborted || Date.now() - started > 12000) {
            window.clearInterval(timer); reject(new Error(signal.aborted ? "Transfer cancelled" : "The target could not buffer this track in time")); return;
          }
          if (stateRef.current.generation <= previousGeneration) return;
          if (entry?.track.remoteOccurrenceId !== queue.entries[queue.index].occurrenceId ||
              stateRef.current.entries.length !== queue.entries.length ||
              stateRef.current.entries.some((item, index) => item.track.remoteOccurrenceId !== queue.entries[index].occurrenceId)) {
            window.clearInterval(timer); reject(new Error("The target queue changed during preparation")); return;
          }
          if (actual.key !== entry.entryId) return;
          if (actual.state === "error" || stateRef.current.lastError) {
            window.clearInterval(timer); reject(new Error(stateRef.current.lastError || "The target could not load this stream")); return;
          }
          if (activeEngine.isReadyForResume() && actual.duration > 0 && Math.abs(actual.position - snapshot.exactPositionMs / 1000) < .25) {
            window.clearInterval(timer); resolve();
          }
        }, 40);
      });
    },
    start: async (snapshot) => {
      const activeEngine = engineRef.current;
      if (!activeEngine) throw new Error("The playback engine is not ready");
      const entry = currentEntryOf(stateRef.current);
      if (entry?.track.remoteOccurrenceId !== snapshot.queueState.entries[snapshot.queueState.index].occurrenceId ||
          stateRef.current.entries.length !== snapshot.queueState.entries.length ||
          stateRef.current.entries.some((item, index) => item.track.remoteOccurrenceId !== snapshot.queueState.entries[index].occurrenceId) ||
          stateRef.current.currentIndex !== snapshot.queueState.index ||
          stateRef.current.repeatOne !== snapshot.queueState.repeatOne) throw new Error("The target queue changed during handoff");
      activeEngine.seek(snapshot.exactPositionMs / 1000);
      changeVolume(snapshot.volume);
      setCurrentTime(snapshot.exactPositionMs / 1000);
      if (snapshot.playing) {
        await activeEngine.play();
        if (activeEngine.getSnapshot().state !== "playing") { activeEngine.pause(); throw new Error(PLAYBACK_BLOCKED_MESSAGE); }
      }
    },
  };
  const remote = useRemoteSession(isAuthenticated ? sessionId : null, remoteAdapter);
  const controlRemote = async (command: Parameters<typeof remote.command>[0]): Promise<void> => {
    try { await remote.command(command); }
    catch (failure: unknown) {
      console.error("Could not control the remote player:", failure);
      setPlaybackMessage(failure instanceof Error ? failure.message : "Remote playback command failed");
    }
  };
  // The selected device also goes through the hub so its controls are ordered
  // with commands from controllers. Offline and Cast playback stay local.
  const orderedLocalControls = remote.ordersCommands && remote.status === "connected" &&
    remote.activeDevice?.device_id === remote.deviceId && !engineRef.current?.isRemoteOutput && !cast.connected;
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
  remoteRegistryReady.current = remote.status === "connected";
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
    if (remote.status === "connected") restoreRef.current?.resumeWhenReady?.();
  }, [cancelRestoreResume, remote.activeDevice?.device_id, remote.deviceId, remote.isRemote, remote.status]);

  const localHead = persistedQueue.getHead();
  const suppressedRestore = suppressedRestoreRevision.current === queueState.revision;
  const accountQueue = useAccountQueue({
    owner: isAuthenticated && hydratedQueueUserId === sessionId ? sessionId : null,
    localCapturedAt: suppressedRestore ? restoredCheckpointTime.current : localHead?.checkpoint.capturedAt ?? 0,
    followPaused: !isPlaying && !castRendering && !restorePending && !preferLocalQueue && (!entries.length || Boolean(localHead)),
    activeDevice: remotePlayer,
    status: remote.status,
  });
  followingAccountQueue.current = !isPlaying && Boolean(remotePlayer || accountQueue || suppressedRestore);
  const accountTracks = useMemo(() => accountQueue?.content.entries.map(entry => entry.track as Song), [accountQueue?.content]);
  const accountIndex = accountQueue?.checkpoint.index ?? -1;
  const liveQueueState = liveRemote?.queue;
  const liveTracks = useMemo(() => liveQueueState?.entries.map((entry): Song => ({
    id: entry.trackId, title: entry.title, artist: entry.artist, album: entry.album, duration: entry.duration,
    mediaResume: entry.resume,
  })), [liveQueueState]);
  const accountSong = accountTracks?.[accountIndex] ?? liveTracks?.[liveQueueState?.index ?? -1];
  const pausedAccountQueue = remotePlayer ? null : accountQueue;
  const queueOccurrenceAt = (index: number) => liveQueueState
    ? liveQueueState.entries[index]?.occurrenceId
    : remotePlayer ? accountQueue?.content.entries[index]?.entryId : stateRef.current.entries[index]?.entryId;
  const orderedSeek = orderedLocalControls && engineHasLoaded(currentEntryId) && duration > 0;
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
    } : null)
      : accountQueue ? accountSong ?? null : currentSong,
    activeSidebar,
    setActiveSidebar,
    autoOpenSidebar,
    isAutoplayEnabled,
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
    isLooping: liveQueueState?.repeatOne ?? accountQueue?.checkpoint.repeatOne ?? (!remotePlayer && queueState.repeatOne),
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
    playQueue,
    resumeMedia,
    playQueueSong: remotePlayer || orderedLocalControls ? async (index) => {
      const entry_id = queueOccurrenceAt(index);
      if (entry_id) await controlRemote({ type: "PLAY_QUEUE_ENTRY", entry_id });
    } : pausedAccountQueue ? async (index) => takeAccountQueue(index, true) : playQueueSong,
    moveQueueItem: remotePlayer || orderedLocalControls ? (from, to) => {
      const entry_id = queueOccurrenceAt(from), target_id = queueOccurrenceAt(to);
      if (entry_id && target_id) void controlRemote({ type: "MOVE_QUEUE_ENTRY", entry_id, target_id });
    } : pausedAccountQueue ? (from, to) => { takeAccountQueue(); moveQueueItem(from, to); } : moveQueueItem,
    nextSong: remotePlayer || orderedLocalControls ? () => controlRemote({ type: "SKIP", direction: "next" }) : pausedAccountQueue ? async () => takeAccountQueue(accountIndex + 1) : nextSong,
    previousSong: remotePlayer || orderedLocalControls ? () => controlRemote({ type: "SKIP", direction: "previous" }) : pausedAccountQueue ? async () => takeAccountQueue(accountIndex - 1) : previousSong,
    toggleShuffle: remotePlayer || orderedLocalControls ? () => controlRemote({ type: "TOGGLE_SHUFFLE" }) : pausedAccountQueue ? () => {
      takeAccountQueue();
      toggleShuffleForQueue(pausedAccountQueue.content.entries.length, accountIndex);
    } : toggleShuffle,
    toggleLoop: remotePlayer || orderedLocalControls ? () => controlRemote({ type: "TOGGLE_REPEAT" }) : pausedAccountQueue ? () => {
      takeAccountQueue();
      setRepeatOne(!pausedAccountQueue.checkpoint.repeatOne);
    } : toggleLoop,
    loopPlaylistId,
    togglePlaylistLoop,
    togglePlay: remotePlayer || orderedLocalControls ? toggleSelectedPlayback
      : pausedAccountQueue ? () => takeAccountQueue(accountIndex, true) : togglePlay,
    toggleLike: remoteTrack ? () => toggleLikeSong({ id: remoteTrack.id, title: remoteTrack.title }) : accountSong ? () => toggleLikeSong(accountSong) : toggleLike,
    toggleLikeSong,
    setTrackFavorite,
    seek: remotePlayer || orderedSeek ? (percent) => seekSelectedPlayer(percent / 100 * (remotePlayer ? remotePlayer.duration_ms / 1000 : duration))
      : pausedAccountQueue ? (percent) => takeAccountQueue(accountIndex, false, percent / 100 * (songDurationHint(accountSong) ?? 0)) : seek,
    seekToSeconds: remotePlayer || orderedSeek ? seekSelectedPlayer : pausedAccountQueue ? (seconds) => {
      if (Number.isFinite(seconds)) takeAccountQueue(accountIndex, false, Math.max(0, seconds));
    } : seekToSeconds,
    changeVolume: remotePlayer || orderedLocalControls ? (value) => {
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
    changeAutoplayEnabled,
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
          togglePlay: value.togglePlay, toggleLikeSong, playContext, playSongFromSource,
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
