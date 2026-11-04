import { useParams } from "react-router-dom";
import Album from "./Album";

/** Keep existing artist-album links while using the same view as library albums. */
export default function ArtistExternalAlbum() {
  const { id: artistId, albumId } = useParams();
  return <Album albumId={albumId} backTo={`/artist/${encodeURIComponent(artistId)}`} />;
}
