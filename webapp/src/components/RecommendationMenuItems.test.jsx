import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import RecommendationMenuItems from "./RecommendationMenuItems";
import { sendRecommendationFeedback, startRadio } from "../api/musicdeck";

const mockAddToQueue = jest.fn();
jest.mock("../context/PlayerContext", () => ({
  usePlayer: () => ({ addToQueue: mockAddToQueue }),
}));
jest.mock("../api/musicdeck", () => ({
  sendRecommendationFeedback: jest.fn(),
  startRadio: jest.fn(),
}));

const song = { id: "track", title: "Neon", artist: "Night Pilot", artistId: "artist" };
beforeEach(() => {
  jest.clearAllMocks();
  sendRecommendationFeedback.mockResolvedValue({ ok: true });
  startRadio.mockResolvedValue([{ id: "next", metadata: { recommendationReason: "Based on synthwave" } }]);
});

test("more-like-this saves feedback before requesting local candidates and queues explanations", async () => {
  const close = jest.fn();
  render(<RecommendationMenuItems song={song} onRequestClose={close} />);
  fireEvent.click(screen.getByRole("menuitem", { name: /More like this/ }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(sendRecommendationFeedback).toHaveBeenCalledWith({ action: "more-like-this", itemType: "track", itemId: "track", title: "Neon", artist: "Night Pilot" });
  expect(startRadio).toHaveBeenCalledWith({ type: "track", id: "track" }, 10);
  expect(mockAddToQueue).toHaveBeenCalledWith({
    id: "next", recommendationGenerated: true, metadata: { recommendationReason: "Based on synthwave" },
  });
});

test("external artists can be hidden by metadata when no provider artist ID is available", async () => {
  render(<RecommendationMenuItems song={{ id: "external_song", title: "Outside", artistName: "Distant Artist" }} allowRadio={false} />);
  expect(screen.queryByRole("menuitem", { name: /More like this/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: /Hide artist/ }));
  await waitFor(() => expect(sendRecommendationFeedback).toHaveBeenCalledWith(expect.objectContaining({ action: "block-artist", itemType: "artist", artist: "Distant Artist" })));
  expect(startRadio).not.toHaveBeenCalled();
});

test.each([
  [/^Hide from recommendations/, "hide", "track", "track"],
  [/Hide artist/, "block-artist", "artist", "artist"],
])("persists %s without fetching unrelated music", async (label, action, itemType, itemId) => {
  render(<RecommendationMenuItems song={song} />);
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
  await waitFor(() => expect(sendRecommendationFeedback).toHaveBeenCalledWith({ action, itemType, itemId, title: "Neon", artist: "Night Pilot" }));
  expect(startRadio).not.toHaveBeenCalled();
});

test("keeps a visible, retryable error when feedback fails", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  sendRecommendationFeedback.mockRejectedValueOnce(new Error("Connection lost. Please try again."));
  const close = jest.fn();
  render(<RecommendationMenuItems song={song} onRequestClose={close} />);
  expect(screen.queryByRole("menuitem", { name: /Less like this/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: /^Hide from recommendations/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("menuitem", { name: /^Hide from recommendations/ })).toBeEnabled();
  console.error.mockRestore();
});

test("reports an empty local candidate pool without pretending tracks were queued", async () => {
  startRadio.mockResolvedValue([]);
  render(<RecommendationMenuItems song={song} />);
  fireEvent.click(screen.getByRole("menuitem", { name: /More like this/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Preference saved. No eligible local tracks");
  expect(mockAddToQueue).not.toHaveBeenCalled();
});
