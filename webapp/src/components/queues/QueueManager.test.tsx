import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import QueueManager, { QueueResumePrompt } from "./QueueManager";
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
test("remote playback requires an explicit restore click and passes its full checkpoint", async () => {
  const saved = { content: { version: 2, entries: [{ entryId: "q1", track: { id: "track" } }] }, checkpoint: { index: 0, position: 42.875 } };
  (queueSyncClient.load as jest.Mock).mockResolvedValue(saved);
  render(<QueueResumePrompt />); expect(screen.getByText("Resume playback queue from Desktop?")).toBeVisible(); expect(queueSyncClient.load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Restore queue")); await waitFor(() => expect(mockPlayer.restoreSavedQueue).toHaveBeenCalledWith(saved.content, saved.checkpoint));
  expect(screen.queryByLabelText("Resume queue on this device")).not.toBeInTheDocument();
});
test("changing accounts during restore ignores the old result and resets busy/error state", async () => {
  let finish!: (value: unknown) => void; (queueSyncClient.load as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { rerender } = render(<QueueResumePrompt />); fireEvent.click(screen.getByText("Restore queue"));
  mockOwner = "bob"; mockState = { ...mockState, owner: "bob" }; rerender(<QueueResumePrompt />);
  expect(screen.getByText("Restore queue")).toBeEnabled(); finish({ content: {}, checkpoint: {} });
  await waitFor(() => expect(mockPlayer.restoreSavedQueue).not.toHaveBeenCalled());
});
test("the handoff prompt stays available for a remote player while local playback keeps it hidden", () => {
  mockPlayer.isPlaying = true; mockPlayer.isRemotePlayback = true;
  const { rerender } = render(<QueueResumePrompt />);
  expect(screen.getByText("Resume playback queue from Desktop?")).toBeVisible();
  mockPlayer.isRemotePlayback = false; rerender(<QueueResumePrompt />);
  expect(screen.queryByLabelText("Resume queue on this device")).not.toBeInTheDocument();
});
