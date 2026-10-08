import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ListeningActivity from "./ListeningActivity";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";
import { getListeningHistory, getListeningStatistics, getListeningTrack, getCoverUrl } from "../api/musicdeck";

jest.mock("../context/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("../context/PlayerContext", () => ({ usePlayer: jest.fn() }));
jest.mock("../api/musicdeck", () => ({
  getListeningHistory: jest.fn(), getListeningStatistics: jest.fn(), getListeningTrack: jest.fn(), getCoverUrl: jest.fn(),
  LISTENING_ACTIVITY_CHANGED_EVENT: "musicdeck:listening-activity-changed",
}));
jest.mock("../components/TrackRow", () => ({ song, onPlay }) => <button onClick={() => onPlay(song)}>{song.title}</button>);
jest.mock("../hooks/useTrackPlaylistMenu", () => () => ({ toggleMenu: jest.fn(), isOpen: () => false, renderMenu: () => null }));

const song = { id: "track-1", title: "My Song", artist: "Artist" };
const historyEvent = (id, date = new Date().toISOString()) => ({ id, playedAt: date, listenedSeconds: 60, track: song });
const playSong = jest.fn();
const stats = {
  period: "all", overview: { listeningSeconds: 180, plays: 3, uniqueSongs: 1, uniqueArtists: 1, uniqueAlbums: 1, legacyPlays: 0 },
  topSongs: [{ key: "track-1", plays: 3, listeningSeconds: 180, track: { ...song, album: "Album" } }],
  topArtists: [], topAlbums: [],
  daily: [{ bucket: "2026-10-08", plays: 3, listeningSeconds: 180 }],
  monthly: [{ bucket: "2026-10", plays: 3, listeningSeconds: 180 }],
  weekdays: [{ bucket: "4", plays: 3, listeningSeconds: 180 }],
  hourly: [{ bucket: "12", plays: 3, listeningSeconds: 180 }],
};

beforeEach(() => {
  useAuth.mockReturnValue({ session: { id: "user-1" } });
  usePlayer.mockReturnValue({ playSong });
  getCoverUrl.mockReturnValue(null);
  getListeningHistory.mockResolvedValue({ items: [historyEvent("one")], nextCursor: null });
  getListeningStatistics.mockResolvedValue(stats);
  getListeningTrack.mockResolvedValue(song);
});

function show(path = "/listening-activity") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><ListeningActivity /></MemoryRouter></QueryClientProvider>);
}

test("groups persistent repeat listens by day and plays a freshly resolved library track", async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  getListeningHistory.mockResolvedValue({ items: [historyEvent("one"), historyEvent("two", yesterday.toISOString())], nextCursor: null });
  show();
  expect(await screen.findByText("Today")).toBeInTheDocument();
  expect(screen.getByText("Yesterday")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "My Song" })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "My Song" })[0]);
  await waitFor(() => expect(playSong).toHaveBeenCalledWith(song));
  expect(getListeningTrack).toHaveBeenCalledWith("track-1");
});

test("loads another cursor page without deduplicating legitimate repeat listens", async () => {
  getListeningHistory.mockImplementation(({ cursor }) => Promise.resolve({
    items: [historyEvent(cursor ? "two" : "one")], nextCursor: cursor ? null : "next-page",
  }));
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Load more history" }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: "My Song" })).toHaveLength(2));
  expect(getListeningHistory).toHaveBeenCalledWith(expect.objectContaining({ cursor: "next-page" }));
});

test("search and period changes request a new first page, not a full history download", async () => {
  show();
  await screen.findByText("Today");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Artist" } });
  await waitFor(() => expect(getListeningHistory).toHaveBeenCalledWith(expect.objectContaining({ search: "Artist", cursor: null })));
  fireEvent.change(screen.getByLabelText("Time period"), { target: { value: "7" } });
  await waitFor(() => expect(getListeningHistory).toHaveBeenCalledWith(expect.objectContaining({ period: "7", cursor: null })));
});

test("statistics displays actual API values and supports keyboard tab switching", async () => {
  show();
  await screen.findByText("Today");
  fireEvent.keyDown(screen.getByRole("tab", { name: "History" }), { key: "ArrowRight" });
  expect(await screen.findByText("Listening time")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Statistics" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Statistics" })).toHaveFocus();
  expect(within(screen.getByText("Listening time").parentElement).getByText("3 min")).toBeInTheDocument();
  expect(within(screen.getByText("Song plays").parentElement).getByText("3")).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Listening time by hour" })).toBeInTheDocument();
  expect(screen.getByText("Thursday")).toBeInTheDocument();
});

test("empty histories and unavailable tracks have useful messages", async () => {
  getListeningHistory.mockResolvedValueOnce({ items: [], nextCursor: null });
  const view = show();
  expect(await screen.findByText(/No listening history/)).toBeInTheDocument();
  view.unmount();
  getListeningTrack.mockRejectedValue(new Error("This track is unavailable."));
  show();
  fireEvent.click(await screen.findByRole("button", { name: "My Song" }));
  expect(await screen.findByRole("status")).toHaveTextContent("This track is unavailable.");
});

test("statistics deep link loads statistics directly and exposes retryable errors", async () => {
  getListeningStatistics.mockRejectedValueOnce(new Error("Server unavailable"));
  show("/listening-activity?tab=statistics");
  expect(await screen.findByText("Server unavailable")).toBeInTheDocument();
  expect(getListeningHistory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Listening time")).toBeInTheDocument();
});
