import {
  createContext,
  useContext,
  useRef,
  useState,
  useEffect,
  useCallback,
} from "react";

import {
  getStreamUrl,
  getRecentlyPlayed,
  getStarred,
  reportPlaybackSession,
  getListeningConfig,
  LISTENING_ACTIVITY_CHANGED_EVENT,
  starSong,
  unstarSong,
  getRandomSongs,
  getUserSettings,
  getSilenceAnalysis,
  analyzeSilence,
  USER_SETTINGS_CHANGED_EVENT,
} from "../api/musicdeck";

import {
  useAuth,
} from "./AuthContext";
import {
  DEFAULT_ACCENT_COLOR,
  normalizeAccentColor,
} from "../utils/accentColors";
import { trustedPreviewUrl } from "../utils/previewPlayback";
import { createQueueSnapshot, queueStorageKey, readQueueSnapshot } from "../utils/queuePersistence";
import { createListeningTracker } from "../utils/listeningTracker";


const PlayerContext =
  createContext(null);

const VALID_SIDEBARS = new Set(["none", "now-playing", "queue"]);
const MAX_RECENTLY_PLAYED = 50;

function normalizeSidebar(value) {
  return VALID_SIDEBARS.has(value) ? value : "none";
}

function cancelFadeFrame(frameId) {
  if (frameId === null) return;
  if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frameId);
  else window.clearTimeout(frameId);
}

function normalizeRecentlyPlayed(value) {
  return Array.isArray(value)
    ? value.filter((song) => {
        const playedAt = Date.parse(song?.playedAt);
        return Number.isFinite(playedAt);
      }).slice(0, MAX_RECENTLY_PLAYED)
    : [];
}


