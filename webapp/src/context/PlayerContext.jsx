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
      })
      .catch(() => {
        // Silence trimming stays disabled when settings cannot be loaded.
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);


  /*
   * LOAD LIKED SONGS
   */

  function resetPlayer() {
    playbackRequestRef.current += 1;

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

    if (audioRef.current) {

      audioRef.current.volume =
        volume;

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
      getStreamUrl(song.id, source);


    audioRef.current.pause();

    audioRef.current.src =
      streamUrl;


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

  function handleTimeUpdate() {

    if (!audioRef.current) {
      return;
    }


    setCurrentTime(
      audioRef.current.currentTime
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

    if (
      previewDuration &&
      audioRef.current.currentTime >= previewDuration
    ) {

      audioRef.current.pause();
      handleEnded();
      return;

    }

    // Effective track end: when trailing silence has been detected and
    // trimming is enabled, treat that boundary as "the track finished"
    // instead of waiting for the full (silent) tail to play out.
    const bounds = trimBoundsRef.current;
    if (
      silenceTrimSettings.enabled &&
      bounds &&
      bounds.trailing > 0 &&
      audioRef.current.duration &&
      audioRef.current.currentTime >= audioRef.current.duration - bounds.trailing
    ) {
      handleEnded();
    }

  }


  /*
   * METADATA
   */

  function handleLoadedMetadata() {

    if (!audioRef.current) {
      return;
    }


    setDuration(
      audioRef.current.duration
    );

    // Start playback at the first-audio position when trim bounds are
    // already known (analysis resolved before metadata finished loading).
    const bounds = trimBoundsRef.current;
    if (
      silenceTrimSettings.enabled &&
      bounds &&
      bounds.leading > 0
    ) {
      audioRef.current.currentTime = bounds.leading;
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


    setVolume(newVolume);


    if (audioRef.current) {

      audioRef.current.volume =
        newVolume;

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


  /*
   * SONG FINISHED
   */

  function handleEnded() {

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

        likedSongIds,

        isCurrentSongLiked,

        playbackContext,

        isPreview: Boolean(previewSource),

        previewDurationSeconds:
          (previewSource &&
            previewSource.quality &&
            previewSource.quality.durationSeconds) ||
          null,

        playbackUnavailable,

        volume,

        playSong,

        playSongFromSource,

        playQueue,

        playQueueSong,

        nextSong,

        previousSong,

        togglePlay,

        toggleLike,

        seek,

        changeVolume,

        resetPlayer,

      }}
    >

      {children}


      <audio
        ref={audioRef}

        onTimeUpdate={
          handleTimeUpdate
        }

        onLoadedMetadata={
          handleLoadedMetadata
        }

        onPlay={() =>
          setIsPlaying(true)
        }

        onPause={() =>
          setIsPlaying(false)
        }

        onError={() => {
          setIsPlaying(false);
          setDuration(0);
        }}

        onEnded={
          handleEnded
        }
      />

    </PlayerContext.Provider>

  );

}


export function usePlayer() {

  return useContext(
    PlayerContext
  );

}
