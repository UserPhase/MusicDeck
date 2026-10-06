import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Album from "./Album";
import { getAlbum } from "../api/musicdeck";
import { usePlayer } from "../context/PlayerContext";

jest.mock("../api/musicdeck", () => ({
  ...jest.requireActual("../api/musicdeck"),
  getAlbum: jest.fn(),
}));
jest.mock("../context/PlayerContext", () => ({ usePlayer: jest.fn() }));
jest.mock("../components/TrackRow", () => () => null);
jest.mock("../components/CollectionDownloadButton", () => () => null);
jest.mock("../components/AlbumDeleteButton", () => () => null);

function renderAlbum(data) {
  getAlbum.mockResolvedValue(data);
  usePlayer.mockReturnValue({ playContext: jest.fn(), playQueue: jest.fn() });
  return render(<MemoryRouter initialEntries={["/album/album-1"]}>
    <Routes><Route path="/album/:id" element={<Album />} /></Routes>
  </MemoryRouter>);
}

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
