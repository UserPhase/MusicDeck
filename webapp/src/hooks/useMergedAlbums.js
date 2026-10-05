import { useMemo } from "react";

import { useArtistDiscography } from "./useArtistDiscography";

export function useMergedAlbums(artistId, userId, localAlbums = []) {
  const discography = useArtistDiscography(artistId, userId);
  const albums = useMemo(() => [
    ...localAlbums.map((album) => ({ ...album, discographySource: "local" })),
    ...discography.missingAlbums,
  ], [localAlbums, discography.missingAlbums]);

  return { albums, isLoadingExternal: discography.isEnriching, error: discography.externalError };
}

export default useMergedAlbums;
