import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
  useLocation,
} from "react-router-dom";

import {
  lazy,
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

import { ImportProvider } from "./context/ImportContext";
import { ServerDeletionProvider } from "./context/ServerDeletionContext";
import CommandPalette from "./components/CommandPalette";
import AmbientBackground from "./components/AmbientBackground";
import Player from "./components/Player";
import AppLayout from "./components/Layout/AppLayout";
import RouteBoundary from "./components/RouteBoundary";
import RequireAdmin from "./components/admin/RequireAdmin";
import CustomCssStyle, {
  CustomCssResetButton,
} from "./components/admin/CustomCssStyle";

import Home from "./pages/Home";
import Library from "./pages/Library";
import Login from "./pages/Login.jsx";

import {
  PlayerProvider,
  usePlayer,
} from "./context/PlayerContext";

import {
  AuthProvider,
  useAuth,
} from "./context/AuthContext";

import { BrandingProvider } from "./context/BrandingContext";
import { PrivacyProvider } from "./context/PrivacyContext";
import OfflineStatusBanner from "./components/OfflineStatusBanner";
import DownloadsView from "./views/DownloadsView";
import NewReleasesView from "./views/NewReleasesView";
import { PartyHostBridge } from "./components/playlists/PlaylistPartyPanel";
import PlaylistUndoShortcuts from "./components/playlists/PlaylistUndoShortcuts";
import useAutoDownloadSync from "./hooks/useAutoDownloadSync";
import useGlobalHotkeys from "./hooks/useGlobalHotkeys";
import DesktopServerModal from "./components/desktop/DesktopServerModal";
import DesktopUpdateBanner from "./components/desktop/DesktopUpdateBanner";
import {
  isDesktopRuntime,
  subscribeDesktopRuntimeEvents,
  syncDesktopPlaybackState,
} from "./services/desktop/desktopRuntime";

const AdminTopBar = lazy(() => import("./components/admin/AdminTopBar"));
const AdminSidebar = lazy(() => import("./components/admin/AdminSidebar"));
const Tracks = lazy(() => import("./pages/Tracks"));
const Albums = lazy(() => import("./pages/Albums"));
const Artists = lazy(() => import("./pages/Artists"));
const Playlists = lazy(() => import("./pages/Playlists"));
const SmartPlaylists = lazy(() => import("./pages/SmartPlaylists"));
const LibraryHealth = lazy(() => import("./pages/LibraryHealth"));
const Album = lazy(() => import("./pages/Album"));
const Playlist = lazy(() => import("./pages/Playlist"));
const Artist = lazy(() => import("./pages/Artist"));
const ArtistExternalAlbum = lazy(() => import("./pages/ArtistExternalAlbum"));
const Liked = lazy(() => import("./pages/Liked.jsx"));
const ListeningActivity = lazy(() => import("./pages/ListeningActivity"));
const Search = lazy(() => import("./pages/Search"));
const Explore = lazy(() => import("./pages/Explore"));
const SavedDiscoveriesView = lazy(() => import("./components/SavedDiscoveriesView"));
const Profile = lazy(() => import("./pages/Profile"));
const Settings = lazy(() => import("./pages/Settings"));
const TasteProfileView = lazy(() => import("./views/settings/TasteProfileView"));
const AdminDashboard = lazy(() => import("./pages/admin/AdminDashboard"));
const AdminUsers = lazy(() => import("./pages/admin/AdminUsers"));
const AdminUserDetail = lazy(() => import("./pages/admin/AdminUserDetail"));
const AdminLibrary = lazy(() => import("./pages/admin/AdminLibrary"));
const AdminLibraryHealth = lazy(() => import("./pages/admin/AdminLibraryHealth"));
const AdminLibraryDuplicates = lazy(() => import("./pages/admin/AdminLibraryDuplicates"));
const AdminLibraryMetadata = lazy(() => import("./pages/admin/AdminLibraryMetadata"));
const AdminLibraryScan = lazy(() => import("./pages/admin/AdminLibraryScan"));
const AdminSources = lazy(() => import("./pages/admin/AdminSources"));
const AdminPlugins = lazy(() => import("./pages/admin/AdminPlugins"));
const SonicExtensionView = lazy(() => import("./views/admin/SonicExtensionView"));
const AdminPluginDetail = lazy(() => import("./pages/admin/AdminPluginDetail"));
const AdminAppearance = lazy(() => import("./pages/admin/AdminAppearance"));
const AdminServer = lazy(() => import("./pages/admin/AdminServer"));
const SetupRecoveryView = lazy(() => import("./views/admin/SetupRecoveryView"));
const ActivityCenter = lazy(() => import("./views/ActivityCenter"));
const PlaylistInvitationView = lazy(() => import("./views/PlaylistInvitationView"));
const AdminLibraryAlbums = lazy(() => import("./pages/admin/AdminLibraryBrowse").then((module) => ({ default: module.AdminLibraryAlbums })));
const AdminLibraryArtists = lazy(() => import("./pages/admin/AdminLibraryBrowse").then((module) => ({ default: module.AdminLibraryArtists })));
const AdminLibraryTracks = lazy(() => import("./pages/admin/AdminLibraryBrowse").then((module) => ({ default: module.AdminLibraryTracks })));

function AdminLayout() {
  return (
    <RouteBoundary>
      <AdminTopBar />
      <div className="admin-shell">
        <AdminSidebar />
        <div className="admin-content">
          <RouteBoundary><Outlet /></RouteBoundary>
        </div>
      </div>
    </RouteBoundary>
  );
}


function AuthenticatedApp() {
  const downloadSync = useAutoDownloadSync(true);
  const location = useLocation();
  const {
    activeSidebar,
    setActiveSidebar,
    currentSong,
    isPlaying,
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

  useEffect(() => {
    void syncDesktopPlaybackState({
      title: currentSong?.title || null,
      artist: currentSong?.artist || null,
      isPlaying: Boolean(currentSong && isPlaying),
    });
  }, [currentSong, isPlaying]);

  useEffect(() => {
    return subscribeDesktopRuntimeEvents({
      onMediaControl: (action) => {
        if (action === "toggle-play") togglePlay?.();
        else if (action === "next") nextSong?.();
        else if (action === "previous") previousSong?.();
        else if (action === "mute") toggleMute();
      },
    });
  }, [nextSong, previousSong, toggleMute, togglePlay]);

  return (
    <>
      {!isAdminRoute && <AmbientBackground />}
      <PartyHostBridge />
      <CustomCssStyle />
      <CustomCssResetButton />
      {downloadSync.error && <p className="downloads-notice" role="status">{downloadSync.error}</p>}
      <Routes>
        <Route path="/admin" element={<RequireAdmin />}>
          <Route element={<AdminLayout />}>
            <Route index element={<AdminDashboard />} />
            <Route path="activity" element={<ActivityCenter />} />
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
            <Route path="sonic" element={<SonicExtensionView />} />
            <Route path="plugins/:pluginId" element={<AdminPluginDetail />} />
            <Route path="appearance/*" element={<AdminAppearance />} />
            <Route path="server/*" element={<AdminServer />} />
            <Route path="setup-recovery" element={<SetupRecoveryView />} />
          </Route>
        </Route>
        <Route
          path="*"
          element={
            <AppLayout preset={layoutPreset}>
              <RouteBoundary>
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/login" element={<Navigate to="/" replace />} />
                  <Route path="/library" element={<Library />}>
                    <Route index element={<Navigate to="playlists" replace />} />
                    <Route path="tracks" element={<Tracks />} />
                    <Route path="albums" element={<Albums />} />
                    <Route path="artists" element={<Artists />} />
                    <Route path="playlists" element={<Playlists />} />
                    <Route path="smart-playlists" element={<Navigate to="/library/playlists" replace />} />
                    <Route path="health" element={<LibraryHealth />} />
                  </Route>
                  <Route path="/album/:id" element={<Album />} />
                  <Route path="/artist/:id/album/:albumId" element={<ArtistExternalAlbum />} />
                  <Route path="/artist/:id" element={<Artist />} />
                  <Route path="/playlist/:id" element={<Playlist />} />
                  <Route path="/smart-playlist/:id" element={<SmartPlaylists />} />
                  <Route path="/liked" element={<Liked />} />
                  <Route path="/downloads" element={<DownloadsView />} />
                  <Route path="/new-releases" element={<NewReleasesView />} />
                  <Route path="/playlist-share" element={<PlaylistInvitationView />} />
                  <Route path="/listening-activity" element={<ListeningActivity />} />
                  <Route path="/search" element={<Search />} />
                  <Route path="/explore" element={<Explore />} />
                  <Route path="/saved-discoveries" element={<SavedDiscoveriesView />} />
                  <Route path="/profile" element={<Profile />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/settings/taste" element={<TasteProfileView />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </RouteBoundary>
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
        <Route path="/playlist-share" element={<Login redirectTo="/playlist-share" />} />
        <Route path="/downloads" element={<><DownloadsView /><Player /></>} />
        <Route path="*" element={<Navigate to={navigator.onLine === false ? "/downloads" : "/login"} replace />} />
      </Routes>
    );
  }

  return <ImportProvider><ServerDeletionProvider><AuthenticatedApp /></ServerDeletionProvider></ImportProvider>;
}


function App() {
  const [isDesktopServerModalOpen, setIsDesktopServerModalOpen] = useState(false);

  useEffect(() => {
    if (!isDesktopRuntime()) return undefined;
    return subscribeDesktopRuntimeEvents({
      onOpenServerSettings: () => setIsDesktopServerModalOpen(true),
    });
  }, []);

  return (
    <QueryClientProvider client={artistOverviewQueryClient}>
      <BrowserRouter>
        <OfflineStatusBanner />
        <BrandingProvider>
          <AuthProvider>
            <PrivacyProvider>
            <PlayerProvider>
              <PlaylistUndoShortcuts />
              <AppContent />
              {isDesktopRuntime() && (
                <>
                  <DesktopUpdateBanner />
                  <DesktopServerModal
                    isOpen={isDesktopServerModalOpen}
                    onClose={() => setIsDesktopServerModalOpen(false)}
                  />
                </>
              )}
            </PlayerProvider>
            </PrivacyProvider>
          </AuthProvider>
        </BrandingProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}


export default App;
