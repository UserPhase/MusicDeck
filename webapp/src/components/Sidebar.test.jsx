import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import Sidebar, { isSpotifyPlaylistUrl } from "./Sidebar";
import { ImportProvider, useImport } from "../context/ImportContext";

import {
  getPlaylists,
  createPlaylist,
  startSpotifyPlaylistImport,
  getSpotifyPlaylistImport,
} from "../api/playlists";

import {
  getCoverUrl,
} from "../api/musicdeck";


jest.mock("../api/playlists", () => ({
  getPlaylists: jest.fn(),
  createPlaylist: jest.fn(),
  startSpotifyPlaylistImport: jest.fn(),
  getSpotifyPlaylistImport: jest.fn(),
}));

jest.mock("../api/musicdeck", () => ({
  getCoverUrl: jest.fn(),
}));
jest.mock("../context/AuthContext", () => ({ useAuth: () => ({ session: { id: "test-user" } }) }));

function ImportStatusButton() {
  const { job, isMinimized, openProgress } = useImport();
  return isMinimized && job?.status === "running"
    ? <button type="button" onClick={openProgress}>Show playlist import progress</button>
    : null;
}


function renderSidebar(playlists, initialPath = "/") {
  getCoverUrl.mockImplementation((id, size) =>
    id ? `/api/artwork/${id}${size ? `?size=${size}` : ""}` : null
  );
  getPlaylists.mockResolvedValue(playlists);

  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="route">{location.pathname}</div>;
  }

  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ImportProvider>
        <Sidebar />
        <ImportStatusButton />
        <LocationProbe />
      </ImportProvider>
    </MemoryRouter>
  );
}

beforeEach(() => { jest.clearAllMocks(); sessionStorage.clear(); });


test("sidebar playlist entries render the resolved playlist artwork", async () => {
  renderSidebar([
    {
      id: "mdpl_1",
      name: "Evening Drive",
      coverArt: "mdplart_sig1_mdpl_1",
      coverMode: "collage",
    },
    {
      id: "mdpl_2",
      name: "Focus",
      coverArt: "mdplart_sig2_mdpl_2",
      coverMode: "custom",
    },
  ]);

  expect(await screen.findByText("Evening Drive")).toBeInTheDocument();

  // Both artwork modes resolve through the same shared component and proxy,
  // requested at the small sidebar thumbnail size.
  expect(screen.getByAltText("Evening Drive cover")).toHaveAttribute(
    "src",
    "/api/artwork/mdplart_sig1_mdpl_1?size=64"
  );

  expect(screen.getByAltText("Focus cover")).toHaveAttribute(
    "src",
    "/api/artwork/mdplart_sig2_mdpl_2?size=64"
  );
});

test("sidebar navigation exposes section labels and synchronized active item icons", async () => {
  const { container } = renderSidebar([
    { id: "mdpl_1", name: "Evening Drive", coverArt: null, coverMode: null },
  ], "/library/playlists");

  expect(await screen.findByText("Evening Drive")).toBeInTheDocument();
  const sidebar = screen.getByRole("complementary", { name: "Main navigation" });
  expect(screen.getByRole("heading", { name: "Your Library" })).toHaveClass("nav-title");
  expect(screen.getByRole("heading", { name: "Playlists" })).toHaveClass("nav-title");

  const library = screen.getByRole("link", { name: /Library/ });
  expect(library).toHaveClass("nav-item", "active");
  expect(library).toHaveAttribute("aria-current", "page");
  expect(library.querySelector(".nav-icon")).toHaveClass("nav-icon");
  expect(container.querySelector(".playlist-nav-item")).toHaveClass("nav-item", "playlist-nav-item");
  expect(sidebar).toBeInTheDocument();
});


test("sidebar falls back to the note placeholder for a playlist without artwork", async () => {
  const { container } = renderSidebar([
    { id: "mdpl_3", name: "Brand New", coverArt: null, coverMode: null },
  ]);

  expect(await screen.findByText("Brand New")).toBeInTheDocument();

  await waitFor(() => {
    expect(
      container.querySelector(".nav-icon-playlist-placeholder")
    ).toBeInTheDocument();
  });

  expect(screen.queryByAltText("Brand New cover")).toBeNull();
});

