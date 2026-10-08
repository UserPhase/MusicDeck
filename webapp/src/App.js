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
import { QueryClientProvider } from "@tanstack/react-query";
import { artistOverviewQueryClient } from "./api/artistOverviewQuery";
import {
  getUserSettings,
  USER_SETTINGS_CHANGED_EVENT,
} from "./api/musicdeck";
import { normalizeTheme, THEME_SETTING_KEY } from "./utils/theme";
import {
  LAYOUT_PRESET_SETTING_KEY,
  LAYOUT_PRESET_STORAGE_KEY,
  normalizeLayoutPreset,
  readStoredLayoutPreset,
} from "./utils/layoutPreset";

import AdminTopBar from "./components/admin/AdminTopBar";
import { ImportProvider } from "./context/ImportContext";
import { ServerDeletionProvider } from "./context/ServerDeletionContext";
import CommandPalette from "./components/CommandPalette";
import AmbientBackground from "./components/AmbientBackground";
import Player from "./components/Player";
import AppLayout from "./components/Layout/AppLayout";
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
import ArtistExternalAlbum from "./pages/ArtistExternalAlbum";

import Liked from "./pages/Liked.jsx";
import ListeningActivity from "./pages/ListeningActivity";
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

import { BrandingProvider } from "./context/BrandingContext";
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
    activeSidebar,
    setActiveSidebar,
    togglePlay,
    nextSong,
    previousSong,
    toggleLike,
    volume,
    changeVolume,
  } = usePlayer();
  const lastAudibleVolumeRef = useRef(0.7);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("musicdeckTheme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const [layoutPreset, setLayoutPreset] = useState(readStoredLayoutPreset);
  const isAdminRoute = location.pathname.startsWith("/admin");

  useEffect(() => {
    let cancelled = false;
    const applyTheme = (value) => {
      const nextTheme = normalizeTheme(value);
      if (nextTheme) setTheme(nextTheme);
    };
    const applyLayoutPreset = (value) => {
      const nextPreset = normalizeLayoutPreset(value);
      if (nextPreset) setLayoutPreset(nextPreset);
    };
    const readSetting = (settings, key) => {
      const row = Array.isArray(settings) ? settings.find((setting) => setting.key === key) : null;
      if (!row) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return row.value;
      }
    };

    Promise.resolve()
      .then(() => getUserSettings())
      .then((settings) => {
        if (cancelled) return;
        applyTheme(readSetting(settings, THEME_SETTING_KEY));
        applyLayoutPreset(readSetting(settings, LAYOUT_PRESET_SETTING_KEY));
      })
      .catch(() => {
        // Fall back to the locally stored theme and layout preset.
      });

    function handleUserSettingsChanged(event) {
      applyTheme(event.detail?.[THEME_SETTING_KEY]);
      applyLayoutPreset(event.detail?.[LAYOUT_PRESET_SETTING_KEY]);
    }

    window.addEventListener(USER_SETTINGS_CHANGED_EVENT, handleUserSettingsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(USER_SETTINGS_CHANGED_EVENT, handleUserSettingsChanged);
    };
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
    const root = document.documentElement;
    const previousTheme = root.dataset.theme;
    let transitionTimer = null;
    // Cross-fade only on an actual switch, never on the first paint.
    if (previousTheme && previousTheme !== theme) {
      root.classList.add("theme-transitioning");
      transitionTimer = window.setTimeout(() => root.classList.remove("theme-transitioning"), 350);
    }
    root.dataset.theme = theme;
    try {
      localStorage.setItem("musicdeckTheme", theme);
    } catch {
      // Theme persistence is optional when storage is unavailable.
    }
    return () => {
      if (transitionTimer !== null) {
        window.clearTimeout(transitionTimer);
        root.classList.remove("theme-transitioning");
      }
    };
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.layoutPreset = layoutPreset;
    try {
      localStorage.setItem(LAYOUT_PRESET_STORAGE_KEY, layoutPreset);
    } catch {
      // Preset persistence is optional when storage is unavailable.
    }
  }, [layoutPreset]);

  useEffect(() => () => {
    delete document.documentElement.dataset.layoutPreset;
  }, []);

  useGlobalHotkeys({
    enabled: !isCommandPaletteOpen,
    onTogglePlay: togglePlay,
    onToggleMute: toggleMute,
    onNext: nextSong,
    onPrevious: previousSong,
    onToggleLike: toggleLike,
    onOpenPalette: () => setIsCommandPaletteOpen(true),
  });

  return (
    <>
      {!isAdminRoute && <AmbientBackground />}
      {isAdminRoute && <AdminTopBar />}
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
            <AppLayout preset={layoutPreset}>
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
                <Route path="/artist/:id/album/:albumId" element={<ArtistExternalAlbum />} />
                <Route path="/artist/:id" element={<Artist />} />
                <Route path="/playlist/:id" element={<Playlist />} />
                <Route path="/liked" element={<Liked />} />
                <Route path="/listening-activity" element={<ListeningActivity />} />
                <Route path="/search" element={<Search />} />
                <Route path="/explore" element={<Explore />} />
                <Route path="/profile" element={<Profile />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AppLayout>
          }
        />
      </Routes>
      {isAdminRoute && (
        <Player
          isQueueSidebarOpen={activeSidebar === "queue"}
          onToggleQueueSidebar={() => setActiveSidebar((current) => current === "queue" ? "none" : "queue")}
        />
      )}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
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

  return <ImportProvider><ServerDeletionProvider><AuthenticatedApp /></ServerDeletionProvider></ImportProvider>;
}


function App() {
  return (
    <QueryClientProvider client={artistOverviewQueryClient}>
      <BrowserRouter>
        <BrandingProvider>
          <AuthProvider>
            <PlayerProvider>
              <AppContent />
            </PlayerProvider>
          </AuthProvider>
        </BrandingProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}


export default App;
