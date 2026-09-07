import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import TrackDownloadButton from "./TrackDownloadButton";
import { createAcquisition, getAcquisition } from "../api/musicdeck";

jest.mock("../api/musicdeck", () => ({
  createAcquisition: jest.fn(),
  getAcquisition: jest.fn(),
}));

describe("TrackDownloadButton", () => {
  const mockSong = {
    id: "track-123",
    title: "Bohemian Rhapsody",
    artist: "Queen",
    album: "A Night at the Opera",
    duration: 354,
    metadata: {
      spotifyTrackUrl: "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv",
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("renders download button with spotDL accessible label and title", () => {
    render(<TrackDownloadButton song={mockSong} />);

    const button = screen.getByRole("button", { name: "Download Bohemian Rhapsody with spotDL" });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("title", "Download with spotDL");
  });

  test("returns null if song prop is missing", () => {
    const { container } = render(<TrackDownloadButton song={null} />);
    expect(container.firstChild).toBeNull();
  });

  test("shows a static checkmark (not a clickable download button) when already available in the library", () => {
    render(
      <TrackDownloadButton
        song={{ ...mockSong, availability: { libraryAvailable: true } }}
      />
    );
    expect(screen.getByRole("img", { name: "Bohemian Rhapsody already downloaded" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("shows a static checkmark when the track's source kind is library", () => {
    render(
      <TrackDownloadButton
        song={{ ...mockSong, source: { kind: "library", count: 1 } }}
      />
    );
    expect(screen.getByRole("img", { name: "Bohemian Rhapsody already downloaded" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("clicking button calls createAcquisition with spotDL provider and song metadata", async () => {
    createAcquisition.mockResolvedValueOnce({
      status: "completed",
      jobId: "acq-1",
    });

    render(<TrackDownloadButton song={mockSong} />);

    const button = screen.getByRole("button", { name: "Download Bohemian Rhapsody with spotDL" });
    
    await act(async () => {
      fireEvent.click(button);
    });

    expect(createAcquisition).toHaveBeenCalledWith({
      result: {
        id: "track-123",
        type: "track",
        title: "Bohemian Rhapsody",
        artist: "Queen",
        album: "A Night at the Opera",
        provider: "library",
        source: { kind: "library", count: 1 },
        metadata: {
          spotifyTrackUrl: "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv",
        },
      },
      trackId: "track-123",
      sourceProvider: "spotdl",
    });

    expect(screen.getByRole("button", { name: "Bohemian Rhapsody downloaded to library" })).toBeInTheDocument();
  });

  test("stops click propagation so parent row handlers are not triggered", async () => {
    const parentClickHandler = jest.fn();
    createAcquisition.mockResolvedValueOnce({ status: "completed" });

    render(
      <div onClick={parentClickHandler}>
        <TrackDownloadButton song={mockSong} />
      </div>
    );

    const button = screen.getByRole("button", { name: "Download Bohemian Rhapsody with spotDL" });
    
    await act(async () => {
      fireEvent.click(button);
    });

    expect(parentClickHandler).not.toHaveBeenCalled();
  });

  test("tracks in-flight download progress and completes", async () => {
    createAcquisition.mockResolvedValueOnce({
      status: "downloading",
      jobId: "job-progress-1",
      job: { id: "job-progress-1", status: "downloading" },
    });

    getAcquisition
      .mockResolvedValueOnce({
        id: "job-progress-1",
        status: "downloading",
        progress: { percent: 45 },
      })
      .mockResolvedValueOnce({
        id: "job-progress-1",
        status: "completed",
        progress: { percent: 100 },
      });

    render(<TrackDownloadButton song={mockSong} />);

    const button = screen.getByRole("button", { name: "Download Bohemian Rhapsody with spotDL" });
    
    await act(async () => {
      fireEvent.click(button);
    });

    expect(screen.getByRole("button", { name: /Downloading Bohemian Rhapsody/i })).toBeDisabled();

    // Advance 1s timer for first poll
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.getByRole("button", { name: "Downloading Bohemian Rhapsody (45%)" })).toBeInTheDocument();

    // Advance 1s timer for second poll (completed)
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.getByRole("button", { name: "Bohemian Rhapsody downloaded to library" })).toBeInTheDocument();
  });

  test("handles download failure and allows retry", async () => {
    createAcquisition.mockRejectedValueOnce(new Error("spotDL not found"));

    render(<TrackDownloadButton song={mockSong} />);

    const button = screen.getByRole("button", { name: "Download Bohemian Rhapsody with spotDL" });
    
    await act(async () => {
      fireEvent.click(button);
    });

    expect(screen.getByRole("button", { name: "Download failed for Bohemian Rhapsody. Click to retry." })).toBeInTheDocument();

    // Now retry and succeed
    createAcquisition.mockResolvedValueOnce({ status: "completed" });

    await act(async () => {
      fireEvent.click(button);
    });

    expect(screen.getByRole("button", { name: "Bohemian Rhapsody downloaded to library" })).toBeInTheDocument();
  });
});
