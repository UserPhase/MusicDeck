import type { MusicDeckPlugin, MusicDeckPluginContext } from "./plugin-registry.js";
import type { PlayableSource, SourceProvider } from "../domain/playable-sources.js";
import type { UnifiedSearchResult } from "../domain/search.js";
import { matchContainerFile, normalizeMusicText, versionSignature } from "../domain/music-identity.js";
import { SpotDLDownloaderAdapter, writeCookiesFile } from "../domain/spotdl-downloader-adapter.js";

function required(context: MusicDeckPluginContext, key: string) {
  const value = context.settings.get<string>(key);
  if (!value) throw new Error("Plugin is misconfigured");
  return value;
}

async function json<T>(response: Response, failure = "Plugin unavailable"): Promise<T> {
  if (!response.ok) throw new Error(failure);
  return response.json() as Promise<T>;
}

function trackPayload(payload: Record<string, unknown>) {
  return {
    track: String(payload.title || payload.track || "Unknown title"),
    artist: String(payload.artist || "Unknown artist"),
    album: payload.album ? String(payload.album) : undefined,
  };
}

export function createListenBrainzPlugin(): MusicDeckPlugin {
  return {
    manifest: {
      id: "listenbrainz",
      name: "ListenBrainz",
      version: "1.0.0",
      description: "Scrobble completed tracks and contribute recommendations.",
      capabilities: ["scrobble", "recommendation"],
      permissions: ["history.read", "network.request"],
      config: {
        fields: [
          { key: "token", label: "ListenBrainz token", secret: true, required: true },
          { key: "username", label: "ListenBrainz username", required: true },
        ],
      },
    },
    register(context) {
      context.events.subscribe("track.completed", async (payload) => {
        const response = await context.network!.fetch("https://api.listenbrainz.org/1/submit-listens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Token ${required(context, "token")}`,
          },
          body: JSON.stringify({
            listen_type: "single",
            payload: [{ listened_at: Math.floor(Date.now() / 1000), track_metadata: trackPayload(payload) }],
          }),
        });
        if (!response.ok) throw new Error("ListenBrainz scrobble failed");
        context.logging.info("Scrobbled completed track");
      });
    },
    async test(context) {
      const response = await context.network!.fetch(`https://api.listenbrainz.org/1/user/${encodeURIComponent(required(context, "username"))}/playing-now`, {
        headers: { authorization: `Token ${required(context, "token")}` },
      });
      return { ok: response.ok, message: response.ok ? "ListenBrainz is reachable" : "ListenBrainz authentication failed" };
    },
  };
}

