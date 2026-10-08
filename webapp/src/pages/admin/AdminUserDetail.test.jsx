import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import AdminUserDetail, { formatRelativeTime } from "./AdminUserDetail";
import {
  deleteUser,
  getAdminUserSettings,
  getUsers,
  updateAdminUserSettings,
  updateUser,
} from "../../api/musicdeck";
import { useAuth } from "../../context/AuthContext";

jest.mock("../../api/musicdeck", () => ({
  USER_SETTINGS_CHANGED_EVENT: "musicdeck:user-settings-changed",
  deleteUser: jest.fn(),
  getAdminUserSettings: jest.fn(),
  getUsers: jest.fn(),
  updateAdminUserSettings: jest.fn(),
  updateUser: jest.fn(),
}));

jest.mock("../../context/AuthContext", () => ({
  useAuth: jest.fn(),
}));

const master = {
  id: "user_master",
  username: "owner",
  displayName: "Owner",
  role: "admin",
  disabled: false,
  isMasterAdmin: true,
  externalSearchEnabled: true,
  externalPlaybackEnabled: false,
  lastLoginAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  lastPlaybackAt: null,
  createdAt: "2024-01-01T00:00:00.000Z",
};

const listener = {
  id: "user_listener",
  username: "listener",
  displayName: "Listener",
  role: "user",
  disabled: false,
  isMasterAdmin: false,
  externalSearchEnabled: true,
  externalPlaybackEnabled: false,
  lastLoginAt: null,
  lastPlaybackAt: null,
  createdAt: "2024-02-01T00:00:00.000Z",
};

const updateSession = jest.fn();

function renderDetail(userId, sessionId = "user_master") {
  useAuth.mockReturnValue({ session: { id: sessionId }, updateSession });
  return render(
    <MemoryRouter initialEntries={[`/admin/users/${userId}`]}>
      <Routes>
        <Route path="/admin/users/:userId" element={<AdminUserDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  getUsers.mockResolvedValue([master, listener]);
  getAdminUserSettings.mockResolvedValue([{ key: "ui.theme", value: JSON.stringify("dark") }]);
});

test("locks permissions and danger zone for the master administrator", async () => {
  renderDetail("user_master", "user_other_admin");

  expect(await screen.findByText("Master administrator")).toBeInTheDocument();
  for (const label of ["External search", "Downloads", "Administration"]) {
    expect(screen.getByRole("switch", { name: label })).toBeDisabled();
  }
  expect(screen.getByRole("button", { name: "Disable user" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Delete user" })).toBeDisabled();
  expect(screen.getByText(/cannot be disabled or deleted/i)).toBeInTheDocument();
  expect(screen.queryByText("Connected servers")).not.toBeInTheDocument();
  expect(screen.getByText("2 hours ago")).toBeInTheDocument();
  expect(screen.getByText("No playback yet")).toBeInTheDocument();
});

test("toggles a regular user's downloads permission", async () => {
  updateUser.mockResolvedValue({ ...listener, externalPlaybackEnabled: true });
  renderDetail("user_listener");

  const downloads = await screen.findByRole("switch", { name: "Downloads" });
  expect(downloads).toHaveAttribute("aria-checked", "false");
  fireEvent.click(downloads);

  await waitFor(() => expect(updateUser).toHaveBeenCalledWith("user_listener", { externalPlaybackEnabled: true }));
  await waitFor(() => expect(screen.getByRole("switch", { name: "Downloads" })).toHaveAttribute("aria-checked", "true"));
  expect(screen.getByRole("button", { name: "Delete user" })).toBeEnabled();
  expect(updateSession).not.toHaveBeenCalled();
  expect(deleteUser).not.toHaveBeenCalled();
});

test("saves preference overrides and re-applies them when editing yourself", async () => {
  updateAdminUserSettings.mockResolvedValue([{ key: "ui.theme", value: JSON.stringify("light") }]);
  const listenerSpy = jest.fn();
  window.addEventListener("musicdeck:user-settings-changed", listenerSpy);
  renderDetail("user_master");

  const theme = await screen.findByLabelText("Theme");
  expect(screen.getByRole("option", { name: "Light" })).toBeInTheDocument();
  fireEvent.change(theme, { target: { value: "light" } });

  await waitFor(() => expect(updateAdminUserSettings).toHaveBeenCalledWith("user_master", { "ui.theme": "light" }));
  await waitFor(() => expect(listenerSpy).toHaveBeenCalled());
  expect(listenerSpy.mock.calls[0][0].detail).toEqual({ "ui.theme": "light" });
  expect(screen.getByLabelText("Theme")).toHaveValue("light");
  window.removeEventListener("musicdeck:user-settings-changed", listenerSpy);
});

test("formats relative activity timestamps", () => {
  const now = Date.parse("2024-06-01T12:00:00Z");
  expect(formatRelativeTime("2024-05-30T12:00:00Z", now)).toBe("2 days ago");
  expect(formatRelativeTime(null, now)).toBeNull();
  expect(formatRelativeTime("2024-06-01T11:59:50Z", now)).toBe("Just now");
});
