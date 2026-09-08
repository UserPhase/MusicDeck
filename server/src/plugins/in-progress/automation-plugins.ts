import type { MusicDeckPlugin, MusicDeckPluginContext } from "../plugin-registry.js";
import { normalizeMusicText } from "../../domain/music-identity.js";

function required(context: MusicDeckPluginContext, key: string) {
  const value = context.settings.get<string>(key);
  if (!value) throw new Error("Plugin is misconfigured");
  return value;
}

export function createSpotifyImporterPlugin(): MusicDeckPlugin {
  return {
    manifest: {
      id: "spotify-importer",
      name: "Spotify Playlist Importer",
      version: "1.0.0",
      description: "Imports playlist structure and conservatively matches local tracks.",
      capabilities: ["import"],
      permissions: ["playlist.write", "library.read", "network.request"],
      config: {
        fields: [{ key: "accessToken", label: "Spotify access token", secret: true, required: true }],
      },
    },
    register(context) {
      context.ui?.register({
        location: "settings",
        id: "spotify-importer",
        title: "Import Spotify playlists",
      });
    },
    async test(context) {
      const response = await context.network!.fetch("https://api.spotify.com/v1/me", {
        headers: { authorization: `Bearer ${required(context, "accessToken")}` },
      });
      return { ok: response.ok, message: response.ok ? "Spotify is connected" : "Spotify authentication failed" };
    },
  };
}

export function createDiscordPresencePlugin(): MusicDeckPlugin {
  let current: Record<string, unknown> | null = null;

  return {
    manifest: {
      id: "discord-presence",
      name: "Discord Rich Presence",
      version: "1.0.0",
      description: "Publishes now-playing state to a locally configured Discord bridge.",
      capabilities: ["automation"],
      permissions: ["history.read", "network.request"],
      config: {
        fields: [{ key: "bridgeUrl", label: "Local Discord bridge URL", required: true }],
      },
    },
    register(context) {
      context.events.subscribe("track.started", (payload) => {
        current = { state: "playing", ...payload };
      });
      context.events.subscribe("playback.paused", (payload) => {
        current = { state: "paused", ...payload };
      });
      context.events.subscribe("playback.stopped", () => {
        current = null;
      });
    },
    async test(context) {
      const response = await context.network!.fetch(required(context, "bridgeUrl"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(current),
      });
      return { ok: response.ok, message: response.ok ? "Discord bridge is reachable" : "Discord bridge is unavailable" };
    },
  };
}

export function createHomeAssistantPlugin(): MusicDeckPlugin {
  return {
    manifest: {
      id: "home-assistant",
      name: "Home Assistant",
      version: "1.0.0",
      description: "Sends playback events to Home Assistant.",
      capabilities: ["automation"],
      permissions: ["history.read", "network.request"],
      config: {
        fields: [
          { key: "url", label: "Home Assistant URL", required: true },
          { key: "token", label: "Long-lived access token", secret: true, required: true },
          { key: "entity", label: "Automation entity", required: false },
        ],
      },
    },
    register(context) {
      const send = async (event: string, payload: Record<string, unknown>) => {
        const base = required(context, "url").replace(/\/$/, "");
        const response = await context.network!.fetch(`${base}/api/events/musicdeck_${event.replace(".", "_")}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${required(context, "token")}`,
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error("Home Assistant event failed");
      };

      context.events.subscribe("track.started", (payload) => send("track.started", payload).catch(() => undefined));
      context.events.subscribe("playback.paused", (payload) => send("playback.paused", payload).catch(() => undefined));
      context.events.subscribe("playback.stopped", (payload) => send("playback.stopped", payload).catch(() => undefined));
    },
    async test(context) {
      const base = required(context, "url").replace(/\/$/, "");
      const response = await context.network!.fetch(`${base}/api/`, {
        headers: { authorization: `Bearer ${required(context, "token")}` },
      });
      return { ok: response.ok, message: response.ok ? "Home Assistant is reachable" : "Home Assistant authentication failed" };
    },
  };
}

export function conservativeSpotifyMatch<T extends { title: string; artistName: string; albumName: string }>(
  localTracks: T[],
  item: { name?: string; artists?: Array<{ name?: string }>; album?: { name?: string } }
) {
  const title = normalizeMusicText(item.name);
  const artist = normalizeMusicText(item.artists?.[0]?.name);
  const album = normalizeMusicText(item.album?.name);

  return localTracks.find((track) =>
    normalizeMusicText(track.title) === title
    && normalizeMusicText(track.artistName) === artist
    && normalizeMusicText(track.albumName) === album
  ) || null;
}
