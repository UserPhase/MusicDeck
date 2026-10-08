import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useEffect } from "react";

import AppLayout from "./AppLayout";
import { usePlayer } from "../../context/PlayerContext";
import { getPlaylists } from "../../api/playlists";

jest.mock("../../context/PlayerContext", () => ({ usePlayer: jest.fn() }));
jest.mock("../../api/playlists", () => ({
  getPlaylists: jest.fn(),
}));
jest.mock("../Sidebar", () => ({ id }) => <aside data-testid="library-sidebar" id={id} />);
jest.mock("../QueueSidebar", () => ({ isOpen }) => (isOpen ? <aside data-testid="queue-panel" /> : null));
jest.mock("../NowPlayingSidebar", () => ({ isOpen }) => (isOpen ? <aside data-testid="now-playing-panel" /> : null));
jest.mock("../PlaylistCover", () => () => <span />);
jest.mock("../Topbar", () => ({ leading, showPrimaryNav, playerSlot }) => (
  <header data-testid="topbar">
    {leading}
    {showPrimaryNav && <nav aria-label="Header navigation" />}
    {playerSlot}
  </header>
));
jest.mock("../Player", () => {
  const Player = ({ variant = "bar", actions }) => (
    <footer data-testid={`player-${variant}`}>{actions}</footer>
  );
  return { __esModule: true, default: Player, formatTime: () => "0:00" };
});
jest.mock("./HeaderPlayers/AppleHeaderPlayer", () => () => <div data-testid="apple-header-player" />);

let mounts = 0;
function RoutedPage() {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <p>Page content</p>;
}

function mockMatchMedia(isMobile) {
  window.matchMedia = jest.fn().mockImplementation((query) => ({
    matches: isMobile,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
}

function playerState(overrides = {}) {
  return {
    currentSong: null,
    activeSidebar: "none",
    setActiveSidebar: jest.fn(),
    autoOpenSidebar: true,
    queue: [],
    queueIndex: -1,
    recentlyPlayed: [],
    playSong: jest.fn(),
    ...overrides,
  };
}

function renderLayout(preset, path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppLayout preset={preset}>
        <RoutedPage />
      </AppLayout>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mounts = 0;
  mockMatchMedia(false);
  usePlayer.mockReturnValue(playerState());
  getPlaylists.mockResolvedValue([{ id: "p1", name: "Road Trip" }]);
});

afterEach(() => {
  delete document.documentElement.dataset.layoutShell;
});

test("spotify renders the sidebar, standard header and docked player bar", () => {
  renderLayout("spotify");

  expect(document.documentElement.dataset.layoutShell).toBe("spotify");
  expect(screen.getByTestId("library-sidebar")).toBeInTheDocument();
  expect(screen.getByTestId("player-bar")).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Header navigation" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open Now Playing sidebar" })).toBeInTheDocument();
});

test("apple moves the player into the header", () => {
  renderLayout("apple");

  expect(screen.getByTestId("apple-header-player")).toBeInTheDocument();
  expect(screen.queryByTestId("player-bar")).not.toBeInTheDocument();
  expect(screen.getByTestId("library-sidebar")).toBeInTheDocument();
});

test("ytmusic uses header navigation, a drawer sidebar and the floating player", () => {
  renderLayout("ytmusic");

  expect(screen.getByRole("navigation", { name: "Header navigation" })).toBeInTheDocument();
  expect(screen.getByTestId("player-drawer")).toBeInTheDocument();

  const menu = screen.getByRole("button", { name: "Open menu" });
  expect(menu).toHaveAttribute("aria-expanded", "false");
  expect(menu).toHaveAttribute("aria-controls", screen.getByTestId("library-sidebar").id);
  fireEvent.click(menu);
  expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");
  expect(document.documentElement.dataset.navDrawer).toBe("open");

  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Open menu" })).toHaveAttribute("aria-expanded", "false");
  expect(document.documentElement.dataset.navDrawer).toBeUndefined();
});

test("ytmusic expand button opens Now Playing as a sheet", () => {
  const setActiveSidebar = jest.fn();
  usePlayer.mockReturnValue(playerState({ setActiveSidebar }));
  renderLayout("ytmusic");

  fireEvent.click(screen.getByRole("button", { name: "Expand player" }));
  expect(setActiveSidebar).toHaveBeenCalledWith("now-playing");
});

test("soundcloud renders the inline widget column beside the feed", async () => {
  renderLayout("soundcloud");

  expect(screen.getByRole("complementary", { name: "Activity and recommendations" })).toBeInTheDocument();
  expect(screen.getByTestId("player-bar")).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: "Road Trip" })).toHaveAttribute("href", "/playlist/p1");
});

test("switching presets swaps the shell without remounting the routed page", () => {
  const { rerender } = renderLayout("spotify");
  const main = screen.getByRole("main");

  for (const preset of ["apple", "ytmusic", "soundcloud", "spotify"]) {
    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <AppLayout preset={preset}>
          <RoutedPage />
        </AppLayout>
      </MemoryRouter>,
    );
    expect(document.documentElement.dataset.layoutShell).toBe(preset);
  }

  expect(mounts).toBe(1);
  expect(screen.getByRole("main")).toBe(main);
});

test("every preset falls back to the unified mobile shell below 768px", () => {
  mockMatchMedia(true);
  renderLayout("apple", "/explore");

  expect(document.documentElement.dataset.layoutShell).toBe("mobile");
  expect(screen.queryByTestId("apple-header-player")).not.toBeInTheDocument();
  expect(screen.getByTestId("player-bar")).toBeInTheDocument();
  const nav = screen.getByRole("navigation", { name: "Mobile navigation" });
  expect(nav).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Explore" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
});

test("auto-opens Now Playing on a new track only in docked-panel shells", () => {
  const setActiveSidebar = jest.fn();
  usePlayer.mockReturnValue(playerState({ setActiveSidebar, currentSong: { id: "s1" } }));
  const { unmount } = renderLayout("soundcloud");
  expect(setActiveSidebar).not.toHaveBeenCalledWith("now-playing");
  unmount();

  renderLayout("spotify");
  expect(setActiveSidebar).toHaveBeenCalledWith("now-playing");
});

test("cleans up the shell attribute on unmount", () => {
  const { unmount } = renderLayout("ytmusic");
  act(() => unmount());
  expect(document.documentElement.dataset.layoutShell).toBeUndefined();
});
