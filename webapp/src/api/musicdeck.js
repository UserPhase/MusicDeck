async function request(path, options = {}) {
  const response = await fetch(path, {
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

    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function toSong(track) {
  const isUnified = typeof track.artist === "string" || track.provider || track.source;

  return {
    id: track.id,
    type: "track",
    title: track.title,
    artistId: isUnified ? track.metadata?.artistId || null : track.artistId,
    artist: isUnified ? track.artist : track.artistName,
    albumId: isUnified ? track.metadata?.albumId || null : track.albumId,
    album: isUnified ? track.album : track.albumName,
    duration: isUnified ? track.metadata?.durationSeconds || null : track.durationSeconds,
    track: track.trackNumber || null,
    coverArt: isUnified ? track.artwork?.id || null : track.artworkId,
    artwork: isUnified ? track.artwork || null : undefined,
    streamUrl: isUnified ? null : track.streamUrl,
    availability: track.availability || null,
    source: isUnified ? track.source : undefined,
    provider: isUnified ? track.provider : undefined,
    metadata: isUnified ? track.metadata || {} : {},
    sources: Array.isArray(track.sources) ? track.sources : [],
  };
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
    releaseDate: album.releaseDate || null,
    genre: album.genre || null,
    label: album.label || null,
    coverArt: album.artwork?.id || album.artworkId || null,
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
    ...(songs ? { song: songs } : {}),
  };
}

function toArtist(artist, albums) {
  const isExternal = Array.isArray(artist.albums) || Array.isArray(artist.tracks);

  return {
    id: artist.id,
    name: artist.name,
    coverArt: artist.artworkId,
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
    name: playlist.name,
    comment: playlist.description,
    coverArt: playlist.artworkId,
    songCount: playlist.songCount,
    entry: (playlist.tracks || []).map(toSong),
  };
}

function toSearchItem(result) {
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
  };
}

export async function login(username, password) {
  const data = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });

  return data.user;
}

export async function logout() {
  await request("/api/auth/logout", { method: "POST" });
}

export async function getCurrentSession() {
  return request("/api/auth/session");
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

export async function getAdminHealth() {
  return request("/api/admin/health");
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

export async function getPlugins() {
  const data = await request("/api/plugins");
  return data.plugins || [];
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

export function getCoverUrl(coverArt) {
  if (!coverArt) return null;
  if (typeof coverArt === "object") return coverArt.url || null;
  return String(coverArt).startsWith("extart_")
    ? `/api/artwork/external/${encodeURIComponent(coverArt)}`
    : `/api/artwork/${encodeURIComponent(coverArt)}`;
}

export function getStreamUrl(songId, source) {
  if (!songId) {
    return null;
  }

  const base = `/api/tracks/${encodeURIComponent(songId)}/stream`;

  if (source && typeof source === "object" && source.id) {
    return `${base}?playableSource=${encodeURIComponent(source.id)}`;
  }

  return source ? `${base}?source=${encodeURIComponent(source)}` : base;
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

export async function getRandomAlbums(limit = 16) {
  const data = await request(`/api/library/random-albums?limit=${encodeURIComponent(limit)}`);
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
  return (data.tracks || []).map(toSong);
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

export async function sendRecommendationFeedback(feedback) {
  return request("/api/recommendations/feedback", {
    method: "POST",
    body: JSON.stringify(feedback),
  });
}

export async function recordListeningEvent(trackId, eventType, completionRatio) {
  return request("/api/listening-events", {
    method: "POST",
    body: JSON.stringify({ trackId, eventType, completionRatio }),
  });
}

export async function filterLibraryTracks(filters = [], limit = 200) {
  const data = await request("/api/library/tracks/filter", {
    method: "POST",
    body: JSON.stringify({ filters, limit }),
  });
  return (data.tracks || []).map(toSong);
}

export async function getLibraryHealth() {
  return request("/api/library/health");
}

export async function getLibraryStatistics() {
  return request("/api/library/statistics");
}

export async function getSavedFilters() {
  const data = await request("/api/library/saved-filters");
  return data.filters || [];
}

export async function saveLibraryFilter(name, filters) {
  const data = await request("/api/library/saved-filters", {
    method: "POST",
    body: JSON.stringify({ name, filters }),
  });
  return data.filter;
}

export async function setMediaRating(itemType, itemId, rating) {
  return request(`/api/library/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/rating`, {
    method: "PUT",
    body: JSON.stringify({ rating }),
  });
}

export async function setMediaFavorite(itemType, itemId, favorite) {
  return request(`/api/library/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/favorite`, {
    method: "PUT",
    body: JSON.stringify({ favorite }),
  });
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

export async function getPlaylist(playlistId) {
  const data = await request(`/api/playlists/${encodeURIComponent(playlistId)}`);
  return data.playlist ? toPlaylist(data.playlist) : null;
}

export async function createPlaylist(name) {
  const data = await request("/api/playlists", {
    method: "POST",
    body: JSON.stringify({ name }),
  });

  return data.playlist ? toPlaylist(data.playlist) : null;
}

export async function deletePlaylist(playlistId) {
  await request(`/api/playlists/${encodeURIComponent(playlistId)}`, {
    method: "DELETE",
  });
}

export async function addSongToPlaylist(playlistId, songId) {
  return request(`/api/playlists/${encodeURIComponent(playlistId)}/tracks`, {
    method: "POST",
    body: JSON.stringify({ trackId: String(songId) }),
  });
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

  await request(
    `/api/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(song.id)}`,
    { method: "DELETE" }
  );
}

export async function getStarred() {
  const data = await request("/api/favorites/tracks");
  return (data.tracks || []).map(toSong);
}

export async function getRecentlyPlayed() {
  const data = await request("/api/recently-played");
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

export async function getAcquisitions() {
  const data = await request("/api/acquisitions");
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


