import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ExternalAlbumCard from "./ExternalAlbumCard";

jest.mock("../hooks/useAlbumArtwork", () => ({
  useAlbumArtwork: () => ({ url: null, onError: () => {} }),
}));

test("external album cards open detail, retain preview playback and omit save/import controls", () => {
  const album = { id: "external_deezer_album_7", title: "Night Drive", artist: "Neon", external: true };
  const onPlay = jest.fn();
  render(<MemoryRouter><ExternalAlbumCard album={album} onPlay={onPlay} /></MemoryRouter>);
  expect(screen.getByRole("link", { name: "Open Night Drive" })).toHaveAttribute("href", "/album/external_deezer_album_7");
  fireEvent.click(screen.getByRole("button", { name: "Play Night Drive" }));
  expect(onPlay).toHaveBeenCalledWith(album);
  expect(screen.queryByRole("button", { name: /Save|Add to Library/i })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button")).toHaveLength(1);
});
