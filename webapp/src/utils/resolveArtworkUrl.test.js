import { artworkCandidates, resolveArtworkUrl } from "./resolveArtworkUrl";
import { getCoverUrl } from "../api/musicdeck";

test("album summaries try the resolved artwork before an opaque provider cover", () => {
  expect(artworkCandidates({ albumArtworkUrl: "/api/albums/md_album/artwork", coverArt: "opaque" }, 180))
    .toEqual(["/api/albums/md_album/artwork?size=180", "/api/artwork/opaque?size=180"]);
});

test("handles native IDs, absolute URLs, and authenticated relative URLs", () => {
  expect(getCoverUrl("al-1234", 230)).toBe("/api/artwork/al-1234?size=230");
  expect(getCoverUrl("https://cdn.example.test/cover.jpg", 230)).toBe("https://cdn.example.test/cover.jpg");
  expect(getCoverUrl("http://cdn.example.test/cover.jpg")).toBe("http://cdn.example.test/cover.jpg");
  expect(getCoverUrl("/api/artwork/mdart_1")).toBe("/api/artwork/mdart_1");
});

test("orders root, nested album, and all child track references without duplicate URLs", () => {
  const album = {
    coverUrl: "https://cdn.example.test/root.jpg", coverArt: "native",
    album: { coverUrl: "https://cdn.example.test/nested.jpg" },
    tracks: [{ title: "No art" }, { coverUrl: "https://cdn.example.test/child.jpg" }],
    song: [{ coverArt: "another" }, { coverUrl: "https://cdn.example.test/child.jpg" }],
  };
  expect(resolveArtworkUrl(album)).toBe(album.coverUrl);
  expect(artworkCandidates(album)).toEqual([
    album.coverUrl, "/api/artwork/native", album.album.coverUrl,
    "https://cdn.example.test/child.jpg", "/api/artwork/another",
  ]);
  expect(resolveArtworkUrl({})).toBeNull();
});
