import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import QueueManager from "./QueueManager";
import { queueSyncClient, newQueueOperationId } from "../../services/QueueSyncClient";
let mockOwner = "alice", mockState: any, mockPlayer: any;
jest.mock("../../context/AuthContext", () => ({ useAuth: () => ({ session: { id: mockOwner } }) }));
jest.mock("../../context/PlayerContext", () => ({ usePlayer: () => mockPlayer }));
jest.mock("../../services/QueueSyncClient", () => ({ useQueueSync: () => mockState, queueDeviceId: () => "local", newQueueOperationId: jest.fn(() => "stable-operation"),
  queueSyncClient: { refresh: jest.fn(async () => {}), savePlaylist: jest.fn(), saveNamed: jest.fn(), load: jest.fn(), sync: jest.fn(), removeNamed: jest.fn(), removeDevice: jest.fn() } }));
beforeEach(() => {
  jest.clearAllMocks(); mockOwner = "alice";
  (newQueueOperationId as jest.Mock).mockReturnValue("stable-operation");
  mockPlayer = { queue: Array(5000).fill({ id: "track" }), isPlaying: false, restoreSavedQueue: jest.fn(), queuePersistenceError: "" };
  mockState = { owner: "alice", sessions: [{ deviceId: "desktop", deviceName: "Desktop", trackCount: 5000, contentId: "hash", checkpoint: { position: 42.875 }, updatedAt: 100 }], named: [], syncing: false, error: "" };
});
test("save-as-playlist validates a name, reports failures and retries with the same identity", async () => {
  const save = queueSyncClient.savePlaylist as jest.Mock; save.mockRejectedValueOnce(new Error("Network lost")).mockResolvedValueOnce({ playlistId: "playlist-1" });
  render(<MemoryRouter><QueueManager /></MemoryRouter>);
  fireEvent.click(screen.getByText("Save & restore queues")); fireEvent.click(screen.getByText("Save Queue as Playlist"));
  expect(await screen.findByRole("alert")).toHaveTextContent("name first"); expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Queue name"), { target: { value: "Late night" } }); fireEvent.click(screen.getByText("Save Queue as Playlist"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Network lost"); fireEvent.click(screen.getByText("Save Queue as Playlist"));
  expect(await screen.findByRole("link", { name: /Open saved playlist/ })).toHaveAttribute("href", "/playlist/playlist-1");
  expect(save.mock.calls).toEqual([["Late night", "stable-operation"], ["Late night", "stable-operation"]]);
});
