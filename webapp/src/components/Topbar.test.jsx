import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Topbar from "./Topbar";
import { useAuth } from "../context/AuthContext";
import { searchNavidrome } from "../api/musicdeck";
import { useImport } from "../context/ImportContext";


jest.mock("../context/AuthContext", () => ({
  useAuth: jest.fn(),
}));
jest.mock("../context/ImportContext", () => ({ useImport: jest.fn() }));

jest.mock("../context/PlayerContext", () => ({
  usePlayer: () => ({
    playSong: jest.fn(),
  }),
}));

jest.mock("../api/musicdeck", () => ({
  getCoverUrl: jest.fn(() => null),
  searchNavidrome: jest.fn(),
}));


function renderTopbar(user) {
  useImport.mockReturnValue({ job: null, isMinimized: false, openProgress: jest.fn() });
  useAuth.mockReturnValue({
    session: user,
    signOut: jest.fn(),
  });

  return render(
    <MemoryRouter>
      <Topbar />
    </MemoryRouter>
  );
}

test("shows a minimized playlist import in the header and reopens it", () => {
  const openProgress = jest.fn();
  useAuth.mockReturnValue({ session: { username: "sam", displayName: "Sam", role: "user" }, signOut: jest.fn() });
  useImport.mockReturnValue({ job: { id: "job-1", status: "running" }, isMinimized: true, openProgress });
  render(<MemoryRouter><Topbar /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Show playlist import progress" }));
  expect(openProgress).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Importing 1 Playlist...")).toBeInTheDocument();
});


test("opens and closes the account menu from the profile button", () => {
  renderTopbar({
    username: "sam",
    displayName: "Sam",
    role: "user",
  });

  fireEvent.click(screen.getByRole("button", { name: /sam/i }));

  expect(screen.getByRole("menuitem", { name: /profile/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /settings/i })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: /admin dashboard/i })).not.toBeInTheDocument();
  expect(screen.getByRole("menu").parentElement).toBe(document.body);
  expect(screen.getByRole("menu")).toHaveClass("glass-dropdown", "account-menu");

  fireEvent.keyDown(document, { key: "Escape" });

  expect(screen.queryByRole("menuitem", { name: /profile/i })).not.toBeInTheDocument();
});


test("keeps theme controls out of the profile menu", () => {
  renderTopbar({ username: "sam", displayName: "Sam", role: "user" });
  fireEvent.click(screen.getByRole("button", { name: /sam/i }));
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent.trim()))
    .toEqual(["Profile", "Settings", "Log out"]);
});


test("shows Admin Dashboard only for admin users", () => {
  renderTopbar({
    username: "admin",
    displayName: "Admin",
    role: "admin",
  });

  fireEvent.click(screen.getByRole("button", { name: /admin/i }));

  expect(screen.getByRole("menuitem", { name: /admin dashboard/i })).toBeInTheDocument();
});

test("uses a play button and separate artist links for a live-search result", async () => {
  jest.useFakeTimers();
  searchNavidrome.mockResolvedValue({
    songs: [{ id: "track-1", title: "Digital Love", artist: "Daft Punk, Guest",
      artistCredits: [{ id: "daft-punk", name: "Daft Punk" }, { id: "guest", name: "Guest" }] }],
  });

  renderTopbar({ username: "sam", displayName: "Sam", role: "user" });

  fireEvent.change(screen.getByLabelText("Search your music"), {
    target: { value: "digital" },
  });

  await act(async () => {
    jest.advanceTimersByTime(250);
  });

  expect(await screen.findByRole("button", { name: "Digital Love" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Daft Punk" })).toHaveAttribute("href", "/artist/daft-punk");
  expect(screen.getByRole("link", { name: "Guest" })).toHaveAttribute("href", "/artist/guest");
  const suggestionPanel = screen.getByRole("button", { name: "Digital Love" }).closest(".search-dropdown");
  expect(suggestionPanel.parentElement).toBe(document.body);
  expect(suggestionPanel).toHaveClass("glass-dropdown");
  jest.useRealTimers();
});

test("links to Downloads from the top bar", () => {
  renderTopbar({ username: "sam", displayName: "Sam", role: "user" });

  expect(screen.getByRole("link", { name: "Downloads" })).toHaveAttribute("href", "/downloads");
});
