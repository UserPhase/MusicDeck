import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Topbar from "./Topbar";
import { useAuth } from "../context/AuthContext";
import { searchNavidrome, getAcquisitions } from "../api/musicdeck";


jest.mock("../context/AuthContext", () => ({
  useAuth: jest.fn(),
}));

jest.mock("../context/PlayerContext", () => ({
  usePlayer: () => ({
    playSong: jest.fn(),
  }),
}));

jest.mock("../api/musicdeck", () => ({
  getCoverUrl: jest.fn(() => null),
  searchNavidrome: jest.fn(),
  getAcquisitions: jest.fn(() => Promise.resolve([])),
  cancelAcquisition: jest.fn(),
  retryAcquisition: jest.fn(),
}));


function renderTopbar(user) {
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

  fireEvent.keyDown(document, { key: "Escape" });

  expect(screen.queryByRole("menuitem", { name: /profile/i })).not.toBeInTheDocument();
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

test("uses a real button for a live-search play result", async () => {
  jest.useFakeTimers();
  searchNavidrome.mockResolvedValue({
    songs: [{ id: "track-1", title: "Digital Love", artist: "Daft Punk" }],
  });

  renderTopbar({ username: "sam", displayName: "Sam", role: "user" });

  fireEvent.change(screen.getByLabelText("Search your music"), {
    target: { value: "digital" },
  });

  await act(async () => {
    jest.advanceTimersByTime(250);
  });

  expect(await screen.findByRole("button", { name: "Digital Love" })).toBeInTheDocument();
  jest.useRealTimers();
});

test("shows the Downloads button next to the account menu with active job count", async () => {
  getAcquisitions.mockResolvedValueOnce([
    { id: "acq-1", status: "downloading", progress: { percent: 42 }, files: [{ title: "We Will Rock You" }] },
  ]);

  renderTopbar({ username: "sam", displayName: "Sam", role: "user" });

  const downloadsButton = await screen.findByRole("button", { name: "Downloads" });
  expect(downloadsButton).toBeInTheDocument();
  expect(await screen.findByText("1")).toBeInTheDocument();

  fireEvent.click(downloadsButton);

  expect(await screen.findByText("We Will Rock You")).toBeInTheDocument();
  expect(screen.getByText("Downloading 42%")).toBeInTheDocument();
});
