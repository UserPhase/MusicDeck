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


const AuthContext =
  createContext(null);


export function AuthProvider({
  children,
}) {
  const [status, setStatus] =
    useState("loading");

  const [session, setSession] =
    useState(null);


  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const currentSession =
          await getAuthSession();

        if (cancelled) {
          return;
        }

        setSession(currentSession);
        setStatus(
          currentSession
            ? "authenticated"
            : "unauthenticated"
        );
      } catch {
        if (!cancelled) {
          setSession(null);
          setStatus("unauthenticated");
        }
      }
    }

    loadSession();

    return () => {
      cancelled = true;
    };
  }, []);


  async function signIn(username, password) {
    const user = await authenticate(username, password);
    setSession(user);
    setStatus("authenticated");
  }


  async function signOut() {
    setSession(null);
    setStatus("unauthenticated");

    try {
      await clearAuthSession();
    } catch {
      // The local auth state has already been cleared.
    }
  }


  function updateSession(user) {
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

