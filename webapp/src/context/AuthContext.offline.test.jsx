import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "./AuthContext";
import { getAuthSession, clearAuthSession } from "../api/session";
import { offlineDownloadEngine } from "../services/storage/OfflineDownloadEngine";
import { rememberDownloadOwner, rememberedDownloadOwner } from "../services/storage/offlineIdentity";

jest.mock("../api/session", () => ({ getAuthSession: jest.fn(), clearAuthSession: jest.fn() }));
jest.mock("../services/storage/OfflineDownloadEngine", () => ({ offlineDownloadEngine: { activate: jest.fn() } }));
jest.mock("../services/storage/OfflineAuditor", () => ({ offlineAuditor: { reset: jest.fn() } }));
jest.mock("../services/storage/offlineIdentity", () => ({ rememberedDownloadOwner: jest.fn(), rememberDownloadOwner: jest.fn() }));
function Status() {
  const auth = useAuth();
  return <><output>{auth.isLoading ? "loading" : auth.isAuthenticated ? "authenticated" : "local-only"}</output><button onClick={auth.signOut}>Sign out</button></>;
}
beforeEach(() => {
  jest.clearAllMocks();
  rememberedDownloadOwner.mockResolvedValue("alice");
  offlineDownloadEngine.activate.mockResolvedValue(undefined);
});
test("opens the remembered local collection after server failure without granting server authentication", async () => {
  getAuthSession.mockRejectedValue(new TypeError("Failed to fetch"));
  render(<AuthProvider><Status /></AuthProvider>);
  expect(await screen.findByText("local-only")).toBeInTheDocument();
  expect(offlineDownloadEngine.activate).toHaveBeenCalledWith("alice", false);
});
test("explicit sign-out clears the local selector and stops downloads", async () => {
  getAuthSession.mockResolvedValue({ id: "alice", role: "user" });
  render(<AuthProvider><Status /></AuthProvider>);
  await screen.findByText("authenticated");
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByText("local-only");
  expect(rememberDownloadOwner).toHaveBeenCalledWith(null);
  expect(offlineDownloadEngine.activate).toHaveBeenCalledWith(null, false);
  await waitFor(() => expect(clearAuthSession).toHaveBeenCalled());
});
