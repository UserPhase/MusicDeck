import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TrackActionScope from "./TrackActionScope";
import TrackRow from "./TrackRow";
import { sendRecommendationFeedback } from "../api/musicdeck";
import { editPlaylistTracks, getPlaylists } from "../api/playlists";
import { useMediaQuery } from "../hooks/useMediaQuery";

jest.mock("../context/AuthContext", () => ({ useAuth: () => ({ session: { id: "owner" } }) }));
jest.mock("../context/PlayerContext", () => ({ usePlayer: () => ({}) }));
jest.mock("../context/PrivacyContext", () => ({ usePrivacy: () => ({ canImport: true }) }));
jest.mock("../api/musicdeck", () => ({ getCoverUrl: () => null, sendRecommendationFeedback: jest.fn() }));
jest.mock("../api/playlists", () => ({ getPlaylists: jest.fn(async () => []), editPlaylistTracks: jest.fn() }));
jest.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: jest.fn(() => false) }));
jest.mock("../services/storage/OfflineDownloadEngine", () => ({ offlineDownloadEngine: { getOwner: () => "owner" } }));
jest.mock("../services/storage/OfflineAuditor", () => ({ useOfflineAudit: () => ({ status: "missing" }), offlineDisplayStatus: () => "not-downloaded" }));
jest.mock("../utils/downloadManager", () => ({ isDeviceDownloadPending: () => false, subscribeDeviceDownload: () => () => {} }));
jest.mock("../hooks/useSavedDiscoveries", () => ({ useSavedDiscoveries: () => ({ save: jest.fn() }) }));
jest.mock("./TrackDownloadButton", () => () => null);
jest.mock("./RecommendationMenuItems", () => () => null);
function Harness() {
  const [tracks, setTracks] = useState([
    { id: "a", title: "First", artist: "Artist", source: { kind: "library" } },
    { id: "b", title: "Second", artist: "Artist", source: { kind: "library" } },
  ]);
  sendRecommendationFeedback.mockImplementation(async ({ itemId }) => {
    if (itemId === "a") { setTracks((items) => items.filter((track) => track.id !== "a")); return { ok: true }; }
    throw new Error("Server unavailable for Second");
  });
  return <MemoryRouter><TrackActionScope tracks={tracks} dataKey="recommendations">
    {tracks.map((song, index) => <TrackRow key={song.id} song={song} index={index} onPlay={() => {}} />)}
  </TrackActionScope></MemoryRouter>;
}

test("three-dot actions open for the clicked track without selecting it or replacing an existing selection", () => {
  render(<Harness />);
  const first = screen.getByRole("row", { name: "First by Artist" });
  const second = screen.getByRole("row", { name: "Second by Artist" });
  fireEvent.click(screen.getByRole("button", { name: "More options for First" }));
  expect(screen.getByRole("menu", { name: "Actions for First" })).toBeInTheDocument();
  expect(first).toHaveAttribute("aria-selected", "false");
  expect(screen.queryByRole("button", { name: "Actions for selected tracks" })).not.toBeInTheDocument();

  fireEvent.click(second, { ctrlKey: true });
  fireEvent.click(screen.getByRole("button", { name: "More options for First" }));
  fireEvent.click(screen.getByRole("button", { name: "More options for First" }));
  expect(screen.getByRole("menu", { name: "Actions for First" })).toBeInTheDocument();
  expect(first).toHaveAttribute("aria-selected", "false");
  expect(second).toHaveAttribute("aria-selected", "true");
});

test("batch errors remain visible in the collection when a successful first mutation removes its invoking row", async () => {
  sendRecommendationFeedback.mockClear(); render(<Harness />);
  const first = screen.getByRole("row", { name: "First by Artist" });
  fireEvent.keyDown(first, { key: "a", ctrlKey: true });
  fireEvent.contextMenu(first);
  fireEvent.click(screen.getByRole("menuitem", { name: "Hide from recommendations" }));
  await waitFor(() => expect(sendRecommendationFeedback).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("row", { name: "First by Artist" })).not.toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent("1 completed; 1 failed. Server unavailable for Second");
  expect(screen.getByRole("row", { name: "Second by Artist" })).toHaveAttribute("aria-selected", "true");
});

test("mobile artist text plays the track and the sheet adds it to a filtered editable playlist", async () => {
  useMediaQuery.mockReturnValue(true);
  const proto = window.HTMLDialogElement.prototype;
  const oldShow = proto.showModal;
  const oldClose = proto.close;
  proto.showModal = function () { this.setAttribute("open", ""); };
  proto.close = function () { this.removeAttribute("open"); };
  try {
    getPlaylists.mockResolvedValue([
      { id: "p1", name: "Café at night" },
      { id: "p2", name: "Café read only", permissions: { canEditTracks: false } },
      { id: "p3", name: "Morning mix" },
    ]);
    editPlaylistTracks.mockResolvedValue({ id: "p1" });
    const song = { id: "one", title: "Song", artist: "Artist", artistId: "artist", albumId: "album", source: { kind: "library" } };
    const onPlay = jest.fn();
    render(<MemoryRouter><TrackRow song={song} mobile index={0} onPlay={onPlay} /></MemoryRouter>);
    fireEvent.click(screen.getByText("Artist"));
    expect(onPlay).toHaveBeenCalledWith(song, 0);
    expect(screen.queryByRole("link", { name: "Artist" })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "More options for Song" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Actions for Song" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to artist" })).toHaveAttribute("href", "/artist/artist");
    fireEvent.click(screen.getByRole("button", { name: "Add to playlist" }));
    await screen.findByRole("button", { name: "Café at night" });
    expect(screen.queryByText("Café read only")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search playlists" }), { target: { value: "cafe" } });
    expect(screen.queryByText("Morning mix")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Café at night" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(editPlaylistTracks).toHaveBeenCalledWith("p1", { action: "add", trackIds: ["one"] });
    expect(trigger).toHaveFocus();
  } finally {
    proto.showModal = oldShow;
    proto.close = oldClose;
    useMediaQuery.mockReturnValue(false);
  }
});
