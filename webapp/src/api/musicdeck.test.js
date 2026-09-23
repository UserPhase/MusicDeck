import {
  getAlbums,
  getArtist,
  getArtistOverview,
  getArtistPortrait,
  getCoverUrl,
  getCurrentSession,
  getRecentlyPlayed,
  getPlayableSources,
  getStreamUrl,
  getTrackLyrics,
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

test("artist albums resolve cover art the same way whether the server returns a legacy artworkId or a merged catalog artwork object", async () => {
  global.fetch
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        artist: { id: "artist-1", name: "Queen", artworkId: null, albumCount: 2 },
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        albums: [
          {
            id: "album-legacy",
            name: "Legacy Album",
            artistId: "artist-1",
            artistName: "Queen",
            year: 1975,
            artworkId: "art-legacy",
            songCount: 12,
          },
          {
            id: "album-merged",
            type: "album",
            title: "Merged Album",
            artist: "Queen",
            year: 1980,
            artwork: { id: "art-merged", url: "/api/artwork/art-merged" },
            source: { kind: "library", count: 1 },
            identity: { id: "some-id", strength: "normalized" },
          },
        ],
      }),
    });

  const artist = await getArtist("artist-1");

  expect(artist.album).toEqual([
    expect.objectContaining({ id: "album-legacy", coverArt: "art-legacy" }),
    expect.objectContaining({ id: "album-merged", coverArt: "art-merged" }),
  ]);

  // Both cover IDs must resolve through the same artwork endpoint used by
  // the Album detail page.
  expect(getCoverUrl(artist.album[0].coverArt)).toBe("/api/artwork/art-legacy");
  expect(getCoverUrl(artist.album[1].coverArt)).toBe("/api/artwork/art-merged");
});

test("lyrics lookup sends exact track metadata and accepts synchronized text", async () => {
  global.fetch.mockResolvedValue({
    ok: true, status: 200,
    json: () => Promise.resolve({ syncedLyrics: "[00:15.22] Hello", plainLyrics: "Hello" }),
  });
  await expect(getTrackLyrics("track-1", {
    title: "Hello", artist: "Artist", album: "Album", duration: 180.4,
  })).resolves.toEqual({ syncedLyrics: "[00:15.22] Hello", plainLyrics: "Hello",
    isSynced: true, provider: "none", instrumental: false });
  expect(global.fetch.mock.calls[0][0]).toContain("track_name=Hello&artist_name=Artist&album_name=Album&duration=180");
});

test("lyrics lookup keeps title, artist, and duration when album metadata is absent", async () => {
  global.fetch.mockResolvedValue({
    ok: true, status: 200,
    json: () => Promise.resolve({ plainLyrics: "Found without album" }),
  });
  await expect(getTrackLyrics("track-no-album", {
    title: "X Valentine", artist: "GEMS", duration: 188,
  })).resolves.toEqual({ syncedLyrics: null, plainLyrics: "Found without album",
    isSynced: false, provider: "none", instrumental: false });
  expect(global.fetch.mock.calls[0][0]).toContain("track_name=X+Valentine&artist_name=GEMS&duration=188");
  expect(global.fetch.mock.calls[0][0]).not.toContain("album_name=");
});

test("lyrics API preserves unsynced lyrics.ovh text and provider state", async () => {
  global.fetch.mockResolvedValue({
    ok: true, status: 200,
    json: () => Promise.resolve({ syncedLyrics: null, plainLyrics: "First line\nSecond line",
      isSynced: false, provider: "lyricsovh" }),
  });
  await expect(getTrackLyrics("ovh-track")).resolves.toEqual({
    syncedLyrics: null, plainLyrics: "First line\nSecond line", isSynced: false,
    provider: "lyricsovh", instrumental: false,
  });
});

