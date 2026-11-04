import { act, fireEvent, render, screen } from "@testing-library/react";
import SmartPlaylistBuilder from "./LegacySmartPlaylistBuilder";
import { createSmartPlaylist, previewSmartPlaylist, updateSmartPlaylist, findSmartPlaylistSeeds } from "../api/musicdeck";

jest.mock("../api/musicdeck", () => ({
  createSmartPlaylist: jest.fn(), previewSmartPlaylist: jest.fn(), updateSmartPlaylist: jest.fn(),
  findSmartPlaylistSeeds: jest.fn(),
}));
const sample = { total: 1, tracks: [{ id: "track-1", title: "Night Drive", artist: "Neon", album: "After Hours" }], warning: null, refreshedAt: "2026-10-17T12:00:00Z" };
const tick = async () => { await act(async () => { jest.advanceTimersByTime(350); }); };
const change = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const fill = () => { change("Playlist name", "Night collection"); change("Value 1.1", "Synthwave"); };
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  previewSmartPlaylist.mockResolvedValue(sample);
  findSmartPlaylistSeeds.mockResolvedValue({ tracks: sample.tracks });
});

test("Similar songs selects a real library song instead of matching title text", async () => {
  render(<SmartPlaylistBuilder />);
  fireEvent.click(screen.getByRole("button", { name: "Similar songs", exact: true }));
  change("Playlist name", "Like Night Drive");
  change("Find song 1.1", "Night");
  await tick();
  fireEvent.click(screen.getByRole("button", { name: "Use song: Night Drive — Neon" }));
  await tick();
  expect(previewSmartPlaylist).toHaveBeenCalledWith({ operator: "AND", rules: [
    { field: "similar_to", operator: "matches", value: "track-1" },
  ] }, expect.any(AbortSignal));
  expect([...screen.getByLabelText("Field 1.1").options].map((option) => option.value)).not.toContain("title");
  expect([...screen.getByLabelText("Field 1.1").options].map((option) => option.value)).not.toContain("skip_count");
  expect(screen.getByRole("button", { name: "Change song" })).toBeInTheDocument();
});

test("existing title and skip rules are preserved without offering them for new conditions", async () => {
  render(<SmartPlaylistBuilder playlist={{ id: "old", name: "Legacy", rules: { operator: "AND", rules: [
    { field: "title", operator: "contains", value: "Night" },
    { field: "skip_count", operator: "less_than", value: 3 },
  ] } }} />);
  expect(screen.getByLabelText("Value 1.1")).toHaveValue("Night");
  expect(screen.getByLabelText("Value 1.2")).toHaveValue(3);
  await tick();
  expect(previewSmartPlaylist.mock.calls[0][0].rules).toHaveLength(2);
});
afterEach(() => jest.useRealTimers());

