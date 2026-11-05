import { isBrowserIntegrationAllowed } from "../services/privacyPolicy";
import { resolveDesktopApiUrl } from "../services/desktop/desktopRuntime";
import { playlistCommands, setPlaylistCommandNotifier } from "../services/playlists/PlaylistCommandStore";
import {
  normalizeTrackData,
} from "../utils/normalizeTrackData";

export async function request(path, options = {}) {
  const response = await fetch(resolveDesktopApiUrl(path), {
    credentials: "include",
    headers: {
      // Only send a JSON content-type when there's actually a JSON body —
      // Fastify's strict JSON parser rejects an empty body sent with this
      // header (FST_ERR_CTP_EMPTY_JSON_BODY), which surfaced as a 500 on
      // no-body POSTs like plugin test/enable/disable requests.
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    let message = `MusicDeck returned ${response.status}`;

    try {
      const data = await response.json();
      message = data.error?.message || message;
    } catch {
      // Keep the status-based message when the body is not JSON.
    }

    throw Object.assign(new Error(message), { status: response.status });
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export const taskStreamUrl = () => resolveDesktopApiUrl("/api/v1/admin/tasks/stream");
export const inspectAudioStream = (trackId, inspectionId, signal) =>
  request(`/api/v1/stream/inspect/${encodeURIComponent(trackId)}?${new URLSearchParams({ inspectionId })}`, { signal });
export const getMediaCheckpoints = (signal, type, mediaId) => {
  const query = type && mediaId ? `?${new URLSearchParams({ type, mediaId })}` : "";
  return request(`/api/v1/user/media-sessions${query}`, { signal });
};
export const saveMediaCheckpoint = (checkpoint, signal) => request("/api/v1/user/media-sessions", {
  method: "POST", body: JSON.stringify(checkpoint), keepalive: true, signal,
});
export const getDataExportSummary = (signal) => request("/api/v1/user/export/summary", { signal });

export function downloadUserData(kind, format, playlistId) {
  const suffix = kind === "playlists" && playlistId ? `playlists/${encodeURIComponent(playlistId)}` : kind;
  const anchor = document.createElement("a");
  anchor.href = resolveDesktopApiUrl(`/api/v1/user/export/${suffix}?${new URLSearchParams({ format })}`);
  anchor.download = "";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export const controlTask = (id, action) => request(`/api/v1/admin/tasks/${encodeURIComponent(id)}/${action}`, { method: "POST" });
export const setTaskPriority = (id, priority) => request(`/api/v1/admin/tasks/${encodeURIComponent(id)}/priority`, {
  method: "PATCH", body: JSON.stringify({ priority }),
});
export const getTaskLogs = (id, signal) => request(`/api/v1/admin/tasks/${encodeURIComponent(id)}/logs`, { signal });
export const clearTaskHistory = () => request("/api/v1/admin/tasks/history", { method: "DELETE" });

function toSong(track) {
  return { ...normalizeTrackData(track), playedAt: track.playedAt || null, playCount: track.playCount || 0 };
}

export const getSavedDiscoveries = () => request("/api/v1/discoveries/saved");
export const saveDiscovery = (item) => request("/api/v1/discoveries/save", {
  method: "POST", body: JSON.stringify(item),
});
export const removeSavedDiscovery = (id) => request(`/api/v1/discoveries/saved/${encodeURIComponent(id)}`, { method: "DELETE" });

export const listSmartPlaylists = () => request("/api/v1/smart-playlists");
export const getSmartPlaylist = (id) => request(`/api/v1/smart-playlists/${encodeURIComponent(id)}`);
export const findSmartPlaylistSeeds = (query, signal, id) => request(`/api/v1/smart-playlists/seeds?${new URLSearchParams({ q: query, ...(id ? { id } : {}) })}`, { signal });
export const createSmartPlaylist = (playlist) => request("/api/v1/smart-playlists", {
  method: "POST", body: JSON.stringify(playlist),
});
export const saveMixPlaylist = (playlist) => request("/api/v1/smart-playlists/snapshot", {
  method: "POST", body: JSON.stringify(playlist),
});
export const updateSmartPlaylist = (id, playlist) => request(`/api/v1/smart-playlists/${encodeURIComponent(id)}`, {
  method: "PUT", body: JSON.stringify(playlist),
});
export const deleteSmartPlaylist = (id) => request(`/api/v1/smart-playlists/${encodeURIComponent(id)}`, { method: "DELETE" });
export async function previewSmartPlaylist(rules, signal, options) {
  const result = await request("/api/v1/smart-playlists/preview", {
    method: "POST", body: JSON.stringify({ rules, limit: 12, ...(options ? { options } : {}) }), signal,
  });
  return { ...result, tracks: result.tracks.map(toSong) };
}
export async function getSmartPlaylistTracks(id, offset = 0, limit = 500) {
  const result = await request(`/api/v1/smart-playlists/${encodeURIComponent(id)}/tracks?${new URLSearchParams({ offset, limit })}`);
  return { ...result, tracks: result.tracks.map(toSong) };
}

function toAlbum(album, songs) {
  const isExternal = typeof album.title === "string" && !("name" in album);
  const isExternalAlbumSummary = typeof album.identity === "object" && !("artistName" in album);
  const external = isExternal || isExternalAlbumSummary;

  return {
    id: album.id,
    name: external ? album.title : album.name,
    artistId: album.artistId,
    artist: external ? album.artist : album.artistName,
    year: album.year,
    metadata: { ...album.metadata, sourceServer: album.sourceServer ?? album.metadata?.sourceServer },
    releaseDate: album.releaseDate || null,
    genre: album.genre || null,
    label: album.label || null,
    coverArt: album.artwork?.id || album.artworkId || album.coverArt || null,
    coverUrl: album.artwork?.url || album.artworkUrl || album.coverUrl || null,
    unavailableArtworkIds: album.unavailableArtworkIds || [],
    artworkResolutionFailed: Boolean(album.artworkResolutionFailed),
    songCount: isExternal ? (album.tracks || []).length : album.songCount,
    // Catalog-aware completeness: total known tracks vs. locally downloaded
    // tracks. Falls back to songCount when the server hasn't merged catalog
    // data (e.g. external catalog disabled), so the UI degrades gracefully.
    trackCount: typeof album.trackCount === "number" ? album.trackCount : undefined,
    localTrackCount: typeof album.localTrackCount === "number" ? album.localTrackCount : undefined,
    availability: album.availability || null,
    source: external ? { kind: "external", count: 0 } : undefined,
    provider: external ? "external" : undefined,
    identity: album.identity,
    inLibrary: Boolean(album.inLibrary),
    localAlbumId: album.localAlbumId || null,
    albumArtworkUrl: !external && !songs && album.id ? `/api/albums/${encodeURIComponent(album.id)}/artwork` : null,
    ...(songs ? { song: songs } : {}),
  };
}

function toArtist(artist, albums) {
  const isExternal = Array.isArray(artist.albums) || Array.isArray(artist.tracks);

  return {
    id: artist.id,
    name: artist.name,
    coverArt: artist.artworkId,
    imageUrl: typeof artist.imageUrl === "string" ? artist.imageUrl : null,
    albumCount: isExternal ? artist.albums.length : artist.albumCount,
    availability: artist.availability || null,
    source: isExternal ? { kind: "external", count: 0 } : undefined,
    provider: isExternal ? "external" : undefined,
    identity: artist.identity,
    tracks: isExternal ? (artist.tracks || []).map(toSong) : undefined,
    ...(albums ? { album: albums } : {}),
  };
}

function toPlaylist(playlist) {
  return {
    id: playlist.id,
    ownerUserId: playlist.ownerUserId,
    sharingMode: playlist.sharingMode,
    sharingRevision: playlist.sharingRevision,
    permissions: playlist.permissions,
    excludeFromTaste: Boolean(playlist.excludeFromTaste),
    editRevision: playlist.editRevision,
    name: playlist.name,
    createdAt: playlist.createdAt,
    description: playlist.description ?? null,
    comment: playlist.description ?? null,
    coverArt: playlist.artworkId,
    coverMode: playlist.artworkMode || null,
    songCount: playlist.songCount,
    itemIds: playlist.itemIds,
    entry: (playlist.tracks || []).map((track) => ({
      ...normalizeTrackData(track, "playlist"),
      genres: track.genres || [],
      addedByUserId: track.addedByUserId ?? null,
      addedBy: track.addedBy ?? null,
      showContributor: playlist.sharingMode === "COLLABORATIVE",
      tastePlaylistId: playlist.id,
      excludeFromTaste: Boolean(playlist.excludeFromTaste),
      ...(track.playlistItemId ? { playlistItemId: track.playlistItemId } : {}),
      ...(track.playlistAddedAt ? { playlistAddedAt: track.playlistAddedAt } : {}),
    })),
  };
}

setPlaylistCommandNotifier((result, playlistId) => {
  window.dispatchEvent(new CustomEvent("playlistsChanged", { detail: {
    playlistId, playlist: result.playlist ? toPlaylist(result.playlist) : null, deletedAt: result.deletedAt,
  } }));
});

function toSearchItem(result) {
  if (result.type === "track") {
    return {
      ...normalizeTrackData(result, "search"),
      subtitle: result.subtitle || null,
      inLibrary: Boolean(result.inLibrary),
      localTrackId: result.localTrackId || null,
    };
  }

  return {
    type: result.type,
    id: result.id,
    title: result.title,
    subtitle: result.subtitle,
    artist: result.artist,
    album: result.album,
    coverArt: result.artwork?.id || null,
    availability: result.availability || null,
    source: result.source,
    provider: result.provider,
    metadata: result.metadata || {},
    inLibrary: Boolean(result.inLibrary),
    localAlbumId: result.localAlbumId || null,
  };
}

export async function login(username, password, options = {}) {
  const payload = {
    username,
    password,
    ...(typeof options?.rememberMe === "boolean" ? { rememberMe: options.rememberMe } : {}),
  };
  const data = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return data.user;
}

export async function logout() {
  await request("/api/auth/logout", { method: "POST" });
}

export async function getCurrentSession(signal) {
  return request("/api/auth/session", signal ? { signal } : {});
}

export async function changePassword(currentPassword, newPassword) {
  return request("/api/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function getCurrentUser() {
  const data = await request("/api/users/me");
  return data.user;
}

export async function updateCurrentUser(profile) {
  const data = await request("/api/users/me", {
    method: "PATCH",
    body: JSON.stringify(profile),
  });

  return data.user;
}

/* Upload the signed-in user's avatar as a base64 image data URL. */
export async function uploadCurrentUserAvatar(image) {
  const data = await request("/api/users/profile/avatar", {
    method: "POST",
    body: JSON.stringify({ image }),
  });

  return data.user;
}

export async function removeCurrentUserAvatar() {
  const data = await request("/api/users/profile/avatar", {
    method: "DELETE",
  });

  return data.user;
}

export async function getUserSettings() {
  const data = await request("/api/settings/user");
  return data.settings || [];
}

export async function updateUserSettings(settings) {
  const data = await request("/api/settings/user", {
    method: "PATCH",
    body: JSON.stringify({ settings }),
  });

  return data.settings || [];
}

// Fired after the signed-in user's own preferences change outside Settings
// (e.g. an admin editing their own account) so live app state can re-apply them.
export const USER_SETTINGS_CHANGED_EVENT = "musicdeck:user-settings-changed";

export async function getPublicConfig() {
  return request("/api/public/config");
}

export async function updateAppConfig(config) {
  return request("/api/admin/config", {
    method: "PATCH",
    body: JSON.stringify(config),
  });
}

export async function getAdminUserSettings(userId) {
  const data = await request(`/api/admin/users/${encodeURIComponent(userId)}/settings`);
  return data.settings || [];
}

export async function updateAdminUserSettings(userId, settings) {
  const data = await request(`/api/admin/users/${encodeURIComponent(userId)}/settings`, {
    method: "PATCH",
    body: JSON.stringify({ settings }),
  });

  return data.settings || [];
}

export async function getAdminHealth() {
  return request("/api/admin/health");
}

export async function getAdminLogs({ level, limit = 1000 } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (level) params.set("level", level);
  return request(`/api/admin/logs?${params}`);
}

export async function clearAdminLogs() {
  return request("/api/admin/logs", { method: "DELETE" });
}

export function adminLogsStreamUrl(afterSeq) {
  return resolveDesktopApiUrl(
    Number.isInteger(afterSeq) && afterSeq > 0
      ? `/api/admin/logs/stream?after=${afterSeq}`
      : "/api/admin/logs/stream"
  );
}

export async function getAdminBackendConnections() {
  const data = await request("/api/admin/backend-connections");
  return data.backendConnections || [];
}

export async function getAdminSearchProviders() {
  const data = await request("/api/admin/search-providers");
  return data.searchProviders || [];
}

export async function updateAdminSearchProvider(providerId, updates) {
  const data = await request(`/api/admin/search-providers/${encodeURIComponent(providerId)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });

  return data.searchProvider;
}

export async function testAdminSearchProvider(providerId) {
  const data = await request(`/api/admin/search-providers/${encodeURIComponent(providerId)}/test`, {
    method: "POST",
  });
  return data.test;
}

export async function getAdminSourceProviders() {
  const data = await request("/api/admin/source-providers");
  return data.sourceProviders || [];
}

export async function updateAdminSourceProvider(providerId, updates) {
  const data = await request(`/api/admin/source-providers/${encodeURIComponent(providerId)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });

  return data.sourceProvider;
}

export async function testAdminSourceProvider(providerId) {
  const data = await request(`/api/admin/source-providers/${encodeURIComponent(providerId)}/test`, {
    method: "POST",
  });
  return data.test;
}

export async function getAdminPlugins() {
  const data = await request("/api/admin/plugins");
  return data.plugins || [];
}

export async function updateAdminPlugin(pluginId, updates) {
  const data = await request(`/api/admin/plugins/${encodeURIComponent(pluginId)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
  return data.plugin;
}

export async function testAdminPlugin(pluginId) {
  const data = await request(`/api/admin/plugins/${encodeURIComponent(pluginId)}/test`, {
    method: "POST",
  });
  return data.test;
}

export async function installAdminPlugin(manifest) {
  const data = await request("/api/admin/plugins/install", {
    method: "POST",
    body: JSON.stringify({ manifest }),
  });
  return data.plugin;
}

export async function uninstallAdminPlugin(pluginId) {
  await request(`/api/admin/plugins/${encodeURIComponent(pluginId)}`, {
    method: "DELETE",
  });
}

export async function getServerSettings() {
  const data = await request("/api/admin/settings/server");
  return data.settings || [];
}

export async function updateServerSettings(settings) {
  const data = await request("/api/admin/settings/server", {
    method: "PATCH",
    body: JSON.stringify({ settings }),
  });

  return data.settings || [];
}

export async function getAdminLibraryScanStatus() {
  return request("/api/admin/library/scan/status");
}

/** Queues a library scan; resolves immediately with `{ started, alreadyRunning, status }`. */
export async function triggerAdminLibraryScan() {
  return request("/api/admin/library/scan", { method: "POST" });
}

export async function getUsers() {
  const data = await request("/api/users");
  return data.users || [];
}

export async function createUser(user) {
  const data = await request("/api/users", {
    method: "POST",
    body: JSON.stringify(user),
  });

  return data.user;
}

export async function updateUser(userId, updates) {
  const data = await request(`/api/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });

  return data.user;
}

export async function deleteUser(userId) {
  await request(`/api/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

/**
 * Resolve any MusicDeck artwork reference (library, playlist, or external) to
 * its authenticated proxy URL. `size` is an optional square-thumbnail hint in
 * pixels; the server snaps it to a supported size and resizes at the source,
 * so grids and sidebars never download full-resolution covers.
 */
export function getCoverUrl(coverArt, size) {
  if (!coverArt) return null;
  if (typeof coverArt === "object") return getCoverUrl(coverArt.url, size);

  const id = String(coverArt);
  if (!isBrowserIntegrationAllowed("artwork") && (
    /^https?:\/\//i.test(id) || id.startsWith("extart_") || id.startsWith("/api/artwork/external/")
  )) return null;
  if (/^https?:\/\//i.test(id) || (id.startsWith("/") && !id.startsWith("//"))) {
    return resolveDesktopApiUrl(id);
  }

  if (id.startsWith("extart_")) {
    return resolveDesktopApiUrl(`/api/artwork/external/${encodeURIComponent(id)}`);
  }

  const url = `/api/artwork/${encodeURIComponent(id)}`;

  return resolveDesktopApiUrl(size ? `${url}?size=${encodeURIComponent(size)}` : url);
}

export async function prepareNormalizedPlayback(songId, source, previewUrl, signal, streamQuality = "original", targetLufs = -16) {
  return request("/api/playback/normalize", {
    method: "POST",
    signal,
    body: JSON.stringify({
      trackId: String(songId),
      ...(source && typeof source === "object" && source.id ? { playableSource: source.id } : source ? { source } : {}),
      ...(previewUrl ? { previewUrl } : {}),
      ...(["128", "192", "256", "320"].includes(streamQuality) ? { bitRate: Number(streamQuality) } : {}),
      background: true,
      targetLufs,
    }),
  });
}

export async function getLoudnessScan(signal) {
  return (await request("/api/playback/loudness-scan", { signal })).scan;
}

export async function startLoudnessScan() {
  return (await request("/api/playback/loudness-scan", { method: "POST", body: "{}" })).scan;
}

export async function getSilenceScan(signal) {
  return (await request("/api/playback/silence-scan", { signal })).scan;
}

export async function startSilenceScan(parameters) {
  return (await request("/api/playback/silence-scan", { method: "POST", body: JSON.stringify(parameters) })).scan;
}

export function getStreamUrl(songId, source, streamQuality = "original") {
  if (!songId) {
    return null;
  }

  const base = `/api/tracks/${encodeURIComponent(songId)}/stream`;
  const params = new URLSearchParams();

  if (source && typeof source === "object" && source.id) {
    params.set("playableSource", source.id);
  } else if (source) {
    params.set("source", source);
  }

  if (["128", "192", "256", "320"].includes(streamQuality)) {
    params.set("maxBitRate", streamQuality);
  }

  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export async function getTrackLyrics(songId, song = null) {
  if (!songId) return null;
  const duration = Number(song?.duration ?? song?.metadata?.durationSeconds);
  const params = new URLSearchParams();
  if (song?.title && song?.artist && Number.isFinite(duration) && duration > 0) {
    params.set("track_name", song.title);
    params.set("artist_name", song.artist);
    if (song.album) params.set("album_name", song.album);
    params.set("duration", String(Math.round(duration)));
  }
  const query = params.toString();
  const suffix = query ? `?${query}` : "";
  const data = await request(`/api/tracks/${encodeURIComponent(songId)}/lyrics${suffix}`);
  const parsedLines = Array.isArray(data.syncedLyrics)
    ? data.syncedLyrics.filter((line) => Number.isFinite(line?.time) && typeof line?.text === "string")
    : null;
  const syncedLyrics = parsedLines ? (parsedLines.length ? parsedLines : null)
    : typeof data.syncedLyrics === "string" && data.syncedLyrics.trim() ? data.syncedLyrics : null;
  return {
    syncedLyrics,
    plainLyrics: typeof data.plainLyrics === "string" ? data.plainLyrics
      : !syncedLyrics && typeof data.lyrics === "string" ? data.lyrics : null,
    isSynced: data.isSynced === false ? false : Boolean(syncedLyrics),
    provider: ["lrclib", "lyricsovh", "none"].includes(data.provider) ? data.provider : "none",
    instrumental: data.instrumental === true,
  };
}

export async function getTrackArtistBiography(songId) {
  if (!songId) return null;
  const data = await request(`/api/tracks/${encodeURIComponent(songId)}/artist-biography`);
  return typeof data.biography === "string" ? data.biography : null;
}

export async function getSilenceAnalysis(songId, options) {
  if (!songId) {
    return null;
  }

  const params = new URLSearchParams();
  if (options?.thresholdDb !== undefined) params.set("thresholdDb", String(options.thresholdDb));
  if (options?.minSilenceSeconds !== undefined) params.set("minSilenceSeconds", String(options.minSilenceSeconds));
  const query = params.toString();
  const data = await request(`/api/tracks/${encodeURIComponent(songId)}/silence-analysis${query ? `?${query}` : ""}`);
  return data.analysis;
}

export async function analyzeSilence(songId, options = {}) {
  const data = await request(`/api/tracks/${encodeURIComponent(songId)}/silence-analysis`, {
    method: "POST",
    body: JSON.stringify(options),
  });
  return data.analysis;
}

export async function getPlayableSources(result) {
  const data = await request("/api/sources", {
    method: "POST",
    body: JSON.stringify({
      result: {
        id: result.id,
        type: result.type || "track",
        title: result.title,
        subtitle: result.subtitle || null,
        artist: result.artist || null,
        album: result.album || null,
        provider: result.provider || "library",
        source: result.source || { kind: "library", count: result.sources?.length || 1 },
        metadata: result.metadata || {},
      },
    }),
  });

  return {
    sources: data.sources || [],
    selectedSource: data.selectedSource || null,
    degraded: Boolean(data.degraded),
  };
}

export async function getAlbums(limit = 20) {
  const data = await request(`/api/albums?limit=${encodeURIComponent(limit)}`);
  return (data.albums || []).map((album) => toAlbum(album));
}

export async function getRandomSongs(limit = 10) {
  const data = await request(`/api/library/random-tracks?limit=${encodeURIComponent(limit)}`);
  return (data.tracks || []).map(toSong);
}

export async function getAlbum(albumId) {
  const [albumData, tracksData] = await Promise.all([
    request(`/api/albums/${encodeURIComponent(albumId)}`),
    request(`/api/albums/${encodeURIComponent(albumId)}/tracks`),
  ]);

  return toAlbum(
    albumData.album,
    (tracksData.tracks || []).map(toSong)
  );
}

export async function getAllSongs() {
  const data = await request("/api/tracks");
  return (data.tracks || []).map((track) =>
    normalizeTrackData(track, "library")
  );
}

export async function getTrackPage({ offset = 0, limit = 200, filters = [], signal } = {}) {
  const data = filters.length
    ? await request("/api/library/tracks/filter", {
      method: "POST", body: JSON.stringify({ filters, offset, limit }), signal,
    })
    : await request(`/api/tracks?offset=${offset}&limit=${limit}`, { signal });
  return { items: (data.tracks || []).map(toSong), total: data.total, revision: data.revision };
}

export async function getAlbumPage({ offset = 0, limit = 200, signal } = {}) {
  const data = await request(`/api/albums?offset=${offset}&limit=${limit}`, { signal });
  return { items: (data.albums || []).map((album) => toAlbum(album)), total: data.total, revision: data.revision };
}

export async function getCollectorCatalog(includeAlbums, signal) {
  const data = await request(`/api/library/collector?albums=${includeAlbums ? 1 : 0}`, { signal });
  return {
    ownerId: data.ownerId,
    tracks: data.tracks.map(track => ({ ...toSong(track), favorite: track.favorite, played: track.played })),
    albums: data.albums.map(album => toAlbum(album)),
    degraded: data.degraded,
  };
}

export async function getArtists() {
  const data = await request("/api/artists");
  return (data.artists || []).map((artist) => toArtist(artist));
}

export async function getArtist(artistId) {
  const [artistData, albumsData] = await Promise.all([
    request(`/api/artists/${encodeURIComponent(artistId)}`),
    request(`/api/artists/${encodeURIComponent(artistId)}/albums`),
  ]);

  return toArtist(
    artistData.artist,
    (albumsData.albums || []).map((album) => toAlbum(album))
  );
}

export async function getExplore() {
  const data = await request("/api/search?q=music&mode=hybrid");
  return {
    albums: (data.results?.album || []).map(toSearchItem),
    artists: (data.results?.artist || []).map(toSearchItem),
    songs: (data.results?.track || []).map(toSearchItem),
    degraded: Boolean(data.degraded),
  };
}

function toRecommendationSection(section) {
  return {
    id: section.id,
    title: section.title,
    items: (section.items || []).map(toSearchItem),
  };
}

export async function getRecommendations(kinds, limit = 12) {
  const params = new URLSearchParams({
    kinds: kinds.join(","),
    limit: String(limit),
  });
  const data = await request(`/api/recommendations?${params.toString()}`);
  return {
    sections: (data.sections || []).map(toRecommendationSection),
    degraded: Boolean(data.degraded),
  };
}

export async function startRadio(seed, limit = 20) {
  const data = await request("/api/recommendations/radio", {
    method: "POST",
    body: JSON.stringify({ ...seed, limit }),
  });
  return (data.tracks || []).map(toSearchItem);
}

export const RECOMMENDATION_FEEDBACK_CHANGED_EVENT = "musicdeck:recommendation-feedback-changed";

export async function getAutoplayTracks(seedId, limit = 10, excludeIds = [], taste = {}) {
  const data = await request("/api/recommendations/autoplay", {
    method: "POST",
    body: JSON.stringify({ seedId: String(seedId), limit, excludeIds: excludeIds.map(String).slice(-500),
      ...(taste.playlistId ? { playlistId: String(taste.playlistId), excludeFromTaste: Boolean(taste.excludeFromTaste) } : {}) }),
  });
  return (data.tracks || []).map((track) => ({
    ...toSearchItem(track),
    recommendationGenerated: true,
    autoplayGenerated: true,
  }));
}

export async function sendRecommendationFeedback(feedback) {
  const result = await request("/api/recommendations/feedback", {
    method: "POST",
    body: JSON.stringify(feedback),
  });
  window.dispatchEvent(new CustomEvent(RECOMMENDATION_FEEDBACK_CHANGED_EVENT, { detail: feedback }));
  return result;
}

export async function recordListeningEvent(trackId, eventType, completionRatio) {
  return request("/api/listening-events", {
    method: "POST",
    keepalive: true,
    body: JSON.stringify({ trackId, eventType, completionRatio }),
  });
}

export const LISTENING_ACTIVITY_CHANGED_EVENT = "musicdeck:listening-activity-changed";

export async function reportPlaybackSession(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const result = await request("/api/listening-events", {
      method: "POST", keepalive: true, signal: controller.signal, body: JSON.stringify(payload),
    });
    if (result.newlyCounted || payload.finished) window.dispatchEvent(new Event(LISTENING_ACTIVITY_CHANGED_EVENT));
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

export function getListeningConfig() {
  return request("/api/listening-activity/config");
}

export async function getListeningHistory({ period = "all", search = "", cursor, signal } = {}) {
  const query = new URLSearchParams({ period, search, limit: "30" });
  if (cursor) query.set("cursor", cursor);
  const data = await request(`/api/listening-activity/history?${query}`, { signal });
  return { ...data, items: data.items.map((item) => ({ ...item, track: normalizeTrackData(item.track) })) };
}

export function getListeningStatistics(period = "30", signal) {
  return request(`/api/listening-activity/statistics?${new URLSearchParams({ period })}`, { signal });
}

export async function getListeningTrack(trackId) {
  const data = await request(`/api/tracks/${encodeURIComponent(trackId)}`);
  return toSong(data.track);
}

export async function getArtistOverview(artistId, { scope } = {}) {
  const suffix = scope === "local" ? "?scope=local" : "";
  const data = await request(`/api/artists/${encodeURIComponent(artistId)}/overview${suffix}`);
  return {
    artist: toArtist(data.artist, (data.albums || []).map(toAlbum)),
    tracks: (data.tracks || []).map(toSong),
    topTracks: (data.topTracks || []).map(toSong),
    localAlbumCount: data.localAlbumCount,
    localSongCount: data.localSongCount,
    externalEnrichmentAvailable: Boolean(data.externalEnrichmentAvailable),
  };
}

export async function getArtistDiscography(artistId) {
  const data = await request(`/api/artists/${encodeURIComponent(artistId)}/discography`);
  return {
    missingAlbums: data.missingAlbums || [],
    missingTracks: data.missingTracks || [],
    providers: data.providers || {},
  };
}

export async function getArtistTopTracks(artistId) {
  const data = await request(`/api/artists/${encodeURIComponent(artistId)}/top-tracks`);
  return (data.tracks || []).map(toSong);
}

export async function getArtistPortrait(artistId, options = {}) {
  const params = new URLSearchParams();
  if (options.skipNative) params.set("skipNative", "1");
  if (options.skipDeezer) params.set("skipDeezer", "1");
  const query = params.toString();
  const suffix = query ? `?${query}` : "";
  const data = await request(`/api/artists/${encodeURIComponent(artistId)}/portrait${suffix}`);
  return typeof data.imageUrl === "string" && data.imageUrl.trim()
    ? { url: data.imageUrl, source: data.imageSource || "native",
      kind: data.imageKind || "artist" } : null;
}

export async function getMusicBrainzArtistPortrait(artistId) {
  const data = await request(`/api/artists/${encodeURIComponent(artistId)}/portrait/musicbrainz`);
  return typeof data.imageUrl === "string" && data.imageUrl.trim()
    ? { url: data.imageUrl, source: "musicbrainz", kind: "artist" } : null;
}

export async function getRecentlyAddedSongs(limit = 6) {
  const data = await request(`/api/tracks/recently-added?limit=${encodeURIComponent(limit)}`);
  return (data.tracks || []).map(toSong);
}

export async function getLibraryHealth() {
  return request("/api/library/health");
}

/** Admin background health check: poll this for progress and the report. */
export async function getAdminHealthScan() {
  const data = await request("/api/admin/library/health/scan");
  return data.status;
}

export async function startAdminHealthScan() {
  return request("/api/admin/library/health/scan", { method: "POST" });
}

export async function rescanLibraryArtwork() {
  return request("/api/admin/library/health/repair/artwork", { method: "POST" });
}

export async function pruneOrphanedTracks() {
  return request("/api/admin/library/health/repair/prune-orphans", { method: "POST" });
}

export async function getLibraryStatistics() {
  return request("/api/library/statistics");
}

export async function setMediaFavorite(itemType, itemId, favorite, album) {
  return request(`/api/library/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/favorite`, {
    method: "PUT",
    body: JSON.stringify({ favorite, ...(album ? { album } : {}) }),
  });
}

export async function getLikedAlbums() {
  const data = await request("/api/favorites/albums");
  return data.albums || [];
}

export async function getArtistTracks(artistId) {
  const data = await request(`/api/artists/${encodeURIComponent(artistId)}/tracks`);
  return (data.tracks || []).map(toSong);
}

export async function searchNavidrome(query, options = {}) {
  const params = new URLSearchParams({
    q: query,
    types: "artists,albums,tracks,playlists",
  });

  if (options.mode) {
    params.set("mode", options.mode);
  }
  if (options.phase) {
    params.set("phase", options.phase);
  }

  const data = await request(`/api/search?${params.toString()}`);

  return {
    artists: (data.artists || []).map((artist) => toArtist(artist)),
    albums: (data.albums || []).map((album) => toAlbum(album)),
    songs: (data.tracks || []).map(toSong),
    playlists: (data.playlists || []).map(toPlaylist),
    results: {
      track: (data.results?.track || []).map(toSearchItem),
      album: (data.results?.album || []).map(toSearchItem),
      artist: (data.results?.artist || []).map(toSearchItem),
      playlist: (data.results?.playlist || []).map(toSearchItem),
    },
    degraded: Boolean(data.degraded),
  };
}

export async function getPlaylists() {
  const data = await request("/api/playlists");
  return (data.playlists || []).map(toPlaylist);
}

export async function getPlaylist(playlistId, signal) {
  const data = await request(`/api/playlists/${encodeURIComponent(playlistId)}`, signal ? { signal } : {});
  return data.playlist ? toPlaylist(data.playlist) : null;
}

export async function patchPlaylist(playlistId, updates) {
  if (playlistCommands.getSnapshot().owner) {
    const result = await playlistCommands.execute(String(playlistId), { kind: "details", ...updates });
    return result.playlist ? toPlaylist(result.playlist) : null;
  }
  const data = await request(`/api/playlists/${encodeURIComponent(playlistId)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });

  return data.playlist ? toPlaylist(data.playlist) : null;
}

export async function createPlaylist(name, description = "") {
  const data = await request("/api/playlists", {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });

  return data.playlist ? toPlaylist(data.playlist) : null;
}

export async function deletePlaylist(playlistId) {
  if (playlistCommands.getSnapshot().owner) {
    await playlistCommands.execute(String(playlistId), { kind: "trash" }); return;
  }
  await request(`/api/playlists/${encodeURIComponent(playlistId)}`, {
    method: "DELETE",
  });
}

export async function addSongToPlaylist(playlistId, songId) {
  if (playlistCommands.getSnapshot().owner) {
    const result = await playlistCommands.execute(String(playlistId), { kind: "add", trackIds: [String(songId)] });
    return { added: Boolean(result.command) };
  }
  return request(`/api/playlists/${encodeURIComponent(playlistId)}/tracks`, {
    method: "POST",
    body: JSON.stringify({ trackId: String(songId) }),
  });
}

export async function reorderPlaylistItems(playlistId, itemIds, expectedItemIds) {
  if (playlistCommands.getSnapshot().owner) {
    const result = await playlistCommands.execute(String(playlistId), { kind: "reorder", itemIds, expectedItemIds });
    return toPlaylist(result.playlist);
  }
  const data = await request(`/api/v1/playlists/${encodeURIComponent(playlistId)}/reorder`, {
    method: "POST", body: JSON.stringify({ itemIds, expectedItemIds }),
  });
  return toPlaylist(data.playlist);
}

export async function editPlaylistTracks(playlistId, edit) {
  if (playlistCommands.getSnapshot().owner) {
    const { action, ...payload } = edit;
    const result = await playlistCommands.execute(String(playlistId), { kind: action, ...payload });
    return toPlaylist(result.playlist);
  }
  const data = await request(`/api/v1/playlists/${encodeURIComponent(playlistId)}/tracks/batch`, {
    method: "POST", body: JSON.stringify(edit),
  });
  return toPlaylist(data.playlist);
}

export async function updatePlaylist(playlistId, songIdToAdd = null) {
  if (!songIdToAdd) {
    return request(`/api/playlists/${encodeURIComponent(playlistId)}`, {
      method: "PATCH",
      body: JSON.stringify({}),
    });
  }

  return addSongToPlaylist(playlistId, songIdToAdd);
}

export async function removeSongFromPlaylist(playlistId, songIndex) {
  const playlist = await getPlaylist(playlistId);
  const song = playlist?.entry?.[songIndex];

  if (!song) {
    return;
  }

  if (playlistCommands.getSnapshot().owner && song.playlistItemId) {
    await playlistCommands.execute(String(playlistId), { kind: "remove", itemIds: [song.playlistItemId], expectedItemIds: playlist.itemIds }); return;
  }

  await request(
    `/api/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(song.playlistItemId || song.id)}`,
    { method: "DELETE" }
  );
}

/*
 * Replace a playlist's automatic 2x2 collage with custom artwork.
 *
 * The image is sent as a base64 data URL; the server validates the media
 * type and size, stores only the custom artwork, and continues to serve it
 * through the same authenticated artwork proxy as the collage.
 */
export async function setPlaylistArtwork(playlistId, image) {
  const data = await request(`/api/playlists/${encodeURIComponent(playlistId)}/artwork`, {
    method: "PUT",
    body: JSON.stringify({ image }),
  });

  return data.playlist ? toPlaylist(data.playlist) : null;
}

/* Remove custom artwork so the playlist falls back to the automatic collage. */
export async function clearPlaylistArtwork(playlistId) {
  const data = await request(`/api/playlists/${encodeURIComponent(playlistId)}/artwork`, {
    method: "DELETE",
  });

  return data.playlist ? toPlaylist(data.playlist) : null;
}

export async function getStarred(signal) {
  const data = await request("/api/favorites/tracks", signal ? { signal } : {});
  return (data.tracks || []).map((track) =>
    normalizeTrackData(track, "liked")
  );
}

export async function matchLibraryItems(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const batches = [];
  for (let index = 0; index < items.length; index += 100) {
    batches.push(items.slice(index, index + 100));
  }
  const responses = await Promise.all(batches.map((batch) => request("/api/library/matches", {
    method: "POST",
    body: JSON.stringify({ items: batch }),
  })));
  return responses.flatMap((data) => data.matches || []);
}

export async function getExternalCharts() {
  return request("/api/discovery/external");
}

export async function getPersonalizedDiscovery() {
  return request("/api/discovery/personalized");
}

export async function hydrateExternalPreviews(tracks) {
  const data = await request("/api/discovery/external/previews", {
    method: "POST",
    body: JSON.stringify({ tracks }),
  });
  return data.tracks || [];
}

export async function getRecentlyPlayed({ tasteOnly = false } = {}) {
  const data = await request(`/api/recently-played${tasteOnly ? "?tasteOnly=1" : ""}`);
  return (data.tracks || []).map(toSong);
}

export async function recordRecentlyPlayed(songId) {
  await request("/api/recently-played", {
    method: "POST",
    body: JSON.stringify({ trackId: String(songId) }),
  });
}

export async function starSong(songId) {
  await request(`/api/favorites/tracks/${encodeURIComponent(songId)}`, {
    method: "PUT",
  });
}

export async function unstarSong(songId) {
  await request(`/api/favorites/tracks/${encodeURIComponent(songId)}`, {
    method: "DELETE",
  });
}

export async function createAcquisition(payload) {
  return request("/api/acquisitions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** @param {{ ownOnly?: boolean, signal?: AbortSignal }} [options] */
export async function getAcquisitions({ ownOnly = false, signal } = {}) {
  const data = await request(ownOnly ? "/api/acquisitions?scope=mine" : "/api/acquisitions", { signal });
  return data.jobs || [];
}

export async function getAcquisition(jobId) {
  const data = await request(`/api/acquisitions/${encodeURIComponent(jobId)}`);
  return data.job;
}

export async function cancelAcquisition(jobId) {
  return request(`/api/acquisitions/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
}

export async function retryAcquisition(jobId) {
  return request(`/api/acquisitions/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
  });
}

export async function getAdminAcquisitions() {
  return request("/api/admin/acquisitions");
}

export async function getDownloaderDiagnostics() {
  const data = await request("/api/admin/downloader/diagnostics");
  return data.downloaders || [];
}

export async function cleanupAdminAcquisitions() {
  return request("/api/admin/acquisitions/cleanup", {
    method: "POST",
  });
}

export async function scanAdminAcquisitions() {
  return request("/api/admin/acquisitions/scan", {
    method: "POST",
  });
}
