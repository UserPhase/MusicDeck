import { useQuery } from "@tanstack/react-query";

import { getArtistOverview } from "../api/musicdeck";
import { parseArtistId, toArtistApiId } from "../utils/idResolver";

export function useUniversalArtist(rawId, userId) {
  const parsed = parseArtistId(rawId);
  const apiId = toArtistApiId(rawId);
  const isExternal = parsed.type !== "local";
  const local = useQuery({
    queryKey: ["artist-local", userId || "anonymous", apiId],
    queryFn: () => getArtistOverview(apiId, { scope: "local" }),
    enabled: Boolean(apiId) && !isExternal,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
  const shouldUseExternal = isExternal || local.isError || (local.isSuccess && !local.data?.artist);
  const external = useQuery({
    queryKey: ["artist-external", parsed.type, parsed.id],
    queryFn: () => getArtistOverview(apiId),
    enabled: Boolean(apiId) && shouldUseExternal,
    staleTime: 24 * 60 * 60_000,
    gcTime: 7 * 24 * 60 * 60_000,
    retry: 1,
  });
  const active = shouldUseExternal ? external : local;
  const data = active.data || null;
  return {
    ...active,
    data,
    apiId,
    isExternal: Boolean(data?.artist?.source?.kind === "external" || isExternal),
    localTrackCount: data?.localSongCount || 0,
  };
}

export default useUniversalArtist;
