import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AlbumGridCard } from "./AlbumGrid";

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
