import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";

import Topbar from "./components/Topbar";
import AdminTopBar from "./components/admin/AdminTopBar";
import Sidebar from "./components/Sidebar";
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
} from "./context/PlayerContext";

import {
  AuthProvider,
  useAuth,
} from "./context/AuthContext";


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

  return (
    <>
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
              <main className="main">
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
              </main>
            </>
          }
        />
      </Routes>
      <Player />
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
