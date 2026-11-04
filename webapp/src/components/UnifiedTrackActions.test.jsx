import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TrackActionScope from "./TrackActionScope";
import TrackRow from "./TrackRow";
import { sendRecommendationFeedback } from "../api/musicdeck";

jest.mock("../context/AuthContext", () => ({ useAuth: () => ({ session: { id: "owner" } }) }));
jest.mock("../context/PlayerContext", () => ({ usePlayer: () => ({}) }));
jest.mock("../context/PrivacyContext", () => ({ usePrivacy: () => ({ canImport: true }) }));
jest.mock("../api/musicdeck", () => ({ sendRecommendationFeedback: jest.fn() }));
jest.mock("../api/playlists", () => ({ getPlaylists: jest.fn(async () => []) }));
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
