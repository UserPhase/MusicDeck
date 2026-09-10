import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import Playlist from "./Playlist";

import {
  getPlaylist,
  setPlaylistArtwork,
  clearPlaylistArtwork,
} from "../api/playlists";

import {
  getCoverUrl,
} from "../api/musicdeck";

import { usePlayer } from "../context/PlayerContext";


jest.mock("../api/playlists", () => ({
  getPlaylist: jest.fn(),
  removeSongFromPlaylist: jest.fn(),
  deletePlaylist: jest.fn(),
  setPlaylistArtwork: jest.fn(),
  clearPlaylistArtwork: jest.fn(),
}));

jest.mock("../api/musicdeck", () => ({
  getCoverUrl: jest.fn(),
  getStreamUrl: jest.fn(),
}));

jest.mock("../context/PlayerContext", () => ({
  usePlayer: jest.fn(),
}));

jest.mock("../components/SourceMenu", () => () => null);
jest.mock("../components/TrackDownloadButton", () => () => null);
jest.mock("../components/AvailabilityHint", () => () => null);


const collagePlaylist = {
  id: "mdpl_1",
  name: "Evening Drive",
  coverArt: "mdplart_collage_mdpl_1",
  coverMode: "collage",
  entry: [],
};

const customPlaylist = {
  ...collagePlaylist,
  coverArt: "mdplart_custom_mdpl_1",
  coverMode: "custom",
};


function renderPlaylist(playlist = collagePlaylist) {
  jest.clearAllMocks();

  getCoverUrl.mockImplementation((id, size) =>
    id ? `/api/artwork/${id}${size ? `?size=${size}` : ""}` : null
  );

  usePlayer.mockReturnValue({
    playSong: jest.fn(),
    playQueue: jest.fn(),
    currentSong: null,
    isPlaying: false,
  });

  getPlaylist.mockResolvedValue(playlist);

  return render(
    <MemoryRouter initialEntries={["/playlist/mdpl_1"]}>
      <Routes>
        <Route path="/playlist/:id" element={<Playlist />} />
      </Routes>
    </MemoryRouter>
  );
}


function coverInput() {
  return document.getElementById("playlist-cover-upload");
}

function imageFile(name = "cover.png", type = "image/png", size = 1024) {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}


beforeAll(() => {
  // jsdom's FileReader cannot read the stubbed file contents, and its
  // `result` is getter-only, so the reader is replaced wholesale.
  global.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,AAAA";
      this.onload?.();
    }
  };
});


test("a collage playlist offers an upload action and no remove action", async () => {
  renderPlaylist();

  expect(await screen.findByText("Evening Drive")).toBeInTheDocument();

  expect(screen.getByText("Upload cover")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /remove custom cover/i })).toBeNull();

  // The page renders the same resolved artwork reference as everywhere else.
  expect(screen.getByAltText("Evening Drive cover")).toHaveAttribute(
    "src",
    "/api/artwork/mdplart_collage_mdpl_1"
  );
});


test("uploading custom artwork swaps the cover and reveals the remove action", async () => {
  renderPlaylist();

  expect(await screen.findByText("Evening Drive")).toBeInTheDocument();

  setPlaylistArtwork.mockResolvedValue(customPlaylist);

  fireEvent.change(coverInput(), { target: { files: [imageFile()] } });

  await waitFor(() => {
    expect(setPlaylistArtwork).toHaveBeenCalledWith(
      "mdpl_1",
      "data:image/png;base64,AAAA"
    );
  });

  // Custom artwork overrides the collage, and the action becomes "Change".
  await waitFor(() => {
    expect(screen.getByAltText("Evening Drive cover")).toHaveAttribute(
      "src",
      "/api/artwork/mdplart_custom_mdpl_1"
    );
  });

  expect(screen.getByText("Change cover")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /remove custom cover/i })
  ).toBeInTheDocument();
});


test("removing custom artwork immediately falls back to the automatic collage", async () => {
  renderPlaylist(customPlaylist);

  expect(await screen.findByText("Evening Drive")).toBeInTheDocument();
  expect(screen.getByText("Change cover")).toBeInTheDocument();

  clearPlaylistArtwork.mockResolvedValue(collagePlaylist);

  fireEvent.click(screen.getByRole("button", { name: /remove custom cover/i }));

  await waitFor(() => {
    expect(clearPlaylistArtwork).toHaveBeenCalledWith("mdpl_1");
  });

  // No reload needed: the collage is shown straight away.
  await waitFor(() => {
    expect(screen.getByAltText("Evening Drive cover")).toHaveAttribute(
      "src",
      "/api/artwork/mdplart_collage_mdpl_1"
    );
  });

  expect(screen.getByText("Upload cover")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /remove custom cover/i })).toBeNull();
});


test("rejects an unsupported file type without uploading", async () => {
  renderPlaylist();

  expect(await screen.findByText("Evening Drive")).toBeInTheDocument();

  fireEvent.change(coverInput(), {
    target: { files: [imageFile("evil.html", "text/html")] },
  });

  expect(await screen.findByRole("alert")).toHaveTextContent(
    /PNG, JPEG, WebP, or GIF/i
  );

  expect(setPlaylistArtwork).not.toHaveBeenCalled();
});


test("rejects an oversized image without uploading", async () => {
  renderPlaylist();

  expect(await screen.findByText("Evening Drive")).toBeInTheDocument();

  fireEvent.change(coverInput(), {
    target: { files: [imageFile("big.png", "image/png", 6 * 1024 * 1024)] },
  });

  expect(await screen.findByRole("alert")).toHaveTextContent(/5 MB or smaller/i);

  expect(setPlaylistArtwork).not.toHaveBeenCalled();
});
