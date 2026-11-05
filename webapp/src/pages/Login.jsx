import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import {
  DESKTOP_CONFIG_CHANGED_EVENT,
  DESKTOP_OPEN_SERVER_MODAL_EVENT,
  getDesktopServerUrl,
  isDesktopRuntime,
} from "../services/desktop/desktopRuntime";

export const REMEMBER_ME_STORAGE_KEY = "musicdeck.auth.rememberMe";
export const REMEMBERED_USERNAME_STORAGE_KEY = "musicdeck.auth.rememberedUsername";

function readInitialRememberMe() {
  try {
    return localStorage.getItem(REMEMBER_ME_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function readRememberedUsername() {
  try {
    if (!readInitialRememberMe()) return "";
    return localStorage.getItem(REMEMBERED_USERNAME_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function Login({ redirectTo } = {}) {
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const isDesktop = isDesktopRuntime();

  const [username, setUsername] = useState(readRememberedUsername);
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(readInitialRememberMe);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [serverUrl, setServerUrl] = useState(() => (isDesktop ? getDesktopServerUrl() : ""));

  useEffect(() => {
    if (!isDesktop) return undefined;
    function handleConfigChanged(event) {
      setServerUrl(event.detail?.serverUrl || getDesktopServerUrl());
    }
    window.addEventListener(DESKTOP_CONFIG_CHANGED_EVENT, handleConfigChanged);
    return () => window.removeEventListener(DESKTOP_CONFIG_CHANGED_EVENT, handleConfigChanged);
  }, [isDesktop]);

  function handleRememberMeChange(event) {
    const next = event.target.checked;
    setRememberMe(next);
    try {
      localStorage.setItem(REMEMBER_ME_STORAGE_KEY, String(next));
      if (!next) {
        localStorage.removeItem(REMEMBERED_USERNAME_STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors.
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();

    setError("");
    setLoading(true);

    try {
      await signIn(username, password, { rememberMe });

      try {
        localStorage.setItem(REMEMBER_ME_STORAGE_KEY, String(rememberMe));
        if (rememberMe) {
          localStorage.setItem(REMEMBERED_USERNAME_STORAGE_KEY, username.trim());
        } else {
          localStorage.removeItem(REMEMBERED_USERNAME_STORAGE_KEY);
        }
      } catch {
        // Ignore storage errors.
      }

      navigate(redirectTo === "/playlist-share" && /^#token=[a-f0-9]{64}$/.test(window.location.hash)
        ? `/playlist-share${window.location.hash}` : "/library/playlists");
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <form
        className="login-form"
        onSubmit={handleSubmit}
      >
        <h1>Welcome back</h1>

        <p>
          Sign in to your music library.
        </p>

        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(event) =>
            setUsername(event.target.value)
          }
          autoComplete="username"
          required
        />

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(event) =>
            setPassword(event.target.value)
          }
          autoComplete="current-password"
          required
        />

        <label
          className="login-remember-me"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "0.875rem",
            color: "var(--text-secondary, #9ca3af)",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={handleRememberMeChange}
            style={{ width: "auto", margin: 0 }}
          />
          <span>Remember me</span>
        </label>

        {error && (
          <div className="login-error">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>

        {isDesktop && (
          <div
            className="login-desktop-server"
            style={{
              marginTop: "12px",
              paddingTop: "12px",
              borderTop: "1px solid var(--panel-border, rgba(255, 255, 255, 0.12))",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              fontSize: "0.82rem",
              color: "var(--text-secondary, #9ca3af)",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Server: {serverUrl}
            </span>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent(DESKTOP_OPEN_SERVER_MODAL_EVENT))}
              style={{
                background: "transparent",
                border: "1px solid var(--panel-border, rgba(255, 255, 255, 0.2))",
                color: "var(--text-primary, #f9fafb)",
                borderRadius: "6px",
                padding: "4px 10px",
                fontSize: "0.8rem",
                cursor: "pointer",
              }}
            >
              Server Connection
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

export default Login;
