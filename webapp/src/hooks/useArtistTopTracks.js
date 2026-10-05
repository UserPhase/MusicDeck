import { useQuery } from "@tanstack/react-query";

import { getArtistTopTracks } from "../api/musicdeck";

export function useArtistTopTracks(artistId, userId) {
  return useQuery({
    queryKey: ["artist-top-tracks", userId || "anonymous", artistId],
    queryFn: () => getArtistTopTracks(artistId),
    enabled: Boolean(artistId) && !artistId.startsWith("external_") && !artistId.startsWith("extdetail_"),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 1,
  });
}

export default useArtistTopTracks;
