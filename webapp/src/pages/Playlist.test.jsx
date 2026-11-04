import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import Playlist from "./Playlist";

import {
  getPlaylist,
  updatePlaylist,
  setPlaylistArtwork,
  clearPlaylistArtwork,
  reorderPlaylistItems,
  editPlaylistTracks,
  getPlaylists,
  getPlaylistRecommendations,
} from "../api/playlists";

import {
  getCoverUrl,
} from "../api/musicdeck";

import { usePlayer } from "../context/PlayerContext";
import { downloadToDevice } from "../utils/downloadManager";
import { offlineAuditor } from "../services/storage/OfflineAuditor";


jest.mock("../api/playlists", () => ({
  getPlaylist: jest.fn(),
  updatePlaylist: jest.fn(),
  removeSongFromPlaylist: jest.fn(),
  deletePlaylist: jest.fn(),
  setPlaylistArtwork: jest.fn(),
  clearPlaylistArtwork: jest.fn(),
  reorderPlaylistItems: jest.fn(),
  editPlaylistTracks: jest.fn(),
  getPlaylists: jest.fn(),
  getPlaylistRecommendations: jest.fn(),
}));

jest.mock("../api/musicdeck", () => ({
  getCoverUrl: jest.fn(),
  getStreamUrl: jest.fn(),
  getSavedDiscoveries: jest.fn(async () => ({ discoveries: [] })),
}));

jest.mock("../context/PlayerContext", () => ({
  usePlayer: jest.fn(),
}));
jest.mock("../context/AuthContext", () => ({ useAuth: () => ({ session: { id: "playlist-user", role: "user" } }) }));


jest.mock("../components/TrackDownloadButton", () => () => null);
jest.mock("../components/AvailabilityHint", () => () => null);
jest.mock("../utils/downloadManager", () => ({
  downloadToDevice: jest.fn(async () => ({})),
  readOfflineTrack: jest.fn(async () => null),
  subscribeDeviceDownload: () => () => {},
  isDeviceDownloadPending: () => false,
}));


const collagePlaylist = {
  permissions: { canRead: true, canEditTracks: true, canManage: true },
  sharingMode: "PRIVATE",
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

const playContext = jest.fn();
const togglePlay = jest.fn();
const addToQueue = jest.fn();
const queueTracks = jest.fn();
const playTracksNext = jest.fn();


function renderPlaylist(playlist = collagePlaylist, playerOverrides = {}, withNavigation = false) {
  jest.clearAllMocks();
  getPlaylistRecommendations.mockResolvedValue({ items: [], message: null, canModify: true });

  getCoverUrl.mockImplementation((id, size) =>
    id ? `/api/artwork/${id}${size ? `?size=${size}` : ""}` : null
  );

  usePlayer.mockReturnValue({
    playSong: jest.fn(),
    playContext,
    playQueue: jest.fn(),
    addToQueue,
    queueTracks,
    playTracksNext,
    playSongFromSource: jest.fn(),
    currentSong: null,
    isPlaying: false,
    togglePlay,
    ...playerOverrides,
  });

  getPlaylist.mockResolvedValue(playlist);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/playlist/mdpl_1"]}>
        <Routes>
          <Route path="/playlist/:id" element={<>{withNavigation && <Link to="/playlist/mdpl_other">Open another playlist</Link>}<Playlist /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const editablePlaylist = {
  ...collagePlaylist,
  itemIds: ["first", "missing", "second", "third"],
  songCount: 4,
  entry: [
    { id: "same", playlistItemId: "first", title: "First", artist: "Artist", isDownloaded: true },
    { id: "two", playlistItemId: "second", title: "Second", artist: "Artist", isDownloaded: true },
    { id: "same", playlistItemId: "third", title: "Third", artist: "Artist", isDownloaded: true },
  ],
};
test("viewer access keeps playback available while withholding sharing, artwork and track edit controls", async () => {
  renderPlaylist({ ...editablePlaylist, sharingMode: "SHARED_READ", permissions: { canRead: true, canEditTracks: false, canManage: false } });
  await screen.findByRole("row", { name: "First by Artist" });
  expect(screen.queryByRole("button", { name: "Share playlist" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Choose photo for Evening Drive" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "More options" }));
  expect(screen.getByRole("menuitem", { name: "Edit details" })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: "Delete playlist" })).toBeDisabled();
  expect(screen.queryByRole("menuitem", { name: "Remove from Playlist" })).not.toBeInTheDocument();
  expect(screen.getByText(/Viewer access/)).toBeInTheDocument();
});

test("grabbing a playlist track selects it without opening a separate batch action bar", async () => {
  renderPlaylist(editablePlaylist);
  const row = await screen.findByRole("row", { name: "First by Artist" });
  fireEvent.dragStart(row, { dataTransfer: { setData: jest.fn(), setDragImage: jest.fn() } });
  expect(row).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("complementary", { name: "Selected track actions" })).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Selected track actions" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /selected/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Move Up" })).not.toBeInTheDocument();
  fireEvent.dragEnd(row);
});

