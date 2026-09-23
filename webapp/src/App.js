import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";

import {
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";

import Topbar from "./components/Topbar";
import AdminTopBar from "./components/admin/AdminTopBar";
import Sidebar from "./components/Sidebar";
import QueueSidebar from "./components/QueueSidebar";
import NowPlayingSidebar from "./components/NowPlayingSidebar";
import CommandPalette from "./components/CommandPalette";
import AmbientBackground from "./components/AmbientBackground";
import Player from "./components/Player";
import AdminSidebar from "./components/admin/AdminSidebar";
import RequireAdmin from "./components/admin/RequireAdmin";
import CustomCssStyle, {
  CustomCssResetButton,
} from "./components/admin/CustomCssStyle";

import Home from "./pages/Home";
import Library from "./pages/Library";

import Tracks from "./pages/Tracks";
import Albums from "./pages/Albums";
import Artists from "./pages/Artists";
import Playlists from "./pages/Playlists";
import LibraryHealth from "./pages/LibraryHealth";

import Album from "./pages/Album";
import Playlist from "./pages/Playlist";
import Artist from "./pages/Artist";

import Liked from "./pages/Liked.jsx";
import Login from "./pages/Login.jsx";
import Search from "./pages/Search";
import Explore from "./pages/Explore";
import Profile from "./pages/Profile";
import Settings from "./pages/Settings";

import AdminDashboard from "./pages/admin/AdminDashboard";
import AdminUsers from "./pages/admin/AdminUsers";
import AdminUserDetail from "./pages/admin/AdminUserDetail";
import AdminLibrary from "./pages/admin/AdminLibrary";
import AdminLibraryHealth from "./pages/admin/AdminLibraryHealth";
import AdminLibraryDuplicates from "./pages/admin/AdminLibraryDuplicates";
import AdminLibraryMetadata from "./pages/admin/AdminLibraryMetadata";
import AdminLibraryScan from "./pages/admin/AdminLibraryScan";
import {
  AdminLibraryAlbums,
  AdminLibraryArtists,
  AdminLibraryTracks,
} from "./pages/admin/AdminLibraryBrowse";
import AdminSources from "./pages/admin/AdminSources";
import AdminPlugins from "./pages/admin/AdminPlugins";
import AdminPluginDetail from "./pages/admin/AdminPluginDetail";
import AdminAppearance from "./pages/admin/AdminAppearance";
import AdminServer from "./pages/admin/AdminServer";

import {
  PlayerProvider,
  usePlayer,
} from "./context/PlayerContext";

import {
  AuthProvider,
  useAuth,
} from "./context/AuthContext";

import useGlobalHotkeys from "./hooks/useGlobalHotkeys";

function AdminLayout() {
  return (
    <div className="admin-shell">
      <AdminSidebar />
      <div className="admin-content">
        <RequireAdmin />
      </div>
    </div>
  );
}


function AuthenticatedApp() {
  const location = useLocation();
  const {
    currentSong,
    activeSidebar,
    setActiveSidebar,
    autoOpenSidebar,
    togglePlay,
    nextSong,
    previousSong,
    toggleLike,
    volume,
    changeVolume,
  } = usePlayer();
  const previousTrackIdRef = useRef(null);
  const lastAudibleVolumeRef = useRef(0.7);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("musicdeckTheme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const isSidebarOpen = activeSidebar !== "none";
  const isDetailPage = /^\/(?:album|artist|playlist)\/[^/]+/.test(location.pathname);
  const isSongPage = isDetailPage || [
    "/library/tracks",
    "/liked",
    "/search",
  ].includes(location.pathname);
  const isWideContentPage = isSongPage || ["/", "/explore"].includes(location.pathname) ||
    /^\/library\/(?:playlists|albums|artists)$/.test(location.pathname);
  const isHomePage = location.pathname === "/";

  const toggleTheme = useCallback(() => {
    setTheme((currentTheme) => currentTheme === "dark" ? "light" : "dark");
  }, []);

  const toggleMute = useCallback(() => {
    if (volume > 0) {
      lastAudibleVolumeRef.current = volume;
      changeVolume(0);
      return;
    }
    changeVolume(lastAudibleVolumeRef.current || 0.7);
  }, [changeVolume, volume]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("musicdeckTheme", theme);
    } catch {
      // Theme persistence is optional when storage is unavailable.
    }
  }, [theme]);

  useGlobalHotkeys({
    enabled: !isCommandPaletteOpen,
    onTogglePlay: togglePlay,
    onToggleMute: toggleMute,
    onNext: nextSong,
    onPrevious: previousSong,
    onToggleLike: toggleLike,
    onOpenPalette: () => setIsCommandPaletteOpen(true),
  });

  useEffect(() => {
    const nextTrackId = currentSong?.id == null
      ? null
      : String(currentSong.id);
    const previousTrackId = previousTrackIdRef.current;
    const isNewTrack = Boolean(nextTrackId) && nextTrackId !== previousTrackId;

    if (
      isNewTrack &&
      autoOpenSidebar &&
      activeSidebar !== "now-playing"
    ) {
      setActiveSidebar("now-playing");
    }

    previousTrackIdRef.current = nextTrackId;
  }, [
    currentSong?.id,
    autoOpenSidebar,
    activeSidebar,
    setActiveSidebar,
  ]);

  return (
    <>
      {!location.pathname.startsWith("/admin") && <AmbientBackground />}
      {location.pathname.startsWith("/admin") ? <AdminTopBar /> : <Topbar />}
      <CustomCssStyle />
      <CustomCssResetButton />
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminDashboard />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="users/:userId" element={<AdminUserDetail />} />
          <Route path="library" element={<AdminLibrary />} />
          <Route path="library/tracks" element={<AdminLibraryTracks />} />
          <Route path="library/albums" element={<AdminLibraryAlbums />} />
          <Route path="library/artists" element={<AdminLibraryArtists />} />
          <Route path="library/health" element={<AdminLibraryHealth />} />
          <Route path="library/duplicates" element={<AdminLibraryDuplicates />} />
          <Route path="library/metadata" element={<AdminLibraryMetadata />} />
          <Route path="library/scan" element={<AdminLibraryScan />} />
          <Route path="sources" element={<AdminSources />} />
          <Route path="plugins" element={<AdminPlugins />} />
          <Route path="plugins/:pluginId" element={<AdminPluginDetail />} />
          <Route path="appearance/*" element={<AdminAppearance />} />
          <Route path="server/*" element={<AdminServer />} />
        </Route>
        <Route
          path="*"
          element={
            <>
              <Sidebar />
              <main
                className={
                  `main${
                    isSidebarOpen
                      ? " sidebar-open"
                      : ""
                  }`
                }
              >
                {activeSidebar === "none" && (
                  <button
                    className="main-now-playing-toggle"
                    type="button"
                    onClick={() => setActiveSidebar("now-playing")}
                    aria-label="Open Now Playing sidebar"
                  >
                    <span aria-hidden="true">♫</span>
                    Now Playing
                  </button>
                )}
                <div className={`main-content${isDetailPage ? " main-content--detail" : ""}${isHomePage ? " main-content--home" : ""}${isWideContentPage ? " main-content--wide" : ""}`}>
                  <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/login" element={<Navigate to="/" replace />} />
                    <Route path="/library" element={<Library />}>
                      <Route index element={<Navigate to="playlists" replace />} />
                      <Route path="tracks" element={<Tracks />} />
                      <Route path="albums" element={<Albums />} />
                      <Route path="artists" element={<Artists />} />
                      <Route path="playlists" element={<Playlists />} />
                      <Route path="health" element={<LibraryHealth />} />
                    </Route>
                    <Route path="/album/:id" element={<Album />} />
                    <Route path="/artist/:id" element={<Artist />} />
                    <Route path="/playlist/:id" element={<Playlist />} />
                    <Route path="/liked" element={<Liked />} />
                    <Route path="/search" element={<Search />} />
                    <Route path="/explore" element={<Explore />} />
                    <Route path="/profile" element={<Profile />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </div>
              </main>
              <QueueSidebar
                isOpen={activeSidebar === "queue"}
                onClose={() => setActiveSidebar("none")}
              />
              <NowPlayingSidebar
                isOpen={activeSidebar === "now-playing"}
                onClose={() => setActiveSidebar("none")}
                onOpenQueue={() => setActiveSidebar("queue")}
              />
            </>
          }
        />
      </Routes>
      <Player
        isQueueSidebarOpen={activeSidebar === "queue"}
        onToggleQueueSidebar={() => setActiveSidebar((current) => current === "queue" ? "none" : "queue")}
      />
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        onToggleTheme={toggleTheme}
      />
    </>
  );
}


function AppContent() {
  const { isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return <div className="loading">Loading...</div>;
  }

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return <AuthenticatedApp />;
}


function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <PlayerProvider>
          <AppContent />
        </PlayerProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}


export default App;
