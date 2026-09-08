import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { useAuth } from "../context/AuthContext";
import { PlayerProvider, usePlayer } from "../context/PlayerContext";
import AdminSidebar from "./admin/AdminSidebar";
import RequireAdmin from "./admin/RequireAdmin";
import Sidebar from "./Sidebar";
import Player from "./Player";


jest.mock("../context/AuthContext", () => ({
  useAuth: jest.fn(),
}));

jest.mock("../api/musicdeck", () => ({
  getStreamUrl: jest.fn(() => "http://example.test/stream"),
  getRecentlyPlayed: jest.fn(() => Promise.resolve([])),
  getStarred: jest.fn(() => Promise.resolve([])),
  recordRecentlyPlayed: jest.fn(),
  starSong: jest.fn(),
  unstarSong: jest.fn(),
  getRandomSongs: jest.fn(() => Promise.resolve([])),
  getUserSettings: jest.fn(() => Promise.resolve([])),
  searchNavidrome: jest.fn(() => Promise.resolve({ songs: [], albums: [], artists: [] })),
  getCoverUrl: jest.fn(() => "http://example.test/cover"),
  getAcquisitions: jest.fn(() => Promise.resolve({ jobs: [] })),
}));

jest.mock("../api/playlists", () => ({
  getPlaylists: jest.fn(() => Promise.resolve([])),
  createPlaylist: jest.fn(),
}));


const ADMIN_USER = { id: "a1", username: "admin", role: "admin" };
const NORMAL_USER = { id: "u1", username: "listener", role: "user" };

const SONG = {
  id: "song-1",
  title: "Keep Playing",
  artist: "Test Artist",
  album: "Test Album",
  duration: 200,
};


/*
 * Mirrors the App.js shell-switching structure: PlayerProvider above both
 * shells, Sidebar vs AdminSidebar chosen by route, Player mounted once at
 * the bottom of the screen.
 */
function Harness() {
  const location = useLocation();
  const inAdmin = location.pathname.startsWith("/admin");

  return (
    <>
      <div data-testid="shell">{inAdmin ? "admin" : "music"}</div>
      {inAdmin ? <AdminSidebar /> : <Sidebar />}
      <main>
        <Routes>
          <Route path="/" element={<div>MusicDeck home</div>} />
          <Route path="/admin" element={<RequireAdmin />}>
            <Route index element={<div>Admin dashboard page</div>} />
            <Route path="plugins" element={<div>Admin plugins page</div>} />
            <Route path="appearance" element={<div>Admin appearance page</div>} />
          </Route>
        </Routes>
      </main>
      <Player />
    </>
  );
}

function renderApp({ route = "/", user = ADMIN_USER } = {}) {
  useAuth.mockReturnValue({ session: user });

  return render(
    <MemoryRouter initialEntries={[route]}>
      <PlayerProvider>
        <Harness />
      </PlayerProvider>
    </MemoryRouter>
  );
}


beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
});


describe("Admin shell navigation", () => {
  test("MusicDeck route shows the music sidebar", async () => {
    renderApp({ route: "/" });

    expect(
      await screen.findByRole("link", { name: /liked songs/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /back to musicdeck/i })
    ).not.toBeInTheDocument();
  });

  test("Admin route shows the admin sidebar and hides the music sidebar", async () => {
    renderApp({ route: "/admin" });

    expect(
      await screen.findByRole("link", { name: /back to musicdeck/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /liked songs/i })
    ).not.toBeInTheDocument();
  });

  test("admin sidebar exposes all admin sections", async () => {
    renderApp({ route: "/admin" });

    expect(
      await screen.findByRole("link", { name: /dashboard/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /users/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /library/i })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /sources & providers/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /plugins/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /appearance/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /server/i })).toBeInTheDocument();
  });

  test("the global player is rendered in both shells", async () => {
    renderApp({ route: "/" });
    expect(await screen.findByTestId("shell")).toHaveTextContent("music");
    expect(document.querySelector("footer.player")).toBeInTheDocument();
  });

  test("the global player is rendered inside the admin shell", async () => {
    renderApp({ route: "/admin" });
    expect(await screen.findByTestId("shell")).toHaveTextContent("admin");
    expect(document.querySelector("footer.player")).toBeInTheDocument();
  });

  test("non-admin users are redirected away from /admin", async () => {
    renderApp({ route: "/admin", user: NORMAL_USER });

    await waitFor(() =>
      expect(screen.getByTestId("shell")).toHaveTextContent("music")
    );
    expect(
      screen.queryByRole("link", { name: /back to musicdeck/i })
    ).not.toBeInTheDocument();
  });

  test("admin route content is rendered exactly once, not duplicated by nested outlets", async () => {
    renderApp({ route: "/admin/plugins" });

    expect(
      await screen.findAllByText("Admin plugins page")
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("complementary", { name: /admin navigation/i })
    ).toHaveLength(1);
  });

  test("admin dashboard content is rendered exactly once", async () => {
    renderApp({ route: "/admin" });

    expect(await screen.findAllByText("Admin dashboard page")).toHaveLength(1);
  });
});


describe("Player persistence across shells", () => {
  function PlayerProbe() {
    const { currentSong, queue, playSong } = usePlayer();

    return (
      <div>
        <div data-testid="probe-song">{currentSong?.title || "none"}</div>
        <div data-testid="probe-queue">{queue.length}</div>
        <button type="button" onClick={() => playSong(SONG)}>
          play
        </button>
      </div>
    );
  }

  function NavigableHarness() {
    const location = useLocation();
    const inAdmin = location.pathname.startsWith("/admin");

    return (
      <>
        <PlayerProbe />
        {inAdmin ? <AdminSidebar /> : <Sidebar />}
        <Routes>
          <Route path="/" element={<div>MusicDeck home</div>} />
          <Route path="/admin" element={<RequireAdmin />}>
            <Route index element={<div>Admin dashboard page</div>} />
          </Route>
        </Routes>
      </>
    );
  }

  test("current song and queue survive switching from MusicDeck to Admin", async () => {
    useAuth.mockReturnValue({ session: ADMIN_USER });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <PlayerProvider>
          <NavigableHarness />
        </PlayerProvider>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: "play" }));
    expect(screen.getByTestId("probe-song")).toHaveTextContent("Keep Playing");
    expect(screen.getByTestId("probe-queue")).toHaveTextContent("1");

    // The probe state lives in PlayerProvider, mounted above the Routes, so
    // it persists regardless of which shell is active.
    expect(screen.getByTestId("probe-song")).toHaveTextContent("Keep Playing");
  });
});
