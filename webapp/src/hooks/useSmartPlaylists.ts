import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { listSmartPlaylists } from "../api/musicdeck";
import { artistOverviewQueryClient as client } from "../api/artistOverviewQuery";
import { useAuth } from "../context/AuthContext";
import type { SmartPlaylist } from "../api/smartPlaylists";

const empty: SmartPlaylist[] = [];
export function useSmartPlaylists() {
  const userId = useAuth()?.session?.id;
  const query = useQuery({
    queryKey: ["smart-playlists", userId || "anonymous"], enabled: Boolean(userId),
    queryFn: async (): Promise<SmartPlaylist[]> => (await listSmartPlaylists()).playlists,
    staleTime: 30_000, retry: false,
  }, client);
  useEffect(() => {
    const refresh = () => { void client.invalidateQueries({ queryKey: ["smart-playlists", userId || "anonymous"] }); };
    window.addEventListener("smartPlaylistsChanged", refresh);
    return () => window.removeEventListener("smartPlaylistsChanged", refresh);
  }, [userId]);
  return { items: userId ? query.data || empty : empty, loading: Boolean(userId) && query.isPending, error: query.error, refresh: query.refetch };
}
