import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AlbumGrid, { AlbumGridCard } from "./AlbumGrid";
import { usePlayer } from "../context/PlayerContext";
import { useMediaQuery } from "../hooks/useMediaQuery";

jest.mock("../context/PlayerContext", () => ({ usePlayer: jest.fn() }));
jest.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: jest.fn() }));

jest.mock("../context/ServerDeletionContext", () => ({
  useServerDeletion: () => ({ deletedAlbums: new Set(), canDelete: false }),
}));
jest.mock("../context/PrivacyContext", () => ({
  usePrivacy: () => ({ canArtwork: true }),
}));

test("grid card falls back to track art / metadata when the album cover is a placeholder", () => {
  render(<MemoryRouter>
    <AlbumGridCard album={{ id: "a1", name: "Volume One", artist: "She & Him", coverArt: "al-0" }} />
  </MemoryRouter>);
  // al-0 is a known placeholder ID, so the resolver skips it and goes to the metadata lookup.
  const image = screen.getByAltText("Volume One cover");
  expect(image).toHaveAttribute("src", "/api/metadata/album-artwork?artist=She+%26+Him&album=Volume+One");
});

test("grid card uses the album cover URL and advances past it on image error", () => {
  render(<MemoryRouter>
    <AlbumGridCard album={{ id: "a1", name: "Demos", artist: "Artist", coverArt: "mdart_real" }} />
  </MemoryRouter>);
  const image = screen.getByAltText("Demos cover");
  expect(image).toHaveAttribute("src", "/api/artwork/mdart_real?size=180");
  fireEvent.error(image);
  expect(image).toHaveAttribute("src", "/api/metadata/album-artwork?artist=Artist&album=Demos");
});

test("grid card shows the placeholder glyph when no artwork resolves", () => {
  render(<MemoryRouter>
    <AlbumGridCard album={{ id: "a1", name: "Quiet", artist: "Unknown artist" }} />
  </MemoryRouter>);
  expect(screen.queryByAltText("Quiet cover")).not.toBeInTheDocument();
});

test("mobile renders two columns and moves the caption indicator with album playback", () => {
  useMediaQuery.mockReturnValue(true);
  usePlayer.mockReturnValue({ currentSong: { metadata: { albumId: "deezer_album_2" } }, isPlaying: true });
  const albums = [
    { id: "a1", name: "Volume One", artist: "Artist", coverArt: "mdart_first" },
    { id: "external_deezer_album_2", name: "Volume One", artist: "Artist", coverArt: "mdart_second" },
  ];
  const grid = () => <MemoryRouter><AlbumGrid itemCount={albums.length} getItem={index => albums[index]} /></MemoryRouter>;
  const { rerender } = render(grid());
  const row = screen.getByRole("listitem");
  const [first, second] = within(row).getAllByRole("link");
  expect(row.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  expect(first).not.toHaveClass("is-current");
  expect(second).toHaveAccessibleDescription("Now playing");
  expect(second.querySelector(".album-grid-title .track-equalizer")).toHaveClass("is-animating");
  expect(second.querySelector(".album-cover").querySelector("button, .track-equalizer")).toBeNull();
  expect(within(second).getByRole("img", { name: "Volume One cover" })).toHaveAttribute("width", "320");

  usePlayer.mockReturnValue({ currentSong: { mediaResume: { type: "album", mediaId: "a1" } }, isPlaying: false });
  rerender(grid());
  expect(first).toHaveAccessibleDescription("Playback paused");
  expect(first.querySelector(".track-equalizer")).toHaveClass("is-paused");
  expect(second).not.toHaveClass("is-current");
});
