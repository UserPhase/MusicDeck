import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AlbumEditionPicker, { albumReleaseName, matchingAlbumEditions } from "./AlbumEditionPicker";
import { getArtist } from "../api/musicdeck";

jest.mock("../api/musicdeck", () => ({ getArtist: jest.fn() }));
const original = { id: "original", name: "Night Drive", artist: "Chromatics", artistId: "artist", year: 2007, songCount: 16 };
const deluxe = { ...original, id: "deluxe", name: "Night Drive (Deluxe Edition)", year: 2017, songCount: 22 };
const remaster = { ...original, id: "remaster", name: "Night Drive - 2020 Remaster", year: 2020 };
const renderPicker = (album = original) => render(<MemoryRouter><AlbumEditionPicker album={album} /></MemoryRouter>);

beforeEach(() => jest.resetAllMocks());

test("matches local edition suffixes while retaining meaningful title qualifiers", () => {
  expect(albumReleaseName("Night Drive (Deluxe Edition) [2020 Remaster]")).toBe("night drive");
  expect(albumReleaseName("Night Drive Deluxe Edition")).toBe("night drive");
  const unrelated = [
    { ...original, id: "live", name: "Night Drive (Live)" },
    { ...deluxe, id: "other", artistId: "other-artist" },
    { ...deluxe, id: "cloud", source: { kind: "external" } },
    { ...deluxe, id: "cloud2", provider: "external" },
  ];
  expect(matchingAlbumEditions(original, [remaster, deluxe, original, ...unrelated]).map((album) => album.id))
    .toEqual(["original", "deluxe", "remaster"]);
});

test("shows distinct local editions and links without starting playback", async () => {
  getArtist.mockResolvedValue({ album: [original, deluxe, remaster] });
  renderPicker(deluxe);
  expect(screen.getByRole("status")).toHaveTextContent("Checking local editions");
  const navigation = await screen.findByRole("navigation", { name: "Album editions" });
  expect(navigation).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Deluxe/ })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: /Original/ })).toHaveAttribute("href", "/album/original");
  expect(screen.getByRole("link", { name: /Remaster/ })).toHaveAttribute("href", "/album/remaster");
  expect(getArtist).toHaveBeenCalledWith("artist");
});

test("single editions and unsupported identities render no switcher", async () => {
  getArtist.mockResolvedValue({ album: [original] });
  const { rerender } = renderPicker();
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  getArtist.mockClear();
  rerender(<MemoryRouter><AlbumEditionPicker album={{ ...original, artistId: null }} /></MemoryRouter>);
  expect(getArtist).not.toHaveBeenCalled();
  rerender(<MemoryRouter><AlbumEditionPicker album={{ ...original, artistId: "external_artist" }} /></MemoryRouter>);
  expect(getArtist).not.toHaveBeenCalled();
});

test("failed lookups surface a retry and stale requests never replace the current album", async () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    getArtist.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ album: [original, deluxe] });
    const { rerender } = renderPicker();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("navigation", { name: "Album editions" });
    let resolveOld;
    getArtist.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    rerender(<MemoryRouter><AlbumEditionPicker album={{ ...original, id: "stale" }} /></MemoryRouter>);
    getArtist.mockResolvedValueOnce({ album: [] });
    rerender(<MemoryRouter><AlbumEditionPicker album={{ ...original, id: "new", name: "Other album" }} /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    resolveOld({ album: [original, deluxe] });
    await waitFor(() => expect(screen.queryByRole("navigation")).not.toBeInTheDocument());
    expect(error).toHaveBeenCalled();
  } finally { error.mockRestore(); }
});
