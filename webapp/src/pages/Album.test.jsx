import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Album from "./Album";
import ArtistExternalAlbum from "./ArtistExternalAlbum";
import { getAlbum } from "../api/musicdeck";
import { usePlayer } from "../context/PlayerContext";
import { useExternalAction } from "../services/externalActions";
import { usePrivacy } from "../context/PrivacyContext";

jest.mock("../api/musicdeck", () => ({
  ...jest.requireActual("../api/musicdeck"),
  getAlbum: jest.fn(),
}));
jest.mock("../context/PlayerContext", () => ({ usePlayer: jest.fn() }));
jest.mock("../components/TrackRow", () => () => null);
jest.mock("../components/CollectionDownloadButton", () => () => null);
jest.mock("../components/AlbumDeleteButton", () => () => null);
jest.mock("../services/externalActions", () => ({ useExternalAction: jest.fn() }));
jest.mock("../context/PrivacyContext", () => ({ usePrivacy: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  usePrivacy.mockReturnValue({ canMetadata: true, canImport: true, canArtwork: true });
  useExternalAction.mockReturnValue({ snapshot: { state: "IDLE", message: null }, start: jest.fn() });
});

function renderAlbum(data, route = "/album/album-1") {
  getAlbum.mockResolvedValue(data);
  usePlayer.mockReturnValue({ playContext: jest.fn(), playQueue: jest.fn() });
  return render(<MemoryRouter initialEntries={[route]}>
    <Routes><Route path="/album/:id" element={<Album />} /><Route path="/artist/:id/album/:albumId" element={<ArtistExternalAlbum />} /></Routes>
  </MemoryRouter>);
}

test("the whole-album Play action supplies explicit album context", async () => {
  renderAlbum({ id: "album-1", name: "Record", artist: "Artist", song: [{ id: "one" }, { id: "two" }] });
  fireEvent.click(await screen.findByRole("button", { name: /Play/ }));
  expect(usePlayer().playQueue).toHaveBeenCalledWith([{ id: "one" }, { id: "two" }], 0, expect.objectContaining({ type: "album", id: "album-1" }));
});

test("an undownloaded album uses the shared hero, library count, preview queue and import action", async () => {
  const album = { id: "external_deezer_album_42", name: "Undownloaded Record", artist: "Artist", source: { kind: "external" },
    trackCount: 2, localTrackCount: 0, song: [
      { id: "unavailable", title: "No preview" },
      { id: "preview", title: "Preview", previewUrl: "https://cdns-preview-a.dzcdn.net/song.mp3" },
    ] };
  const start = jest.fn();
  useExternalAction.mockReturnValue({ snapshot: { state: "IDLE", message: null }, start });
  renderAlbum(album, "/album/deezer_album_42");
  expect(await screen.findByRole("heading", { name: album.name })).toBeInTheDocument();
  expect(getAlbum).toHaveBeenCalledWith("external_deezer_album_42");
  expect(screen.getByText("0 / 2 in library")).toBeInTheDocument();
  expect(screen.getByRole("table", { name: "Album tracks" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Play$/ }));
  expect(usePlayer().playQueue).toHaveBeenCalledWith(album.song, 1, expect.objectContaining({ type: "album", id: album.id }));
  fireEvent.click(screen.getByRole("button", { name: "Add to Library" }));
  expect(start).toHaveBeenCalledTimes(1);
});

test("artist album links render the shared album page and retain their back destination", async () => {
  renderAlbum({ id: "external_itunes_album_9", name: "Artist Release", artist: "Artist", song: [],
    trackCount: 0, localTrackCount: 0 }, "/artist/ext:itunes:12/album/external_itunes_album_9");
  expect(await screen.findByRole("heading", { name: "Artist Release" })).toBeInTheDocument();
  expect(getAlbum).toHaveBeenCalledWith("external_itunes_album_9");
  expect(screen.getByRole("link", { name: "← Back" })).toHaveAttribute("href", "/artist/ext%3Aitunes%3A12");
  expect(screen.getByRole("button", { name: /Play$/ })).toBeDisabled();
});

test("privacy policy blocks external album loading without blocking local albums", async () => {
  usePrivacy.mockReturnValue({ canMetadata: false, canImport: false });
  renderAlbum({ id: "external_deezer_album_42", name: "Record", song: [] }, "/album/external_deezer_album_42");
  expect(screen.getByRole("status")).toHaveTextContent("External releases are disabled");
  expect(getAlbum).not.toHaveBeenCalled();
});

test("known HTTP 200 placeholders never become the hero src, even before an error event", async () => {
  renderAlbum({
    id: "album-1", name: "Demos", artist: "Dominic Fike",
    coverArt: "al-0", coverUrl: "/images/album-placeholder.png",
    song: [{ coverArt: "default-cover" }, { provider: "external", coverUrl: "https://cdn.test/real.jpg" }],
  });
  expect(await screen.findByAltText("Demos cover")).toHaveAttribute("src", "https://cdn.test/real.jpg");
});

test("Album hero uses Babydoll artwork when the root cover is missing", async () => {
  renderAlbum({
    id: "album-1", name: "Don't Forget About Me, Demos", artist: "Dominic Fike",
    song: [{ title: "No cover" }, { title: "Babydoll", coverUrl: "https://cdn.example.test/babydoll.jpg" }],
  });
  expect(await screen.findByAltText("Don't Forget About Me, Demos cover"))
    .toHaveAttribute("src", "https://cdn.example.test/babydoll.jpg");
});

test("failed root artwork tries every child before metadata lookup or placeholder", async () => {
  renderAlbum({
    id: "album-1", name: "Demos", artist: "Dominic Fike", coverArt: "broken",
    song: [{ coverUrl: "https://cdn.example.test/child.jpg" }, { coverArt: "working-child" }],
  });
  const image = await screen.findByAltText("Demos cover");
  expect(image).toHaveAttribute("src", "/api/artwork/broken?size=360");
  fireEvent.error(image);
  expect(image).toHaveAttribute("src", "https://cdn.example.test/child.jpg");
  fireEvent.error(image);
  expect(image).toHaveAttribute("src", "/api/artwork/working-child?size=360");
  fireEvent.error(image);
  expect(image).toHaveAttribute("src", "/api/metadata/album-artwork?artist=Dominic+Fike&album=Demos");
  fireEvent.error(image);
  expect(screen.getByLabelText("Artwork unavailable")).toBeInTheDocument();
});

test("does not cycle back to failed covers when more than six child images fail", async () => {
  renderAlbum({
    id: "album-1", name: "Demos", artist: "Dominic Fike",
    song: Array.from({ length: 9 }, (_, index) => ({ coverUrl: `https://cdn.example.test/${index}.jpg` })),
  });
  const image = await screen.findByAltText("Demos cover");
  for (let index = 0; index < 9; index++) {
    expect(image).toHaveAttribute("src", `https://cdn.example.test/${index}.jpg`);
    fireEvent.error(image);
  }
  expect(image).toHaveAttribute("src", "/api/metadata/album-artwork?artist=Dominic+Fike&album=Demos");
  fireEvent.error(image);
  expect(screen.queryByAltText("Demos cover")).not.toBeInTheDocument();
});
