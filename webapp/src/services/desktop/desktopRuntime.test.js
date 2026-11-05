import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DesktopServerModal from "../../components/desktop/DesktopServerModal";
import DesktopUpdateBanner from "../../components/desktop/DesktopUpdateBanner";
import { AuthProvider } from "../../context/AuthContext";
import Login, {
  REMEMBER_ME_STORAGE_KEY,
  REMEMBERED_USERNAME_STORAGE_KEY,
} from "../../pages/Login";
import {
  checkDesktopServerConnection,
  DEFAULT_DESKTOP_SERVER_URL,
  DESKTOP_SERVER_URL_KEY,
  getDesktopServerUrl,
  installDesktopRuntime,
  isDesktopRuntime,
  normalizeDesktopServerUrl,
  resolveDesktopApiUrl,
  saveDesktopConfig,
  subscribeDesktopRuntimeEvents,
  syncDesktopPlaybackState,
} from "./desktopRuntime";

describe("desktopRuntime", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    localStorage.clear();
    delete window.__TAURI__;
    delete window.__TAURI_INTERNALS__;
    delete window.__MUSICDECK_DESKTOP__;
    delete document.documentElement.dataset.desktopApp;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete window.__TAURI__;
    delete window.__TAURI_INTERNALS__;
    delete window.__MUSICDECK_DESKTOP__;
    global.fetch = originalFetch;
  });

  test("detects browser vs Tauri desktop runtime accurately", () => {
    expect(isDesktopRuntime()).toBe(false);

    window.__TAURI_INTERNALS__ = {};
    expect(isDesktopRuntime()).toBe(true);
  });

  test("normalizes valid server URLs, bare LAN IPs, and rejects invalid ones", () => {
    expect(normalizeDesktopServerUrl("  http://192.168.1.50:8080/  ")).toBe(
      "http://192.168.1.50:8080"
    );
    expect(normalizeDesktopServerUrl("192.168.2.38")).toBe(
      "http://192.168.2.38:8080"
    );
    expect(normalizeDesktopServerUrl("192.168.2.38:8080/")).toBe(
      "http://192.168.2.38:8080"
    );
    expect(normalizeDesktopServerUrl("https://music.example.com///")).toBe(
      "https://music.example.com"
    );

    expect(() => normalizeDesktopServerUrl("")).toThrow(/required/i);
    expect(() => normalizeDesktopServerUrl("ftp://localhost:4534")).toThrow(
      /http:\/\/ or https:\/\//i
    );
    expect(() => normalizeDesktopServerUrl("http://user:pass@localhost:4534")).toThrow(
      /credentials/i
    );
  });

  test("auto-discovers Docker port 8080 when user enters port 4534", async () => {
    window.__MUSICDECK_DESKTOP__ = true;
    global.fetch = jest.fn((url) => {
      if (String(url) === "http://192.168.2.38:4534/api/public/config") {
        return Promise.reject(new Error("Connection refused"));
      }
      if (String(url) === "http://192.168.2.38:8080/api/public/config") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ appName: "LAN MusicDeck" }),
        });
      }
      return Promise.reject(new Error("Unreachable"));
    });

    const result = await checkDesktopServerConnection("http://192.168.2.38:4534");
    expect(result).toEqual({
      reachable: true,
      serverUrl: "http://192.168.2.38:8080",
      appName: "LAN MusicDeck",
      error: null,
    });
  });

  test("leaves relative /api paths unchanged in standard web browser mode", () => {
    expect(resolveDesktopApiUrl("/api/auth/session")).toBe("/api/auth/session");
    expect(resolveDesktopApiUrl("/api/tracks/123/stream")).toBe("/api/tracks/123/stream");
  });

  test("resolves /api paths against configured desktop server URL in desktop mode", () => {
    window.__TAURI_INTERNALS__ = {};
    localStorage.setItem(DESKTOP_SERVER_URL_KEY, "http://192.168.1.25:4534");

    expect(getDesktopServerUrl()).toBe("http://192.168.1.25:4534");
    expect(resolveDesktopApiUrl("/api/auth/session")).toBe(
      "http://192.168.1.25:4534/api/auth/session"
    );
    expect(resolveDesktopApiUrl("/api/artwork/art_1?size=180")).toBe(
      "http://192.168.1.25:4534/api/artwork/art_1?size=180"
    );
    expect(resolveDesktopApiUrl("https://cdn.example.com/cover.jpg")).toBe(
      "https://cdn.example.com/cover.jpg"
    );
  });

  test("installs fetch interceptor in desktop mode and syncs Tauri config", async () => {
    const invokeMock = jest.fn((cmd) => {
      if (cmd === "desktop_get_config") {
        return Promise.resolve({
          serverUrl: "http://10.0.0.12:4534",
          closeToTray: true,
        });
      }
      return Promise.resolve(null);
    });

    window.__TAURI__ = {
      core: { invoke: invokeMock },
    };

    const rawFetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ appName: "MusicDeck" }),
      })
    );
    window.fetch = rawFetch;

    const cleanup = installDesktopRuntime();
    expect(document.documentElement.dataset.desktopApp).toBe("true");

    await waitFor(() => {
      expect(getDesktopServerUrl()).toBe("http://10.0.0.12:4534");
    });

    await window.fetch("/api/public/config");
    expect(rawFetch).toHaveBeenCalledWith(
      "http://10.0.0.12:4534/api/public/config",
      expect.objectContaining({ credentials: "include" })
    );

    cleanup();
    expect(document.documentElement.dataset.desktopApp).toBeUndefined();
  });

  test("checks server connection via Tauri command or HTTP fallback", async () => {
    window.__MUSICDECK_DESKTOP__ = true;
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ appName: "StudioDeck" }),
      })
    );

    const result = await checkDesktopServerConnection("http://localhost:4534/");
    expect(result).toEqual({
      reachable: true,
      serverUrl: DEFAULT_DESKTOP_SERVER_URL,
      appName: "StudioDeck",
      error: null,
    });
  });

  test("synchronizes playback state and media control events with Tauri backend", async () => {
    const invokeMock = jest.fn(() => Promise.resolve(null));
    const listeners = {};
    window.__TAURI__ = {
      core: { invoke: invokeMock },
      event: {
        listen: jest.fn((eventName, handler) => {
          listeners[eventName] = handler;
          return Promise.resolve(() => {
            delete listeners[eventName];
          });
        }),
      },
    };

    await syncDesktopPlaybackState({
      title: "Midnight City",
      artist: "M83",
      isPlaying: true,
    });

    expect(invokeMock).toHaveBeenCalledWith("desktop_update_playback", {
      status: {
        title: "Midnight City",
        artist: "M83",
        isPlaying: true,
      },
    });

    const onMediaControl = jest.fn();
    const unlisten = subscribeDesktopRuntimeEvents({ onMediaControl });

    await waitFor(() => {
      expect(typeof listeners["desktop://media-control"]).toBe("function");
    });

    listeners["desktop://media-control"]({ payload: { action: "toggle-play" } });
    expect(onMediaControl).toHaveBeenCalledWith("toggle-play");

    unlisten();
  });

  test("renders DesktopServerModal and saves updated server connection", async () => {
    const invokeMock = jest.fn((cmd, args) => {
      if (cmd === "desktop_check_server") {
        return Promise.resolve({
          reachable: true,
          serverUrl: args.serverUrl,
          appName: "Home MusicDeck",
          error: null,
        });
      }
      return Promise.resolve(null);
    });
    window.__TAURI__ = { core: { invoke: invokeMock } };

    const onClose = jest.fn();
    const onSaved = jest.fn();

    render(
      <MemoryRouter>
        <DesktopServerModal isOpen={true} onClose={onClose} onSaved={onSaved} />
      </MemoryRouter>
    );

    const input = screen.getByLabelText(/MusicDeck Server URL/i);
    fireEvent.change(input, { target: { value: "http://192.168.1.99:8080/" } });

    fireEvent.click(screen.getByRole("button", { name: /Test Connection/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /Connected to Home MusicDeck \(http:\/\/192\.168\.1\.99:8080\)/i
    );

    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith({
        serverUrl: "http://192.168.1.99:8080",
        closeToTray: true,
        autoCheckUpdates: true,
      });
    });
    expect(getDesktopServerUrl()).toBe("http://192.168.1.99:8080");
  });

  test("checks for desktop updates on startup and triggers one-click install", async () => {
    const invokeMock = jest.fn((cmd) => {
      if (cmd === "desktop_check_for_updates") {
        return Promise.resolve({
          updateAvailable: true,
          currentVersion: "0.1.0",
          latestVersion: "0.2.0",
          notes: "MusicDeck Desktop v0.2.0",
          installerUrl:
            "https://github.com/UserPhase/MusicDeck/releases/download/desktop-latest/MusicDeck_0.2.0_x64-setup.exe",
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          error: null,
        });
      }
      if (cmd === "desktop_install_update") {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    window.__TAURI__ = {
      core: { invoke: invokeMock },
    };

    render(<DesktopUpdateBanner />);

    expect(
      await screen.findByText(/Update Available \(v0\.2\.0\)/i)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Update & Restart/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("desktop_install_update", {
        installerUrl:
          "https://github.com/UserPhase/MusicDeck/releases/download/desktop-latest/MusicDeck_0.2.0_x64-setup.exe",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      });
    });
  });

  test("shows Server Connection controls on Login only when running in desktop mode", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ authenticated: false, user: null }),
      })
    );

    const { unmount } = render(
      <MemoryRouter>
        <AuthProvider>
          <Login />
        </AuthProvider>
      </MemoryRouter>
    );

    await screen.findByRole("heading", { name: /welcome back/i });
    expect(screen.queryByRole("button", { name: /Server Connection/i })).not.toBeInTheDocument();
    unmount();

    window.__TAURI_INTERNALS__ = {};
    localStorage.setItem(DESKTOP_SERVER_URL_KEY, "http://192.168.1.42:4534");

    render(
      <MemoryRouter>
        <AuthProvider>
          <Login />
        </AuthProvider>
      </MemoryRouter>
    );

    await screen.findByRole("heading", { name: /welcome back/i });
    expect(screen.getByRole("button", { name: /Server Connection/i })).toBeInTheDocument();
    expect(screen.getByText(/http:\/\/192\.168\.1\.42:4534/i)).toBeInTheDocument();
  });

  test("Remember me checkbox on Login sends rememberMe flag and manages remembered username", async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).includes("/api/auth/session")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ authenticated: false, user: null }),
        });
      }
      if (String(url).includes("/api/auth/login")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              user: { id: "u-1", username: "alice", role: "user" },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });

    const { unmount } = render(
      <MemoryRouter>
        <AuthProvider>
          <Login />
        </AuthProvider>
      </MemoryRouter>
    );

    await screen.findByRole("heading", { name: /welcome back/i });
    const rememberCheckbox = screen.getByRole("checkbox", { name: /Remember me/i });
    expect(rememberCheckbox).toBeChecked();

    fireEvent.change(screen.getByPlaceholderText(/Username/i), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Password/i), {
      target: { value: "secret123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Sign in/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/auth/login",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            username: "alice",
            password: "secret123",
            rememberMe: true,
          }),
        })
      );
    });
    expect(localStorage.getItem(REMEMBERED_USERNAME_STORAGE_KEY)).toBe("alice");
    expect(localStorage.getItem(REMEMBER_ME_STORAGE_KEY)).toBe("true");
    unmount();

    // Re-render Login: username should be pre-filled, and unchecking Remember me clears it
    render(
      <MemoryRouter>
        <AuthProvider>
          <Login />
        </AuthProvider>
      </MemoryRouter>
    );

    await screen.findByRole("heading", { name: /welcome back/i });
    expect(screen.getByPlaceholderText(/Username/i)).toHaveValue("alice");

    const rememberCheckboxSecond = screen.getByRole("checkbox", { name: /Remember me/i });
    fireEvent.click(rememberCheckboxSecond);
    expect(rememberCheckboxSecond).not.toBeChecked();
    expect(localStorage.getItem(REMEMBERED_USERNAME_STORAGE_KEY)).toBeNull();
  });
});
