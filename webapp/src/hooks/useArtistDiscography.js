import { useQuery } from "@tanstack/react-query";

import { getArtistDiscography, getArtistOverview } from "../api/musicdeck";
import { usePrivacy } from "../context/PrivacyContext";

/**
 * Local artist data is its own query and always resolves first. The external
 * query starts only after it supplies a verified local artist, keeping the
 * page responsive when Deezer or iTunes are slow.
 */
export function useArtistDiscography(artistId, userId) {
  const { canMetadata } = usePrivacy();
  const local = useQuery({
    queryKey: ["artist-overview", userId || "anonymous", artistId, "local"],
    queryFn: () => getArtistOverview(artistId, { scope: "local" }),
    enabled: Boolean(artistId) && !artistId.startsWith("external_") && !artistId.startsWith("extdetail_"),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
  const external = useQuery({
    queryKey: ["artist-discography", userId || "anonymous", artistId],
    queryFn: () => getArtistDiscography(artistId),
    enabled: canMetadata && Boolean(local.data?.artist?.id),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 1,
  });

  return {
    local: local.data || null,
    missingAlbums: canMetadata ? external.data?.missingAlbums || [] : [],
    missingTracks: canMetadata ? external.data?.missingTracks || [] : [],
    isLocalLoading: local.isLoading,
    isEnriching: canMetadata && external.isFetching,
    localError: local.error || null,
    externalError: canMetadata ? external.error || null : null,
  };
}

export default useArtistDiscography;
