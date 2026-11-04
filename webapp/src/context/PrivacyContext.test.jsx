import { act, fireEvent, render, screen } from "@testing-library/react";
import { PrivacyProvider, usePrivacy } from "./PrivacyContext";
import { getPrivacySettings, updatePrivacySettings } from "../api/privacy";
import { isBrowserIntegrationAllowed, setBrowserPrivacy } from "../services/privacyPolicy";

let mockSession = { id: "admin", role: "admin" };
jest.mock("./AuthContext", () => ({ useAuth: () => ({ session: mockSession }) }));
jest.mock("../api/privacy", () => ({ getPrivacySettings: jest.fn(), updatePrivacySettings: jest.fn() }));

const allowed = { localOnly: false, allowMetadata: true, allowImports: true, allowArtwork: true,
  enforcedByEnvironment: false, effective: { metadata: true, imports: true, artwork: true, external: true } };
const denied = { ...allowed, localOnly: true, effective: { metadata: false, imports: false, artwork: false, external: false } };
function Probe() {
  const privacy = usePrivacy();
  return <div><input aria-label="Local player state" defaultValue="Paused at 1:42" />
    <output data-testid="permissions">{`${privacy.canMetadata}/${privacy.canImport}/${privacy.canArtwork}`}</output>
    <output data-testid="busy">{String(privacy.busy)}</output>
    <button onClick={() => { void privacy.save(denied).catch(() => {}); }}>Save policy</button>
  </div>;
}
const flush = () => act(async () => {});
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockSession = { id: "admin", role: "admin" };
  getPrivacySettings.mockResolvedValue(allowed);
});
afterEach(() => { jest.useRealTimers(); setBrowserPrivacy(undefined); jest.restoreAllMocks(); });

test("holds authenticated children until the initial policy is known", async () => {
  render(<PrivacyProvider><Probe /></PrivacyProvider>);
  expect(screen.queryByLabelText("Local player state")).not.toBeInTheDocument();
  expect(isBrowserIntegrationAllowed("metadata")).toBe(false);
  await flush();
  expect(screen.getByTestId("permissions")).toHaveTextContent("true/true/true");
});

test("synchronizes restrictions every five seconds and on window focus", async () => {
  render(<PrivacyProvider><Probe /></PrivacyProvider>);
  await flush();
  getPrivacySettings.mockResolvedValueOnce(denied);
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(screen.getByTestId("permissions")).toHaveTextContent("false/false/false");
  expect(isBrowserIntegrationAllowed("imports")).toBe(false);
  fireEvent(window, new Event("focus"));
  await flush();
  expect(screen.getByTestId("permissions")).toHaveTextContent("true/true/true");
});

test("keeps local playback mounted but fails external access closed during a sync outage", async () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  render(<PrivacyProvider><Probe /></PrivacyProvider>);
  await flush();
  const player = screen.getByLabelText("Local player state");
  fireEvent.change(player, { target: { value: "Playing at 2:10" } });
  getPrivacySettings.mockRejectedValueOnce(new Error("Disconnected"));
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(screen.getByLabelText("Local player state")).toBe(player);
  expect(player).toHaveValue("Playing at 2:10");
  expect(screen.getByRole("alert")).toHaveTextContent("Local playback remains available");
  expect(screen.getByTestId("permissions")).toHaveTextContent("false/false/false");
  expect(isBrowserIntegrationAllowed("artwork")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry privacy sync" }));
  await flush();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Local player state")).toBe(player);
  expect(error).toHaveBeenCalled();
});

test("an initial failure stays closed and exposes retry", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  getPrivacySettings.mockRejectedValueOnce(new Error("Offline"));
  render(<PrivacyProvider><Probe /></PrivacyProvider>);
  await flush();
  expect(screen.queryByLabelText("Local player state")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Privacy policy unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await flush();
  expect(screen.getByLabelText("Local player state")).toBeInTheDocument();
});

test("ignores an old account's response after switching accounts", async () => {
  let resolveOld;
  getPrivacySettings.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValueOnce(denied);
  const view = render(<PrivacyProvider><Probe /></PrivacyProvider>);
  mockSession = { id: "other-admin", role: "admin" };
  view.rerender(<PrivacyProvider><Probe /></PrivacyProvider>);
  await flush();
  await act(async () => { resolveOld(allowed); });
  expect(screen.getByTestId("permissions")).toHaveTextContent("false/false/false");
});

test("a late save from an old account cannot overwrite the new account's policy", async () => {
  let resolveSave;
  updatePrivacySettings.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
  const view = render(<PrivacyProvider><Probe /></PrivacyProvider>);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
  expect(screen.getByTestId("busy")).toHaveTextContent("true");
  mockSession = { id: "other-admin", role: "admin" };
  getPrivacySettings.mockResolvedValue(denied);
  view.rerender(<PrivacyProvider><Probe /></PrivacyProvider>);
  await flush();
  await act(async () => { resolveSave(allowed); });
  expect(screen.getByTestId("permissions")).toHaveTextContent("false/false/false");
  expect(screen.getByTestId("busy")).toHaveTextContent("false");
});
