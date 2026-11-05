import { tasteProfileStore } from '../services/TasteProfileStore';
import {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";

import {
  login as authenticate,
} from "../api/auth";

import {
  clearAuthSession,
  getAuthSession,
} from "../api/session";
import { artistOverviewQueryClient } from "../api/artistOverviewQuery";
import { offlineDownloadEngine } from "../services/storage/OfflineDownloadEngine";
import { offlineAuditor } from "../services/storage/OfflineAuditor";
import { rememberedDownloadOwner, rememberDownloadOwner } from "../services/storage/offlineIdentity";
import { playlistCommands } from "../services/playlists/PlaylistCommandStore";


/** @typedef {{ id: string, username?: string, role: "admin" | "user", externalSearchEnabled?: boolean, acquisitionEnabled?: boolean, [key: string]: unknown }} AuthSession */
/** @typedef {{ session: AuthSession | null, isAuthenticated: boolean, isLoading: boolean, signIn(username: string, password: string, options?: { rememberMe?: boolean }): Promise<void>, signOut(): Promise<void>, updateSession(user: AuthSession): void }} AuthState */
const AuthContext =
  createContext(/** @type {AuthState | null} */ (null));


export function AuthProvider({
  children,
}) {
  const [status, setStatus] =
    useState("loading");

  const [session, setSession] =
    useState(null);


  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    async function loadSession() {
      try {
        const currentSession =
          await getAuthSession(controller.signal);

        if (cancelled) {
          return;
        }

        if (currentSession) await rememberDownloadOwner(String(currentSession.id));
        await offlineDownloadEngine.activate(currentSession ? String(currentSession.id) : await rememberedDownloadOwner(), Boolean(currentSession));
        offlineAuditor.reset();
        if (cancelled) return;

        playlistCommands.activate(currentSession ? String(currentSession.id) : null); tasteProfileStore.activate(currentSession ? String(currentSession.id) : null);
        setSession(currentSession);
        setStatus(
          currentSession
            ? "authenticated"
            : "unauthenticated"
        );
      } catch {
        if (!cancelled) {
          await offlineDownloadEngine.activate(await rememberedDownloadOwner(), false);
          offlineAuditor.reset();
          if (cancelled) return;
          playlistCommands.activate(null); tasteProfileStore.activate(null);
          setSession(null);
          setStatus("unauthenticated");
        }
      } finally { clearTimeout(timeout); }
    }

    loadSession();
    const invalidated = () => { cancelled = true; controller.abort(); offlineAuditor.reset(); playlistCommands.activate(null); tasteProfileStore.activate(null); setSession(null); setStatus("unauthenticated"); };
    window.addEventListener("musicdeck:downloads-account-invalidated", invalidated);

    return () => {
      cancelled = true;
      clearTimeout(timeout); controller.abort();
      tasteProfileStore.activate(null);
      window.removeEventListener("musicdeck:downloads-account-invalidated", invalidated);
    };
  }, []);


  async function signIn(username, password, options = {}) {
    const user = await authenticate(username, password, options);
    const shouldRemember = options?.rememberMe !== false;
    await rememberDownloadOwner(shouldRemember ? String(user.id) : null);
    await offlineDownloadEngine.activate(String(user.id));
    offlineAuditor.reset();
    playlistCommands.activate(String(user.id)); tasteProfileStore.activate(String(user.id));
    setSession(user);
    setStatus("authenticated");
  }


  async function signOut() {
    playlistCommands.activate(null); tasteProfileStore.activate(null);
    await rememberDownloadOwner(null);
    await offlineDownloadEngine.activate(null, false);
    offlineAuditor.reset();
    artistOverviewQueryClient.clear();
    setSession(null);
    setStatus("unauthenticated");

    try {
      await clearAuthSession();
    } catch {
      // The local auth state has already been cleared.
    }
  }


  function updateSession(user) {
    playlistCommands.activate(user ? String(user.id) : null); tasteProfileStore.activate(user ? String(user.id) : null);
    setSession(user);
  }


  return (
    <AuthContext.Provider
      value={{
        status,
        session,
        isLoading: status === "loading",
        isAuthenticated: status === "authenticated",
        signIn,
        signOut,
        updateSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}


export function useAuth() {
  return useContext(AuthContext);
}
