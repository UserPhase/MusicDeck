import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import NowPlayingSidebar from "./NowPlayingSidebar";
import { getTrackArtistBiography, getTrackLyrics } from "../api/musicdeck";
import { getWikipediaBiography } from "../services/biographyFallback";
import { usePlayer } from "../context/PlayerContext";

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
  const scrollIntoView = jest.fn();
  const previous = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scrollIntoView;
  getTrackLyrics.mockResolvedValue({ syncedLyrics: "[00:00.00] ♪\n[00:15.22] First line\n[00:30.00] Second line", plainLyrics: null });
  const song = { id: "queen-track", title: "Queen Track", artist: "Queen", album: "Queen Album", duration: 180 };
  usePlayer.mockReturnValue({ currentSong: song, currentTime: 0, queue: [] });
  const { rerender } = render(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={jest.fn()} />);
  expect(await screen.findByText("First line")).toBeInTheDocument();
  expect(document.querySelector(".right-sidebar-lyric-line")).toHaveAttribute("aria-current", "true");

  usePlayer.mockReturnValue({ currentSong: song, currentTime: 16, queue: [] });
  rerender(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={jest.fn()} />);
  expect(screen.getByText("First line")).toHaveAttribute("aria-current", "true");
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" }));

  usePlayer.mockReturnValue({ currentSong: song, currentTime: 31, queue: [] });
  rerender(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={jest.fn()} />);
  expect(screen.getByText("Second line")).toHaveAttribute("aria-current", "true");
  expect(getTrackLyrics).toHaveBeenCalledTimes(1);
  Element.prototype.scrollIntoView = previous;
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
