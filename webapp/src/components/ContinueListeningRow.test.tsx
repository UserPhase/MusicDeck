import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ContinueListeningRow from "./ContinueListeningRow";
import { getMediaCheckpoints } from "../api/musicdeck";
import { getPlaylist } from "../api/playlists";
import { MEDIA_CHECKPOINT_CHANGED } from "../services/mediaSessions";
import type { MediaCheckpoint } from "../services/mediaSessions";

let mockUserId = "resume-user";
const mockResume = jest.fn();
jest.mock("../context/AuthContext", () => ({ useAuth: () => ({ session: { id: mockUserId } }) }));
jest.mock("../context/PlayerContext", () => ({ usePlayer: () => ({ resumeMedia: mockResume }) }));
jest.mock("../api/musicdeck", () => ({ getMediaCheckpoints: jest.fn(), getAlbum: jest.fn() }));
jest.mock("../api/playlists", () => ({ getPlaylist: jest.fn() }));
const checkpoint: MediaCheckpoint = {
  type: "playlist", mediaId: "set-one", title: "Late Night", trackId: "track-two",
  occurrenceId: "slot-two", trackIndex: 1, trackCount: 3, positionSeconds: 102.125,
  durationSeconds: 600, progress: .39, capturedAt: 1000, updatedAt: 1000,
};
const tracks = [{ id: "track-two", playlistItemId: "slot-two" }, { id: "track-two", playlistItemId: "slot-one" }];
beforeEach(() => {
  jest.clearAllMocks();
  mockUserId = "resume-user";
  jest.mocked(getMediaCheckpoints).mockResolvedValue({ items: [checkpoint] });
  jest.mocked(getPlaylist).mockResolvedValue({ entry: tracks } as Awaited<ReturnType<typeof getPlaylist>>);
  mockResume.mockResolvedValue(undefined);
});
test("Home resumes reordered duplicate occurrences at the exact fractional audio second", async () => {
  render(<MemoryRouter><ContinueListeningRow /></MemoryRouter>);
  expect(await screen.findByRole("img", { name: "39% complete" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Resume from Track 2 - 1:42" }));
  await waitFor(() => expect(mockResume).toHaveBeenCalledWith(tracks, 0,
    expect.objectContaining({ id: "set-one", type: "playlist" }), 102.125));
  expect(screen.getByRole("link", { name: "Late Night" })).toHaveAttribute("href", "/playlist/set-one");
});
test("a removed occurrence fails visibly without playing a different duplicate", async () => {
  jest.mocked(getPlaylist).mockResolvedValue({ entry: [tracks[1]] } as Awaited<ReturnType<typeof getPlaylist>>);
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  render(<MemoryRouter><ContinueListeningRow /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: /Resume from Track/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("no longer in this collection");
  expect(mockResume).not.toHaveBeenCalled();
  log.mockRestore();
});
test("offline shelf offers retry, preserves the recent-track fallback and clears data on account switch", async () => {
  jest.mocked(getMediaCheckpoints).mockRejectedValueOnce(new Error("Offline"));
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  const view = render(<MemoryRouter><ContinueListeningRow fallback={<p>Recent tracks</p>} /></MemoryRouter>);
  expect(await screen.findByText(/Offline/)).toBeInTheDocument();
  expect(screen.getByText("Recent tracks")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Retry listening progress"));
  expect(await screen.findByText("Late Night")).toBeInTheDocument();
  jest.mocked(getMediaCheckpoints).mockResolvedValue({ items: [] });
  mockUserId = "other-account";
  view.rerender(<MemoryRouter><ContinueListeningRow fallback={<p>Recent tracks</p>} /></MemoryRouter>);
  expect(screen.queryByText("Late Night")).not.toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText("Loading listening progress...")).not.toBeInTheDocument());
  log.mockRestore();
});
test("sync events update rings immediately and completed collections leave the shelf", async () => {
  render(<MemoryRouter><ContinueListeningRow fallback={<p>Recent tracks</p>} /></MemoryRouter>);
  await screen.findByText("Late Night");
  act(() => window.dispatchEvent(new CustomEvent(MEDIA_CHECKPOINT_CHANGED, {
    detail: { userId: "resume-user", input: { ...checkpoint, capturedAt: 2000 }, checkpoint: { ...checkpoint, progress: .75, capturedAt: 2000 } },
  })));
  expect(screen.getByRole("img", { name: "75% complete" })).toBeInTheDocument();
  act(() => window.dispatchEvent(new CustomEvent(MEDIA_CHECKPOINT_CHANGED, {
    detail: { userId: "resume-user", input: { ...checkpoint, capturedAt: 3000, completed: true }, checkpoint: null },
  })));
  expect(screen.queryByText("Late Night")).not.toBeInTheDocument();
  expect(screen.getByText("Recent tracks")).toBeInTheDocument();
  act(() => window.dispatchEvent(new CustomEvent(MEDIA_CHECKPOINT_CHANGED, {
    detail: { userId: "resume-user", input: { ...checkpoint, capturedAt: 2500 }, checkpoint },
  })));
  expect(screen.queryByText("Late Night")).not.toBeInTheDocument();
});
