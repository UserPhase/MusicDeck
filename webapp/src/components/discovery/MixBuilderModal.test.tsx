import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MixBuilderModal from "./MixBuilderModal";
import { mixRequest, type MixCandidate, type MixPreview } from "../../api/similarMixes";

let mockOwner = "alice", mockCanMetadata = true;
const mockQueue = jest.fn(), mockToggle = jest.fn();
jest.mock("../../context/AuthContext", () => ({ useAuth: () => ({ session: { id: mockOwner } }) }));
jest.mock("../../context/PrivacyContext", () => ({ usePrivacy: () => ({ canMetadata: mockCanMetadata }) }));
jest.mock("../../context/PlayerContext", () => ({ usePlayer: () => ({ queueTracks: mockQueue, isPlaying: false, togglePlay: mockToggle }) }));
jest.mock("../../api/similarMixes", () => ({ mixRequest: jest.fn() }));
const seed = { id: "seed", title: "Seed song", artist: "Seed artist" };
const candidate = (id: string, external = false): MixCandidate => ({ id, title: `Song ${id}`, artist: `Artist ${id}`, album: "Album", inLibrary: !external,
  score: 0.8, similarity: 0.9, familiarity: 0.5, reason: "Similar to 1 of your seed songs", track: { id, title: `Song ${id}`, artistName: `Artist ${id}`, external,
    ...(external ? { provider: "external", source: { kind: "external", count: 0 } } : { provider: "library", source: { kind: "library", count: 1 } }) } });
const initial = [candidate("a"), candidate("b"), candidate("c"), candidate("d", true)];
const preview = (tracks = initial): MixPreview => ({ tracks, previewId: "preview-id", warnings: [], cached: true, generatedInMs: 4, shuffleSeed: "nonce" });
beforeEach(() => {
  mockOwner = "alice"; mockCanMetadata = true; jest.clearAllMocks();
  jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(); jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  (mixRequest as jest.Mock).mockImplementation((path: string) => Promise.resolve(path === "preview" ? preview() : path === "selection" ? { tracks: initial.map(row => row.track) } : path === "save" ? { playlist: { id: "saved" } } : { tracks: [seed] }));
});
afterEach(() => { jest.restoreAllMocks(); });
const show = () => render(<MemoryRouter><MixBuilderModal open onClose={jest.fn()} initialSeeds={[seed]} /></MemoryRouter>);
const build = async () => { fireEvent.click(screen.getByRole("button", { name: "Build my mix" })); await screen.findByRole("button", { name: "Swap Song b" }); };

test("refresh keeps locked rows in their slots and swapping changes only its requested candidate", async () => {
  show(); await build();
  fireEvent.click(screen.getByRole("button", { name: "Lock Song c" }));
  (mixRequest as jest.Mock).mockResolvedValueOnce(preview([initial[2], candidate("e"), candidate("f"), candidate("g")]));
  fireEvent.click(screen.getByRole("button", { name: "Refresh mix" }));
  await screen.findByRole("button", { name: "Swap Song e" });
  const rows = () => [...document.querySelectorAll(".mix-candidates li")].map(row => row.querySelector("strong")!.textContent);
  expect(rows()).toEqual(["Song e", "Song f", "Song c", "Song g"]);
  expect((mixRequest as jest.Mock).mock.calls.filter(call => call[0] === "preview").at(-1)[2].lockedTrackIds).toEqual(["c"]);
  (mixRequest as jest.Mock).mockResolvedValueOnce(preview([candidate("e"), initial[2], candidate("g"), candidate("replacement")]));
  fireEvent.click(screen.getByRole("button", { name: "Swap Song f" }));
  await screen.findByRole("button", { name: "Swap Song replacement" });
  expect(rows()).toEqual(["Song e", "Song replacement", "Song c", "Song g"]);
  const request = (mixRequest as jest.Mock).mock.calls.filter(call => call[0] === "preview").at(-1)[2];
  expect(request.lockedTrackIds).toEqual(["e", "c", "g"]); expect(request.excludeTrackIds).toEqual(["f"]);
});

