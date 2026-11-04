import { LastFmScrobbler } from "../services/scrobble/LastFmScrobbler.js";
import { ListenBrainzScrobbler } from "../services/scrobble/ListenBrainzScrobbler.js";
import type { MusicDeckPlugin, MusicDeckPluginContext } from "./plugin-registry.js";
import { writeCookiesFile, type SpotDLDownloaderAdapter } from "../domain/spotdl-downloader-adapter.js";
import { DEFAULT_SPOTDL_FORMAT, parseSpotDLOutputFormat } from "../domain/spotdl-format.js";
import { ClassifiedPluginError } from "./plugin-errors.js";

function required(context: MusicDeckPluginContext, key: string) {
  const value = context.settings.get<string>(key);
  if (!value) throw new Error("Plugin is misconfigured");
  return value;
}

export function createListenBrainzPlugin(): MusicDeckPlugin {
  return {
    manifest: {
      id: "listenbrainz", name: "ListenBrainz", version: "2.0.0",
      description: "Allow users to connect ListenBrainz in Settings. Qualified listens use a durable per-user queue.",
      capabilities: ["scrobble"], permissions: ["history.read", "network.request"],
      config: { fields: [
        { key: "token", label: "Optional administrator test token", secret: true },
      ] },
    },
    async test(context) {
      const token = context.settings.get<string>("token");
      if (!token) return { ok: true, message: "Enabled for per-user connections in Settings. No shared account receives listens." };
      const username = await new ListenBrainzScrobbler(token, context.network!.fetch).validateToken();
      return { ok: true, message: `Validated ListenBrainz account ${username}. Users connect their own accounts in Settings.` };
    },
  };
}

export function createLastFmPlugin(): MusicDeckPlugin {
  return {
    manifest: {
      id: "lastfm", name: "Last.fm", version: "2.0.0",
      description: "Configure application credentials, then let each user authorize Last.fm in Settings.",
      capabilities: ["scrobble"], permissions: ["history.read", "network.request"],
      config: { fields: [
        { key: "apiKey", label: "Application API key", secret: true, required: true },
        { key: "apiSecret", label: "Application shared secret", secret: true, required: true },
        { key: "sessionKey", label: "Optional administrator test session", secret: true },
      ] },
    },
    async test(context) {
      const sessionKey = context.settings.get<string>("sessionKey");
      const client = new LastFmScrobbler({ apiKey: required(context, "apiKey"), apiSecret: required(context, "apiSecret"), sessionKey }, context.network!.fetch);
      if (sessionKey) await client.validateSession(); else await client.validateApplication();
      return { ok: true, message: "Last.fm credentials validated. Users authorize their own accounts in Settings." };
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
      description: "Configures spotDL downloads and Spotify playlist imports: audio format, Spotify credentials, optional YouTube cookies, and binary paths.",
      capabilities: ["acquisition"],
      permissions: ["library.acquire", "network.request"],
      config: {
        fields: [
          {
            key: "outputFormat", label: "Audio format", type: "select", default: DEFAULT_SPOTDL_FORMAT,
            options: [
              { value: "best", label: "Best source quality (M4A) — recommended" },
              { value: "m4a", label: "M4A — original bitrate" },
              { value: "opus", label: "Opus — original bitrate" },
              { value: "mp3", label: "MP3 — 320 kbps, broad compatibility" },
              { value: "flac", label: "FLAC — larger files" },
              { value: "ogg", label: "OGG Vorbis" },
              { value: "wav", label: "WAV — uncompressed, very large files" },
            ],
            description: "Best uses M4A at the source bitrate and avoids re-encoding when available. Source quality depends on the provider and account; FLAC/WAV cannot improve a lossy source. Applies to new individual downloads and playlist imports. Existing files are reused.",
          },
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
    validateConfig(config) {
      try { parseSpotDLOutputFormat(config.outputFormat); }
      catch { throw new ClassifiedPluginError("not_configured", "Choose a supported spotDL audio format"); }
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
        outputFormat: parseSpotDLOutputFormat(context.settings.get("outputFormat")),
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
