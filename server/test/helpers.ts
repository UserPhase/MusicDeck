import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { vi } from "vitest";

import { loadConfig } from "../src/config.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/database.js";
import { buildServer } from "../src/server.js";
import type { MusicBackend } from "../src/backends/music-backend.js";
import { ProviderRegistry } from "../src/backends/registry.js";
import { CatalogService } from "../src/domain/catalog.js";
import { PlaylistService } from "../src/domain/playlist-service.js";
import { LibraryService } from "../src/domain/library.js";
import { SourceResolver } from "../src/domain/source-resolver.js";
import { SourcePipelineRegistry } from "../src/domain/source-discovery.js";
import { SearchProviderRegistry } from "../src/domain/search-provider-registry.js";
import { SourceProviderRegistry } from "../src/domain/source-provider-registry.js";
import { ExternalCatalogRegistry } from "../src/domain/external-catalog.js";
import { RecommendationRegistry, RecommendationService } from "../src/domain/recommendations.js";
import { LibraryInsightsService } from "../src/domain/library-insights.js";
import { AcquisitionProviderRegistry, AcquisitionService } from "../src/domain/acquisition.js";
import { PluginRegistry } from "../src/plugins/plugin-registry.js";
import {
  createArchiveOrgSourcePlugin,
  createAuthorizedExternalSourcePlugin,
  createDebridCloudSourcePlugin,
  createDiscordPresencePlugin,
  createExternalArtworkPlugin,
  createHomeAssistantPlugin,
  createLastFmPlugin,
  createListenBrainzPlugin,
  createMusicBrainzPlugin,
  createOnDemandLibraryPlugin,
  createSpotifyImporterPlugin,
} from "../src/plugins/first-party.js";
import { createSiteSourcesPlugin } from "../src/plugins/site-sources.js";

export function createFakeBackend(overrides: Partial<MusicBackend> = {}): MusicBackend {
  const track = {
    id: "track-1",
    providerId: "track-1",
    title: "Track One",
    artistId: "artist-1",
    artistName: "Artist One",
    albumId: "album-1",
    albumName: "Album One",
    durationSeconds: 180,
    trackNumber: 1,
    artworkId: "art-1",
    artworkUrl: "/api/artwork/art-1",
    streamUrl: "/api/tracks/track-1/stream",
  };

  const album = {
    id: "album-1",
    providerId: "album-1",
    name: "Album One",
    artistId: "artist-1",
    artistName: "Artist One",
    year: 2024,
    artworkId: "art-1",
    artworkUrl: "/api/artwork/art-1",
    songCount: 1,
  };

  const artist = {
    id: "artist-1",
    providerId: "artist-1",
    name: "Artist One",
    artworkId: "art-1",
    artworkUrl: "/api/artwork/art-1",
    albumCount: 1,
  };

  const playlist = {
    id: "playlist-1",
    providerId: "playlist-1",
    name: "Playlist One",
    description: null,
    artworkId: null,
    artworkUrl: null,
    songCount: 1,
    tracks: [track],
  };

  return {
    listAlbums: vi.fn(async () => [album]),
    getAlbum: vi.fn(async () => album),
    getAlbumTracks: vi.fn(async () => [track]),
    listArtists: vi.fn(async () => [artist]),
    getArtist: vi.fn(async () => artist),
    getArtistAlbums: vi.fn(async () => [album]),
    getArtistTracks: vi.fn(async () => [track]),
    listTracks: vi.fn(async () => [track]),
    getTrack: vi.fn(async () => track),
    search: vi.fn(async () => ({ artists: [artist], albums: [album], tracks: [track] })),
    listPlaylists: vi.fn(async () => [playlist]),
    createPlaylist: vi.fn(async (name: string) => ({ ...playlist, name })),
    getPlaylist: vi.fn(async () => playlist),
    updatePlaylist: vi.fn(async () => playlist),
    deletePlaylist: vi.fn(async () => undefined),
    addTrackToPlaylist: vi.fn(async () => ({ added: true })),
    removePlaylistItem: vi.fn(async () => undefined),
    reorderPlaylistTracks: vi.fn(async () => playlist),
    listFavoriteTracks: vi.fn(async () => [track]),
    setTrackFavorite: vi.fn(async () => undefined),
    getRandomTracks: vi.fn(async () => [track]),
    getRandomAlbums: vi.fn(async () => [album]),
    fetchStream: vi.fn(async () => ({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
      status: 206,
      headers: new Headers({
        "content-type": "audio/mpeg",
        "content-range": "bytes 0-2/3",
        "accept-ranges": "bytes",
      }),
    })),
    fetchArtwork: vi.fn(async () => ({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
      status: 200,
      headers: new Headers({ "content-type": "image/jpeg" }),
    })),
    ...overrides,
  };
}

