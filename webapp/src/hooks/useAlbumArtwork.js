import { useMemo, useRef, useState } from "react";
import { artworkCandidates } from "../utils/resolveArtworkUrl";
import { getEffectiveAlbumCover } from "../utils/resolveAlbumArtwork";

export function useAlbumArtwork(item, size = 360) {
  const [failures, setFailures] = useState({ key: null, urls: [] });
  const artist = item?.artist || item?.artistName;
  const album = typeof item?.album === "string" ? item.album : item?.album?.name || item?.albumName || item?.name;
  const fallback = typeof artist === "string" && typeof album === "string"
    && artist.trim() && album.trim() && !/^unknown artist$/i.test(artist) && !/^unknown album$/i.test(album)
    ? `/api/metadata/album-artwork?${new URLSearchParams({ artist, album })}`
    : null;
  const effective = useMemo(() => getEffectiveAlbumCover(item, size), [item, size]);
  const candidates = [...new Set([effective, ...artworkCandidates(item, size), fallback].filter(Boolean))];
  const key = JSON.stringify([item?.id, candidates]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const failed = failures.key === key ? failures.urls : [];
  const url = candidates.find((candidate) => candidate && !failed.includes(candidate)) || null;
  return {
    url,
    onError: () => {
      if (url && currentKey.current === key) setFailures((previous) => {
        const urls = previous.key === key ? previous.urls : [];
        return { key, urls: urls.includes(url) ? urls : [...urls, url] };
      });
    },
  };
}
