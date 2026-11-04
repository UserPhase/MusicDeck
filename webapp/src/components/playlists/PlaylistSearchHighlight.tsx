import { Fragment } from "react";
import { playlistSearchMatches } from "../../utils/playlistSearch";

export default function PlaylistSearchHighlight({ text, tokens }: { text: string; tokens?: readonly string[] }) {
  if (!tokens?.length) return text;
  const ranges = playlistSearchMatches(text, tokens);
  if (!ranges.length) return text;
  let offset = 0;
  const fragments = ranges.map(([start, end]) => {
    const prefix = text.slice(offset, start);
    offset = end;
    return <Fragment key={start}>{prefix}<mark className="playlist-search-match">{text.slice(start, end)}</mark></Fragment>;
  });
  return <>{fragments}{text.slice(offset)}</>;
}