export async function createTestServer(
  backend = createFakeBackend(),
  configOverrides: Partial<AppConfig> = {},
  sourceFetchImpl?: typeof fetch,
  externalFetchImpl?: typeof fetch,
  pluginFetchImpl?: typeof fetch
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-test-"));
  const config = loadConfig({
    databasePath: path.join(directory, "musicdeck.sqlite"),
    sessionSecret: "test-session-secret",
    firstAdmin: {
      username: "admin",
      password: "admin-password",
    },
    navidrome: {
      url: "http://navidrome.test",
      username: "navidrome-user",
      password: "navidrome-password",
    },
    ...configOverrides,
  });

  const db = await openDatabase(config);
  const registry = new ProviderRegistry([{
    connectionId: "test-connection",
    type: "navidrome",
    name: "Test Navidrome",
    enabled: true,
    provider: backend,
  }]);
  const library = new LibraryService(db);
  const catalog = new CatalogService(registry, library);
  const playlists = new PlaylistService(db, backend, catalog, library);
  const sourceResolver = new SourceResolver(registry, library);
  const searchProviders = new SearchProviderRegistry(db, catalog, playlists);
  const sourcePipeline = new SourcePipelineRegistry(db);
  const sourceProviders = new SourceProviderRegistry(
    db,
    library,
    registry,
    sourceResolver,
    sourceFetchImpl || pluginFetchImpl,
    sourcePipeline
  );
  const externalCatalog = new ExternalCatalogRegistry(externalFetchImpl);
  externalCatalog.configure(searchProviders.list().some((provider) => provider.id === "itunes" && provider.enabled));
  const recommendations = new RecommendationRegistry(new RecommendationService(db, catalog));
  const libraryInsights = new LibraryInsightsService(db, catalog);
  const acquisitionProviders = new AcquisitionProviderRegistry();
  const plugins = new PluginRegistry(db, {
    catalog,
    libraryInsights,
    sources: sourceProviders,
    sourcePipeline,
    acquisition: acquisitionProviders,
    recommendations,
    fetchImpl: pluginFetchImpl,
    playlists: {
      create: async (name, userId) => playlists.create(name, { id: userId, role: "user" } as any),
      addTrack: (playlistId, trackId) => playlists.addTrack(playlistId, trackId),
    },
  });
  const acquisition = new AcquisitionService(
    db,
    acquisitionProviders,
    library,
    catalog,
    plugins,
    {
      downloadDir: path.join(directory, "music"),
      tmpDir: path.join(directory, "acquisitions", "tmp"),
      maxConcurrentDownloads: 3,
      autoScan: true,
      sourcePipeline,
    }
  );
  await plugins.register(createListenBrainzPlugin());
  await plugins.register(createLastFmPlugin());
  await plugins.register(createMusicBrainzPlugin());
  await plugins.register(createExternalArtworkPlugin());
  await plugins.register(createSpotifyImporterPlugin());
  await plugins.register(createDiscordPresencePlugin());
  await plugins.register(createHomeAssistantPlugin());
  await plugins.register(createAuthorizedExternalSourcePlugin());
  await plugins.register(createDebridCloudSourcePlugin());
  await plugins.register(createSiteSourcesPlugin());
  await plugins.register(createArchiveOrgSourcePlugin());
  await plugins.register(createOnDemandLibraryPlugin());
  const app = await buildServer({ config, db, backend, catalog, playlists, library, sourceResolver, searchProviders, sourceProviders, externalCatalog, recommendations, libraryInsights, plugins, acquisition, logger: false });

  return { app, db, backend, catalog, playlists, library, sourceResolver, searchProviders, sourceProviders, sourcePipeline, externalCatalog, recommendations, libraryInsights, plugins, acquisition, acquisitionProviders, registry, directory };
}

export async function closeTestServer(app: FastifyInstance, db: Db) {
  await app.close();
  db.close();
}

export async function login(app: FastifyInstance, username = "admin", password = "admin-password") {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });

  const cookie = response.headers["set-cookie"];

  return {
    response,
    cookie: Array.isArray(cookie) ? cookie[0] : cookie,
  };
}