test("selection distinguishes duplicate occurrences and queues the selected group in playlist order", async () => {
  renderPlaylist(editablePlaylist);
  fireEvent.click(await screen.findByRole("row", { name: "First by Artist" }));
  fireEvent.click(screen.getByRole("row", { name: "Third by Artist" }), { ctrlKey: true });
  expect(screen.queryByRole("complementary", { name: "Selected track actions" })).not.toBeInTheDocument();
  fireEvent.contextMenu(screen.getByRole("row", { name: "Third by Artist" }), { clientX: 400, clientY: 250 });
  expect(screen.getByRole("row", { name: "First by Artist" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("row", { name: "Second by Artist" })).toHaveAttribute("aria-selected", "false");
  fireEvent.click(screen.getByRole("menuitem", { name: "Play Next" }));
  await waitFor(() => expect(playTracksNext).toHaveBeenCalledWith([editablePlaylist.entry[0], editablePlaylist.entry[2]]));
  fireEvent.contextMenu(screen.getByRole("row", { name: "Third by Artist" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Add to Queue/ }));
  await waitFor(() => expect(queueTracks).toHaveBeenCalledWith([editablePlaylist.entry[0], editablePlaylist.entry[2]]));
});

test("Ctrl/Cmd+A selects the entire playlist without row focus and background clicks clear it", async () => {
  renderPlaylist(editablePlaylist);
  await screen.findByRole("row", { name: "First by Artist" });
  const rows = () => screen.getAllByRole("row").filter((row) => row.hasAttribute("aria-selected"));
  fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
  rows().forEach((row) => expect(row).toHaveAttribute("aria-selected", "true"));
  fireEvent.click(screen.getByRole("heading", { name: "Evening Drive" }));
  rows().forEach((row) => expect(row).toHaveAttribute("aria-selected", "false"));
  fireEvent.keyDown(document.body, { key: "a", metaKey: true });
  rows().forEach((row) => expect(row).toHaveAttribute("aria-selected", "true"));
  fireEvent.contextMenu(screen.getByRole("row", { name: "Second by Artist" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Add to Queue/ }));
  await waitFor(() => expect(queueTracks).toHaveBeenCalledWith(editablePlaylist.entry));
  rows().forEach((row) => expect(row).toHaveAttribute("aria-selected", "true"));
  fireEvent.click(document.body);
  rows().forEach((row) => expect(row).toHaveAttribute("aria-selected", "false"));
  expect(screen.queryByRole("button", { name: /selected/i })).not.toBeInTheDocument();
});

test("select-all keeps native text editing and stops handling keys after leaving the playlist", async () => {
  const view = renderPlaylist(editablePlaylist);
  const row = await screen.findByRole("row", { name: "First by Artist" });
  const input = document.createElement("input");
  input.setAttribute("aria-label", "Search music");
  document.body.append(input);
  try {
    input.focus();
    expect(fireEvent.keyDown(input, { key: "a", ctrlKey: true })).toBe(true);
    expect(row).toHaveAttribute("aria-selected", "false");
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit details" }));
    expect(fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "a", ctrlKey: true })).toBe(true);
    expect(row).toHaveAttribute("aria-selected", "false");
    view.unmount();
    expect(fireEvent.keyDown(document.body, { key: "a", ctrlKey: true })).toBe(true);
  } finally { input.remove(); }
});

