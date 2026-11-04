import { EditionBadges } from "../components/common/EditionBadges";
import { collectorMetadata } from "../hooks/useCollectorFilters";
import TrackActionScope from "../components/TrackActionScope";
import {
  useEffect,
  useState,
} from "react";

import {
  useParams,
  Link,
} from "react-router-dom";

import {
  getAlbum,
} from "../api/musicdeck";
import { HeroArtwork } from "../components/Layout/FullHero";

import TrackListHeader from "../components/TrackListHeader";
import TrackRow from "../components/TrackRow";
import CollectionDownloadButton from "../components/CollectionDownloadButton";
import AlbumImportButton from "../components/AlbumImportButton";
import AlbumLikeButton from "../components/AlbumLikeButton";
import AlbumEditionPicker from "../components/AlbumEditionPicker";
import { useServerDeletion } from "../context/ServerDeletionContext";
import { usePrivacy } from "../context/PrivacyContext";
import { toAlbumRouteIdFromApiId, toArtistRouteIdFromApiId } from "../utils/idResolver";


import {
  usePlayer,
} from "../context/PlayerContext";

function Album({ albumId, backTo = "/library" } = {}) {
  const deletion = useServerDeletion();

  const params = useParams();
  const id = toAlbumRouteIdFromApiId(albumId ?? params.id);
  const external = /^(external_|extdetail_)/.test(id);
  const { canMetadata } = usePrivacy();


  const [album, setAlbum] =
    useState(null);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(null);

  useEffect(() => {
    const handleDeleted = (event) => {
      const ids = new Set(event.detail?.trackIds || []);
      if (ids.size) setAlbum((current) => current ? { ...current, song: (current.song || []).filter((song) => !ids.has(song.id)) } : current);
    };
    window.addEventListener("musicdeck:server-deleted", handleDeleted);
    return () => window.removeEventListener("musicdeck:server-deleted", handleDeleted);
  }, []);

  const {
    playContext,
    playQueue,
    playSongFromSource,
    downloadQuality,
    isShuffleEnabled,
    toggleShuffle,
  } = usePlayer();

  function handleTrackPlayback(song, index) {
    playContext(
      songs,
      index,
      {
        type: "album",
        id: album.id,
        name: album.name,
        coverArt: album.coverArt,
      }
    );
  }


  /*
   * Load album
   */

  useEffect(() => {
    let cancelled = false;

    if (external && !canMetadata) return () => { cancelled = true; };

    async function loadAlbum() {

      try {

        setLoading(true);
        setError(null);
        setAlbum(null);


        const data =
          await getAlbum(id);


        if (!cancelled) {
          setAlbum(data);
        }

      } catch (err) {

        console.error(
          "Could not load album:",
          err
        );


        if (!cancelled) {
          setError(
            err.message ||
            "Could not load album."
          );
        }

      } finally {

        if (!cancelled) {
          setLoading(false);
        }

      }

    }


    loadAlbum();

    return () => {
      cancelled = true;
    };

  }, [id, external, canMetadata]);


  /*
   * Loading
   */

  if (external && !canMetadata) return <div className="privacy-banner" role="status">
    External releases are disabled by server privacy policy. <Link to={backTo}>Back to your library</Link>
  </div>;

  if (loading || (album && String(album.id) !== id)) {

    return (

      <div className="album-page" data-view-loading="true">

        <div className="loading">
          Loading album...
        </div>

      </div>

    );

  }


  /*
   * Error
   */

  if (
    error ||
    !album
  ) {

    return (

      <div className="album-page">

        <Link
          to={backTo}
          className="album-back"
        >
          ← Back
        </Link>


        <div className="error">

          {error ||
            "Album not found."}

        </div>

      </div>

    );

  }


  const songs =
    (album.song || []).filter((song) => !deletion?.deletedTracks.has(String(song.id)));


  /*
   * Play entire album
   */

  function playAlbum() {

    if (
      songs.length === 0
    ) {
      return;
    }


    const startIndex = external ? songs.findIndex((song) => song.isDownloaded || song.availability?.libraryAvailable || song.source?.kind === "library" || song.previewUrl) : 0;
    if (startIndex < 0) return;
    playQueue(
      songs,
      startIndex,
      { type: "album", id: album.id, name: album.name, coverArt: album.coverArt }
    );

  }


  return (

    <div
      className="album-page detail-hero-gradient"
      data-view-loading={String(album.id) !== id}
    >


      {/* BACK */}

      <Link
        to={backTo}
        className="album-back"
      >
        ← Back
      </Link>


      {/* ALBUM HEADER */}

      <div className="album-header">


        {/* COVER */}

        <HeroArtwork entity={album} className="album-page-cover" />


        {/* INFO */}

        <div className="album-page-info">


          <div className="album-type">
            ALBUM
          </div>


          <h1>
            {album.name}
          </h1>
          <EditionBadges item={{ ...album, metadata: {
            ...album.metadata,
            formats: [...new Set(songs.flatMap(song => collectorMetadata(song).formats))],
          } }} />


          {/* ARTIST */}

          {album.artistId ? (

            <Link
              to={
                `/artist/${encodeURIComponent(toArtistRouteIdFromApiId(album.artistId))}`
              }
              className="album-artist"
            >
              {album.artist}
            </Link>

          ) : (

            <div className="album-artist">
              {album.artist}
            </div>

          )}


          {/* META */}

          <div className="album-meta">

            {album.year && (

              <>
                {album.year}
                {" · "}
              </>

            )}

            {album.genre && (
              <>
                {album.genre}
                {" · "}
              </>
            )}

            {album.label && (
              <>
                {album.label}
                {" · "}
              </>
            )}

            {songs.length}
            {" "}


            {songs.length === 1
              ? "song"
              : "songs"}

            {typeof album.trackCount === "number" &&
              typeof album.localTrackCount === "number" &&
              album.trackCount > album.localTrackCount && (
                <>
                  {" · "}
                  <span className="album-completion">
                    {album.localTrackCount} / {album.trackCount} in library
                  </span>
                </>
              )}

          </div>


          {/* ACTIONS */}

          <AlbumEditionPicker album={album} />

        </div>

      </div>

      <div className="detail-action-row album-actions">


            {/* PLAY */}

            <button
              className="album-play"
              onClick={playAlbum}
              disabled={
                songs.length === 0 || (external && !songs.some((song) => song.isDownloaded || song.availability?.libraryAvailable || song.source?.kind === "library" || song.previewUrl))
              }
            >

              ▶

              <span>
                Play
              </span>

            </button>

            <button
              type="button"
              className={`detail-secondary-action${isShuffleEnabled ? " is-active" : ""}`}
              aria-label="Toggle shuffle"
              aria-pressed={Boolean(isShuffleEnabled)}
              onClick={toggleShuffle}
            >
              ⇄
            </button>

            <CollectionDownloadButton
              tracks={songs}
              quality={downloadQuality}
              label="album"
              collectionId={album.id}
              collectionName={album.name || album.title}
            />
            {external && <AlbumImportButton album={album} />}


            {/* LIKE */}

            <AlbumLikeButton key={album.id} album={album} />


            {/* MORE */}


      </div>


      {/* TRACK LIST */}

      <div className="track-list" role="table" aria-label="Album tracks">

        <TrackListHeader showAlbum={false} />


        <TrackActionScope tracks={songs} dataKey={album?.id}>
                {songs.map(
          (song, index) => {

          const isDownloaded =
            typeof song.isDownloaded === "boolean"
              ? song.isDownloaded
              : Boolean(song.availability?.libraryAvailable) ||
                song.source?.kind === "library";

          return (
          <TrackRow
            key={`${song.id}-${index}`}
            song={song}
            index={index}
            showAlbum={false}
            showSourceIndicator
            dimWhenUnavailable
            isDownloaded={isDownloaded}
            artistFallback={isDownloaded ? song.artist : `${song.artist} · Not downloaded`}
            onPlay={handleTrackPlayback}
            onSelectSource={playSongFromSource}


          />

          );
        })}
        </TrackActionScope>

      </div>

    </div>

  );

}


export default Album;
