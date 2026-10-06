import { getEffectiveAlbumCover } from "./resolveAlbumArtwork";

test("skips known default root and track URLs before rendering external child art", () => {
  expect(getEffectiveAlbumCover({
    coverUrl: "/api/artwork/al-0", coverArt: "al-0",
    song: [
      { coverUrl: "/images/placeholder.png" },
      { artwork: { id: "deezer", url: "https://cdn.test/genuine.jpg" }, provider: "external" },
    ],
  })).toBe("https://cdn.test/genuine.jpg");
});

test("opaque HTTP 200 placeholders rejected by the backend cannot reappear from children", () => {
  expect(getEffectiveAlbumCover({
    unavailableArtworkIds: ["mdart_default"],
    song: [{ coverArt: "mdart_default" }, { coverUrl: "/api/artwork/mdart_default?size=360" },
      { coverUrl: "https://cdn.test/real.jpg" }],
  })).toBe("https://cdn.test/real.jpg");
});

test("preserves genuine root artwork; all-placeholder albums have no effective cover", () => {
  expect(getEffectiveAlbumCover({ coverUrl: "https://cdn.test/root.jpg",
    tracks: [{ coverUrl: "https://cdn.test/child.jpg" }] })).toBe("https://cdn.test/root.jpg");
  expect(getEffectiveAlbumCover({ coverArt: "al-0", tracks: [{ coverArt: "default-cover" }] })).toBeNull();
});
