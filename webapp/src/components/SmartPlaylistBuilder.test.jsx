import { act, fireEvent, render, screen } from "@testing-library/react";
import SmartPlaylistBuilder from "./SmartPlaylistBuilder";
import { createSmartPlaylist, previewSmartPlaylist, saveMixPlaylist, updateSmartPlaylist, findSmartPlaylistSeeds } from "../api/musicdeck";

jest.mock("../api/musicdeck", () => ({ createSmartPlaylist: jest.fn(), previewSmartPlaylist: jest.fn(), saveMixPlaylist: jest.fn(), updateSmartPlaylist: jest.fn(), findSmartPlaylistSeeds: jest.fn() }));
const sample = { total: 18, available: 18, selectionToken: "a".repeat(64), tracks: [{ id: "one", title: "Night Drive", artist: "Neon", album: "After Hours" }], warning: null, refreshedAt: "2026-10-27T00:00:00Z" };
const tick = async () => { await act(async () => { jest.advanceTimersByTime(350); }); };
const change = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const era = () => { fireEvent.click(screen.getByRole("button", { name: /An era/ })); change("Playlist name", "80s party"); };
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); previewSmartPlaylist.mockResolvedValue(sample); findSmartPlaylistSeeds.mockResolvedValue({ tracks: sample.tracks }); saveMixPlaylist.mockResolvedValue({ playlist: { id: "mdpl_mix", name: "80s party" } }); createSmartPlaylist.mockImplementation(async payload => ({ playlist: { id: "smart_mix", ...payload } })); });
afterEach(() => jest.useRealTimers());

test("starts with three guided ideas instead of a rules editor", () => {
  render(<SmartPlaylistBuilder />);
  expect(screen.getByRole("button", { name: /Similar songs/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /An era/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Rediscover/ })).toBeInTheDocument();
  expect(screen.queryByLabelText("Field 1.1")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Nested group/ })).not.toBeInTheDocument();
});

test("the 80s preset previews an inclusive year range and saves a fixed regular playlist by default", async () => {
  const onSaved = jest.fn(); render(<SmartPlaylistBuilder onSaved={onSaved} />); era(); await tick();
  expect(previewSmartPlaylist).toHaveBeenCalledWith({ operator: "AND", rules: [
    { field: "era_year", operator: "greater_than", value: 1979 }, { field: "era_year", operator: "less_than", value: 1990 },
  ] }, expect.any(AbortSignal), expect.objectContaining({ size: 50, order: "variety" }));
  expect(screen.getByRole("checkbox", { name: /Keep this mix updated/ })).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Save playlist" })); await act(async () => {});
  expect(saveMixPlaylist).toHaveBeenCalledWith(expect.objectContaining({ name: "80s party", selectionToken: sample.selectionToken }));
  expect(createSmartPlaylist).not.toHaveBeenCalled();
  expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "mdpl_mix" }), "playlist");
});

test("size and keep-updated are explicit and persist when saving a smart playlist", async () => {
  render(<SmartPlaylistBuilder />); era(); change("Playlist size", "25");
  fireEvent.click(screen.getByRole("checkbox", { name: /Keep this mix updated/ })); await tick();
  fireEvent.click(screen.getByRole("button", { name: "Save smart playlist" })); await act(async () => {});
  expect(createSmartPlaylist).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ size: 25, order: "variety" }) }));
  expect(saveMixPlaylist).not.toHaveBeenCalled();
});

test("Similar songs chooses a library song, with optional artist and genre refinements", async () => {
  render(<SmartPlaylistBuilder />); fireEvent.click(screen.getByRole("button", { name: /Similar songs/ }));
  change("Find song mix", "Night"); await tick();
  fireEvent.click(screen.getByRole("button", { name: "Use song: Night Drive — Neon" }));
  fireEvent.click(screen.getByText("Refine your mix"));
  change("Genre", "Synthwave"); await tick();
  expect(previewSmartPlaylist.mock.calls.at(-1)[0].rules).toEqual([
    { field: "similar_to", operator: "matches", value: "one" }, { field: "genre", operator: "contains", value: "Synthwave" },
  ]);
  expect(previewSmartPlaylist.mock.calls.at(-1)[2].order).toBe("similar");
});

test("Rediscover uses previous plays, a listening period and personal likes", async () => {
  render(<SmartPlaylistBuilder />); fireEvent.click(screen.getByRole("button", { name: /Rediscover/ }));
  change("Haven't listened in", "90"); await tick();
  expect(previewSmartPlaylist.mock.calls.at(-1)[0].rules).toEqual([
    { field: "play_count", operator: "greater_than", value: 0 }, { field: "last_played", operator: "not_in_last_days", value: 90 },
    { field: "is_favorite", operator: "equals", value: true },
  ]);
});

test("invalid year ranges never preview or save, and zero results cannot make an empty playlist", async () => {
  render(<SmartPlaylistBuilder />); era(); change("From year", "1990"); await tick();
  expect(previewSmartPlaylist).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Save playlist" })).toBeDisabled();
  previewSmartPlaylist.mockResolvedValue({ ...sample, total: 0, tracks: [] }); change("From year", "1980"); await tick();
  expect(screen.getByRole("status")).toHaveTextContent("No songs fit yet");
  expect(screen.getByRole("button", { name: "Save playlist" })).toBeDisabled();
});

test("preview requests abort on change and cannot overwrite a newer mix", async () => {
  let finish; previewSmartPlaylist.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ ...sample, total: 2 });
  const view = render(<SmartPlaylistBuilder />); era(); await tick(); const signal = previewSmartPlaylist.mock.calls[0][1];
  change("Playlist size", "25"); await tick(); expect(signal.aborted).toBe(true);
  await act(async () => { finish({ ...sample, total: 99 }); });
  expect(screen.getByRole("heading", { name: "2 songs" })).toBeInTheDocument();
  const latest = previewSmartPlaylist.mock.calls.at(-1)[1]; view.unmount(); expect(latest.aborted).toBe(true);
});

test("network failures retain the mix and preview can be retried", async () => {
  previewSmartPlaylist.mockRejectedValueOnce(new TypeError("Offline")).mockResolvedValueOnce(sample);
  render(<SmartPlaylistBuilder />); era(); await tick();
  expect(screen.getByRole("alert")).toHaveTextContent("Can't reach MusicDeck");
  fireEvent.click(screen.getByRole("button", { name: "Retry preview" })); await tick();
  expect(screen.getByRole("heading", { name: "18 songs" })).toBeInTheDocument();
  expect(screen.getByLabelText("Playlist name")).toHaveValue("80s party");
});
