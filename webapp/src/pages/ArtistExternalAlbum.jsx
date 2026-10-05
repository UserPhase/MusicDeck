import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { createAcquisition, getAlbum, getCoverUrl } from "../api/musicdeck";
import TrackListHeader from "../components/TrackListHeader";
import TrackRow from "../components/TrackRow";
import { usePlayer } from "../context/PlayerContext";

function acquisitionPayload(item, type) {
  return {
    result: {
      id: item.id,
      type,
      title: item.title || item.name,
      artist: item.artist || "",
      album: type === "track" ? item.album || "" : undefined,
      provider: item.provider || "external",
      source: item.source || { kind: "external", count: 0 },
      metadata: item.metadata || {},
    },
    ...(type === "album" ? { albumId: item.id } : { trackId: item.id }),
    sourceProvider: "spotdl",
  };
}

function ArtistExternalAlbum() {
  const { id: artistId, albumId } = useParams();
  const { playSong } = usePlayer();
  const [importing, setImporting] = useState(null);
  const albumQuery = useQuery({
    queryKey: ["external-album", albumId],
    queryFn: () => getAlbum(albumId),
    enabled: Boolean(albumId),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const album = albumQuery.data;

  async function importItem(item, type) {
    setImporting(type === "album" ? "album" : item.id);
    try {
      await createAcquisition(acquisitionPayload(item, type));
    } finally {
      setImporting(null);
    }
  }

  if (albumQuery.isLoading) return <div className="album-page">Loading release…</div>;
  if (albumQuery.error || !album) return <div className="album-page"><Link to={`/artist/${encodeURIComponent(artistId)}`}>← Back to artist</Link><p className="error">This external release is unavailable.</p></div>;

  const tracks = album.song || [];
  const cover = getCoverUrl(album.coverArt, 480);
  return <div className="album-page detail-hero-gradient external-album-page">
    <Link className="album-back" to={`/artist/${encodeURIComponent(artistId)}`}>← Back to artist</Link>
    <header className="album-header">
      <div className="album-page-cover">{cover ? <img src={cover} alt={`${album.name} cover`} /> : "♪"}</div>
      <div className="album-page-info"><div className="album-type">EXTERNAL RELEASE</div><h1>{album.name}</h1><p className="album-meta">{album.artist || "Unknown artist"} · {album.year || "Release"}</p>
        <button type="button" className="artist-play" disabled={importing === "album"} onClick={() => importItem(album, "album")}>{importing === "album" ? "Adding…" : "☁ Import Album"}</button>
      </div>
    </header>
    <section className="track-list" role="table" aria-label={`${album.name} tracks`}>
      <TrackListHeader />
      {tracks.map((track, index) => <TrackRow key={track.id} song={track} index={index} onPlay={playSong} />)}
    </section>
  </div>;
}

export default ArtistExternalAlbum;
