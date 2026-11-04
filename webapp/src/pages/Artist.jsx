import TrackActionScope from "../components/TrackActionScope";
import { EditionBadges } from "../components/common/EditionBadges";
import { usePrivacy } from "../context/PrivacyContext";
import { memo, useEffect, useState } from "react";

import {
  useParams,
  Link,
} from "react-router-dom";

import {
  getCoverUrl,
  createAcquisition,
} from "../api/musicdeck";
import ArtistAvatar from "../components/ArtistAvatar";
import ArtistFollowButton from "../components/ArtistFollowButton";
import FullHero from "../components/Layout/FullHero";
import ArtistBiography from "../components/ArtistBiography";
import InLibraryBadge from "../components/InLibraryBadge";
import { useArtistBiography } from "../hooks/useArtistBiography";
import { useMergedAlbums } from "../hooks/useMergedAlbums";
import { useArtistTopTracks } from "../hooks/useArtistTopTracks";
import { useUniversalArtist } from "../hooks/useUniversalArtist";

import TrackListHeader from "../components/TrackListHeader";
import TrackRow from "../components/TrackRow";
import { useServerDeletion } from "../context/ServerDeletionContext";


import {
  usePlayer,
} from "../context/PlayerContext";
import { useAuth } from "../context/AuthContext";
import UnifiedAlbumGrid from "../components/Artist/UnifiedAlbumGrid";

const ArtistAlbumCard = memo(function ArtistAlbumCard({ album, artistRouteId }) {
  const deletion = useServerDeletion();
  if (deletion?.deletedAlbums.has(String(album.id))) return null;
  const external = album.source?.kind === "external";
  return (
    <div className="album-card-shell">
    <Link to={external ? `/artist/${encodeURIComponent(artistRouteId)}/album/${album.id}` : `/album/${album.id}`} className="album">
      <div className="album-cover">
        {album.coverArt ? (
          <img src={getCoverUrl(album.coverArt, 300)} alt={`${album.name} cover`} loading="lazy" decoding="async" />
        ) : <div className="album-cover-placeholder">♪</div>}
      </div>
      <div className="album-title search-album-title">
        <span className="search-album-title-text">{album.name}</span>
        <InLibraryBadge visible={album.source?.kind === "external" && album.inLibrary} />
      </div>
      {album.year && <div className="album-artist">{album.year}</div>}
      <EditionBadges item={album} />
      {album.source?.kind === "external" && !album.inLibrary && (
        <div className="album-artist album-not-downloaded">Not downloaded</div>
      )}
    </Link>
    </div>
  );
}, (previous, next) => ["id", "name", "coverArt", "year", "inLibrary", "localAlbumId", "metadata"].every(
  (field) => previous.album[field] === next.album[field]
) && previous.album.source?.kind === next.album.source?.kind);

function ArtistBiographySection({ artist, songs }) {
  const localTrackId = songs.find((song) => song.id && song.source?.kind !== "external"
    && !String(song.id).startsWith("external_"))?.id;
  const { biography, loading, error } = useArtistBiography({
    artistId: artist.id, artistName: artist.name, trackId: localTrackId,
  });
  return (
    <section className="artist-about" aria-labelledby="artist-about-title">
      <div className="artist-section-header"><h2 id="artist-about-title">About {artist.name}</h2></div>
      <ArtistBiography biography={biography} loading={loading} emptyText={error || "Biography not available."} />
    </section>
  );
}

