import { Fragment } from "react";
import { Link } from "react-router-dom";
import { toArtistRouteIdFromApiId } from "../utils/idResolver";
import PlaylistSearchHighlight from "./playlists/PlaylistSearchHighlight";

export type TrackArtistCredit = { id: string | null; name: string };

type Props = {
  song: { artist?: string; artistId?: string | null; artistCredits?: TrackArtistCredit[];
    metadata?: { [key: string]: unknown } };
  className?: string;
  artistId?: string | null;
  fallback?: string;
  searchTokens?: readonly string[];
  onNavigate?: () => void;
};

export default function TrackArtistLinks({ song, className, artistId, fallback, searchTokens, onNavigate }: Props) {
  const id = artistId !== undefined ? artistId
    : song.artistId ?? (typeof song.metadata?.artistId === "string" ? song.metadata.artistId : null);
  const credits = song.artistCredits?.length ? song.artistCredits
    : [{ id, name: (id ? song.artist : fallback ?? song.artist) || "Unknown artist" }];

  return <span className={className}>
    {credits.map((credit, index) => {
      const label = <PlaylistSearchHighlight text={credit.name} tokens={searchTokens} />;
      return <Fragment key={credit.id ?? `${credit.name}:${index}`}>
        {index > 0 && ", "}
        {credit.id ? <Link className="track-artist-link"
          to={`/artist/${encodeURIComponent(toArtistRouteIdFromApiId(credit.id))}`}
          onClick={(event) => { event.stopPropagation(); onNavigate?.(); }}>{label}</Link> : label}
      </Fragment>;
    })}
  </span>;
}
