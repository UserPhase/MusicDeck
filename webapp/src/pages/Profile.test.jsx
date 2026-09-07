import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import Profile from "./Profile";
import {
  changePassword,
  getCurrentUser,
  updateCurrentUser,
} from "../api/musicdeck";
import { useAuth } from "../context/AuthContext";


jest.mock("../api/musicdeck", () => ({
  changePassword: jest.fn(),
  getCurrentUser: jest.fn(),
  updateCurrentUser: jest.fn(),
}));

jest.mock("../context/AuthContext", () => ({
  useAuth: jest.fn(),
}));


beforeEach(() => {
  jest.clearAllMocks();
  useAuth.mockReturnValue({ updateSession: jest.fn() });
});


test("loads the current user and prevents role editing", async () => {
  getCurrentUser.mockResolvedValue({
    id: "user-1",
    username: "sam",
    displayName: "Sam",
    role: "user",
    avatarRef: "avatar-1",
  });

  render(<Profile />);

  expect(await screen.findByRole("heading", { name: "Sam" })).toBeInTheDocument();
  expect(screen.getByDisplayValue("sam")).toBeDisabled();
  expect(screen.getByDisplayValue("user")).toBeDisabled();
});


test("updates display name and avatar reference", async () => {
  const updateSession = jest.fn();
  useAuth.mockReturnValue({ updateSession });
  getCurrentUser.mockResolvedValue({
    id: "user-1",
    username: "sam",
    displayName: "Sam",
    role: "user",
    avatarRef: null,
  });
  updateCurrentUser.mockResolvedValue({
    id: "user-1",
    username: "sam",
    displayName: "Samuel",
    role: "user",
    avatarRef: "avatar-2",
  });

  render(<Profile />);

  fireEvent.change(await screen.findByLabelText(/display name/i), {
    target: { value: "Samuel" },
  });
  fireEvent.change(screen.getByLabelText(/avatar reference/i), {
    target: { value: "avatar-2" },
  });
  fireEvent.click(screen.getByRole("button", { name: /save profile/i }));

  await waitFor(() => {
    expect(updateCurrentUser).toHaveBeenCalledWith({
      displayName: "Samuel",
      avatarRef: "avatar-2",
    });
  });
  expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Samuel" }));
  expect(await screen.findByText(/profile updated/i)).toBeInTheDocument();
});


test("changes password and surfaces API errors", async () => {
  getCurrentUser.mockResolvedValue({
    id: "user-1",
    username: "sam",
    displayName: "Sam",
    role: "user",
    avatarRef: null,
  });
  changePassword.mockRejectedValueOnce(new Error("Current password is incorrect"));
  changePassword.mockResolvedValueOnce({ ok: true });

  render(<Profile />);

  fireEvent.change(await screen.findByLabelText(/current password/i), {
    target: { value: "wrong-password" },
  });
  fireEvent.change(screen.getByLabelText(/new password/i), {
    target: { value: "new-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: /change password/i }));

  expect(await screen.findByText(/current password is incorrect/i)).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/current password/i), {
    target: { value: "old-password" },
  });
  fireEvent.change(screen.getByLabelText(/new password/i), {
    target: { value: "new-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: /change password/i }));

  expect(await screen.findByText(/password updated/i)).toBeInTheDocument();
});
