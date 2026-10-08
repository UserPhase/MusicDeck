import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import Profile from "./Profile";
import {
  changePassword,
  getCurrentUser,
  removeCurrentUserAvatar,
  updateCurrentUser,
  uploadCurrentUserAvatar,
} from "../api/musicdeck";
import { useAuth } from "../context/AuthContext";


jest.mock("../api/musicdeck", () => ({
  changePassword: jest.fn(),
  getCurrentUser: jest.fn(),
  removeCurrentUserAvatar: jest.fn(),
  updateCurrentUser: jest.fn(),
  uploadCurrentUserAvatar: jest.fn(),
}));

jest.mock("../context/AuthContext", () => ({
  useAuth: jest.fn(),
}));


const baseUser = {
  id: "user-1",
  username: "sam",
  displayName: "Sam",
  role: "user",
  avatarUrl: null,
};

function imageFile(type = "image/png", size = 1024) {
  const file = new File(["x"], "avatar.png", { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

beforeAll(() => {
  global.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,AAAA";
      this.onload?.();
    }
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  useAuth.mockReturnValue({ updateSession: jest.fn() });
});


test("shows only the display name field; username and role live in the header", async () => {
  getCurrentUser.mockResolvedValue(baseUser);

  render(<Profile />);

  expect(await screen.findByRole("heading", { name: "Sam" })).toBeInTheDocument();
  expect(screen.getByText("sam · user")).toBeInTheDocument();
  expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
  expect(screen.queryByLabelText(/^username$/i)).toBeNull();
  expect(screen.queryByLabelText(/^role$/i)).toBeNull();
  expect(screen.queryByLabelText(/avatar reference/i)).toBeNull();
  expect(screen.getByRole("button", { name: /choose profile photo/i })).toHaveTextContent("SA");
});


test("updates the display name", async () => {
  const updateSession = jest.fn();
  useAuth.mockReturnValue({ updateSession });
  getCurrentUser.mockResolvedValue(baseUser);
  updateCurrentUser.mockResolvedValue({ ...baseUser, displayName: "Samuel" });

  render(<Profile />);

  fireEvent.change(await screen.findByLabelText(/display name/i), {
    target: { value: "Samuel" },
  });
  fireEvent.click(screen.getByRole("button", { name: /save profile/i }));

  await waitFor(() => {
    expect(updateCurrentUser).toHaveBeenCalledWith({ displayName: "Samuel" });
  });
  expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Samuel" }));
  expect(await screen.findByText(/profile updated/i)).toBeInTheDocument();
});


test("clicking the avatar opens the file picker", async () => {
  getCurrentUser.mockResolvedValue(baseUser);

  render(<Profile />);

  const button = await screen.findByRole("button", { name: /choose profile photo/i });
  const clickSpy = jest.spyOn(screen.getByTestId("avatar-file-input"), "click");
  fireEvent.click(button);
  expect(clickSpy).toHaveBeenCalled();
});


test("uploading an avatar shows the photo and syncs the session", async () => {
  const updateSession = jest.fn();
  useAuth.mockReturnValue({ updateSession });
  getCurrentUser.mockResolvedValue(baseUser);
  const updated = { ...baseUser, avatarUrl: "/api/users/user-1/avatar?v=1" };
  uploadCurrentUserAvatar.mockResolvedValue(updated);

  const { container } = render(<Profile />);

  await screen.findByRole("heading", { name: "Sam" });
  fireEvent.change(screen.getByTestId("avatar-file-input"), {
    target: { files: [imageFile()] },
  });

  await waitFor(() => {
    expect(uploadCurrentUserAvatar).toHaveBeenCalledWith("data:image/png;base64,AAAA");
  });
  await waitFor(() => {
    expect(container.querySelector(".account-avatar img")).toHaveAttribute("src", updated.avatarUrl);
  });
  expect(updateSession).toHaveBeenCalledWith(updated);
  expect(screen.getByRole("button", { name: /remove photo/i })).toBeInTheDocument();
});


test("rejects unsupported and oversized avatars before uploading", async () => {
  getCurrentUser.mockResolvedValue(baseUser);

  render(<Profile />);

  await screen.findByRole("heading", { name: "Sam" });
  const input = screen.getByTestId("avatar-file-input");

  fireEvent.change(input, { target: { files: [imageFile("image/gif")] } });
  expect(await screen.findByRole("alert")).toHaveTextContent(/JPEG, PNG, or WebP/i);

  fireEvent.change(input, { target: { files: [imageFile("image/png", 6 * 1024 * 1024)] } });
  expect(await screen.findByRole("alert")).toHaveTextContent(/5 MB or smaller/i);

  expect(uploadCurrentUserAvatar).not.toHaveBeenCalled();
});


test("removing the avatar restores the initials", async () => {
  const updateSession = jest.fn();
  useAuth.mockReturnValue({ updateSession });
  getCurrentUser.mockResolvedValue({ ...baseUser, avatarUrl: "/api/users/user-1/avatar?v=1" });
  removeCurrentUserAvatar.mockResolvedValue(baseUser);

  render(<Profile />);

  fireEvent.click(await screen.findByRole("button", { name: /remove photo/i }));

  await waitFor(() => {
    expect(screen.getByRole("button", { name: /choose profile photo/i })).toHaveTextContent("SA");
  });
  expect(updateSession).toHaveBeenCalledWith(baseUser);
  expect(screen.queryByRole("button", { name: /remove photo/i })).toBeNull();
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
