import { uniqueTracks } from "./uniqueTracks";

test("prefers exact track and recording IDs with a conservative metadata fallback", () => {
  const first = { id: "first", title: "Café", artist: "A & B", duration: 180 };
  const sameRecording = { ...first, id: "local", identityHints: { isrc: "US-ABC-20-12345" } };
  const alias = { id: "external", title: "Different catalog title", identityHints: { isrc: "usabc2012345" } };
  const live = { ...first, id: "live", title: "Café (Live)" };
  const longer = { ...first, id: "long", duration: 240 };
  const distinct = { ...first, id: "distinct", identityHints: { isrc: "USABC2012346" } };
  const unknown = { title: "Unknown title", artist: "Unknown artist" };
  expect(uniqueTracks([
    sameRecording,
    { ...sameRecording, title: "New metadata" },
    alias,
    { ...first, id: "fallback", title: "CAFE", artistName: "A and B", artist: undefined },
    live, longer, distinct,
    { ...unknown, id: "unknown-1" }, { ...unknown, id: "unknown-2" },
  ]).map(track => track.id)).toEqual(["local", "live", "long", "distinct", "unknown-1", "unknown-2"]);
});
