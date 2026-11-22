import { fireEvent, render as renderWithOptions, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import NowPlayingSidebar from "./NowPlayingSidebar";
import { getTrackArtistBiography, getTrackLyrics } from "../api/musicdeck";
import { getWikipediaBiography } from "../services/biographyFallback";
import { usePlayer } from "../context/PlayerContext";

const render = (element) => renderWithOptions(element, { wrapper: MemoryRouter });

jest.mock("../api/musicdeck", () => ({
  getCoverUrl: jest.fn(() => "/cover.jpg"),
  getTrackLyrics: jest.fn(async () => null),
  getTrackArtistBiography: jest.fn(async () => null),
}));

jest.mock("../context/PlayerContext", () => ({
  usePlayer: jest.fn(),
}));
jest.mock("../services/biographyFallback", () => ({
  getCachedWikipediaBiography: jest.fn(() => null),
  getWikipediaBiography: jest.fn(async () => null),
}));

beforeEach(() => {
  jest.clearAllMocks();
  getTrackLyrics.mockResolvedValue(null);
  getTrackArtistBiography.mockResolvedValue(null);
  getWikipediaBiography.mockResolvedValue(null);
});

test("uses Wikipedia for a missing server bio with attribution and expandable text", async () => {
  const text = "Michael Jackson was an American singer and songwriter. ".repeat(8);
  getWikipediaBiography.mockResolvedValue({ text, source: "wikipedia", url: "https://en.wikipedia.org/wiki/Michael_Jackson" });
  usePlayer.mockReturnValue({ currentSong: { id: "michael-song", artistId: "michael-id", artist: "Michael Jackson", title: "Song" }, queue: [] });
  render(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={jest.fn()} />);

  expect(await screen.findByText((_, element) => element?.classList?.contains("artist-biography-text")
    && element.textContent === text)).toBeInTheDocument();
  expect(getWikipediaBiography).toHaveBeenCalledWith("michael-id", "Michael Jackson");
  expect(screen.getByRole("link", { name: "Source: Wikipedia" })).toHaveAttribute("href", "https://en.wikipedia.org/wiki/Michael_Jackson");
  fireEvent.click(screen.getByRole("button", { name: "Read more" }));
  expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
});

test("keeps a substantial server biography without requesting Wikipedia", async () => {
  const nativeBio = "A locally supplied artist biography with sufficient detail to identify this performer.";
  getTrackArtistBiography.mockResolvedValue(nativeBio);
  usePlayer.mockReturnValue({ currentSong: { id: "local-song", artistId: "artist-id", artist: "Local Artist", title: "Song" }, queue: [] });
  render(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={jest.fn()} />);

  expect(await screen.findByText(nativeBio)).toBeInTheDocument();
  expect(getWikipediaBiography).not.toHaveBeenCalled();
  expect(screen.queryByRole("link", { name: "Source: Wikipedia" })).not.toBeInTheDocument();
});

test("does not display a delayed biography from the previously playing artist", async () => {
  let resolveOld;
  getTrackArtistBiography.mockImplementation((id) => id === "old-song"
    ? new Promise((resolve) => { resolveOld = resolve; })
    : Promise.resolve("The new artist is a singer with a substantial locally stored biography."));
  usePlayer.mockReturnValue({ currentSong: { id: "old-song", artist: "Old artist" }, queue: [] });
  const { rerender } = render(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={jest.fn()} />);
  usePlayer.mockReturnValue({ currentSong: { id: "new-song", artist: "New artist" }, queue: [] });
  rerender(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={jest.fn()} />);
  expect(await screen.findByText("The new artist is a singer with a substantial locally stored biography.")).toBeInTheDocument();
  resolveOld("The previous artist is a musician whose biography should not replace the current artist.");
  await waitFor(() => expect(screen.queryByText(/The previous artist/)).not.toBeInTheDocument());
});

test("keeps the next queue preview visible and hands off to the queue sidebar", async () => {
  const onOpenQueue = jest.fn();
  usePlayer.mockReturnValue({
    currentSong: { id: "current", title: "Current", artist: "Artist" },
    queueIndex: 0,
    queue: [
      { id: "current", title: "Current", artist: "Artist" },
      { id: "next", title: "Next Track", artist: "Artist", duration: 120 },
    ],
  });

  render(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={onOpenQueue} />);

  expect(screen.getByText("Next in queue")).toBeInTheDocument();
  expect(screen.getByText("Next Track")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open queue" }));
  expect(onOpenQueue).toHaveBeenCalledTimes(1);
  expect(getTrackLyrics).toHaveBeenCalledWith("current", {
    title: "Current", artist: "Artist", album: undefined, duration: 0,
  });
  expect(getTrackArtistBiography).toHaveBeenCalledWith("current");
  expect(await screen.findByText("No artist biography is available yet.")).toBeInTheDocument();
});

test("highlights and centers timed lyrics as playback advances or scrubs", async () => {
  const scrollTo = jest.fn();
  const previous = Element.prototype.scrollTo;
  Element.prototype.scrollTo = scrollTo;
  const seekToSeconds = jest.fn();
  getTrackLyrics.mockResolvedValue({ syncedLyrics: "[00:00.00] ♪\n[00:15.22] First line\n[00:30.00] Second line", plainLyrics: null });
  const song = { id: "queen-track", title: "Queen Track", artist: "Queen", album: "Queen Album", duration: 180 };
  usePlayer.mockReturnValue({ currentSong: song, currentTime: 0, queue: [], seekToSeconds });
  const { rerender } = render(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={jest.fn()} />);
  expect(await screen.findByText("First line")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "First line" }));
  expect(seekToSeconds).toHaveBeenCalledWith(15.22);
  expect(document.querySelector(".right-sidebar-lyric-line")).toHaveAttribute("aria-current", "true");

  usePlayer.mockReturnValue({ currentSong: song, currentTime: 16, queue: [] });
  rerender(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={jest.fn()} />);
  expect(screen.getByText("First line")).toHaveAttribute("aria-current", "true");
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ behavior: expect.any(String), top: expect.any(Number) }));

  usePlayer.mockReturnValue({ currentSong: song, currentTime: 31, queue: [] });
  rerender(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={jest.fn()} />);
  expect(screen.getByText("Second line")).toHaveAttribute("aria-current", "true");
  expect(getTrackLyrics).toHaveBeenCalledTimes(1);
  Element.prototype.scrollTo = previous;
});

