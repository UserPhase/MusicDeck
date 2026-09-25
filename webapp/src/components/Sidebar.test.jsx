import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import Sidebar, { isSpotifyPlaylistUrl } from "./Sidebar";

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


function renderSidebar(playlists) {
  getCoverUrl.mockImplementation((id, size) =>
    id ? `/api/artwork/${id}${size ? `?size=${size}` : ""}` : null
  );
  getPlaylists.mockResolvedValue(playlists);

  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="route">{location.pathname}</div>;
  }

  return render(
    <MemoryRouter>
      <Sidebar />
      <LocationProbe />
    </MemoryRouter>
  );
}

beforeEach(() => jest.clearAllMocks());


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

  expect(screen.getByText(/Fetching playlist details and queueing download/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
  await waitFor(() => expect(getSpotifyPlaylistImport).toHaveBeenCalledWith("job-2"), { timeout: 3000 });
  await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent("/playlist/mdpl_two"));
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
