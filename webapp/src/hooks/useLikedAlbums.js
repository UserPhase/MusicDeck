import { useMutation, useQuery } from "@tanstack/react-query";
import { getCoverUrl, getLikedAlbums, setMediaFavorite } from "../api/musicdeck";
import { artistOverviewQueryClient as client } from "../api/artistOverviewQuery";
import { useAuth } from "../context/AuthContext";
import { toAlbumRouteIdFromApiId } from "../utils/idResolver";

const empty = [];

/** Album favorites share one account-scoped cache across detail, sidebar and library. */
export function useLikedAlbums() {
  const userId = useAuth()?.session?.id;
  const queryKey = ["liked-albums", userId || "anonymous"];
  const query = useQuery({
    queryKey, queryFn: getLikedAlbums, enabled: Boolean(userId), retry: false,
    staleTime: 30_000,
  }, client);
  const mutation = useMutation({
    mutationFn: async ({ album, liked }) => {
      const id = toAlbumRouteIdFromApiId(album.id);
      const saved = { id, name: album.name || album.title || "Untitled album", artist: album.artist || "",
        coverUrl: album.coverUrl || getCoverUrl(album.coverArt, 360) || null };
      await setMediaFavorite("album", id, liked,
        liked ? { name: saved.name, artist: saved.artist, coverUrl: saved.coverUrl } : undefined);
      return { saved, liked };
    },
    onSuccess: async ({ saved, liked }) => {
      // A list request started before this save must not erase its result.
      await client.cancelQueries({ queryKey });
      client.setQueryData(queryKey, (current = []) => {
        const rest = current.filter((item) => item.id !== saved.id);
        return liked ? [saved, ...rest] : rest;
      });
    },
  }, client);
  return {
    albums: userId ? query.data || empty : empty,
    enabled: Boolean(userId), loading: Boolean(userId) && query.isPending,
    error: query.error, refresh: query.refetch,
    saving: mutation.isPending, saveError: mutation.error,
    setLiked: mutation.mutateAsync,
  };
}