test("changed settings disable stale saves and queueing until an updated preview is confirmed", async () => {
  show(); await build(); fireEvent.change(screen.getByRole("slider"), { target: { value: "0.8" } });
  expect(screen.getByRole("button", { name: "Save as playlist" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Add to queue" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Update preview" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save as playlist" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
  await waitFor(() => expect(mockQueue).toHaveBeenCalledTimes(1));
  expect(mockQueue.mock.calls[0][0]).toHaveLength(4); expect(mockQueue.mock.calls[0][0][3].external).toBe(true);
  expect(await screen.findByText(/1 discoveries have no preview/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save as playlist" }));
  expect(await screen.findByRole("link", { name: /Open saved playlist/ })).toHaveAttribute("href", "/playlist/saved");
  expect((mixRequest as jest.Mock).mock.calls.find(call => call[0] === "save")[2].trackIds).toEqual(initial.map(row => row.id));
});

test("hidden-lock conflicts remain actionable and preserve the last confirmed preview", async () => {
  show(); await build(); fireEvent.click(screen.getByRole("button", { name: "Lock Song a" }));
  (mixRequest as jest.Mock).mockRejectedValueOnce(new Error("A locked song is no longer eligible. Unlock it and refresh the mix."));
  fireEvent.click(screen.getByRole("button", { name: "Refresh mix" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Unlock it"); expect(screen.getByRole("button", { name: "Unlock Song a" })).toBeEnabled();
});

test("account changes discard an in-flight private preview and abort its request", async () => {
  let finish!: (result: MixPreview) => void;
  (mixRequest as jest.Mock).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = show(); fireEvent.click(screen.getByRole("button", { name: "Build my mix" }));
  const signal = (mixRequest as jest.Mock).mock.calls[0][1] as AbortSignal;
  mockOwner = "bob";
  view.rerender(<MemoryRouter><MixBuilderModal open onClose={jest.fn()} /></MemoryRouter>);
  await act(async () => { finish(preview()); });
  expect(signal.aborted).toBe(true); expect(screen.queryByText("Song a")).not.toBeInTheDocument(); expect(screen.queryByText("Seed song")).not.toBeInTheDocument();
  expect(mockQueue).not.toHaveBeenCalled();
});

test("search adds chips, external seeds register metadata, and local-only mode disables external scopes", async () => {
  show(); fireEvent.change(screen.getByRole("searchbox"), { target: { value: "another" } });
  (mixRequest as jest.Mock).mockImplementation(path => Promise.resolve(String(path).startsWith("seeds?") ? { tracks: [{ id: "new", title: "Another song", artist: "Other" }] } : { track: { id: "external_lastfm_track_new", title: "Outside", artist: "Distant" } }));
  fireEvent.click(await screen.findByRole("button", { name: /Another song/ })); expect(screen.getByRole("button", { name: "Remove seed Another song" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "External song" })); fireEvent.change(screen.getByLabelText("Song title"), { target: { value: "Outside" } });
  fireEvent.change(screen.getByLabelText("Artist"), { target: { value: "Distant" } }); fireEvent.click(screen.getByRole("button", { name: "Add external seed" }));
  expect(await screen.findByRole("button", { name: "Remove seed Outside" })).toBeInTheDocument();
});

test("local-only mode disables external scopes and sends library-only requests", async () => {
  mockCanMetadata = false; show();
  expect(screen.getByRole("button", { name: /Discoveries Songs outside/ })).toBeDisabled(); expect(screen.getByRole("button", { name: "External song" })).toBeDisabled();
  await build(); expect((mixRequest as jest.Mock).mock.calls.find(call => call[0] === "preview")[2].scope).toBe("LIBRARY_ONLY");
});