export function createLastFmPlugin(): MusicDeckPlugin {
  return {
    manifest: {
      id: "lastfm",
      name: "Last.fm",
      version: "1.0.0",
      description: "Scrobble tracks and contribute metadata/recommendations.",
      capabilities: ["scrobble", "recommendation", "metadata"],
      permissions: ["history.read", "network.request"],
      config: {
        fields: [
          { key: "apiKey", label: "API key", secret: true, required: true },
          { key: "sessionKey", label: "Session key", secret: true, required: true },
        ],
      },
    },
    register(context) {
      context.events.subscribe("track.completed", async (payload) => {
        const body = new URLSearchParams({
          method: "track.scrobble",
          api_key: required(context, "apiKey"),
          sk: required(context, "sessionKey"),
          track: trackPayload(payload).track,
          artist: trackPayload(payload).artist,
          timestamp: String(Math.floor(Date.now() / 1000)),
          format: "json",
        });
        const response = await context.network!.fetch("https://ws.audioscrobbler.com/2.0/", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
        if (!response.ok) throw new Error("Last.fm scrobble failed");
      });
    },
    async test(context) {
      const url = new URL("https://ws.audioscrobbler.com/2.0/");
      url.searchParams.set("method", "user.getInfo");
      url.searchParams.set("api_key", required(context, "apiKey"));
      url.searchParams.set("sk", required(context, "sessionKey"));
      url.searchParams.set("format", "json");
      const response = await context.network!.fetch(url);
      return { ok: response.ok, message: response.ok ? "Last.fm is reachable" : "Last.fm authentication failed" };
    },
  };
}

export function createMusicBrainzPlugin(): MusicDeckPlugin {
  return {
    manifest: {
      id: "musicbrainz",
      name: "MusicBrainz Metadata",
      version: "1.0.0",
      description: "Provides canonical metadata lookups without modifying library files.",
      capabilities: ["metadata"],
      permissions: ["network.request"],
      config: {
        fields: [{ key: "contact", label: "Contact URL or email", required: false }],
      },
    },
    async test(context) {
      const response = await context.network!.fetch("https://musicbrainz.org/ws/2/artist/?query=artist:test&fmt=json&limit=1", {
        headers: { "user-agent": "MusicDeck/1.0 (metadata-plugin)" },
      });
      return { ok: response.ok, message: response.ok ? "MusicBrainz is reachable" : "MusicBrainz is unavailable" };
    },
  };
}

export function createExternalArtworkPlugin(): MusicDeckPlugin {
  return {
    manifest: {
      id: "external-artwork",
      name: "External Artwork",
      version: "1.0.0",
      description: "Resolves safe external artwork through MusicDeck's artwork proxy model.",
      capabilities: ["artwork"],
      permissions: ["network.request"],
      config: {
        fields: [{ key: "preferredProvider", label: "Preferred provider", required: false, default: "itunes" }],
      },
    },
    async test(context) {
      const response = await context.network!.fetch("https://itunes.apple.com/search?term=test&media=music&entity=album&limit=1");
      return { ok: response.ok, message: response.ok ? "Artwork provider is reachable" : "Artwork provider is unavailable" };
    },
  };
}

export function createSpotDLDownloaderPlugin(adapter: SpotDLDownloaderAdapter): MusicDeckPlugin {
  return {
    manifest: {
      id: "spotdl-downloader",
      name: "SpotDL Downloader",
      version: "1.0.0",
      description: "Configures the spotDL downloader used by On-Demand Library acquisitions (Spotify app credentials, optional YouTube cookies, binary paths).",
      capabilities: ["acquisition"],
      permissions: ["library.acquire", "network.request"],
      config: {
        fields: [
          { key: "spotdlPath", label: "spotDL executable (leave blank for auto-detect)", required: false },
          { key: "ffmpegPath", label: "FFmpeg executable (leave blank for auto-detect)", required: false },
          {
            key: "clientId",
            label: "Spotify Client ID",
            required: false,
            description: "Optional. spotDL's shared/bundled Spotify app client gets rate-limited under heavy use; providing your own app credentials avoids that. Create an app at developer.spotify.com/dashboard.",
          },
          { key: "clientSecret", label: "Spotify Client Secret", secret: true, required: false },
          {
            key: "youtubeCookies",
            label: "YouTube cookies (Netscape format) — optional",
            type: "textarea",
            secret: true,
            required: false,
            description: "Export cookies while logged into YouTube using a browser extension (e.g. \"Get cookies.txt LOCALLY\"), then paste the entire file's contents here. This ties downloads to that account and is not required for normal operation.",
          },
        ],
      },
    },
    register(context) {
      const spotdlPath = (context.settings.get<string>("spotdlPath") || "").trim();
      const ffmpegPath = (context.settings.get<string>("ffmpegPath") || "").trim();
      const clientId = (context.settings.get<string>("clientId") || "").trim();
      const clientSecret = (context.settings.get<string>("clientSecret") || "").trim();
      const youtubeCookies = context.settings.get<string>("youtubeCookies") || "";

      let cookieFile: string | undefined;
      if (youtubeCookies.trim()) {
        try {
          cookieFile = writeCookiesFile(youtubeCookies);
        } catch (error) {
          context.logging.warn(`Could not persist YouTube cookies file: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      adapter.configure({
        spotdlPath: spotdlPath || undefined,
        ffmpegPath: ffmpegPath || undefined,
        clientId: clientId || undefined,
        clientSecret: clientSecret || undefined,
        cookieFile: cookieFile !== undefined ? cookieFile : (youtubeCookies.trim() ? undefined : ""),
      });
    },
    async test() {
      const result = await adapter.test?.();
      return result || { ok: true, message: "spotDL downloader is registered" };
    },
  };
}