test("lyrics API accepts parsed timed lines and treats an empty line list as unsynced", async () => {
  global.fetch.mockResolvedValueOnce({
    ok: true, status: 200,
    json: () => Promise.resolve({ syncedLyrics: [{ time: 15.22, text: "Hello" }],
      isSynced: true, provider: "lrclib" }),
  }).mockResolvedValueOnce({
    ok: true, status: 200,
    json: () => Promise.resolve({ syncedLyrics: [], plainLyrics: "Untimed", isSynced: true }),
  });
  await expect(getTrackLyrics("timed")).resolves.toMatchObject({
    syncedLyrics: [{ time: 15.22, text: "Hello" }], isSynced: true, provider: "lrclib",
  });
  await expect(getTrackLyrics("untimed")).resolves.toMatchObject({
    syncedLyrics: null, plainLyrics: "Untimed", isSynced: false,
  });
});

test("artist portrait API preserves provider and tile-fallback metadata", async () => {
  global.fetch.mockResolvedValue({ ok: true, status: 200,
    json: () => Promise.resolve({ imageUrl: "/api/artwork/external/itunes-art",
      imageSource: "itunes", imageKind: "artist-tile-fallback" }) });
  await expect(getArtistPortrait("artist-1", { skipNative: true, skipDeezer: true })).resolves.toEqual({
    url: "/api/artwork/external/itunes-art", source: "itunes", kind: "artist-tile-fallback",
  });
  expect(global.fetch.mock.calls[0][0]).toContain("/api/artists/artist-1/portrait?skipNative=1&skipDeezer=1");
});

test("artist overview adapts a verified keyless portrait, undownloaded albums, and popular tracks", async () => {
  global.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      artist: { id: "queen-id", name: "Queen", imageUrl: "/api/artwork/external/portrait-token", albumCount: 1 },
      albums: [
        { id: "local-album", name: "Local Album", artistId: "queen-id", artistName: "Queen" },
        { id: "external_deezer_album_42", title: "More Queen", artist: "Queen", artistId: "queen-id", artworkId: "cover-token" },
      ],
      tracks: [{ id: "local-song", title: "Local Song", artistId: "queen-id", artistName: "Queen" }],
      topTracks: [{ type: "track", id: "external_deezer_track_43", title: "Popular Song", artist: "Queen", source: { kind: "external", count: 0 }, metadata: { artistId: "queen-id" } }],
      localAlbumCount: 1,
      localSongCount: 1,
    }),
  });

  const overview = await getArtistOverview("queen-id");
  expect(overview.artist.imageUrl).toBe("/api/artwork/external/portrait-token");
  expect(overview.artist.album[1]).toMatchObject({
    id: "external_deezer_album_42", source: { kind: "external", count: 0 }, coverArt: "cover-token",
  });
  expect(overview.topTracks[0]).toMatchObject({ title: "Popular Song", artistId: "queen-id" });
  expect(global.fetch).toHaveBeenCalledWith("/api/artists/queen-id/overview", expect.any(Object));

  await getArtistOverview("queen-id", { scope: "local" });
  expect(global.fetch).toHaveBeenLastCalledWith("/api/artists/queen-id/overview?scope=local", expect.any(Object));
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
  expect(getStreamUrl("track-1", null, "128")).toBe("/api/tracks/track-1/stream?maxBitRate=128");
  expect(getStreamUrl("track-1", { id: "playable_1" }, "320")).toBe("/api/tracks/track-1/stream?playableSource=playable_1&maxBitRate=320");
  expect(getStreamUrl("track-1", null, "256")).toBe("/api/tracks/track-1/stream?maxBitRate=256");
  expect(getStreamUrl("track-1", null, "192")).toBe("/api/tracks/track-1/stream?maxBitRate=192");
  expect(getCoverUrl("art-1")).toBe("/api/artwork/art-1");

  // Thumbnail hints are forwarded to the artwork proxy, and external artwork
  // keeps its own opaque-token route.
  expect(getCoverUrl("art-1", 64)).toBe("/api/artwork/art-1?size=64");
  expect(getCoverUrl("mdplart_sig_mdpl_1", 300)).toBe(
    "/api/artwork/mdplart_sig_mdpl_1?size=300"
  );
  expect(getCoverUrl("extart_1", 64)).toBe("/api/artwork/external/extart_1");
  expect(getCoverUrl(null, 64)).toBeNull();
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