test("builds nested AND/OR groups, numeric/date controls, and previews the exact AST before saving", async () => {
  const saved = jest.fn();
  createSmartPlaylist.mockImplementation(async (payload) => ({ playlist: { ...payload, id: "smart-1" } }));
  render(<SmartPlaylistBuilder onSaved={saved} />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Add group to 1" }));
  change("Match 1.2", "OR");
  change("Field 1.2.1", "last_played");
  change("Value 1.2.1", "45");
  fireEvent.click(screen.getByRole("button", { name: "Add condition to 1.2" }));
  change("Field 1.2.2", "bpm");
  change("Operator 1.2.2", "greater_than");
  change("Value 1.2.2", "120.5");
  expect(previewSmartPlaylist).not.toHaveBeenCalled();
  await tick();
  const rules = { operator: "AND", rules: [
    { field: "genre", operator: "contains", value: "Synthwave" },
    { operator: "OR", rules: [
      { field: "last_played", operator: "not_in_last_days", value: 45 },
      { field: "bpm", operator: "greater_than", value: 120.5 },
    ] },
  ] };
  expect(previewSmartPlaylist).toHaveBeenCalledTimes(1);
  expect(previewSmartPlaylist).toHaveBeenCalledWith(rules, expect.any(AbortSignal));
  expect(screen.getByText("Night Drive")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("1 matching track");
  fireEvent.click(screen.getByRole("button", { name: "Create smart playlist" }));
  await act(async () => {});
  expect(createSmartPlaylist).toHaveBeenCalledWith({ name: "Night collection", rules });
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({ id: "smart-1" }));
});

test("prevents old preview responses from describing newly edited rules and aborts on unmount", async () => {
  let finishFirst;
  previewSmartPlaylist.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
    .mockResolvedValueOnce({ ...sample, total: 2, tracks: [] });
  const view = render(<SmartPlaylistBuilder />);
  fill();
  await tick();
  const signal = previewSmartPlaylist.mock.calls[0][1];
  change("Value 1.1", "Jazz");
  expect(signal.aborted).toBe(true);
  await tick();
  expect(screen.getByRole("status")).toHaveTextContent("2 matching tracks");
  await act(async () => { finishFirst({ ...sample, total: 99 }); });
  expect(screen.getByRole("status")).not.toHaveTextContent("99");
  const latest = previewSmartPlaylist.mock.calls[1][1];
  view.unmount();
  expect(latest.aborted).toBe(true);
});

test("invalid/empty groups never query the backend or enable saving", async () => {
  render(<SmartPlaylistBuilder />);
  change("Playlist name", "Invalid");
  await tick();
  expect(previewSmartPlaylist).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove condition 1.1" }));
  expect(screen.getByRole("status")).toHaveTextContent("Add at least one condition");
  expect(screen.getByRole("button", { name: "Create smart playlist" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Add condition to 1" }));
  change("Field 1.1", "play_count");
  change("Value 1.1", "-1");
  await tick();
  expect(previewSmartPlaylist).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Create smart playlist" })).toBeDisabled();
});

test("favorite fields expose boolean values and only compatible operators", async () => {
  render(<SmartPlaylistBuilder />);
  change("Field 1.1", "is_favorite");
  change("Value 1.1", "false");
  expect([...screen.getByLabelText("Operator 1.1").options].map((option) => option.value)).toEqual(["equals", "not_equals"]);
  await tick();
  expect(previewSmartPlaylist.mock.calls[0][0].rules[0]).toEqual({ field: "is_favorite", operator: "equals", value: false });
});

test("preview network failures are explicit and retryable without losing conditions", async () => {
  previewSmartPlaylist.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(sample);
  render(<SmartPlaylistBuilder />);
  fill();
  await tick();
  expect(screen.getByRole("alert")).toHaveTextContent("Can't reach MusicDeck");
  expect(screen.getByLabelText("Value 1.1")).toHaveValue("Synthwave");
  fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
  await tick();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText("Night Drive")).toBeInTheDocument();
});

test("saving failures retain edits; after creating, subsequent saves update rather than duplicate", async () => {
  createSmartPlaylist.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockImplementationOnce(async (payload) => ({ playlist: { ...payload, id: "smart-1" } }));
  updateSmartPlaylist.mockImplementation(async (id, payload) => ({ playlist: { id, ...payload } }));
  render(<SmartPlaylistBuilder />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Create smart playlist" }));
  await act(async () => {});
  expect(screen.getByRole("alert")).toHaveTextContent("Can't reach MusicDeck");
  expect(screen.getByLabelText("Value 1.1")).toHaveValue("Synthwave");
  fireEvent.click(screen.getByRole("button", { name: "Create smart playlist" }));
  await act(async () => {});
  change("Playlist name", "Updated collection");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await act(async () => {});
  expect(createSmartPlaylist).toHaveBeenCalledTimes(2);
  expect(updateSmartPlaylist).toHaveBeenCalledWith("smart-1", expect.objectContaining({ name: "Updated collection" }));
});

