import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";

import Topbar from "./components/Topbar";
import Sidebar from "./components/Sidebar";
import Player from "./components/Player";

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
import Admin from "./pages/Admin";

import {
  PlayerProvider,
} from "./context/PlayerContext";

import {
  AuthProvider,
  useAuth,
} from "./context/AuthContext";


function AuthenticatedApp() {
  return (
    <>
      <Topbar />
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
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
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
