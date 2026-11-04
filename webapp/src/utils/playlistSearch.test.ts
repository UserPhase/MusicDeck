import { normalizePlaylistSearch, playlistSearchMatches, playlistTrackSearchText } from "./playlistSearch";
test("playlist search indexes title, artist, album and every genre with accent folding", () => {
  const text = playlistTrackSearchText({ title: "L'été", artist: "Björk", album: "Evening", metadata: { genres: ["Ambient", { name: "Jazz" }] } });
  for (const query of ["ete", "bjork", "evening", "ambient", "jazz"]) expect(text).toContain(normalizePlaylistSearch(query));
});

test("highlights every match in the original text, merging overlapping tokens", () => {
  const title = "Ánana e\u0301te\u0301";
  const spans = playlistSearchMatches(title, ["ana", "ete"]).map(([start, end]) => title.slice(start, end));
  expect(spans).toEqual(["Ánana", "e\u0301te\u0301"]);
  expect(playlistSearchMatches("ABBA", ["a"])).toEqual([[0, 1], [3, 4]]);
});
