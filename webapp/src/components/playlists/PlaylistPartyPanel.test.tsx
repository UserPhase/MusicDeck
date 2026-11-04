import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PlaylistPartyPanel from "./PlaylistPartyPanel";
import { getPartyState, requestPartyTrack, controlPlaylistParty } from "../../api/playlistCollaboration";
import { partyRequestKey } from "../../services/playlists/PartyQueueClient";
const mockAdd = jest.fn();
jest.mock("../../context/AuthContext", () => ({ useAuth: () => ({ session: { id: "editor" } }) }));
jest.mock("../../context/PlayerContext", () => ({ usePlayer: () => ({ queueTracks: mockAdd, currentSong: { id: "active" } }) }));
jest.mock("../../api/playlistCollaboration", () => ({ getPartyState: jest.fn(), requestPartyTrack: jest.fn(), controlPlaylistParty: jest.fn() }));
jest.mock("../../services/playlists/PartyQueueClient", () => ({ partyDeviceId: () => "device", partyRequestKey: jest.fn(() => "request-id"), partyHost: {
  subscribe: () => () => {}, getSnapshot: () => mockHosting, start: jest.fn(), close: jest.fn(),
} }));
const mockHosting = { ownerId: "editor", playlistId: null, error: "" };
const pending = { party: { id: "party", isHost: false, expiresAt: Date.now() + 90000 }, requests: [] };
beforeEach(() => { jest.clearAllMocks(); sessionStorage.clear(); (getPartyState as jest.Mock).mockResolvedValue(pending); (requestPartyTrack as jest.Mock).mockResolvedValue({ id: "req", state: "PENDING" });
  (partyRequestKey as jest.Mock).mockReturnValue("request-id");
  (controlPlaylistParty as jest.Mock).mockResolvedValue({ ok: true }); });
test("submits explicit selected requests while leaving the local playback queue alone", async () => {
  render(<PlaylistPartyPanel playlistId="list" canManage={false} selectedTracks={[{ id: "one", title: "One" }]} />);
  fireEvent.click(screen.getByText("Party request queue"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Request selected tracks (1)" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Request selected tracks (1)" }));
  await waitFor(() => expect(requestPartyTrack).toHaveBeenCalledWith("list", "editor", "one", "request-id", expect.any(AbortSignal)));
  expect(mockAdd).not.toHaveBeenCalled();
});
test("retrying a failed host acknowledgement never adds the same request twice", async () => {
  (getPartyState as jest.Mock).mockResolvedValue({ ...pending, party: { ...pending.party, isHost: true }, requests: [{ id: "req", trackId: "one", track: { id: "one", title: "One" }, requestedBy: "Riley" }] });
  (controlPlaylistParty as jest.Mock).mockRejectedValueOnce(new Error("Connection lost"));
  render(<PlaylistPartyPanel playlistId="list" canManage selectedTracks={[]} />);
  fireEvent.click(screen.getByText("Party request queue"));
  fireEvent.click(await screen.findByRole("button", { name: "Add to queue" })); expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
  fireEvent.click(screen.getByRole("button", { name: "Retry acknowledgement" }));
  await waitFor(() => expect(controlPlaylistParty).toHaveBeenCalledTimes(2)); expect(mockAdd).toHaveBeenCalledTimes(1);
  expect(mockAdd).toHaveBeenCalledWith([expect.objectContaining({ id: "one", title: "One" })]);
});
test("unmount aborts outstanding party reads", async () => {
  let finish!: (value: unknown) => void; (getPartyState as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<PlaylistPartyPanel playlistId="list" canManage={false} selectedTracks={[]} />);
  await act(async () => { await Promise.resolve(); });
  const signal = (getPartyState as jest.Mock).mock.calls[0][2]; view.unmount(); await act(async () => { finish(pending); }); expect(signal.aborted).toBe(true);
});