test("right-clicking an unselected row replaces the old selection and opens actions without playback", async () => {
  renderPlaylist(editablePlaylist);
  fireEvent.click(await screen.findByRole("row", { name: "First by Artist" }));
  const second = screen.getByRole("row", { name: "Second by Artist" });
  fireEvent.contextMenu(second, { clientX: 120, clientY: 180 });
  const menu = screen.getByRole("menu", { name: "Actions for Second" });
  expect(menu).toHaveStyle({ top: "180px" });
  expect(screen.getByRole("row", { name: "First by Artist" })).toHaveAttribute("aria-selected", "false");
  expect(second).toHaveAttribute("aria-selected", "true");
  expect(playContext).not.toHaveBeenCalled();
  expect(within(menu).getByRole("menuitem", { name: "Add to Playlist..." })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Remove from Playlist" })).toBeInTheDocument();
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Add to Queue/ }));
  await waitFor(() => expect(queueTracks).toHaveBeenCalledWith([editablePlaylist.entry[1]]));
});

test("keyboard reordering preserves unavailable slots and rolls back on failure without a floating toolbar", async () => {
  let rejectEdit;
  reorderPlaylistItems.mockImplementation(() => new Promise((_resolve, reject) => { rejectEdit = reject; }));
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  renderPlaylist(editablePlaylist);
  fireEvent.click(await screen.findByRole("row", { name: "Third by Artist" }));
  fireEvent.keyDown(screen.getByRole("row", { name: "Third by Artist" }), { key: "ArrowUp", altKey: true });
  expect(reorderPlaylistItems).toHaveBeenCalledWith("mdpl_1", ["first", "missing", "third", "second"], editablePlaylist.itemIds);
  expect(screen.getAllByRole("row").filter((row) => row.hasAttribute("aria-selected")).map((row) => row.getAttribute("aria-label")))
    .toEqual(["First by Artist", "Third by Artist", "Second by Artist"]);
  expect(screen.getByRole("row", { name: "Third by Artist" })).toHaveAttribute("draggable", "false");
  expect(screen.queryByRole("complementary", { name: "Selected track actions" })).not.toBeInTheDocument();
  await act(async () => rejectEdit(new Error("Playlist changed elsewhere. Reload and try again.")));
  expect(screen.getAllByRole("row").filter((row) => row.hasAttribute("aria-selected")).map((row) => row.getAttribute("aria-label")))
    .toEqual(["First by Artist", "Second by Artist", "Third by Artist"]);
  expect(screen.getByRole("row", { name: "Third by Artist" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("button", { name: "Reload playlist" })).toBeEnabled();
  expect(screen.getAllByRole("alert").some((alert) => alert.textContent.includes("changed elsewhere"))).toBe(true);
  log.mockRestore();
});

test("batch removal removes only selected occurrences and keeps selection on failure", async () => {
  renderPlaylist(editablePlaylist);
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  editPlaylistTracks.mockRejectedValueOnce(new Error("Network offline"));
  fireEvent.click(await screen.findByRole("row", { name: "First by Artist" }));
  fireEvent.contextMenu(screen.getByRole("row", { name: "First by Artist" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove from Playlist" }));
  await waitFor(() => expect(editPlaylistTracks).toHaveBeenCalledWith("mdpl_1", {
    action: "remove", itemIds: ["first"], expectedItemIds: editablePlaylist.itemIds,
  }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Network offline");
  fireEvent.contextMenu(screen.getByRole("row", { name: "First by Artist" }));
  expect(screen.getByRole("row", { name: "First by Artist" })).toHaveAttribute("aria-selected", "true");
  editPlaylistTracks.mockResolvedValueOnce({
    ...editablePlaylist, itemIds: ["missing", "second", "third"], songCount: 3, entry: editablePlaylist.entry.slice(1),
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove from Playlist" }));
  await waitFor(() => expect(screen.queryByRole("row", { name: "First by Artist" })).not.toBeInTheDocument());
  expect(screen.getByRole("row", { name: "Third by Artist" })).toBeInTheDocument();
  expect(screen.queryByRole("complementary", { name: "Selected track actions" })).not.toBeInTheDocument();
  confirm.mockRestore();
  log.mockRestore();
});

test("Add to Playlist loads destinations and sends one idempotent batch", async () => {
  renderPlaylist(editablePlaylist);
  getPlaylists.mockResolvedValue([{ id: "destination", name: "Road Trip" }]);
  editPlaylistTracks.mockResolvedValue(editablePlaylist);
  fireEvent.keyDown(await screen.findByRole("row", { name: "First by Artist" }), { key: "a", ctrlKey: true });
  fireEvent.contextMenu(screen.getByRole("row", { name: "First by Artist" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Add to Playlist..." }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Road Trip" }));
  await waitFor(() => expect(editPlaylistTracks).toHaveBeenCalledWith("destination", {
    action: "add", trackIds: ["same", "two"],
  }));
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
});

test("downloads deduplicate song IDs and clearly report partial failures", async () => {
  renderPlaylist(editablePlaylist);
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  const audit = jest.spyOn(offlineAuditor, "recordDownloaded").mockResolvedValue({ status: "verified" });
  downloadToDevice.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Network offline"));
  fireEvent.keyDown(await screen.findByRole("row", { name: "First by Artist" }), { key: "a", ctrlKey: true });
  fireEvent.contextMenu(screen.getByRole("row", { name: "First by Artist" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Download Selected" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("1 completed; 1 failed");
  expect(downloadToDevice).toHaveBeenCalledTimes(2);
  expect(downloadToDevice.mock.calls.map(([trackId]) => trackId)).toEqual(["same", "two"]);
  expect(screen.getByRole("alert")).toHaveTextContent("Network offline");
  audit.mockRestore();
  log.mockRestore();
});

test("a successful reorder response cannot overwrite a different playlist after navigation", async () => {
  let finish;
  reorderPlaylistItems.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  renderPlaylist(editablePlaylist, {}, true);
  fireEvent.click(await screen.findByRole("row", { name: "Third by Artist" }));
  fireEvent.keyDown(screen.getByRole("row", { name: "Third by Artist" }), { key: "ArrowUp", altKey: true });
  getPlaylist.mockResolvedValueOnce({ ...collagePlaylist, id: "mdpl_other", name: "Other Playlist" });
  fireEvent.click(screen.getByRole("link", { name: "Open another playlist" }));
  expect(await screen.findByRole("heading", { name: "Other Playlist" })).toBeInTheDocument();
  await act(async () => finish({ ...editablePlaylist, entry: [...editablePlaylist.entry].reverse() }));
  expect(screen.getByRole("heading", { name: "Other Playlist" })).toBeInTheDocument();
  expect(screen.queryByRole("row", { name: "First by Artist" })).not.toBeInTheDocument();
});

test("a failed keyboard reorder cannot display stale errors on a different playlist", async () => {
  let fail;
  reorderPlaylistItems.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  renderPlaylist(editablePlaylist, {}, true);
  fireEvent.keyDown(await screen.findByRole("row", { name: "Third by Artist" }), { key: "ArrowUp", altKey: true });
  getPlaylist.mockResolvedValueOnce({ ...collagePlaylist, id: "mdpl_other", name: "Other Playlist" });
  fireEvent.click(screen.getByRole("link", { name: "Open another playlist" }));
  expect(await screen.findByRole("heading", { name: "Other Playlist" })).toBeInTheDocument();
  await act(async () => fail(new Error("Old playlist network failure")));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  log.mockRestore();
});


test("clicking a playlist row starts its full playback context", async () => {
  const playlist = {
    ...collagePlaylist,
    entry: [
      { id: "track-1", title: "First", artist: "Artist" },
      { id: "track-2", title: "Second", artist: "Artist" },
    ],
  };

  renderPlaylist(playlist);
  fireEvent.click(await screen.findByRole("button", { name: "Play Second" }));

  expect(playContext).toHaveBeenCalledWith(
    playlist.entry,
    1,
    {
      type: "playlist",
      id: playlist.id,
      name: playlist.name,
      coverArt: playlist.coverArt,
    }
  );
});


test("clicking the active playlist track toggles playback without rebuilding its queue", async () => {
  const playlist = {
    ...collagePlaylist,
    entry: [{ id: "track-1", title: "First", artist: "Artist" }],
  };

  renderPlaylist(playlist, { currentSong: playlist.entry[0], isPlaying: true });
  fireEvent.click(await screen.findByRole("button", { name: "Pause First" }));

  expect(togglePlay).toHaveBeenCalledTimes(1);
  expect(playContext).not.toHaveBeenCalled();
});

test("adds every playlist track to the end of the queue from the options menu", async () => {
  const playlist = {
    ...collagePlaylist,
    entry: [
      { id: "track-1", title: "First", artist: "Artist" },
      { id: "track-2", title: "Second", artist: "Artist" },
    ],
  };
  renderPlaylist(playlist);

  fireEvent.click(await screen.findByRole("button", { name: "More options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Add 2 tracks to queue" }));

  expect(addToQueue).toHaveBeenNthCalledWith(1, playlist.entry[0], 0, playlist.entry);
  expect(addToQueue).toHaveBeenNthCalledWith(2, playlist.entry[1], 1, playlist.entry);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(playContext).not.toHaveBeenCalled();
});

test("closes the edit details dialog with Escape", async () => {
  renderPlaylist();
  fireEvent.click(await screen.findByRole("button", { name: "More options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Edit details/ }));
  expect(await screen.findByRole("dialog", { name: "Edit details" })).toBeInTheDocument();

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Edit details" })).not.toBeInTheDocument();
});

test("renders the playlist description in the hero and saves edited details", async () => {
  const playlist = {
    ...collagePlaylist,
    description: "Spotify playlist notes\n\nImported from Spotify: https://open.spotify.com/playlist/abc",
  };
  renderPlaylist(playlist);

  expect(await screen.findByText(/Spotify playlist notes/)).toHaveTextContent("Imported from Spotify");
  fireEvent.click(screen.getByRole("button", { name: "More options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Edit details/ }));

  const name = await screen.findByRole("textbox", { name: "Name" });
  const description = screen.getByRole("textbox", { name: "Description" });
  expect(name).toHaveValue(playlist.name);
  expect(description).toHaveValue(playlist.description);

  fireEvent.change(name, { target: { value: "Updated playlist" } });
  fireEvent.change(description, { target: { value: "Updated description" } });
  updatePlaylist.mockResolvedValue({
    ...playlist,
    name: "Updated playlist",
    description: "Updated description",
  });
  fireEvent.keyDown(document, { key: "Enter", ctrlKey: true });

  await waitFor(() => expect(updatePlaylist).toHaveBeenCalledWith("mdpl_1", {
    name: "Updated playlist",
    description: "Updated description",
  }));
  expect(await screen.findByRole("heading", { name: "Updated playlist" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});


function coverInput() {
  return document.getElementById("playlist-cover-upload");
}

function imageFile(name = "cover.png", type = "image/png", size = 1024) {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

test("opens edit details from the title and saves the chosen cover with the name", async () => {
  renderPlaylist();
  fireEvent.click(await screen.findByRole("button", { name: "Evening Drive" }));
  const dialog = screen.getByRole("dialog", { name: "Edit details" });
  const fileInput = within(dialog).getByLabelText("Playlist cover image");
  const picker = jest.spyOn(fileInput, "click");
  fireEvent.click(within(dialog).getByRole("button", { name: "Choose playlist cover" }));
  expect(picker).toHaveBeenCalled();
  fireEvent.change(fileInput, { target: { files: [imageFile()] } });
  expect(await within(dialog).findByAltText("New cover preview")).toBeInTheDocument();
  expect(setPlaylistArtwork).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Night Drive" } });
  updatePlaylist.mockResolvedValue({ ...collagePlaylist, name: "Night Drive" });
  setPlaylistArtwork.mockResolvedValue(customPlaylist);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("heading", { name: "Night Drive" })).toBeInTheDocument();
  expect(setPlaylistArtwork).toHaveBeenCalledWith("mdpl_1", "data:image/png;base64,AAAA");
  expect(screen.queryByRole("dialog", { name: "Edit details" })).not.toBeInTheDocument();
});


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


test("a collage playlist offers the choose-photo overlay and no remove action", async () => {
  renderPlaylist();

  expect(await screen.findByText("Evening Drive")).toBeInTheDocument();

  expect(screen.getByRole("button", { name: /choose photo for evening drive/i })).toBeInTheDocument();
  expect(screen.queryByText("Upload cover")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /more options/i }));
  expect(screen.queryByRole("menuitem", { name: /remove custom cover/i })).toBeNull();

  // The page renders the same resolved artwork reference as everywhere else.
  expect(screen.getByAltText("Evening Drive cover")).toHaveAttribute(
    "src",
    "/api/artwork/mdplart_collage_mdpl_1"
  );
});


test("clicking the cover opens the hidden file picker", async () => {
  renderPlaylist();

  expect(await screen.findByText("Evening Drive")).toBeInTheDocument();

  const clickSpy = jest.spyOn(coverInput(), "click");
  fireEvent.click(screen.getByRole("button", { name: /choose photo/i }));
  expect(clickSpy).toHaveBeenCalled();
});


test("uploading custom artwork swaps the cover, syncs the sidebar, and reveals the remove action", async () => {
  renderPlaylist();

  expect(await screen.findByText("Evening Drive")).toBeInTheDocument();

  setPlaylistArtwork.mockResolvedValue(customPlaylist);
  const changed = jest.fn();
  window.addEventListener("playlistsChanged", changed);

  fireEvent.change(coverInput(), { target: { files: [imageFile()] } });

  await waitFor(() => {
    expect(setPlaylistArtwork).toHaveBeenCalledWith(
      "mdpl_1",
      "data:image/png;base64,AAAA"
    );
  });

  await waitFor(() => {
    expect(screen.getByAltText("Evening Drive cover")).toHaveAttribute(
      "src",
      "/api/artwork/mdplart_custom_mdpl_1"
    );
  });

  expect(changed).toHaveBeenCalled();
  window.removeEventListener("playlistsChanged", changed);

  fireEvent.click(screen.getByRole("button", { name: /more options/i }));
  expect(
    screen.getByRole("menuitem", { name: /remove custom cover/i })
  ).toBeInTheDocument();
});


test("removing custom artwork from the options menu falls back to the automatic collage", async () => {
  renderPlaylist(customPlaylist);

  expect(await screen.findByText("Evening Drive")).toBeInTheDocument();

  clearPlaylistArtwork.mockResolvedValue(collagePlaylist);

  fireEvent.click(screen.getByRole("button", { name: /more options/i }));
  fireEvent.click(screen.getByRole("menuitem", { name: /remove custom cover/i }));

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

  fireEvent.click(screen.getByRole("button", { name: /more options/i }));
  expect(screen.queryByRole("menuitem", { name: /remove custom cover/i })).toBeNull();
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
