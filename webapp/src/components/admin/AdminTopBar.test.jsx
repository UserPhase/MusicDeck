import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminTopBar from "./AdminTopBar";
import { useAuth } from "../../context/AuthContext";

jest.mock("../../context/AuthContext", () => ({ useAuth: jest.fn() }));

test("admin profile actions render in a glass portal and support keyboard dismissal", () => {
  const signOut = jest.fn();
  useAuth.mockReturnValue({ session: { username: "Admin" }, signOut });
  render(<MemoryRouter><AdminTopBar /></MemoryRouter>);
  const trigger = screen.getByRole("button", { name: /Profile/ });
  fireEvent.click(trigger);
  const menu = screen.getByRole("menu");
  expect(menu.parentElement).toBe(document.body);
  expect(menu).toHaveClass("glass-dropdown", "admin-profile-menu");
  expect(screen.getByRole("menuitem", { name: "Profile" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: "End" });
  expect(screen.getByRole("menuitem", { name: "Log out" })).toHaveFocus();
  fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
  expect(signOut).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
