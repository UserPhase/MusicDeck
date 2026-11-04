export function normalizePlaylistSearch(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

export function playlistSearchMatches(text: string, tokens: readonly string[]): [number, number][] {
  if (!tokens.length) return [];
  const normalized = normalizePlaylistSearch(text);
  const matches: [number, number][] = [];
  for (const token of tokens) {
    if (!token) continue;
    for (let index = normalized.indexOf(token); index !== -1; index = normalized.indexOf(token, index + 1)) {
      matches.push([index, index + token.length]);
    }
  }
  if (!matches.length) return [];

  // Preserve the original spelling, including combining accents removed by search.
  const starts: number[] = [], ends: number[] = [];
  for (const { 0: character, index: offset } of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const width = normalizePlaylistSearch(character).length;
    for (let i = 0; i < width; i++) {
      starts.push(offset!);
      ends.push(offset! + character.length);
    }
  }
  const ranges: [number, number][] = [];
  for (const [start, end] of matches.sort((a, b) => a[0] - b[0])) {
    const from = starts[start], to = ends[end - 1];
    if (from === undefined || to === undefined) continue;
    const previous = ranges.at(-1);
    if (previous && from <= previous[1]) previous[1] = Math.max(previous[1], to);
    else ranges.push([from, to]);
  }
  return ranges;
}
export function playlistTrackSearchText(track: Record<string, any>): string {
  const metadata = track.metadata || {};
  const genres = track.genres || metadata.genres || track.genre || metadata.genre || [];
  const names = (Array.isArray(genres) ? genres : [genres]).map(genre => typeof genre === "string" ? genre : genre?.name || "");
  return normalizePlaylistSearch([track.title, track.artist || track.artistName || metadata.artistName,
    track.album || track.albumName || metadata.albumName, ...names].filter(Boolean).join(" "));
}
