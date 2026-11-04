import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TasteProfileView from "./TasteProfileView";
import { tasteProfileStore } from "../../services/TasteProfileStore";
let mockOwner = "alice";
jest.mock("../../context/AuthContext", () => ({ useAuth: () => ({ session: { id: mockOwner } }) }));
jest.mock("../../hooks/useTasteProfile", () => ({ useTasteProfile: () => ({ privateListening: false, pending: false, error: "", setPrivate: jest.fn(async () => {}) }) }));
jest.mock("../../services/TasteProfileStore", () => ({ TASTE_CHANGED: "taste-test-change", tasteProfileStore: { request: jest.fn() } }));
const initial = { privateListening: false, revision: 5, resetBefore: null, providerHistoryDisabled: false, eligibleListens: 20,
  hidden: [{ id: "artist", type: "artist", title: "Night Pilot", artist: "Night Pilot", album: "", aliases: 2 }, { id: "track", type: "track", title: "Midnight", artist: "Night Pilot", album: "After Hours", aliases: 1 }],
  trackExclusions: [{ id: "rain", title: "Rain", artist: "Sleep" }], playlistExclusions: [{ id: "party", name: "Party set" }] };
beforeEach(() => { mockOwner = "alice"; jest.clearAllMocks(); (tasteProfileStore.request as jest.Mock).mockResolvedValue(initial); });
const show = () => render(<MemoryRouter><TasteProfileView /></MemoryRouter>);
test("filters hidden rules and restores the selected canonical artist", async () => {
  show(); await screen.findByRole("button", { name: "Restore Night Pilot" });
  fireEvent.change(screen.getByRole("combobox", { name: "Hidden item type" }), { target: { value: "artist" } });
  expect(screen.queryByRole("button", { name: "Restore Midnight" })).not.toBeInTheDocument();
  (tasteProfileStore.request as jest.Mock).mockResolvedValueOnce({ ...initial, hidden: initial.hidden.slice(1) });
  fireEvent.click(screen.getByRole("button", { name: "Restore Night Pilot" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Restore Night Pilot" })).not.toBeInTheDocument());
  expect(tasteProfileStore.request).toHaveBeenCalledWith("/restore", { type: "artist", id: "artist" });
});
test("reset requires explicit confirmation and explains what remains saved", async () => {
  show(); await screen.findByRole("button", { name: "Restore Night Pilot" });
  fireEvent.click(screen.getByRole("button", { name: "Reset listening influence" }));
  expect(screen.getByRole("button", { name: "Confirm reset" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Confirm taste reset"), { target: { value: "RESET" } });
  (tasteProfileStore.request as jest.Mock).mockResolvedValueOnce({ ...initial, eligibleListens: 0, revision: 6, resetBefore: new Date().toISOString() });
  fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
  expect(await screen.findByText(/Past listening influence has been reset/)).toBeInTheDocument();
  expect(tasteProfileStore.request).toHaveBeenCalledWith("/reset", { revision: 5, confirmation: "RESET" });
  expect(screen.getByRole("link", { name: "Party set" })).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Restore Midnight" })).toBeInTheDocument();
});
test("a failed restore remains visible after the list reloads", async () => {
  show(); await screen.findByRole("button", { name: "Restore Midnight" });
  (tasteProfileStore.request as jest.Mock).mockRejectedValueOnce(new Error("Connection interrupted. Try again."));
  fireEvent.click(screen.getByRole("button", { name: "Restore Midnight" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
  await waitFor(() => expect(screen.getByRole("button", { name: "Restore Midnight" })).toBeEnabled());
  expect(screen.getByRole("alert")).toHaveTextContent("Connection interrupted");
});
test("account changes discard private in-flight dashboard data", async () => {
  let finish!: (result: unknown) => void;
  (tasteProfileStore.request as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = show(); mockOwner = "bob";
  (tasteProfileStore.request as jest.Mock).mockResolvedValue({ ...initial, hidden: [], trackExclusions: [], playlistExclusions: [] });
  view.rerender(<MemoryRouter><TasteProfileView /></MemoryRouter>);
  await act(async () => { finish(initial); });
  expect(screen.queryByRole("button", { name: "Restore Midnight" })).not.toBeInTheDocument();
});