function Artist() {

  const { id } = useParams();
  const userId = useAuth()?.session?.id;
  const universalArtist = useUniversalArtist(id, userId);
  const topTracksQuery = useArtistTopTracks(universalArtist.apiId, userId);


  const [artist, setArtist] =
    useState(null);

  const [albums, setAlbums] =
    useState([]);
  const { albums: mergedAlbums, isLoadingExternal: isLoadingAlbums } = useMergedAlbums(universalArtist.apiId, userId, albums);

  const [songs, setSongs] =
    useState([]);

  const [songCount, setSongCount] =
    useState(0);

  const [albumCount, setAlbumCount] =
    useState(0);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(null);
  const [isImportingArtist, setIsImportingArtist] = useState(false);
  const { canImport } = usePrivacy();

  const {
    playQueue,
    playSong,
    playSongFromSource,
    isShuffleEnabled,
    toggleShuffle,
  } = usePlayer();


  /*
   * Load artist
   */

  useEffect(() => {
    if (universalArtist.isLoading) {
      setLoading(true);
      return;
    }
    if (universalArtist.error || !universalArtist.data?.artist) {
      setError(universalArtist.error?.message || "Artist not found.");
      setLoading(false);
      return;
    }

    const overview = universalArtist.data;
    const artistData = overview.artist;
    const artistAlbums = (artistData.album || []).filter((album) =>
      !album.artistId || String(album.artistId) === String(universalArtist.apiId)
    );
    const artistSongs = Array.isArray(overview.tracks) ? overview.tracks : [];
    const rankedSongs = Array.isArray(overview.topTracks) ? overview.topTracks : artistSongs;

    setError(null);
    setArtist(artistData);
    setAlbums(artistAlbums);
    setSongs(rankedSongs.slice(0, 10));
    setSongCount(typeof overview.localSongCount === "number" ? overview.localSongCount : 0);
    setAlbumCount(typeof overview.localAlbumCount === "number" ? overview.localAlbumCount : artistAlbums.length);
    setLoading(false);
  }, [universalArtist.apiId, universalArtist.data, universalArtist.error, universalArtist.isLoading]);

  async function importArtistDiscography() {
    if (!canImport || !artist) return;
    setIsImportingArtist(true);
    try {
      await createAcquisition({
        result: {
          id: artist.id,
          type: "artist",
          title: artist.name,
          artist: artist.name,
          provider: "external",
          source: { kind: "external", count: 0 },
          metadata: {},
        },
        sourceProvider: "spotdl",
      });
    } finally {
      setIsImportingArtist(false);
    }
  }

  const topTracks = topTracksQuery.data?.length ? topTracksQuery.data : songs;

  function handleTopTrack(song) {
    return playSong(song);
  }


  /*
   * Play entire artist
   */

  function playArtist() {

    if (
      songs.length === 0
    ) {

      return;

    }


    playQueue(
      songs,
      0
    );

  }


  /*
   * Loading
   */

  if (loading) {

    return (

      <div className="artist-page detail-hero-gradient artist-page-loading" aria-label="Loading artist" aria-busy="true">
        <div className="artist-back artist-skeleton artist-skeleton-back" />
        <div className="artist-header">
          <div className="artist-page-cover artist-skeleton" />
          <div className="artist-page-info artist-skeleton-info">
            <div className="artist-skeleton artist-skeleton-kicker" />
            <div className="artist-skeleton artist-skeleton-name" />
            <div className="artist-skeleton artist-skeleton-meta" />
          </div>
        </div>
        <div className="artist-albums">
          <div className="artist-skeleton artist-skeleton-section-title" />
          <div className="artist-skeleton-albums">
            {Array.from({ length: 5 }, (_, index) => <div className="artist-skeleton artist-skeleton-album" key={index} />)}
          </div>
        </div>
        <div className="artist-tracks">
          <div className="artist-skeleton artist-skeleton-section-title" />
          <div className="artist-skeleton-rows">
            {Array.from({ length: 10 }, (_, index) => <div className="artist-skeleton artist-skeleton-row" key={index} />)}
          </div>
        </div>

      </div>

    );

  }

  /*
   * Error
   */

  if (
    error ||
    !artist
  ) {

    return (

      <div className="artist-page">

        <Link
          to="/library/artists"
          className="artist-back"
        >
          ← Back
        </Link>


        <div className="error">

          {error ||
            "Artist not found."}

        </div>

      </div>

    );

  }

  return (

    <div
      className="artist-page detail-hero-gradient"
    >


      {/* BACK */}

      <Link
        to="/library/artists"
        className="artist-back"
      >
        ← Back
      </Link>


      {/* ARTIST HEADER */}

      <FullHero
        className="artist-header"
        artwork={<ArtistAvatar key={id} artist={artist} className="artist-page-cover" enableMusicBrainzFallback />}
        eyebrow={universalArtist.isExternal ? "EXTERNAL ARTIST" : "ARTIST"}
        title={artist.name}
        metadata={
          <div className="artist-meta">
            {albumCount} {albumCount === 1 ? "album" : "albums"}
            {" · "}
            {songCount} {songCount === 1 ? "song" : "songs"}
            {artist.source?.kind !== "external" && " in library"}
          </div>
        }
        actions={
          <>
            <ArtistFollowButton artistId={universalArtist.apiId} artistName={artist.name} />
            {(!universalArtist.isExternal || canImport) && <button
              className="artist-play"
              onClick={universalArtist.isExternal ? importArtistDiscography : playArtist}
              disabled={universalArtist.isExternal ? isImportingArtist : songs.length === 0}
            >
              {universalArtist.isExternal ? "☁" : "▶"}
              <span>
                {universalArtist.isExternal ? (isImportingArtist ? "Adding…" : "Import Discography") : "Play"}
              </span>
            </button>}
            <button
              type="button"
              className={`detail-secondary-action${isShuffleEnabled ? " is-active" : ""}`}
              aria-label="Toggle shuffle"
              aria-pressed={Boolean(isShuffleEnabled)}
              onClick={toggleShuffle}
            >
              ⇄
            </button>
          </>
        }
      />


      <ArtistBiographySection artist={artist} songs={songs} />


      {/* ALBUMS */}

      {(mergedAlbums.length > 0 || isLoadingAlbums) && (

        <section className="artist-albums">

          <div className="artist-section-header">

            <h2>
              Albums
            </h2>

            {isLoadingAlbums && <span className="artist-enrichment-status" role="status">Finding more releases…</span>}

          </div>


          <div className="album-grid">

            {albums.map((album) => <ArtistAlbumCard key={album.id} album={album} artistRouteId={id} />)}
            <UnifiedAlbumGrid albums={mergedAlbums.filter((album) => album.discographySource === "external")} artistId={id} />

          </div>

        </section>

      )}

      {/* TRACKS */}

      <section className="artist-tracks">

        <div className="artist-section-header">

          <h2>Top 10 Popular Tracks</h2>

        </div>


        <div className="track-list" role="table" aria-label="Artist tracks">

          <TrackListHeader />

          {topTracks.length === 0 && !topTracksQuery.isFetching && (

            <div className="artist-tracks-empty" role="row">
              <span role="cell">No tracks yet.</span>
            </div>

          )}

          <TrackActionScope tracks={topTracks} dataKey={id}>
                {topTracks.map(
            (song, index) => (
            <TrackRow
              key={`${song.id}-${index}`}
              song={song}
              index={index}
              showDownloadStatus={false}
              showSourceIndicator
              onPlay={handleTopTrack}
              onSelectSource={playSongFromSource}


            />

          ))}
        </TrackActionScope>

        </div>

      </section>

    </div>

  );

}


export default Artist;