export function PlayerProvider({
  children,
}) {

  const audioRef =
    useRef(null);

  const primaryAudioRef =
    useRef(null);

  const secondaryAudioRef =
    useRef(null);

  const volumeRef =
    useRef(1);

  const crossfadeDurationRef =
    useRef(0);

  const crossfadeFrameRef =
    useRef(null);

  const crossfadeTokenRef =
    useRef(0);

  const isCrossfadingRef =
    useRef(false);

  const isTransitioningRef =
    useRef(false);

  const deckGainRef =
    useRef(new Map());



  const {
    isAuthenticated,
    isLoading: authIsLoading,
    session,
  } = useAuth();
  const playbackRequestRef =
    useRef(0);
  const audioRequestIdsRef = useRef(new WeakMap());
  const listeningSessionRef = useRef(null);
  const trackingUserRef = useRef(null);
  trackingUserRef.current = isAuthenticated ? session?.id : null;
  useEffect(() => {
    if (!isAuthenticated || !session?.id) return undefined;
    const tracker = createListeningTracker({
      userId: session.id, storage: window.sessionStorage,
      report: reportPlaybackSession,
    });
    listeningSessionRef.current = tracker;
    getListeningConfig().then((config) => tracker.setThreshold(config.thresholdSeconds))
      .catch((error) => console.error("Could not load listening threshold; using 30 seconds:", error));
    const flush = () => tracker.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      if (trackingUserRef.current !== session.id) tracker.finish();
      tracker.suspend();
      window.removeEventListener("pagehide", flush);
      if (listeningSessionRef.current === tracker) listeningSessionRef.current = null;
    };
  }, [isAuthenticated, session?.id]);
  const pendingRestoreSeekRef = useRef(null);
  const restoreRequestRef = useRef(null);
  const resumeListenerCleanupRef = useRef(null);
  const queueStorageKeyRef = useRef(null);
  const [hydratedQueueUserId, setHydratedQueueUserId] = useState(null);
  const [restorePending, setRestorePending] = useState(false);

  /*
   * CURRENT SONG
   */

  const [
    currentSong,
    setCurrentSong,
  ] = useState(null);


  const [
    activeSidebar,
    setActiveSidebarState,
  ] = useState("none");

  const setActiveSidebar = useCallback((nextSidebar) => {
    setActiveSidebarState((currentSidebar) => normalizeSidebar(
      typeof nextSidebar === "function"
        ? nextSidebar(currentSidebar)
        : nextSidebar
    ));
  }, []);


  const [
    autoOpenSidebar,
    setAutoOpenSidebar,
  ] = useState(() => {
    try {
      return localStorage.getItem("playerAutoOpenSidebar") === "true";
    } catch (error) {
      console.error("Could not load auto-open sidebar preference:", error);
      return false;
    }
  });


  const [
    isAutoplayEnabled,
    setIsAutoplayEnabled,
  ] = useState(() => {
    try {
      const saved = localStorage.getItem("playerAutoplayEnabled");
      return saved === null ? true : saved === "true";
    } catch (error) {
      console.error("Could not load autoplay preference:", error);
      return true;
    }
  });


  const [
    autoDownloadLiked,
    setAutoDownloadLiked,
  ] = useState(() => {
    try {
      return localStorage.getItem("playerAutoDownloadLiked") === "true";
    } catch (error) {
      console.error("Could not load auto-download preference:", error);
      return false;
    }
  });


  const [
    isPlaying,
    setIsPlaying,
  ] = useState(false);


  const [
    currentTime,
    setCurrentTime,
  ] = useState(0);


  const [
    duration,
    setDuration,
  ] = useState(0);


  /*
   * QUEUE
   *
   * queue contains the current song
   * plus upcoming songs.
   *
   * queueIndex points to current song.
   */

  const [
    queue,
    setQueue,
  ] = useState([]);


  const [
    queueIndex,
    setQueueIndex,
  ] = useState(-1);


  const [
    isShuffleEnabled,
    setIsShuffleEnabled,
  ] = useState(false);


  const [
    isLooping,
    setIsLooping,
  ] = useState(false);


  /*
   * RECENTLY PLAYED
   */

  const [
    recentlyPlayed,
    setRecentlyPlayed,
  ] = useState([]);


  /*
   * LIKED SONGS
   *
   * Navidrome is the source of truth.
   */

  const [
    likedSongIds,
    setLikedSongIds,
  ] = useState(
    () => new Set()
  );


  const [
    isCurrentSongLiked,
    setIsCurrentSongLiked,
  ] = useState(false);


  /*
   * VOLUME
   */

  const [
    volume,
    setVolume,
  ] = useState(() => {

    try {

      const saved =
        localStorage.getItem(
          "playerVolume"
        );

      if (saved !== null) {

        const value =
          Number(saved);

        if (
          !Number.isNaN(value) &&
          value >= 0 &&
          value <= 1
        ) {

          return value;

        }

      }

    } catch (error) {

      console.error(
        "Could not load volume:",
        error
      );

    }

    return 1;

  });


  const [
    crossfadeDuration,
    setCrossfadeDuration,
  ] = useState(() => {

    try {

      const saved =
        localStorage.getItem(
          "playerCrossfadeDuration"
        );

      const value =
        Number(saved);

      if (
        saved !== null &&
        Number.isFinite(value)
      ) {

        return Math.max(
          0,
          Math.min(12, value)
        );

      }

    } catch (error) {

      console.error(
        "Could not load crossfade duration:",
        error
      );

    }

    return 0;

  });


  const [
    layoutDensity,
    setLayoutDensity,
  ] = useState(() => {
    try {
      return localStorage.getItem("playerLayoutDensity") === "compact"
        ? "compact"
        : "comfortable";
    } catch (error) {
      console.error("Could not load layout density:", error);
      return "comfortable";
    }
  });

  const [accentColor, setAccentColor] = useState(() => {
    try {
      return normalizeAccentColor(localStorage.getItem("playerAccentColor"));
    } catch (error) {
      console.error("Could not load accent color:", error);
      return DEFAULT_ACCENT_COLOR;
    }
  });

  useEffect(() => {
    document.documentElement.style.setProperty("--color-accent", accentColor);
  }, [accentColor]);


  const [
    streamQuality,
    setStreamQuality,
  ] = useState(() => {
    try {
      const saved = localStorage.getItem("playerStreamQuality");
      return ["128", "320", "original"].includes(saved)
        ? saved
        : "original";
    } catch (error) {
      console.error("Could not load streaming quality:", error);
      return "original";
    }
  });

  const streamQualityRef = useRef(streamQuality);

  const [downloadQuality, setDownloadQuality] = useState(() => {
    try {
      const saved = localStorage.getItem("playerDownloadQuality");
      return ["lossless", "320kbps", "256kbps", "192kbps", "128kbps"].includes(saved)
        ? saved
        : "320kbps";
    } catch (error) {
      console.error("Could not load download quality:", error);
      return "320kbps";
    }
  });


  const [
    isReplayGainEnabled,
    setIsReplayGainEnabled,
  ] = useState(() => {
    try {
      return localStorage.getItem("playerReplayGainEnabled") === "true";
    } catch (error) {
      console.error("Could not load ReplayGain preference:", error);
      return false;
    }
  });

  const isReplayGainEnabledRef = useRef(isReplayGainEnabled);


  /*
   * SILENCE TRIMMING
   *
   * Per-user preference, loaded once on auth. Actual trim bounds for the
   * currently loaded track are fetched lazily and applied at playback time;
   * a missing/failed analysis simply falls back to playing the full track.
   */

  const [
    silenceTrimSettings,
    setSilenceTrimSettings,
  ] = useState({ enabled: false, thresholdDb: -35, minSilenceSeconds: 0.5 });

  const trimBoundsRef = useRef(null);
  const silenceAnalysisRequestsRef = useRef(new Map());

  /*
   * PLAYBACK CONTEXT
   *
   * What the current queue was started from (e.g. a playlist), so the player
   * can show where playback is coming from using that item's own resolved
   * artwork.
   */

  const [
    playbackContext,
    setPlaybackContext,
  ] = useState(null);

  /*
   * EXTERNAL PREVIEW PLAYBACK
   *
   * A track that is not in the local library can still be auditioned when an
   * external source provides a preview. Resolution goes through the
   * provider-neutral PlayableSource model, so the player never knows (or
   * hard-codes) which provider supplied the preview. `previewSource` is set
   * only while a preview — rather than a full track — is loaded.
   */

  const [
    previewSource,
    setPreviewSource,
  ] = useState(null);

  const [
    playbackUnavailable,
    setPlaybackUnavailable,
  ] = useState(false);

  const [playbackMessage, setPlaybackMessage] = useState("");
  const progressSecond = Math.floor(currentTime);

  useEffect(() => {
    const handleServerDeletion = (event) => {
      const ids = new Set((event.detail?.trackIds || []).map(String));
      if (!ids.size || !queue.some((song) => ids.has(String(song.id)))) return;
      const remaining = queue.filter((song) => !ids.has(String(song.id)));
      if (currentSong && ids.has(String(currentSong.id))) {
        playbackRequestRef.current += 1;
        audioRef.current?.pause();
        listeningSessionRef.current?.finish();
        setCurrentSong(null);
        setIsPlaying(false);
        setCurrentTime(0);
        setDuration(0);
        setPlaybackContext(null);
        setQueue(remaining);
        setQueueIndex(-1);
      } else {
        const removedBefore = queue.slice(0, queueIndex + 1).filter((song) => ids.has(String(song.id))).length;
        setQueue(remaining);
        setQueueIndex(Math.max(-1, queueIndex - removedBefore));
      }
    };
    window.addEventListener("musicdeck:server-deleted", handleServerDeletion);
    return () => window.removeEventListener("musicdeck:server-deleted", handleServerDeletion);
  }, [queue, queueIndex, currentSong]);

  const cancelRestoreResume = useCallback(() => {
    resumeListenerCleanupRef.current?.();
    resumeListenerCleanupRef.current = null;
    restoreRequestRef.current = null;
    setRestorePending(false);
  }, []);

  function attemptRestoredPlayback(activeAudio, requestId) {
    if (restoreRequestRef.current?.requestId !== requestId || audioRef.current !== activeAudio) return;

    let playPromise;
    try {
      // Call play synchronously from the click/keydown handler to retain user activation.
      playPromise = activeAudio.play();
    } catch (error) {
      playPromise = Promise.reject(error);
    }

    Promise.resolve(playPromise).then(() => {
      if (restoreRequestRef.current?.requestId !== requestId) return;
      resumeListenerCleanupRef.current?.();
      resumeListenerCleanupRef.current = null;
      restoreRequestRef.current = null;
      setRestorePending(false);
      setIsPlaying(true);
    }).catch((error) => {
      if (restoreRequestRef.current?.requestId !== requestId) return;
      setIsPlaying(false);
      setRestorePending(false);

      if (error?.name !== "NotAllowedError" && error?.name !== "AbortError") {
        restoreRequestRef.current = null;
        return;
      }

      if (resumeListenerCleanupRef.current) return;
      const retry = () => {
        resumeListenerCleanupRef.current?.();
        resumeListenerCleanupRef.current = null;
        attemptRestoredPlayback(activeAudio, requestId);
      };
      window.addEventListener("click", retry, { once: true });
      window.addEventListener("keydown", retry, { once: true });
      resumeListenerCleanupRef.current = () => {
        window.removeEventListener("click", retry);
        window.removeEventListener("keydown", retry);
      };
    });
  }

  useEffect(() => {
    if (!isAuthenticated || !session?.id) return;
    const key = queueStorageKey(session.id);
    queueStorageKeyRef.current = key;
    const saved = readQueueSnapshot(localStorage, session.id);
    if (saved) {
      setQueue(saved.queueItems);
      setQueueIndex(saved.queueIndex);
      const song = saved.queueIndex >= 0 ? saved.queueItems[saved.queueIndex] : null;
      setCurrentSong(song);
      setCurrentTime(song ? saved.playbackProgressSeconds : 0);
      setDuration(song?.duration || song?.metadata?.durationSeconds || 0);
      setIsShuffleEnabled(saved.shuffleEnabled);
      setIsLooping(saved.repeatMode === "one");
      setVolume(saved.volume);
      volumeRef.current = saved.volume;

      if (song && saved.wasPlaying) {
        const activeAudio = primaryAudioRef.current;
        audioRef.current = activeAudio;
        const requestId = ++playbackRequestRef.current;
        restoreRequestRef.current = { requestId };
        setRestorePending(true);
        pendingRestoreSeekRef.current = saved.playbackProgressSeconds;
        activeAudio.volume = saved.volume;

        const loadRestoredSource = async () => {
          const localTrack = isLibraryPlayable(song);
          const source = localTrack ? song.playableSource || song.sourceId || null : null;
          const previewUrl = localTrack ? null : trustedPreviewUrl(song.previewUrl);
          if (restoreRequestRef.current?.requestId !== requestId) return;
          if (!localTrack && !previewUrl) {
            cancelRestoreResume();
            return;
          }
          const restoredPreview = previewUrl ? { type: "preview", quality: { durationSeconds: 30 } } : null;
          setPreviewSource(restoredPreview);
          previewSourceRef.current = restoredPreview;
          activeAudio.src = previewUrl || getStreamUrl(song.id, source, streamQualityRef.current);
          audioRequestIdsRef.current.set(activeAudio, { requestId, src: activeAudio.src });
        };
        loadRestoredSource().catch(() => {
          if (restoreRequestRef.current?.requestId === requestId) cancelRestoreResume();
        });
      }
    }
    setHydratedQueueUserId(session.id);
  }, [isAuthenticated, session?.id, cancelRestoreResume]);

  useEffect(() => {
    if (!isAuthenticated || !session?.id || hydratedQueueUserId !== session.id || restorePending) return;
    const snapshot = createQueueSnapshot({
      currentSong, queue, queueIndex, isShuffleEnabled, isLooping, volume, currentTime: progressSecond, wasPlaying: isPlaying,
    });
    try {
      localStorage.setItem(queueStorageKey(session.id), JSON.stringify(snapshot));
    } catch (error) {
      console.error("Could not save playback queue:", error);
    }
  }, [isAuthenticated, session?.id, hydratedQueueUserId, currentSong, queue, queueIndex, isShuffleEnabled, isLooping, volume, progressSecond, isPlaying, restorePending]);

  useEffect(() => {
    if (!isAuthenticated || !session?.id || hydratedQueueUserId !== session.id) return undefined;
    const saveBeforeUnload = () => {
      const snapshot = createQueueSnapshot({
        currentSong, queue, queueIndex, isShuffleEnabled, isLooping, volume,
        currentTime: audioRef.current?.currentTime || currentTime,
        wasPlaying: isPlaying || restorePending,
      });
      try {
        localStorage.setItem(queueStorageKey(session.id), JSON.stringify(snapshot));
      } catch (error) {
        console.error("Could not save playback queue:", error);
      }
    };
    window.addEventListener("pagehide", saveBeforeUnload);
    return () => window.removeEventListener("pagehide", saveBeforeUnload);
  }, [isAuthenticated, session?.id, hydratedQueueUserId, currentSong, queue, queueIndex, isShuffleEnabled, isLooping, volume, currentTime, isPlaying, restorePending]);

  useEffect(() => () => {
    resumeListenerCleanupRef.current?.();
    resumeListenerCleanupRef.current = null;
    restoreRequestRef.current = null;
  }, []);

  /* Mirrors previewSource for the timeupdate handler's end-of-preview check. */
  const previewSourceRef = useRef(null);

  useEffect(() => {
    if (isPlaying && currentSong && !previewSourceRef.current && isLibraryPlayable(currentSong)) {
      listeningSessionRef.current?.begin(currentSong, audioRef.current);
    }
  }, [isPlaying, currentSong]);

  useEffect(() => {
    if (!playbackMessage) return undefined;
    const timeout = window.setTimeout(() => setPlaybackMessage(""), 4200);
    return () => window.clearTimeout(timeout);
  }, [playbackMessage]);

  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = primaryAudioRef.current;
    }
  }, []);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => {
    crossfadeDurationRef.current = crossfadeDuration;
  }, [crossfadeDuration]);

  useEffect(() => {
    streamQualityRef.current = streamQuality;
  }, [streamQuality]);

  useEffect(() => {
    isReplayGainEnabledRef.current = isReplayGainEnabled;
  }, [isReplayGainEnabled]);

  useEffect(() => {
    document.documentElement.dataset.layoutDensity = layoutDensity;

    return () => {
      delete document.documentElement.dataset.layoutDensity;
    };
  }, [layoutDensity]);

  useEffect(() => () => {
    crossfadeTokenRef.current += 1;
    isCrossfadingRef.current = false;

    cancelFadeFrame(crossfadeFrameRef.current);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    let cancelled = false;

    getUserSettings()
      .then((settings) => {
        if (cancelled || !Array.isArray(settings)) {
          return;
        }

        const map = {};
        for (const setting of settings) {
          try {
            map[setting.key] = JSON.parse(setting.value);
          } catch {
            map[setting.key] = setting.value;
          }
        }

        setSilenceTrimSettings((current) => ({
          enabled: Boolean(map["playback.silenceTrim.enabled"]),
          thresholdDb:
            typeof map["playback.silenceTrim.thresholdDb"] === "number"
              ? map["playback.silenceTrim.thresholdDb"]
              : current.thresholdDb,
          minSilenceSeconds:
            typeof map["playback.silenceTrim.minSilenceSeconds"] === "number"
              ? map["playback.silenceTrim.minSilenceSeconds"]
              : current.minSilenceSeconds,
        }));

        if (
          typeof map["playback.crossfadeDuration"] === "number"
        ) {
          const nextCrossfadeDuration =
            Math.max(
              0,
              Math.min(
                12,
                map["playback.crossfadeDuration"]
              )
            );

          setCrossfadeDuration(nextCrossfadeDuration);
          crossfadeDurationRef.current = nextCrossfadeDuration;

          try {
            localStorage.setItem(
              "playerCrossfadeDuration",
              String(nextCrossfadeDuration)
            );
          } catch (error) {
            console.error(
              "Could not save crossfade duration:",
              error
            );
          }
        }

        if (
          ["128", "320", "original"].includes(
            map["playback.streamQuality"]
          )
        ) {
          const nextStreamQuality =
            map["playback.streamQuality"];

          setStreamQuality(nextStreamQuality);
          streamQualityRef.current = nextStreamQuality;

          try {
            localStorage.setItem(
              "playerStreamQuality",
              nextStreamQuality
            );
          } catch (error) {
            console.error("Could not save streaming quality:", error);
          }
        }

        if (
          ["lossless", "320kbps", "256kbps", "192kbps", "128kbps"].includes(
            map["playback.downloadQuality"]
          )
        ) {
          const nextDownloadQuality = map["playback.downloadQuality"];
          setDownloadQuality(nextDownloadQuality);

          try {
            localStorage.setItem("playerDownloadQuality", nextDownloadQuality);
          } catch (error) {
            console.error("Could not save download quality:", error);
          }
        }

        if (
          typeof map["playback.replayGain.enabled"] === "boolean"
        ) {
          const nextReplayGainEnabled =
            map["playback.replayGain.enabled"];

          setIsReplayGainEnabled(nextReplayGainEnabled);
          isReplayGainEnabledRef.current = nextReplayGainEnabled;

          try {
            localStorage.setItem(
              "playerReplayGainEnabled",
              String(nextReplayGainEnabled)
            );
          } catch (error) {
            console.error("Could not save ReplayGain preference:", error);
          }
        }

        if (
          map["ui.layoutDensity"] === "comfortable" ||
          map["ui.layoutDensity"] === "compact"
        ) {
          const nextLayoutDensity = map["ui.layoutDensity"];
          setLayoutDensity(nextLayoutDensity);

          try {
            localStorage.setItem("playerLayoutDensity", nextLayoutDensity);
          } catch (error) {
            console.error("Could not save layout density:", error);
          }
        }

        if (typeof map["ui.autoOpenSidebar"] === "boolean") {
          const nextAutoOpenSidebar = map["ui.autoOpenSidebar"];
          setAutoOpenSidebar(nextAutoOpenSidebar);

          try {
            localStorage.setItem(
              "playerAutoOpenSidebar",
              String(nextAutoOpenSidebar)
            );
          } catch (error) {
            console.error("Could not save auto-open sidebar preference:", error);
          }
        }

        if (typeof map["playback.autoplay.enabled"] === "boolean") {
          const nextAutoplayEnabled = map["playback.autoplay.enabled"];
          setIsAutoplayEnabled(nextAutoplayEnabled);

          try {
            localStorage.setItem("playerAutoplayEnabled", String(nextAutoplayEnabled));
          } catch (error) {
            console.error("Could not save autoplay preference:", error);
          }
        }

        if (typeof map["acquisition.autoDownloadLiked"] === "boolean") {
          const nextAutoDownloadLiked = map["acquisition.autoDownloadLiked"];
          setAutoDownloadLiked(nextAutoDownloadLiked);

          try {
            localStorage.setItem("playerAutoDownloadLiked", String(nextAutoDownloadLiked));
          } catch (error) {
            console.error("Could not save auto-download preference:", error);
          }
        }
      })
      .catch(() => {
        // Silence trimming stays disabled when settings cannot be loaded.
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  useEffect(() => {
    function handleUserSettingsChanged(event) {
      const settings = event.detail || {};
      const nextStreamQuality = settings["playback.streamQuality"];
      const nextDownloadQuality = settings["playback.downloadQuality"];

      try {
        if (["128", "320", "original"].includes(nextStreamQuality)) {
          streamQualityRef.current = nextStreamQuality;
          setStreamQuality(nextStreamQuality);
          localStorage.setItem("playerStreamQuality", nextStreamQuality);
        }
        if (["lossless", "320kbps", "256kbps", "192kbps", "128kbps"].includes(nextDownloadQuality)) {
          setDownloadQuality(nextDownloadQuality);
          localStorage.setItem("playerDownloadQuality", nextDownloadQuality);
        }
      } catch (error) {
        console.error("Could not save updated playback preferences:", error);
      }
    }

    window.addEventListener(USER_SETTINGS_CHANGED_EVENT, handleUserSettingsChanged);
    return () => window.removeEventListener(USER_SETTINGS_CHANGED_EVENT, handleUserSettingsChanged);
  }, []);


  function requestFadeFrame(callback) {
    if (typeof window.requestAnimationFrame === "function") {
      return window.requestAnimationFrame(callback);
    }

    return window.setTimeout(
      () => callback(Date.now()),
      16
    );
  }


  const getInactiveAudio = useCallback(() => {
    return audioRef.current === primaryAudioRef.current
      ? secondaryAudioRef.current
      : primaryAudioRef.current;
  }, []);

  function reportPlaybackFailure(audio, requestId, error) {
    if (!audio || audio !== audioRef.current || requestId !== playbackRequestRef.current) return;
    const source = audioRequestIdsRef.current.get(audio);
    if (source?.requestId !== requestId || (audio.currentSrc && source.src !== audio.currentSrc)) return;
    const message = error?.name === "NotAllowedError"
      ? "Playback was blocked by the browser. Press play to try again."
      : (typeof error?.message === "string" && error.message) ||
        "Could not play this track. Check the connection and try again.";
    setIsPlaying(false);
    setPlaybackUnavailable(true);
    setPlaybackMessage(message);
  }

  function handleMediaError(event) {
    const audio = event.currentTarget;
    const source = audioRequestIdsRef.current.get(audio);
    if (audio !== audioRef.current || !source || source.requestId !== playbackRequestRef.current) return;
    const code = audio.error?.code;
    const message = code === 2
      ? "A network error prevented this track from loading."
      : code === 3
        ? "This track could not be decoded."
        : code === 4
          ? "This audio source is unavailable."
          : "Playback failed. Try again or choose another source.";
    reportPlaybackFailure(audio, source.requestId, { message });
  }

  const applyDeckVolume = useCallback((audio, intensity = 1) => {
    if (!audio) return;
    audio.volume = Math.max(0, Math.min(1,
      volumeRef.current * (deckGainRef.current.get(audio) || 1) * intensity));
  }, []);

  const cancelCrossfade = useCallback(() => {
    crossfadeTokenRef.current += 1;
    isCrossfadingRef.current = false;
    cancelFadeFrame(crossfadeFrameRef.current);
    crossfadeFrameRef.current = null;

    const incomingAudio =
      getInactiveAudio();

    if (incomingAudio) {
      incomingAudio.pause();
      incomingAudio.removeAttribute("src");
      incomingAudio.load();
      incomingAudio.volume = 0;
    }

    if (audioRef.current) {
      applyDeckVolume(audioRef.current);
    }
  }, [applyDeckVolume, getInactiveAudio]);


  /*
   * LOAD LIKED SONGS
   */

  const resetPlayer = useCallback(() => {
    cancelRestoreResume();
    playbackRequestRef.current += 1;
    pendingRestoreSeekRef.current = null;
    if (queueStorageKeyRef.current) {
      try {
        localStorage.removeItem(queueStorageKeyRef.current);
      } catch (error) {
        console.error("Could not clear playback queue:", error);
      }
      queueStorageKeyRef.current = null;
    }
    setHydratedQueueUserId(null);
    listeningSessionRef.current?.finish();
    isTransitioningRef.current = false;

    cancelCrossfade();

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }

    setCurrentSong(null);
    setActiveSidebar("none");
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setQueue([]);
    setQueueIndex(-1);
    setIsShuffleEnabled(false);
    setIsLooping(false);
    setLikedSongIds(new Set());
    setIsCurrentSongLiked(false);
    setRecentlyPlayed([]);
    setPlaybackContext(null);
    setPlaybackUnavailable(false);
    setPreviewSource(null);
    previewSourceRef.current = null;

    try {
      localStorage.removeItem("recentlyPlayed");
    } catch (error) {
      console.error(
        "Could not clear recently played:",
        error
      );
    }
  }, [cancelCrossfade, cancelRestoreResume, setActiveSidebar]);

  useEffect(() => {

    if (!isAuthenticated) {
      if (authIsLoading) return undefined;
      resetPlayer();
      return undefined;
    }

    let cancelled = false;
    let recentRequest = 0;

    async function loadLikedSongs() {

      try {

        const songs =
          await getStarred();

        const ids =
          new Set(
            (songs || []).map(
              (song) =>
                String(song.id)
            )
          );

        if (!cancelled) {
          setLikedSongIds(ids);
        }

      } catch (error) {

        console.error(
          "Could not load liked songs:",
          error
        );

      }

    }

    async function loadRecentlyPlayed() {
      const requestId = ++recentRequest;
      try {

        const songs =
          await getRecentlyPlayed();

        if (!cancelled && requestId === recentRequest) {
          setRecentlyPlayed(normalizeRecentlyPlayed(songs));
        }

      } catch (error) {

        console.error(
          "Could not load recently played:",
          error
        );

      }

    }


    loadLikedSongs();
    loadRecentlyPlayed();
    window.addEventListener(LISTENING_ACTIVITY_CHANGED_EVENT, loadRecentlyPlayed);
    window.addEventListener("focus", loadRecentlyPlayed);
    const refresh = window.setInterval(loadRecentlyPlayed, 60_000);

    return () => {
      cancelled = true;
      window.removeEventListener(LISTENING_ACTIVITY_CHANGED_EVENT, loadRecentlyPlayed);
      window.removeEventListener("focus", loadRecentlyPlayed);
      window.clearInterval(refresh);
    };

  }, [isAuthenticated, authIsLoading, session?.id, resetPlayer]);


  /*
   * UPDATE HEART WHEN SONG CHANGES
   */

  useEffect(() => {

    if (!currentSong) {

      setIsCurrentSongLiked(false);

      return;

    }


    setIsCurrentSongLiked(
      likedSongIds.has(
        String(currentSong.id)
      )
    );

  }, [
    currentSong,
    likedSongIds,
  ]);


  /*
   * APPLY VOLUME TO AUDIO
   */

  useEffect(() => {

    if (
      audioRef.current &&
      !isCrossfadingRef.current
    ) {

      audioRef.current.volume = Math.max(
        0,
        Math.min(
          1,
          volume * (deckGainRef.current.get(audioRef.current) || 1)
        )
      );

    }

  }, [volume]);




  /*
   * LIKE / UNLIKE
   */

  async function toggleLikeSong(song) {

    if (!song?.id) {
      return;
    }


    const songId =
      String(song.id);


    const currentlyLiked =
      likedSongIds.has(songId);


    try {

      if (currentlyLiked) {

        await unstarSong(
          song.id
        );


        setLikedSongIds(
          (current) => {

            const next =
              new Set(current);

            next.delete(songId);

            return next;

          }
        );


        if (String(currentSong?.id) === songId) {
          setIsCurrentSongLiked(false);
        }

      } else {

        await starSong(
          song.id
        );


        setLikedSongIds(
          (current) => {

            const next =
              new Set(current);

            next.add(songId);

            return next;

          }
        );


        if (String(currentSong?.id) === songId) {
          setIsCurrentSongLiked(true);
        }

      }

    } catch (error) {

      console.error(
        "Could not change liked status:",
        error
      );

    }

  }


  /*
   * REFILL QUEUE
   *
   * Keeps at least 10 songs after
   * the current song.
   */

  async function refillQueue(
    currentQueue,
    currentIndex
  ) {

    if (!isAutoplayEnabled) {
      return currentQueue;
    }

    const upcomingCount =
      Math.max(
        0,
        currentQueue.length -
        currentIndex -
        1
      );


    if (upcomingCount >= 10) {

      return currentQueue;

    }


    const songsNeeded =
      10 - upcomingCount;


    try {

      const randomSongs =
        await getRandomSongs(
          songsNeeded + 5
        );


      if (
        !randomSongs ||
        randomSongs.length === 0
      ) {

        return currentQueue;

      }


      const existingIds =
        new Set(
          currentQueue.map(
            (song) =>
              String(song.id)
          )
        );


      const newSongs =
        randomSongs.filter(
          (song) =>
            !existingIds.has(
              String(song.id)
            )
        );


      return [
        ...currentQueue,
        ...newSongs.slice(
          0,
          songsNeeded
        ),
      ];

    } catch (error) {

      console.error(
        "Could not refill queue:",
        error
      );

      return currentQueue;

    }

  }


  /*
   * LOCAL AVAILABILITY
   *
   * Whether a song can be streamed straight from the local library. Anything
   * the server has already marked as library-backed (or that carries no
   * availability information at all, e.g. library reads) plays normally; only
   * catalog-only entries need an external source resolved.
   */

  function isLibraryPlayable(song) {

    if (!song) {
      return false;
    }


    if (
      song.availability &&
      typeof song.availability.libraryAvailable === "boolean"
    ) {

      return song.availability.libraryAvailable;

    }


    const kind =
      song.source &&
      song.source.kind;


    return (
      !kind ||
      kind === "library" ||
      kind === "musicdeck"
    );

  }

  function getOrAnalyzeSilence(song) {
    const trackId = String(song.id);
    const pendingAnalysis = silenceAnalysisRequestsRef.current.get(trackId);
    if (pendingAnalysis) {
      return pendingAnalysis;
    }

    const analysisRequest = (async () => {
      const savedAnalysis = await getSilenceAnalysis(trackId);
      if (savedAnalysis) {
        return savedAnalysis;
      }

      return analyzeSilence(trackId, {
        thresholdDb: silenceTrimSettings.thresholdDb,
        minSilenceSeconds: silenceTrimSettings.minSilenceSeconds,
      });
    })();

    silenceAnalysisRequestsRef.current.set(trackId, analysisRequest);
    analysisRequest.finally(() => {
      if (silenceAnalysisRequestsRef.current.get(trackId) === analysisRequest) {
        silenceAnalysisRequestsRef.current.delete(trackId);
      }
    }).catch(() => {
      // The playback caller logs and handles background analysis failures.
    });
    return analysisRequest;
  }


  /*
   * PLAY SONG
   */

  async function loadAndPlaySong(song, resumeAtSeconds = 0) {

    if (
      !audioRef.current ||
      !song
    ) {

      return;

    }

    const activeAudio = audioRef.current;
    cancelRestoreResume();

    cancelCrossfade();


    const requestId =
      playbackRequestRef.current + 1;

    playbackRequestRef.current =
      requestId;

    setPlaybackMessage("");


    /*
     * Prefer the full local track. When the track is not in the library,
     * play only its trusted provider-supplied preview URL; otherwise
     * report the track as unavailable.
     */

    const localTrack = isLibraryPlayable(song);
    const source = localTrack ? song.playableSource || song.sourceId || null : null;
    const directPreviewUrl = localTrack ? null : trustedPreviewUrl(song.previewUrl);

    // External catalog entries may only use their provider-supplied preview.
    // Do not resolve a full external source when that preview is unavailable.
    if (!localTrack && !directPreviewUrl) {
      setPlaybackMessage("Preview unavailable for this track");
      setPlaybackUnavailable(true);
      setIsPlaying(false);
      return false;
    }

    const preview = directPreviewUrl
      ? { type: "preview", quality: { durationSeconds: 30, lossless: false } }
      : null;

    setPreviewSource(preview);
    previewSourceRef.current = preview;
    listeningSessionRef.current?.finish();
    setPlaybackUnavailable(false);


    const streamUrl = directPreviewUrl ||
      getStreamUrl(
        song.id,
        source,
        streamQualityRef.current
      );


    activeAudio.pause();

    deckGainRef.current.set(
      activeAudio,
      replayGainMultiplierForSong(song)
    );

    pendingRestoreSeekRef.current = resumeAtSeconds > 0 ? resumeAtSeconds : null;
    activeAudio.src =
      streamUrl;
    audioRequestIdsRef.current.set(activeAudio, { requestId, src: activeAudio.src });

    applyDeckVolume(activeAudio);


    setCurrentSong(song);

    setCurrentTime(resumeAtSeconds);

    setDuration(0);

    // Reset trim bounds for the new track; graceful fallback to the full
    // track until (and unless) an analysis is available.
    trimBoundsRef.current = null;

    if (silenceTrimSettings.enabled && !preview && isLibraryPlayable(song)) {
      getOrAnalyzeSilence(song)
        .then((analysis) => {
          if (
            requestId !== playbackRequestRef.current ||
            !analysis ||
            analysis.status !== "completed"
          ) {
            return;
          }

          trimBoundsRef.current = {
            leading: analysis.leadingSilenceSeconds || 0,
            trailing: analysis.trailingSilenceSeconds || 0,
          };

          // Analysis can arrive after playback has already started; jump
          // past any leading silence immediately in that case.
          if (
            audioRef.current &&
            trimBoundsRef.current.leading > 0 &&
            audioRef.current.currentTime < trimBoundsRef.current.leading
          ) {
            audioRef.current.currentTime = trimBoundsRef.current.leading;
          }
        })
        .catch((error) => {
          console.warn("Could not analyze silence for track:", song.id, error);
        });
    }


    try {

      await activeAudio.play();

      if (
        requestId === playbackRequestRef.current
      ) {
        setIsPlaying(true);
        if (!preview && isLibraryPlayable(song)) {
          listeningSessionRef.current?.begin(song, activeAudio);
        }
      }

    } catch (error) {

      reportPlaybackFailure(activeAudio, requestId, error);

    }

    return requestId;

  }


  async function playSong(song) {
    if (!song) {
      return;
    }

    if (
      song.id !== null &&
      song.id !== undefined &&
      currentSong?.id !== null &&
      currentSong?.id !== undefined &&
      String(song.id) === String(currentSong.id)
    ) {
      togglePlay();
      return;
    }

    const started = await loadAndPlaySong(song);
    if (started === false || started !== playbackRequestRef.current) return;

    setPlaybackContext(null);
    setQueue([song]);
    setQueueIndex(0);
  }

  function addToQueue(song) {
    if (!song) return;

    setQueue((currentQueue) => {
      const alreadyQueued = currentQueue.some(
        (queuedSong) => String(queuedSong?.id) === String(song.id)
      );
      return alreadyQueued ? currentQueue : [...currentQueue, song];
    });
  }

  /*
   * PLAY SONG FROM A SPECIFIC SOURCE
   *
   * Same as playSong, but tags the song with the chosen source ID so the
   * stream endpoint resolves that provider source (with server-side fallback
   * if it fails). The queue and playback flow are otherwise unchanged.
   */

  async function playSongFromSource(song, source) {
    if (!song) {
      return;
    }

    await playSong({
      ...song,
      ...(typeof source === "object" ? { playableSource: source } : { sourceId: source }),
    });
  }

  function toggleLike() {
    return toggleLikeSong(currentSong);
  }


  function replayGainDbForSong(song) {
    const replayGain =
      song?.replayGain ||
      song?.metadata?.replayGain ||
      {};

    const rawGain =
      replayGain.trackGainDb ??
      replayGain.trackGain ??
      song?.replayGainTrackGainDb ??
      song?.replayGainTrackGain ??
      song?.metadata?.replayGainTrackGainDb ??
      song?.metadata?.replayGainTrackGain ??
      null;

    if (typeof rawGain === "number") {
      return Number.isFinite(rawGain) ? rawGain : null;
    }

    if (typeof rawGain === "string") {
      const parsed = Number.parseFloat(rawGain);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }


  function replayGainMultiplierForSong(song) {
    if (!isReplayGainEnabledRef.current) {
      return 1;
    }

    const gainDb = replayGainDbForSong(song);

    if (gainDb === null) {
      return 1;
    }

    return Math.max(
      0,
      Math.min(
        4,
        10 ** (gainDb / 20)
      )
    );
  }


  /*
   * PLAY A TRACK IN ITS LIST CONTEXT
   *
   * Row clicks use this path so the selected track starts immediately while
   * the tracks after it become the upcoming queue. The queue's internal
   * contract still keeps the current song at index 0, which lets next/previous
   * and the queue UI share one consistent playback sequence.
   */

  async function playContext(
    tracks,
    startIndex = 0,
    context = null
  ) {
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return;
    }

    const safeStartIndex =
      startIndex >= 0 && startIndex < tracks.length
        ? startIndex
        : 0;
    const activeTrack = tracks[safeStartIndex];
    let contextQueue = [
      activeTrack,
      ...tracks.slice(safeStartIndex + 1),
    ];

    if (isShuffleEnabled) {
      contextQueue = shuffleUpcomingSongs(contextQueue, 0);
    }

    setPlaybackContext(context);
    setQueue(contextQueue);
    setQueueIndex(0);

    await loadAndPlaySong(activeTrack);
  }


  function shuffleUpcomingSongs(songs, currentIndex) {

    const upcomingStart =
      currentIndex + 1;


    if (
      currentIndex < 0 ||
      songs.length - upcomingStart < 2
    ) {
      return songs;
    }


    const shuffledUpcoming =
      songs.slice(upcomingStart);


    for (
      let index = shuffledUpcoming.length - 1;
      index > 0;
      index -= 1
    ) {

      const randomIndex =
        Math.floor(
          Math.random() *
          (index + 1)
        );


      [
        shuffledUpcoming[index],
        shuffledUpcoming[randomIndex],
      ] = [
        shuffledUpcoming[randomIndex],
        shuffledUpcoming[index],
      ];

    }


    return [
      ...songs.slice(0, upcomingStart),
      ...shuffledUpcoming,
    ];

  }


  /*
   * PLAY QUEUE
   */

  async function playQueue(
    songs,
    startIndex = 0,
    context = null
  ) {

    if (
      !songs ||
      songs.length === 0
    ) {

      return;

    }


    if (
      startIndex < 0 ||
      startIndex >= songs.length
    ) {

      startIndex = 0;

    }


    setPlaybackContext(context);


    let newQueue = [
      ...songs,
    ];


    /*
     * Add random songs behind
     * the supplied queue.
     */

    newQueue =
      await refillQueue(
        newQueue,
        startIndex
      );


    if (isShuffleEnabled) {
      newQueue =
        shuffleUpcomingSongs(
          newQueue,
          startIndex
        );
    }


    setQueue(newQueue);

    setQueueIndex(startIndex);


    await loadAndPlaySong(
      newQueue[startIndex]
    );

  }


  /*
   * PLAY SONG AT QUEUE INDEX
   *
   * Important when clicking a song
   * inside the queue.
   */

  async function playQueueSong(index) {

    if (
      index < 0 ||
      index >= queue.length
    ) {

      return;

    }


    setQueueIndex(index);

    await loadAndPlaySong(
      queue[index]
    );

  }

  function moveQueueItem(from, to) {
    if (
      !Number.isInteger(from) || !Number.isInteger(to) ||
      from <= queueIndex || to <= queueIndex ||
      from < 0 || to < 0 || from >= queue.length || to >= queue.length ||
      from === to
    ) {
      return;
    }

    // An incoming crossfade deck must not commit a now-reordered next track.
    if (isCrossfadingRef.current) cancelCrossfade();
    setQueue((currentQueue) => {
      if (from >= currentQueue.length || to >= currentQueue.length) return currentQueue;
      const reordered = [...currentQueue];
      const [song] = reordered.splice(from, 1);
      reordered.splice(to, 0, song);
      return reordered;
    });
  }

  async function refillUpcomingQueue(baseQueue, index) {
    const updatedQueue = await refillQueue(baseQueue, index);
    const additions = updatedQueue.slice(baseQueue.length);
    if (!additions.length) return;
    setQueue((currentQueue) => {
      if (currentQueue[index] !== baseQueue[index]) return currentQueue;
      const existingIds = new Set(currentQueue.map((song) => String(song.id)));
      return [...currentQueue, ...additions.filter((song) => !existingIds.has(String(song.id)))];
    });
  }


  /*
   * NEXT SONG
   */

  async function nextSong() {

    if (isTransitioningRef.current) {
      return;
    }

    isTransitioningRef.current = true;

    try {
      const nextIndex = queueIndex + 1;

      if (
        queueIndex >= 0 &&
        nextIndex < queue.length
      ) {
        setQueueIndex(nextIndex);
        await loadAndPlaySong(queue[nextIndex]);

        await refillUpcomingQueue(
          queue,
          nextIndex
        );
        return;
      }

      if (!isAutoplayEnabled) {
        stopPlaybackAtQueueEnd();
        return;
      }

      try {
        const randomSongs = await getRandomSongs(10);

        if (!randomSongs || randomSongs.length === 0) {
          stopPlaybackAtQueueEnd();
          return;
        }

        setQueue(randomSongs);
        setQueueIndex(0);
        await loadAndPlaySong(randomSongs[0]);
      } catch (error) {
        console.error(
          "Could not generate new songs:",
          error
        );
        stopPlaybackAtQueueEnd();
      }
    } finally {
      isTransitioningRef.current = false;
    }

  }


  function stopPlaybackAtQueueEnd() {
    cancelRestoreResume();
    playbackRequestRef.current += 1;
    listeningSessionRef.current?.finish();

    if (audioRef.current) {
      audioRef.current.pause();

      try {
        audioRef.current.currentTime = 0;
      } catch {
        // Some media implementations expose currentTime as read-only while
        // their source is being detached. State still resets below.
      }
    }

    setCurrentSong(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setQueue([]);
    setQueueIndex(-1);
    setPlaybackContext(null);
    setPlaybackUnavailable(false);
    setPreviewSource(null);
    previewSourceRef.current = null;
    trimBoundsRef.current = null;
  }


  /*
   * PREVIOUS SONG
   */

  async function previousSong() {

    if (!audioRef.current) {
      return;
    }


    /*
     * More than 3 seconds into song:
     * restart current song.
     */

    if (
      audioRef.current.currentTime >
      3
    ) {

      listeningSessionRef.current?.finish();
      audioRef.current.currentTime =
        0;
      if (isPlaying && !previewSourceRef.current) {
        listeningSessionRef.current?.begin(currentSong, audioRef.current, false);
      }
      return;

    }


    /*
     * Go backwards if possible.
     */

    if (
      queue.length === 0 ||
      queueIndex <= 0
    ) {

      listeningSessionRef.current?.finish();
      audioRef.current.currentTime =
        0;
      if (isPlaying && !previewSourceRef.current) {
        listeningSessionRef.current?.begin(currentSong, audioRef.current, false);
      }
      return;

    }


    const previousIndex =
      queueIndex - 1;


    setQueueIndex(
      previousIndex
    );


    await loadAndPlaySong(
      queue[previousIndex]
    );

  }


  /*
   * CROSSFADE
   *
   * Two audio elements alternate roles. The current deck fades down while
   * the idle deck starts the next queued track at zero volume. Once the fade
   * finishes, the incoming deck becomes the active player used by every
   * existing playback control.
   */

  async function startCrossfade() {
    const fadeSeconds =
      crossfadeDurationRef.current;

    const nextIndex =
      queueIndex + 1;

    if (
      fadeSeconds <= 0 ||
      isCrossfadingRef.current ||
      isLooping ||
      queueIndex < 0 ||
      nextIndex >= queue.length
    ) {
      return;
    }

    const outgoingAudio =
      audioRef.current;

    const incomingAudio =
      getInactiveAudio();

    const nextTrack =
      queue[nextIndex];

    if (
      !outgoingAudio ||
      !incomingAudio ||
      !nextTrack
    ) {
      return;
    }

    isCrossfadingRef.current = true;

    const transitionToken =
      crossfadeTokenRef.current + 1;

    crossfadeTokenRef.current =
      transitionToken;

    playbackRequestRef.current += 1;

    const localNextTrack = isLibraryPlayable(nextTrack);
    const source = localNextTrack ? nextTrack.playableSource || nextTrack.sourceId || null : null;
    const previewUrl = localNextTrack ? null : trustedPreviewUrl(nextTrack.previewUrl);

    if (
      transitionToken !== crossfadeTokenRef.current
    ) {
      return;
    }

    if (
      !localNextTrack &&
      !previewUrl
    ) {
      isCrossfadingRef.current = false;
      return;
    }

    const incomingPreview = previewUrl
      ? { type: "preview", quality: { durationSeconds: 30, lossless: false } }
      : null;

    incomingAudio.pause();
    incomingAudio.src = previewUrl || getStreamUrl(nextTrack.id, source, streamQualityRef.current);
    incomingAudio.currentTime = 0;
    deckGainRef.current.set(
      incomingAudio,
      replayGainMultiplierForSong(nextTrack)
    );
    incomingAudio.volume = 0;

    try {
      await incomingAudio.play();
    } catch (error) {
      if (
        transitionToken === crossfadeTokenRef.current
      ) {
        isCrossfadingRef.current = false;
        incomingAudio.removeAttribute("src");
        incomingAudio.load();

        if (outgoingAudio.ended) {
          nextSong();
        }
      }
      return;
    }

    if (
      transitionToken !== crossfadeTokenRef.current
    ) {
      incomingAudio.pause();
      return;
    }

    const fadeStartedAt =
      typeof performance !== "undefined"
        ? performance.now()
        : Date.now();
    const incomingStartedAt = Date.now();

    const fadeDurationMs =
      Math.max(100, fadeSeconds * 1000);

    function finishCrossfade() {
      if (
        transitionToken !== crossfadeTokenRef.current
      ) {
        return;
      }

      if (!previewSourceRef.current) {
        listeningSessionRef.current?.finish();
      }

      audioRef.current = incomingAudio;
      applyDeckVolume(incomingAudio);

      outgoingAudio.pause();
      outgoingAudio.removeAttribute("src");
      outgoingAudio.load();
      outgoingAudio.volume = 0;

      isCrossfadingRef.current = false;
      crossfadeFrameRef.current = null;

      setQueueIndex(nextIndex);
      setCurrentSong(nextTrack);
      setCurrentTime(incomingAudio.currentTime || 0);
      setDuration(
        Number.isFinite(incomingAudio.duration)
          ? incomingAudio.duration
          : 0
      );
      setPreviewSource(incomingPreview);
      previewSourceRef.current = incomingPreview;
      setPlaybackUnavailable(false);
      setIsPlaying(true);
      trimBoundsRef.current = null;

      if (!incomingPreview && isLibraryPlayable(nextTrack)) {
        const fadeListenSeconds = Math.min((Date.now() - incomingStartedAt) / 1000,
          (incomingAudio.currentTime || 0) / (incomingAudio.playbackRate || 1));
        listeningSessionRef.current?.begin(nextTrack, incomingAudio, false, fadeListenSeconds, incomingStartedAt);
      }

      if (
        silenceTrimSettings.enabled &&
        !incomingPreview &&
        isLibraryPlayable(nextTrack)
      ) {
        getOrAnalyzeSilence(nextTrack)
          .then((analysis) => {
            if (
              audioRef.current !== incomingAudio ||
              !analysis ||
              analysis.status !== "completed"
            ) {
              return;
            }

            trimBoundsRef.current = {
              leading: analysis.leadingSilenceSeconds || 0,
              trailing: analysis.trailingSilenceSeconds || 0,
            };

            if (
              trimBoundsRef.current.leading > 0 &&
              incomingAudio.currentTime < trimBoundsRef.current.leading
            ) {
              incomingAudio.currentTime = trimBoundsRef.current.leading;
            }
          })
          .catch((error) => {
            console.warn("Could not analyze silence for track:", nextTrack.id, error);
          });
      }

      refillUpcomingQueue(queue, nextIndex);
    }

    function animateCrossfade(timestamp) {
      if (
        transitionToken !== crossfadeTokenRef.current
      ) {
        return;
      }

      const progress =
        Math.min(
          1,
          Math.max(
            0,
            (timestamp - fadeStartedAt) /
              fadeDurationMs
          )
        );

      applyDeckVolume(outgoingAudio, 1 - progress);
      applyDeckVolume(incomingAudio, progress);

      if (progress >= 1) {
        finishCrossfade();
        return;
      }

      crossfadeFrameRef.current =
        requestFadeFrame(animateCrossfade);
    }

    crossfadeFrameRef.current =
      requestFadeFrame(animateCrossfade);
  }


  /*
   * TOGGLE SHUFFLE
   *
   * Enabling shuffle randomizes the unplayed portion of the queue. Playback
   * then continues through that order, ensuring that every queued track is
   * heard once before any new tracks are added.
   */

  function toggleShuffle() {

    const shouldEnable =
      !isShuffleEnabled;


    setIsShuffleEnabled(
      shouldEnable
    );


    if (!shouldEnable) {
      return;
    }

    setQueue(
      shuffleUpcomingSongs(
        queue,
        queueIndex
      )
    );

  }


  function toggleLoop() {

    setIsLooping(
      (current) => !current
    );

  }


  /*
   * PLAY / PAUSE
   */

  function togglePlay() {

    if (
      !audioRef.current ||
      !currentSong
    ) {

      return;

    }

    cancelRestoreResume();


    if (isPlaying) {

      if (isCrossfadingRef.current) {
        cancelCrossfade();
      }

      audioRef.current.pause();

    } else {

      if (!audioRef.current.getAttribute("src")) {
        loadAndPlaySong(currentSong, currentTime);
        return;
      }

      const activeAudio = audioRef.current;
      const source = audioRequestIdsRef.current.get(activeAudio);
      activeAudio.play().catch((error) => {
        reportPlaybackFailure(activeAudio, source?.requestId, error);
      });

    }

  }


  /*
   * TIME
   */

  function handleTimeUpdate(event) {

    const activeAudio =
      event.currentTarget;

    if (
      !activeAudio ||
      activeAudio !== audioRef.current
    ) {
      return;
    }


    setCurrentTime(
      activeAudio.currentTime
    );
    if (!previewSourceRef.current) {
      listeningSessionRef.current?.sample();
    }

    /*
     * A preview is only a fragment of the real recording: stop at the
     * preview endpoint instead of letting the source run past it.
     */

    const preview =
      previewSourceRef.current;

    const previewDuration =
      preview &&
      preview.quality &&
      Number(preview.quality.durationSeconds);

    const bounds = trimBoundsRef.current;

    const effectiveEnd =
      previewDuration ||
      (
        activeAudio.duration
          ? activeAudio.duration -
            (
              silenceTrimSettings.enabled &&
              bounds
                ? bounds.trailing || 0
                : 0
            )
          : 0
      );

    if (
      crossfadeDurationRef.current > 0 &&
      effectiveEnd > 0 &&
      activeAudio.currentTime >=
        effectiveEnd - crossfadeDurationRef.current
    ) {
      startCrossfade();
    }

    if (
      previewDuration &&
      activeAudio.currentTime >= previewDuration
    ) {

      if (!isCrossfadingRef.current) {
        activeAudio.pause();
      }
      handleEnded();
      return;

    }

    // Effective track end: when trailing silence has been detected and
    // trimming is enabled, treat that boundary as "the track finished"
    // instead of waiting for the full (silent) tail to play out.
    if (
      silenceTrimSettings.enabled &&
      bounds &&
      bounds.trailing > 0 &&
      activeAudio.duration &&
      activeAudio.currentTime >= activeAudio.duration - bounds.trailing
    ) {
      handleEnded();
    }

  }


  /*
   * METADATA
   */

  function handleLoadedMetadata(event) {

    const activeAudio =
      event.currentTarget;

    if (
      !activeAudio ||
      activeAudio !== audioRef.current
    ) {
      return;
    }


    const audioDuration = Number.isFinite(activeAudio.duration)
      ? activeAudio.duration
      : 0;
    setDuration(audioDuration);
    setCurrentSong((song) => song ? {
      ...song,
      metadataDuration: song.metadataDuration ?? song.duration ?? song.metadata?.durationSeconds ?? null,
      audioDuration,
    } : song);

    const restoredPosition = pendingRestoreSeekRef.current;
    if (restoredPosition !== null) {
      const maxPosition = Number.isFinite(activeAudio.duration)
        ? Math.max(0, activeAudio.duration - 0.25)
        : restoredPosition;
      activeAudio.currentTime = Math.min(restoredPosition, maxPosition);
      setCurrentTime(activeAudio.currentTime);
      pendingRestoreSeekRef.current = null;
      if (restoreRequestRef.current) {
        attemptRestoredPlayback(activeAudio, restoreRequestRef.current.requestId);
      }
      return;
    }

    // Start playback at the first-audio position when trim bounds are
    // already known (analysis resolved before metadata finished loading).
    const bounds = trimBoundsRef.current;
    if (
      silenceTrimSettings.enabled &&
      bounds &&
      bounds.leading > 0
    ) {
      activeAudio.currentTime = bounds.leading;
    }

  }


  /*
   * SEEK
   */

  function seek(value) {

    if (!audioRef.current) {
      return;
    }


    const newTime =
      (value / 100) * duration;


    audioRef.current.currentTime =
      newTime;
    setCurrentTime(newTime);

  }


  /*
   * VOLUME
   */

  function changeVolume(value) {

    const newVolume =
      Math.max(
        0,
        Math.min(
          1,
          Number(value)
        )
      );


    volumeRef.current = newVolume;

    setVolume(newVolume);


    if (
      audioRef.current &&
      !isCrossfadingRef.current
    ) {

      applyDeckVolume(audioRef.current);

    }


    try {

      localStorage.setItem(
        "playerVolume",
        newVolume
      );

    } catch (error) {

      console.error(
        "Could not save volume:",
        error
      );

    }

  }


  function changeCrossfadeDuration(value) {
    const nextDuration =
      Math.max(
        0,
        Math.min(
          12,
          Number(value) || 0
        )
      );

    crossfadeDurationRef.current =
      nextDuration;

    setCrossfadeDuration(
      nextDuration
    );

    try {
      localStorage.setItem(
        "playerCrossfadeDuration",
        String(nextDuration)
      );
    } catch (error) {
      console.error(
        "Could not save crossfade duration:",
        error
      );
    }
  }


  function changeStreamQuality(value) {
    const nextQuality =
      ["128", "320", "original"].includes(value)
        ? value
        : "original";

    streamQualityRef.current = nextQuality;
    setStreamQuality(nextQuality);

    try {
      localStorage.setItem("playerStreamQuality", nextQuality);
    } catch (error) {
      console.error("Could not save streaming quality:", error);
    }
  }


  function changeDownloadQuality(value) {
    const nextQuality =
      ["lossless", "320kbps", "256kbps", "192kbps", "128kbps"].includes(value)
        ? value
        : "320kbps";

    setDownloadQuality(nextQuality);

    try {
      localStorage.setItem("playerDownloadQuality", nextQuality);
    } catch (error) {
      console.error("Could not save download quality:", error);
    }
  }


  function changeReplayGainEnabled(value) {
    const nextEnabled = Boolean(value);

    isReplayGainEnabledRef.current = nextEnabled;
    setIsReplayGainEnabled(nextEnabled);

    try {
      localStorage.setItem(
        "playerReplayGainEnabled",
        String(nextEnabled)
      );
    } catch (error) {
      console.error("Could not save ReplayGain preference:", error);
    }
  }


  function changeLayoutDensity(value) {
    const nextDensity =
      value === "compact"
        ? "compact"
        : "comfortable";

    setLayoutDensity(nextDensity);

    try {
      localStorage.setItem("playerLayoutDensity", nextDensity);
    } catch (error) {
      console.error("Could not save layout density:", error);
    }
  }

  function changeAccentColor(value) {
    const nextAccentColor = normalizeAccentColor(value);
    setAccentColor(nextAccentColor);
    try {
      localStorage.setItem("playerAccentColor", nextAccentColor);
    } catch (error) {
      console.error("Could not save accent color:", error);
    }
  }


  function changeAutoOpenSidebar(value) {
    const nextEnabled = Boolean(value);
    setAutoOpenSidebar(nextEnabled);

    try {
      localStorage.setItem(
        "playerAutoOpenSidebar",
        String(nextEnabled)
      );
    } catch (error) {
      console.error("Could not save auto-open sidebar preference:", error);
    }
  }


  function changeAutoplayEnabled(value) {
    const nextEnabled = Boolean(value);
    setIsAutoplayEnabled(nextEnabled);

    try {
      localStorage.setItem("playerAutoplayEnabled", String(nextEnabled));
    } catch (error) {
      console.error("Could not save autoplay preference:", error);
    }
  }


  function changeAutoDownloadLiked(value) {
    const nextEnabled = Boolean(value);
    setAutoDownloadLiked(nextEnabled);

    try {
      localStorage.setItem("playerAutoDownloadLiked", String(nextEnabled));
    } catch (error) {
      console.error("Could not save auto-download preference:", error);
    }
  }


  /*
   * SONG FINISHED
   */

  async function handleEnded() {

    if (
      isCrossfadingRef.current ||
      isTransitioningRef.current
    ) {
      return;
    }

    if (!previewSourceRef.current && audioRef.current) {
      listeningSessionRef.current?.finish();
    }

    if (isLooping) {
      const activeAudio = audioRef.current;

      if (!activeAudio) {
        return;
      }

      isTransitioningRef.current = true;

      try {
        activeAudio.currentTime = 0;
        setCurrentTime(0);
        await activeAudio.play();
        setIsPlaying(true);
        listeningSessionRef.current?.begin(currentSong, activeAudio, false);
      } catch (error) {
        setIsPlaying(false);
      } finally {
        isTransitioningRef.current = false;
      }

      return;
    }

    await nextSong();

  }


  return (

    <PlayerContext.Provider
      value={{

        currentSong,

        activeSidebar,

        setActiveSidebar,

        autoOpenSidebar,

        isAutoplayEnabled,

        autoDownloadLiked,

        isPlaying,

        currentTime,

        duration,

        queue,

        queueIndex,

        recentlyPlayed,

        // QueueSidebar calls this play history. It is the same existing
        // recently-played array, exposed under a clearer playback name.
        playHistory: recentlyPlayed,

        likedSongIds,

        isCurrentSongLiked,

        playbackContext,

        isPreview: Boolean(previewSource),

        isShuffleEnabled,

        isLooping,

        previewDurationSeconds:
          (previewSource &&
            previewSource.quality &&
            previewSource.quality.durationSeconds) ||
          null,

        playbackUnavailable,

        playbackMessage,

        volume,

        crossfadeDuration,

        streamQuality,

        downloadQuality,

        isReplayGainEnabled,

        layoutDensity,

        accentColor,

        playSong,

        addToQueue,

        playSongFromSource,

        playContext,

        playQueue,

        playQueueSong,

        moveQueueItem,

        nextSong,

        previousSong,

        toggleShuffle,

        toggleLoop,

        togglePlay,

        toggleLike,

        toggleLikeSong,

        seek,

        changeVolume,

        changeCrossfadeDuration,

        changeStreamQuality,

        changeDownloadQuality,

        changeReplayGainEnabled,

        changeLayoutDensity,

        changeAccentColor,

        changeAutoOpenSidebar,

        changeAutoplayEnabled,

        changeAutoDownloadLiked,

        resetPlayer,

      }}
    >

      {children}


      <audio
        ref={primaryAudioRef}

        loop={isLooping}

        onTimeUpdate={
          handleTimeUpdate
        }

        onLoadedMetadata={
          handleLoadedMetadata
        }

        onPlay={(event) => {
          if (event.currentTarget === audioRef.current) {
            setIsPlaying(true);
          }
        }}

        onPause={(event) => {
          if (
            event.currentTarget === audioRef.current &&
            !isCrossfadingRef.current
          ) {
            setIsPlaying(false);
          }
        }}

        onError={(event) => {
          if (event.currentTarget === audioRef.current) {
            if (restoreRequestRef.current) cancelRestoreResume();
            setDuration(0);
            handleMediaError(event);
          }
        }}

        onEnded={(event) => {
          if (event.currentTarget === audioRef.current) {
            handleEnded();
          }
        }}
      />

      <audio
        ref={secondaryAudioRef}

        loop={isLooping}

        onTimeUpdate={
          handleTimeUpdate
        }

        onLoadedMetadata={
          handleLoadedMetadata
        }

        onPlay={(event) => {
          if (event.currentTarget === audioRef.current) {
            setIsPlaying(true);
          }
        }}

        onPause={(event) => {
          if (
            event.currentTarget === audioRef.current &&
            !isCrossfadingRef.current
          ) {
            setIsPlaying(false);
          }
        }}

        onError={(event) => {
          if (event.currentTarget === audioRef.current) {
            if (restoreRequestRef.current) cancelRestoreResume();
            setDuration(0);
            handleMediaError(event);
          }
        }}

        onEnded={(event) => {
          if (event.currentTarget === audioRef.current) {
            handleEnded();
          }
        }}
      />

    </PlayerContext.Provider>

  );

}


export function usePlayer() {

  return useContext(
    PlayerContext
  );

}
