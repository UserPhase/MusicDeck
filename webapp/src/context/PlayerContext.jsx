import {
  createContext,
  useContext,
  useRef,
  useState,
  useEffect,
} from "react";

import {
  getStreamUrl,
  getRecentlyPlayed,
  getStarred,
  recordRecentlyPlayed,
  starSong,
  unstarSong,
  getRandomSongs,
  getUserSettings,
  getSilenceAnalysis,
  getPlayableSources,
} from "../api/musicdeck";

import {
  useAuth,
} from "./AuthContext";


const PlayerContext =
  createContext(null);


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

  const deckGainRef =
    useRef(new Map());



  const {
    isAuthenticated,
  } = useAuth();
  const playbackRequestRef =
    useRef(0);

  /*
   * CURRENT SONG
   */

  const [
    currentSong,
    setCurrentSong,
  ] = useState(null);


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
  ] = useState(() => {

    try {

      const saved =
        localStorage.getItem(
          "recentlyPlayed"
        );

      if (!saved) {
        return [];
      }

      return JSON.parse(saved);

    } catch (error) {

      console.error(
        "Could not load recently played:",
        error
      );

      return [];

    }

  });


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

  /* Mirrors previewSource for the timeupdate handler's end-of-preview check. */
  const previewSourceRef = useRef(null);

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
      })
      .catch(() => {
        // Silence trimming stays disabled when settings cannot be loaded.
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);


  function requestFadeFrame(callback) {
    if (typeof window.requestAnimationFrame === "function") {
      return window.requestAnimationFrame(callback);
    }

    return window.setTimeout(
      () => callback(Date.now()),
      16
    );
  }


  function cancelFadeFrame(frameId) {
    if (frameId === null) {
      return;
    }

    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(frameId);
      return;
    }

    window.clearTimeout(frameId);
  }


  function getInactiveAudio() {
    return audioRef.current === primaryAudioRef.current
      ? secondaryAudioRef.current
      : primaryAudioRef.current;
  }


  function cancelCrossfade() {
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
  }


  /*
   * LOAD LIKED SONGS
   */

  function resetPlayer() {
    playbackRequestRef.current += 1;

    cancelCrossfade();

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }

    setCurrentSong(null);
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
  }

  useEffect(() => {

    if (!isAuthenticated) {
      resetPlayer();
      return undefined;
    }

    let cancelled = false;

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

      try {

        const songs =
          await getRecentlyPlayed();

        if (!cancelled) {
          setRecentlyPlayed(songs || []);
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

    return () => {
      cancelled = true;
    };

  }, [isAuthenticated]);


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
   * RECENTLY PLAYED
   */

  function addToRecentlyPlayed(song) {

    if (!song?.id) {
      return;
    }


    setRecentlyPlayed(
      (current) => {

        const withoutSong =
          current.filter(
            (recentSong) =>
              String(recentSong.id) !==
              String(song.id)
          );


        const updated = [
          song,
          ...withoutSong,
        ].slice(0, 10);


        try {

          localStorage.setItem(
            "recentlyPlayed",
            JSON.stringify(updated)
          );

        } catch (error) {

          console.error(
            "Could not save recently played:",
            error
          );

        }


        return updated;

      }
    );

  }


  /*
   * LIKE / UNLIKE
   */

  async function toggleLike() {

    if (!currentSong) {
      return;
    }


    const songId =
      String(currentSong.id);


    const currentlyLiked =
      likedSongIds.has(songId);


    try {

      if (currentlyLiked) {

        await unstarSong(
          currentSong.id
        );


        setLikedSongIds(
          (current) => {

            const next =
              new Set(current);

            next.delete(songId);

            return next;

          }
        );


        setIsCurrentSongLiked(false);

      } else {

        await starSong(
          currentSong.id
        );


        setLikedSongIds(
          (current) => {

            const next =
              new Set(current);

            next.add(songId);

            return next;

          }
        );


        setIsCurrentSongLiked(true);

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


  /*
   * PLAY SONG
   */

  async function loadAndPlaySong(song) {

    if (
      !audioRef.current ||
      !song
    ) {

      return;

    }

    cancelCrossfade();


    const requestId =
      playbackRequestRef.current + 1;

    playbackRequestRef.current =
      requestId;


    /*
     * Prefer the full local track. When the track is not in the library,
     * transparently resolve a playable external source (typically a
     * preview) through the provider-neutral source model instead of
     * failing playback.
     */

    let source =
      song.playableSource ||
      song.sourceId ||
      null;


    if (
      !source &&
      !isLibraryPlayable(song)
    ) {

      try {

        const resolution =
          await getPlayableSources(song);

        source =
          resolution.selectedSource ||
          (resolution.sources || []).find(
            (candidate) =>
              candidate.availability ===
              "available"
          ) ||
          null;

      } catch (error) {

        source = null;

      }


      if (
        requestId !== playbackRequestRef.current
      ) {

        return;

      }


      if (!source) {

        /*
         * Nothing playable exists for this track: keep the existing
         * unavailable state rather than loading a broken stream.
         */

        audioRef.current.pause();

        setCurrentSong(song);
        setIsPlaying(false);
        setCurrentTime(0);
        setDuration(0);
        setPreviewSource(null);
        previewSourceRef.current = null;
        setPlaybackUnavailable(true);

        return;

      }

    }


    const preview =
      source &&
      typeof source === "object" &&
      source.type === "preview"
        ? source
        : null;

    setPreviewSource(preview);
    previewSourceRef.current = preview;
    setPlaybackUnavailable(false);


    const streamUrl =
      getStreamUrl(
        song.id,
        source,
        streamQualityRef.current
      );


    audioRef.current.pause();

    deckGainRef.current.set(
      audioRef.current,
      replayGainMultiplierForSong(song)
    );

    audioRef.current.src =
      streamUrl;

    applyDeckVolume(audioRef.current);


    setCurrentSong(song);

    setCurrentTime(0);

    setDuration(0);

    // Reset trim bounds for the new track; graceful fallback to the full
    // track until (and unless) an analysis is available.
    trimBoundsRef.current = null;

    if (silenceTrimSettings.enabled && !preview) {
      getSilenceAnalysis(song.id)
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
        .catch(() => {
          // Analysis unavailable — play the full track.
        });
    }


    try {

      await audioRef.current.play();

      if (
        requestId === playbackRequestRef.current
      ) {
        setIsPlaying(true);
        addToRecentlyPlayed(song);
        recordRecentlyPlayed(song.id).catch((error) => {
          console.error(
            "Could not record recently played:",
            error
          );
        });
      }

    } catch (error) {

      if (
        requestId === playbackRequestRef.current
      ) {
        setIsPlaying(false);
      }

    }

  }


  async function playSong(song) {
    if (!song) {
      return;
    }

    setPlaybackContext(null);
    setQueue([song]);
    setQueueIndex(0);

    await loadAndPlaySong(song);
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


  function deckGain(audio) {
    return deckGainRef.current.get(audio) || 1;
  }


  function applyDeckVolume(audio, intensity = 1) {
    if (!audio) {
      return;
    }

    audio.volume = Math.max(
      0,
      Math.min(
        1,
        volumeRef.current * deckGain(audio) * intensity
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


  /*
   * NEXT SONG
   */

  async function nextSong() {

    /*
     * No queue:
     * create a fresh random queue.
     */

    if (
      queue.length === 0 ||
      queueIndex < 0
    ) {

      try {

        const randomSongs =
          await getRandomSongs(10);


        if (
          !randomSongs ||
          randomSongs.length === 0
        ) {

          setIsPlaying(false);

          return;

        }


        setQueue(randomSongs);

        setQueueIndex(0);


        await loadAndPlaySong(
          randomSongs[0]
        );

      } catch (error) {

        console.error(
          "Could not create queue:",
          error
        );

        setIsPlaying(false);

      }

      return;

    }


    const nextIndex =
      queueIndex + 1;


    /*
     * Existing next song.
     */

    if (
      nextIndex < queue.length
    ) {

      setQueueIndex(
        nextIndex
      );


      await loadAndPlaySong(
        queue[nextIndex]
      );


      /*
       * Refill after advancing.
       */

      const updatedQueue =
        await refillQueue(
          queue,
          nextIndex
        );


      setQueue(
        updatedQueue
      );


      return;

    }


    /*
     * End of queue.
     *
     * Generate 10 completely
     * new random songs.
     */

    try {

      const randomSongs =
        await getRandomSongs(10);


      if (
        !randomSongs ||
        randomSongs.length === 0
      ) {

        setIsPlaying(false);

        return;

      }


      setQueue(
        randomSongs
      );

      setQueueIndex(0);


      await loadAndPlaySong(
        randomSongs[0]
      );

    } catch (error) {

      console.error(
        "Could not generate new songs:",
        error
      );

      setIsPlaying(false);

    }

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

      audioRef.current.currentTime =
        0;

      return;

    }


    /*
     * Go backwards if possible.
     */

    if (
      queue.length === 0 ||
      queueIndex <= 0
    ) {

      audioRef.current.currentTime =
        0;

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

    let source =
      nextTrack.playableSource ||
      nextTrack.sourceId ||
      null;

    if (
      !source &&
      !isLibraryPlayable(nextTrack)
    ) {
      try {
        const resolution =
          await getPlayableSources(nextTrack);

        source =
          resolution.selectedSource ||
          (resolution.sources || []).find(
            (candidate) =>
              candidate.availability === "available"
          ) ||
          null;
      } catch (error) {
        source = null;
      }
    }

    if (
      transitionToken !== crossfadeTokenRef.current
    ) {
      return;
    }

    if (
      !source &&
      !isLibraryPlayable(nextTrack)
    ) {
      isCrossfadingRef.current = false;
      return;
    }

    const incomingPreview =
      source &&
      typeof source === "object" &&
      source.type === "preview"
        ? source
        : null;

    incomingAudio.pause();
    incomingAudio.src =
      getStreamUrl(
        nextTrack.id,
        source,
        streamQualityRef.current
      );
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

    const fadeDurationMs =
      Math.max(100, fadeSeconds * 1000);

    function finishCrossfade() {
      if (
        transitionToken !== crossfadeTokenRef.current
      ) {
        return;
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

      addToRecentlyPlayed(nextTrack);
      recordRecentlyPlayed(nextTrack.id).catch((error) => {
        console.error(
          "Could not record recently played:",
          error
        );
      });

      if (
        silenceTrimSettings.enabled &&
        !incomingPreview
      ) {
        getSilenceAnalysis(nextTrack.id)
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
          })
          .catch(() => {
            // Analysis unavailable — play the full incoming track.
          });
      }

      refillQueue(queue, nextIndex)
        .then((updatedQueue) => {
          if (
            audioRef.current === incomingAudio
          ) {
            setQueue(updatedQueue);
          }
        });
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


    if (isPlaying) {

      if (isCrossfadingRef.current) {
        cancelCrossfade();
      }

      audioRef.current.pause();

    } else {

      audioRef.current.play().catch(() => {
        setIsPlaying(false);
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


    setDuration(
      activeAudio.duration
    );

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


  /*
   * SONG FINISHED
   */

  function handleEnded() {

    if (isCrossfadingRef.current) {
      return;
    }

    nextSong();

  }


  return (

    <PlayerContext.Provider
      value={{

        currentSong,

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

        volume,

        crossfadeDuration,

        streamQuality,

        isReplayGainEnabled,

        playSong,

        playSongFromSource,

        playContext,

        playQueue,

        playQueueSong,

        nextSong,

        previousSong,

        toggleShuffle,

        toggleLoop,

        togglePlay,

        toggleLike,

        seek,

        changeVolume,

        changeCrossfadeDuration,

        changeStreamQuality,

        changeReplayGainEnabled,

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
            setIsPlaying(false);
            setDuration(0);
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
            setIsPlaying(false);
            setDuration(0);
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
