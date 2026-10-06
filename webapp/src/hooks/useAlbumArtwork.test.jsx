import { act, fireEvent, render, screen } from "@testing-library/react";
import { useAlbumArtwork } from "./useAlbumArtwork";

function Artwork({ item }) {
  const { url, onError } = useAlbumArtwork(item);
  return url ? <img src={url} onError={onError} alt="Cover" /> : <span>No cover</span>;
}

test("prefers supplied URL and falls back to native artwork then same-origin lookup on image errors", () => {
  render(<Artwork item={{ coverArt: "native", coverUrl: "https://example.test/cover.jpg", artist: "Artist", album: "Album" }} />);
  expect(screen.getByAltText("Cover")).toHaveAttribute("src", "https://example.test/cover.jpg");
  fireEvent.error(screen.getByAltText("Cover"));
  expect(screen.getByAltText("Cover")).toHaveAttribute("src", "/api/artwork/native?size=360");
  fireEvent.error(screen.getByAltText("Cover"));
  expect(screen.getByAltText("Cover")).toHaveAttribute("src", "/api/metadata/album-artwork?artist=Artist&album=Album");
  fireEvent.error(screen.getByAltText("Cover"));
  expect(screen.getByText("No cover")).toBeInTheDocument();
});

test("looks up missing album covers without changing identity and retries for a new item", () => {
  const { rerender } = render(<Artwork item={{ artist: "Artist", name: "Album" }} />);
  fireEvent.error(screen.getByAltText("Cover"));
  rerender(<Artwork item={{ artist: "Other", name: "Different Album" }} />);
  expect(screen.getByAltText("Cover")).toHaveAttribute("src", "/api/metadata/album-artwork?artist=Other&album=Different+Album");
});

test("does not look up unknown artists or albums", () => {
  render(<Artwork item={{ artist: "Unknown artist", album: "Unknown album" }} />);
  expect(screen.getByText("No cover")).toBeInTheDocument();
});

test("resets failed covers when the album identity changes even if URLs are shared", () => {
  const shared = { coverUrl: "https://example.test/shared.jpg" };
  const { rerender } = render(<Artwork item={{ ...shared, id: "first" }} />);
  fireEvent.error(screen.getByAltText("Cover"));
  expect(screen.getByText("No cover")).toBeInTheDocument();
  rerender(<Artwork item={{ ...shared, id: "second" }} />);
  expect(screen.getByAltText("Cover")).toHaveAttribute("src", shared.coverUrl);
});

test("ignores delayed image errors from the previous album", () => {
  let latest;
  function Capture({ item }) {
    latest = useAlbumArtwork(item);
    return null;
  }
  const coverUrl = "https://example.test/shared.jpg";
  const { rerender } = render(<Capture item={{ id: "first", coverUrl }} />);
  const previousError = latest.onError;
  rerender(<Capture item={{ id: "second", coverUrl }} />);
  act(() => previousError());
  expect(latest.url).toBe(coverUrl);
});
