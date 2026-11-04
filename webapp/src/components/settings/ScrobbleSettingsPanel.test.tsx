import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ScrobbleSettingsPanel from "./ScrobbleSettingsPanel";
import * as api from "../../api/scrobble";
import type { ScrobbleConnection } from "../../api/scrobble";

let mockOwner: string | null = "user-1";
let mockPrivacy = true;
jest.mock("../../context/AuthContext", () => ({ useAuth: () => ({ session: mockOwner ? { id: mockOwner } : null }) }));
jest.mock("../../context/PrivacyContext", () => ({ usePrivacy: () => ({ policy: { effective: { external: mockPrivacy } } }) }));
jest.mock("../../api/scrobble");
const status = (provider: "lastfm" | "listenbrainz", extra: Partial<ScrobbleConnection> = {}): ScrobbleConnection => ({
  provider, available: true, unavailableReason: null, enabled: false, username: null, status: "disconnected",
  lastSuccessfulScrobble: null, lastListenedAt: null, lastCheckedAt: null, nextRetryAt: null, pending: 0, failed: 0, error: null, diagnostics: [], ...extra,
});
let connections: ScrobbleConnection[];
beforeEach(() => {
  jest.resetAllMocks(); mockOwner = "user-1"; mockPrivacy = true;
  connections = [status("lastfm"), status("listenbrainz")];
  jest.mocked(api.getScrobbleConnections).mockImplementation(async () => ({ connections }));
  jest.mocked(api.connectScrobble).mockImplementation(async () => ({ connections: [connections[0], status("listenbrainz", { enabled: true, username: "listener", status: "connected" })] }));
  jest.mocked(api.scrobbleAction).mockImplementation(async () => ({ connections }));
});
test("validates ListenBrainz tokens, clears the field, and displays the connected account", async () => {
  render(<ScrobbleSettingsPanel />);
  const input = await screen.findByLabelText("ListenBrainz user token");
  await waitFor(() => expect(input).toBeEnabled());
  expect(input).toHaveAttribute("type", "password");
  fireEvent.change(input, { target: { value: "private-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Validate & connect" }));
  expect(await screen.findByText("Connected as listener")).toBeInTheDocument();
  expect(api.connectScrobble).toHaveBeenCalledWith("listenbrainz", "private-token", expect.any(AbortSignal));
  expect(input).toHaveValue("");
  expect(window.localStorage.getItem("private-token")).toBeNull();
});
test("shows last-success and diagnostic status and tests without submitting a fake play", async () => {
  connections[0] = status("lastfm", { enabled: true, username: "collector", status: "error", pending: 1, failed: 1,
    lastSuccessfulScrobble: "2026-11-01T12:00:00Z", lastListenedAt: "2026-11-01T11:00:00Z", nextRetryAt: "2026-11-01T13:00:00Z",
    error: { code: "LASTFM_16", message: "Last.fm is temporarily unavailable.", httpStatus: 200 },
    diagnostics: [{ id: "job-1", track: "Night Music", artist: "Artist", listenedAt: "2026-11-01T11:00:00Z", state: "pending", attempts: 2,
      code: "LASTFM_16", message: "Waiting for Last.fm.", httpStatus: 200, nextRetryAt: "2026-11-01T13:00:00Z" }] });
  render(<ScrobbleSettingsPanel />);
  const card = await screen.findByRole("article", { name: "Last.fm" });
  expect(await within(card).findByText("Connected as collector")).toBeInTheDocument();
  expect(within(card).getByText(new Date("2026-11-01T12:00:00Z").toLocaleString())).toBeInTheDocument();
  expect(within(card).getByText("Artist — Night Music")).toBeInTheDocument();
  fireEvent.click(within(card).getByRole("button", { name: "Test Last.fm connection" }));
  expect(await screen.findByText(/No test listen was submitted/)).toBeInTheDocument();
  expect(api.scrobbleAction).toHaveBeenCalledWith("lastfm", "test", expect.any(AbortSignal));
  fireEvent.click(within(card).getByRole("button", { name: "Retry failed listens" }));
  await waitFor(() => expect(api.scrobbleAction).toHaveBeenCalledWith("lastfm", "retry", expect.any(AbortSignal)));
});
test("privacy blocks connections and testing while disconnect remains available", async () => {
  mockPrivacy = false;
  connections[1] = status("listenbrainz", { enabled: true, username: "listener", status: "paused" });
  render(<ScrobbleSettingsPanel />);
  const disconnect = await screen.findByRole("button", { name: "Disconnect ListenBrainz" });
  expect(screen.getByRole("button", { name: "Test ListenBrainz connection" })).toBeDisabled();
  expect(screen.getByLabelText("ListenBrainz user token")).toBeDisabled();
  expect(disconnect).toBeEnabled();
  fireEvent.click(disconnect);
  await waitFor(() => expect(api.scrobbleAction).toHaveBeenCalledWith("listenbrainz", "disconnect", expect.any(AbortSignal)));
});
test("a user change clears private fields and ignores stale connection responses", async () => {
  const { rerender } = render(<ScrobbleSettingsPanel />);
  const input = await screen.findByLabelText("ListenBrainz user token");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: "old-user-token" } });
  mockOwner = "user-2";
  rerender(<ScrobbleSettingsPanel />);
  expect(screen.getByLabelText("ListenBrainz user token")).toHaveValue("");
  await waitFor(() => expect(api.getScrobbleConnections).toHaveBeenCalledTimes(2));
});
test("failed validation reports an actionable message and erases the attempted secret", async () => {
  jest.mocked(api.connectScrobble).mockRejectedValue(new Error("ListenBrainz rejected this user token. Replace it in Settings."));
  render(<ScrobbleSettingsPanel />);
  const input = await screen.findByLabelText("ListenBrainz user token");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: "bad-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Validate & connect" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Replace it in Settings");
  expect(input).toHaveValue("");
});
test("polls live status and cancels the request on unmount", async () => {
  jest.useFakeTimers();
  try {
    const { unmount } = render(<ScrobbleSettingsPanel />);
    await act(async () => {});
    await act(async () => { jest.advanceTimersByTime(15000); });
    expect(api.getScrobbleConnections).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => { jest.advanceTimersByTime(15000); });
    expect(api.getScrobbleConnections).toHaveBeenCalledTimes(2);
  } finally { jest.useRealTimers(); }
});