test("both sidebar actions open the playlist path chooser", async () => {
  renderSidebar([]);
  await screen.findByText("Add playlist");
  fireEvent.click(screen.getAllByRole("button", { name: /add playlist/i })[0]);
  expect(screen.getByRole("dialog", { name: "Create New Playlist" })).toBeInTheDocument();
  expect(screen.getByRole("dialog").closest(".playlist-modal-backdrop").parentElement).toBe(document.body);
  expect(screen.getByRole("button", { name: /blank playlist/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /import spotify playlist/i })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close playlist dialog" }));
  fireEvent.click(screen.getAllByRole("button", { name: /add playlist/i })[1]);
  expect(screen.getByRole("dialog", { name: "Create New Playlist" })).toBeInTheDocument();
});

test("creates a blank playlist with its optional description", async () => {
  createPlaylist.mockImplementation(async () => {
    const playlist = { id: "mdpl_new", name: "Night Drive", coverArt: null };
    getPlaylists.mockResolvedValue([playlist]);
    return playlist;
  });
  renderSidebar([]);
  fireEvent.click(screen.getAllByRole("button", { name: /add playlist/i })[1]);
  fireEvent.click(screen.getByRole("button", { name: /blank playlist/i }));
  fireEvent.change(screen.getByLabelText(/playlist name/i), { target: { value: " Night Drive " } });
  fireEvent.change(screen.getByLabelText(/description/i), { target: { value: " After dark " } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  await waitFor(() => expect(createPlaylist).toHaveBeenCalledWith("Night Drive", "After dark"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText("Night Drive")).toBeInTheDocument();
});

test("rejects invalid Spotify links before starting an import", () => {
  renderSidebar([]);
  fireEvent.click(screen.getAllByRole("button", { name: /add playlist/i })[1]);
  fireEvent.click(screen.getByRole("button", { name: /import spotify playlist/i }));
  fireEvent.change(screen.getByLabelText("Spotify playlist URL"), { target: { value: "https://open.spotify.com/track/abc123" } });
  fireEvent.click(screen.getByRole("button", { name: "Import & Download" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Please enter a valid open.spotify.com/playlist URL");
  expect(startSpotifyPlaylistImport).not.toHaveBeenCalled();
  expect(isSpotifyPlaylistUrl("https://open.spotify.com/playlist/abc123?si=link")).toBe(true);
  expect(isSpotifyPlaylistUrl("https://open.spotify.com.evil.test/playlist/abc123")).toBe(false);
});

test("opens the imported playlist when the background job completes", async () => {
  startSpotifyPlaylistImport.mockResolvedValue({ id: "job-1", status: "completed", playlistId: "mdpl_imported", playlistName: "Road Trip" });
  renderSidebar([]);
  fireEvent.click(screen.getAllByRole("button", { name: /add playlist/i })[1]);
  fireEvent.click(screen.getByRole("button", { name: /import spotify playlist/i }));
  fireEvent.change(screen.getByLabelText("Spotify playlist URL"), { target: { value: "https://open.spotify.com/playlist/abc123?si=link" } });
  fireEvent.click(screen.getByRole("button", { name: "Import & Download" }));

  await waitFor(() => expect(startSpotifyPlaylistImport).toHaveBeenCalledWith("https://open.spotify.com/playlist/abc123?si=link"));
  await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent("/playlist/mdpl_imported"));
  expect(screen.getByRole("status")).toHaveTextContent("Successfully imported 'Road Trip'!");
  expect(getSpotifyPlaylistImport).not.toHaveBeenCalled();
});

test("warns about missing songs while opening a partially imported playlist", async () => {
  startSpotifyPlaylistImport.mockResolvedValue({
    id: "job-partial", status: "partial", playlistId: "mdpl_partial", playlistName: "Road Trip",
    expectedCount: 15, importedCount: 7, error: "Imported 7 of 15 songs. 8 could not be downloaded or indexed.",
  });
  renderSidebar([]);
  fireEvent.click(screen.getAllByRole("button", { name: /add playlist/i })[1]);
  fireEvent.click(screen.getByRole("button", { name: /import spotify playlist/i }));
  fireEvent.change(screen.getByLabelText("Spotify playlist URL"), { target: { value: "https://open.spotify.com/playlist/abc123" } });
  fireEvent.click(screen.getByRole("button", { name: "Import & Download" }));

  await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent("/playlist/mdpl_partial"));
  expect(screen.getByRole("alert")).toHaveTextContent("Imported 7 of 15 songs");
});

test("keeps the dialog loading while the import job is queued and polls for completion", async () => {
  startSpotifyPlaylistImport.mockResolvedValue({ id: "job-2", status: "queued" });
  getSpotifyPlaylistImport.mockResolvedValue({ id: "job-2", status: "completed", playlistId: "mdpl_two", playlistName: "Mix" });
  renderSidebar([]);
  fireEvent.click(screen.getAllByRole("button", { name: /add playlist/i })[1]);
  fireEvent.click(screen.getByRole("button", { name: /import spotify playlist/i }));
  fireEvent.change(screen.getByLabelText("Spotify playlist URL"), { target: { value: "https://open.spotify.com/playlist/abc123" } });
  fireEvent.click(screen.getByRole("button", { name: "Import & Download" }));

  expect(await screen.findByRole("dialog", { name: "Importing Playlist..." })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run in Background" })).toBeEnabled();
  await waitFor(() => expect(getSpotifyPlaylistImport).toHaveBeenCalledWith("job-2"), { timeout: 3000 });
  await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent("/playlist/mdpl_two"));
});

test("shows live track progress and reopens a minimized import", async () => {
  startSpotifyPlaylistImport.mockResolvedValue({ id: "job-live", status: "running", stage: "downloading", expectedCount: 12, downloadedCount: 1, currentTrack: 2, currentTrackName: "2hollis - crush" });
  getSpotifyPlaylistImport.mockResolvedValue({ id: "job-live", status: "running", stage: "downloading", expectedCount: 12, downloadedCount: 2, currentTrack: 3, currentTrackName: "Next song" });
  renderSidebar([]);
  fireEvent.click(screen.getAllByRole("button", { name: /add playlist/i })[1]);
  fireEvent.click(screen.getByRole("button", { name: /import spotify playlist/i }));
  fireEvent.change(screen.getByLabelText("Spotify playlist URL"), { target: { value: "https://open.spotify.com/playlist/abc123" } });
  fireEvent.click(screen.getByRole("button", { name: "Import & Download" }));
  expect(await screen.findByText("Downloading track 2 of 12")).toBeInTheDocument();
  expect(screen.getByText("Fetching: 2hollis - crush")).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
  fireEvent.click(screen.getByRole("button", { name: "Run in Background" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Importing playlist in the background...");
  await waitFor(() => expect(getSpotifyPlaylistImport).toHaveBeenCalledWith("job-live"), { timeout: 3000 });
  fireEvent.click(screen.getByRole("button", { name: "Show playlist import progress" }));
  expect(screen.getByRole("dialog", { name: "Importing Playlist..." })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close playlist dialog" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Show playlist import progress" })).toBeInTheDocument();
});

test("keeps the import form available for retry after a backend error", async () => {
  startSpotifyPlaylistImport.mockRejectedValueOnce(new Error("spotDL unavailable"));
  renderSidebar([]);
  fireEvent.click(screen.getAllByRole("button", { name: /add playlist/i })[1]);
  fireEvent.click(screen.getByRole("button", { name: /import spotify playlist/i }));
  fireEvent.change(screen.getByLabelText("Spotify playlist URL"), { target: { value: "https://open.spotify.com/playlist/abc123" } });
  fireEvent.click(screen.getByRole("button", { name: "Import & Download" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("spotDL unavailable");
  expect(screen.getByRole("button", { name: "Import & Download" })).toBeEnabled();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});