test("renders plain lyrics without parsing or auto-scrolling on time updates", async () => {
  const previous = Element.prototype.scrollIntoView;
  const scrollIntoView = jest.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  getTrackLyrics.mockResolvedValue({ syncedLyrics: null, plainLyrics: "First line\nSecond line",
    isSynced: false, provider: "lyricsovh" });
  const song = { id: "plain-track", title: "Plain Track", artist: "Artist", duration: 180 };
  usePlayer.mockReturnValue({ currentSong: song, currentTime: 0, queue: [] });
  const { rerender } = render(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={jest.fn()} />);
  expect(await screen.findByText((_, element) => element?.classList?.contains("right-sidebar-lyrics-plain")
    && element.textContent === "First line\nSecond line")).toBeInTheDocument();
  usePlayer.mockReturnValue({ currentSong: song, currentTime: 75, queue: [] });
  rerender(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={jest.fn()} />);
  expect(scrollIntoView).not.toHaveBeenCalled();
  expect(document.querySelector(".right-sidebar-lyric-line")).not.toBeInTheDocument();
  Element.prototype.scrollIntoView = previous;
});

test("fetches silently with the panel closed and shows a settled unavailable state", async () => {
  const song = { id: "missing", title: "Missing", artist: "Artist", album: "Album", duration: 200 };
  usePlayer.mockReturnValue({ currentSong: song, currentTime: 0, queue: [] });
  const { rerender } = render(<NowPlayingSidebar isOpen={false} onClose={jest.fn()} onOpenQueue={jest.fn()} />);
  expect(getTrackLyrics).toHaveBeenCalledWith("missing", {
    title: "Missing", artist: "Artist", album: "Album", duration: 200,
  });
  expect(getTrackArtistBiography).not.toHaveBeenCalled();
  rerender(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={jest.fn()} />);
  expect(await screen.findByText("Lyrics not available for this track.")).toBeInTheDocument();
  expect(await screen.findByText("No artist biography is available yet.")).toBeInTheDocument();
});

