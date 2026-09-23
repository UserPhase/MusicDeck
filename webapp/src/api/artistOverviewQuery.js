import { QueryClient } from "@tanstack/react-query";
import { getArtistOverview } from "./musicdeck";

// One small, page-specific cache survives navigation and coalesces duplicate
// requests without making the rest of the application depend on query state.
export const artistOverviewQueryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 5 * 60_000, retry: false },
  },
});

export function fetchArtistOverview(artistId, scope, userId) {
  return artistOverviewQueryClient.fetchQuery({
    queryKey: ["artist-overview", userId || "anonymous", artistId, scope || "full"],
    queryFn: () => getArtistOverview(artistId, scope ? { scope } : undefined),
  });
}
