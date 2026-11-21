import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "../styles/android-connection.css";

const SETTINGS_KEY = "musicdeck:android:connection";

function readConnection() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    return {
      serverUrl: typeof saved?.serverUrl === "string" ? saved.serverUrl : "",
      localNetwork: saved?.localNetwork === true,
    };
  } catch {
    return { serverUrl: "", localNetwork: false };
  }
}

export default function AndroidConnection() {
  const [connection, setConnection] = useState(readConnection);
  const [action, setAction] = useState(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const { serverUrl, localNetwork } = connection;
  const busy = action !== null;

  async function submit(event) {
    event.preventDefault();
    const open = event.nativeEvent.submitter?.value !== "test";
    setError("");
    setStatus("");
    setAction(open ? "connect" : "test");
    try {
      const target = await invoke("connect_musicdeck_server", { serverUrl, localNetwork, open });
      if (open) {
        const saved = { serverUrl: target, localNetwork };
        try {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved));
        } catch { /* The connection works with storage disabled. */ }
        setConnection(saved);
      } else {
        setStatus("Connection successful at " + target);
      }
    } catch (failure) {
      setError(typeof failure === "string" ? failure : "Could not connect to your MusicDeck server.");
    } finally {
      setAction(null);
    }
  }

  function updateConnection(update) {
    setConnection({ ...connection, ...update });
    setError("");
    setStatus("");
  }

  async function openReleases() {
    setAction("updates");
    setError("");
    setStatus("");
    try {
      await invoke("open_musicdeck_android_releases");
    } catch (failure) {
      setError(typeof failure === "string" ? failure : "Could not open the MusicDeck releases page.");
    } finally {
      setAction(null);
    }
  }

  return <main className="android-connection">
    <form onSubmit={submit} aria-busy={busy}>
      <img src="/musicdeck-192.png" width="56" height="56" alt="" />
      <h1>Connect to MusicDeck</h1>
      <label htmlFor="android-server-url">Server URL</label>
      <input id="android-server-url" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        placeholder="https://music.example.com" required disabled={busy} value={serverUrl}
        onChange={(event) => updateConnection({ serverUrl: event.target.value })} />
      <label className="android-connection-local">
        <input type="checkbox" checked={localNetwork} disabled={busy}
          onChange={(event) => updateConnection({ localNetwork: event.target.checked })} />
        This server is on my local network
      </label>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      <button type="submit" value="connect" disabled={busy}>
        {action === "connect" ? "Checking server…" : "Connect"}
      </button>
      <button className="android-connection-secondary" type="submit" value="test" disabled={busy}>
        {action === "test" ? "Testing…" : "Test connection"}
      </button>
      <button className="android-connection-secondary" type="button" disabled={busy} onClick={openReleases}>
        Android APK releases
      </button>
    </form>
  </main>;
}