test("keeps the mobile playback deck together while lyrics load and settle", async () => {
  let finishLyrics;
  getTrackLyrics.mockReturnValue(new Promise((resolve) => { finishLyrics = resolve; }));
  const onOpenQueue = jest.fn();
  usePlayer.mockReturnValue({
    currentSong: { id: "mobile-track", title: "Track title", artist: "Artist", duration: 180 },
    duration: 180,
    isPreview: true,
    playbackMessage: "Preparing playback.",
  });
  render(<NowPlayingSidebar mobile isOpen onClose={jest.fn()} onOpenQueue={onOpenQueue} />);

  const dialog = screen.getByRole("dialog", { name: "Now Playing" });
  const deck = dialog.querySelector(".mobile-now-playing-deck");
  const lyrics = within(dialog).getByRole("region", { name: "Lyrics" });
  const playbackOptions = within(deck).getByRole("group", { name: "Playback options" });
  expect(within(deck).getByText("Preview")).toBeInTheDocument();
  expect(within(deck).getByRole("button", { name: "Like song" })).toBeInTheDocument();
  expect(within(deck).getByRole("slider", { name: "Song progress" })).toBeEnabled();
  expect(within(deck).getByRole("button", { name: "Turn on repeat" }).parentElement.nextElementSibling).toBe(playbackOptions);
  expect(playbackOptions.nextElementSibling).toHaveTextContent("Preparing playback.");
  expect(deck.nextElementSibling).toBe(lyrics);
  expect(within(lyrics).getByRole("status")).toHaveTextContent(/Finding lyrics/);

  finishLyrics(null);
  expect(await within(lyrics).findByText("Lyrics not available for this track.")).toBeInTheDocument();
  fireEvent.click(within(playbackOptions).getByRole("button", { name: "Queue" }));
  expect(onOpenQueue).toHaveBeenCalledTimes(1);
});

test("mobile lyrics show a short preview and share playback controls with the full reader", async () => {
  const togglePlay = jest.fn();
  const seek = jest.fn();
  getTrackLyrics.mockResolvedValue({ syncedLyrics: Array.from({ length: 10 }, (_, i) => ({
    timestampMs: i * 1000, text: `Line ${i + 1}`,
  })) });
  usePlayer.mockReturnValue({ currentSong: { id: "lyrics", title: "Lyrics track" }, currentTime: 2,
    duration: 100, isPlaying: true, togglePlay, seek });
  render(<NowPlayingSidebar mobile isOpen onClose={jest.fn()} onOpenQueue={jest.fn()} />);
  const card = screen.getByRole("region", { name: "Lyrics" });
  await within(card).findByText("Line 3");
  expect(card.querySelectorAll(".lyrics-preview-line")).toHaveLength(3);
  expect(card.querySelector(".lyrics-scroll")).toBeNull();

  fireEvent.click(within(card).getByRole("button", { name: "Full screen" }));
  const reader = screen.getByRole("dialog", { name: "Lyrics track" });
  expect(reader.querySelectorAll(".lyrics-scroll")).toHaveLength(1);
  expect(reader.querySelectorAll(".right-sidebar-lyric-line")).toHaveLength(10);
  const controls = within(reader).getByRole("group", { name: "Lyrics playback" });
  fireEvent.click(within(controls).getByRole("button", { name: "Pause" }));
  fireEvent.change(within(controls).getByRole("slider", { name: "Song progress" }), { target: { value: "73" } });
  expect(togglePlay).toHaveBeenCalledTimes(1);
  expect(seek).toHaveBeenCalledWith(73);
  fireEvent.click(within(reader).getByRole("button", { name: "Close full-screen lyrics" }));
  expect(screen.queryByRole("dialog", { name: "Lyrics track" })).not.toBeInTheDocument();
});
