import {
  getAlbums,
  getCoverUrl,
  getCurrentSession,
  getRecentlyPlayed,
  getPlayableSources,
  getStreamUrl,
  login,
  recordRecentlyPlayed,
  searchNavidrome,
} from "./musicdeck";


beforeEach(() => {
  global.fetch = jest.fn();
});


test("login posts credentials to MusicDeck without storing Navidrome tokens", async () => {
  global.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      user: {
        id: "user-1",
        username: "admin",
        role: "admin",
      },
    }),
  });

  await expect(login("admin", "password123")).resolves.toEqual({
    id: "user-1",
    username: "admin",
    role: "admin",
  });

  expect(global.fetch).toHaveBeenCalledWith(
    "/api/auth/login",
    expect.objectContaining({
      credentials: "include",
      method: "POST",
    })
  );
});


test("session lookup uses the MusicDeck session endpoint", async () => {
  global.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ authenticated: false, user: null }),
  });

  await expect(getCurrentSession()).resolves.toEqual({
    authenticated: false,
    user: null,
  });

  expect(global.fetch).toHaveBeenCalledWith(
    "/api/auth/session",
    expect.objectContaining({ credentials: "include" })
  );
});


test("album responses are adapted to existing UI shapes", async () => {
  global.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      albums: [
        {
          id: "album-1",
          name: "Album",
          artistId: "artist-1",
          artistName: "Artist",
          year: 2024,
          artworkId: "art-1",
          songCount: 10,
        },
      ],
    }),
  });

  await expect(getAlbums()).resolves.toEqual([
    expect.objectContaining({
      id: "album-1",
      artist: "Artist",
      coverArt: "art-1",
    }),
  ]);
});

test("search adapts provider-neutral groups while retaining legacy arrays", async () => {
  global.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      artists: [],
      albums: [],
      tracks: [],
      playlists: [],
      degraded: true,
      results: {
        track: [{
          type: "track",
          id: "md_track-1",
          title: "Digital Love",
          subtitle: "Daft Punk",
          artist: "Daft Punk",
          album: "Discovery",
          artwork: { id: "mdart_1", url: "/api/artwork/mdart_1" },
          provider: "library",
          source: { kind: "library", count: 2 },
          availability: { state: "available", availableSourceCount: 2 },
          metadata: { artistId: "md_artist-1", albumId: "md_album-1", durationSeconds: 210 },
        }],
        album: [],
        artist: [],
        playlist: [{
          type: "playlist",
          id: "mdpl_1",
          title: "Night Drive",
          subtitle: "Playlist",
          artist: null,
          album: null,
          artwork: null,
          provider: "musicdeck",
          source: { kind: "musicdeck", count: 1 },
          availability: null,
          metadata: { songCount: 8 },
        }],
      },
    }),
  });

  const result = await searchNavidrome("digital");

  expect(result.degraded).toBe(true);
  expect(result.results.track[0]).toMatchObject({
    type: "track",
    title: "Digital Love",
    coverArt: "mdart_1",
    provider: "library",
    source: { kind: "library", count: 2 },
  });
  expect(result.results.playlist[0]).toMatchObject({
    type: "playlist",
    provider: "musicdeck",
    title: "Night Drive",
  });
});


test("stream and artwork URLs never include backend credentials", () => {
  expect(getStreamUrl("track-1")).toBe("/api/tracks/track-1/stream");
  expect(getStreamUrl("track-1", { id: "playable_1" })).toBe("/api/tracks/track-1/stream?playableSource=playable_1");
  expect(getCoverUrl("art-1")).toBe("/api/artwork/art-1");
});

test("playable source resolution sends normalized result data only to MusicDeck", async () => {
  global.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      sources: [{ id: "playable_1", type: "external", label: "External source", availability: "available" }],
      degraded: false,
    }),
  });

  await expect(getPlayableSources({
    id: "external_1",
    type: "track",
    title: "External Song",
    provider: "external",
    source: { kind: "external", count: 0 },
  })).resolves.toEqual({
    sources: [{ id: "playable_1", type: "external", label: "External source", availability: "available" }],
    selectedSource: null,
    degraded: false,
  });

  expect(global.fetch).toHaveBeenCalledWith(
    "/api/sources",
    expect.objectContaining({ method: "POST", credentials: "include" })
  );
});


test("recently played reads and writes through MusicDeck endpoints", async () => {
  global.fetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ tracks: [] }),
  });
  global.fetch.mockResolvedValueOnce({
    ok: true,
    status: 201,
    json: () => Promise.resolve({ ok: true }),
  });

  await expect(getRecentlyPlayed()).resolves.toEqual([]);
  await expect(recordRecentlyPlayed("track-1")).resolves.toBeUndefined();

  expect(global.fetch).toHaveBeenNthCalledWith(
    1,
    "/api/recently-played",
    expect.objectContaining({ credentials: "include" })
  );
  expect(global.fetch).toHaveBeenNthCalledWith(
    2,
    "/api/recently-played",
    expect.objectContaining({
      credentials: "include",
      method: "POST",
    })
  );
});
