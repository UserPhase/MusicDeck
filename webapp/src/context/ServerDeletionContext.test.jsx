import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { deleteServerAlbum, deleteServerTrack } from "../api/adminMedia";
import { ServerDeletionProvider } from "./ServerDeletionContext";
import TrackContextMenu from "../components/TrackContextMenu";
import AlbumDeleteButton from "../components/AlbumDeleteButton";

jest.mock("./AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("../api/adminMedia", () => ({ deleteServerAlbum: jest.fn(), deleteServerTrack: jest.fn() }));
jest.mock("../components/TrackLikeButton", () => () => <button type="button">Like</button>);

const song = { id: "track-1", title: "Midnight Signal" };

function renderActions(role) {
  useAuth.mockReturnValue({ session: { id: "user-1", role } });
  return render(<MemoryRouter><ServerDeletionProvider>
    <TrackContextMenu song={song} isServerSynced offlineStatus="not-downloaded" />
    <AlbumDeleteButton album={{ id: "album-1", name: "Night Drive" }} />
  </ServerDeletionProvider></MemoryRouter>);
}

beforeEach(() => jest.clearAllMocks());

test("non-admin users cannot see deletion actions", () => {
  renderActions("user");
  expect(screen.queryByRole("menuitem", { name: /delete from server/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /more options for night drive/i })).toBeNull();
});

test("track deletion requires confirmation and reports success", async () => {
  deleteServerTrack.mockResolvedValue({ success: true });
  renderActions("admin");
  fireEvent.click(screen.getByRole("menuitem", { name: /delete from server/i }));
  expect(screen.getByRole("alertdialog", { name: "Permanently Delete File?" })).toHaveTextContent("Midnight Signal");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(deleteServerTrack).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: /delete from server/i }));
  fireEvent.click(screen.getByRole("button", { name: "Delete File" }));
  await waitFor(() => expect(deleteServerTrack).toHaveBeenCalledWith("track-1"));
  expect(await screen.findByRole("status")).toHaveTextContent("Track deleted from server.");
});

test("album card menu confirms deletion of the album", async () => {
  deleteServerAlbum.mockResolvedValue({ success: true, trackIds: ["track-1"] });
  renderActions("admin");
  fireEvent.click(screen.getByRole("button", { name: "More options for Night Drive" }));
  fireEvent.click(screen.getAllByRole("menuitem", { name: /delete from server/i })[1]);
  expect(screen.getByRole("alertdialog", { name: "Permanently Delete Album?" })).toHaveTextContent("Night Drive");
  fireEvent.click(screen.getByRole("button", { name: "Delete Album" }));
  await waitFor(() => expect(deleteServerAlbum).toHaveBeenCalledWith("album-1"));
  expect(await screen.findByRole("status")).toHaveTextContent("Album deleted from server.");
});
