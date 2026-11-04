import { act, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import Album from "./Album";
import Artist from "./Artist";
import { artistOverviewQueryClient } from "../api/artistOverviewQuery";
import Explore from "./Explore";
import {
  getAlbum,
  getAlbums,
  getArtist,
  getArtistPortrait,
  getMusicBrainzArtistPortrait,
  getArtistOverview,
  getArtistDiscography,
  getArtistTopTracks,
  getArtistTracks,
  getTrackArtistBiography,
  getCoverUrl,
  getExternalCharts,
  hydrateExternalPreviews,
  getExplore,
  getRecommendations,
  getPersonalizedDiscovery,
  searchNavidrome,
  matchLibraryItems,
  setMediaFavorite,
} from "../api/musicdeck";
import { usePlayer } from "../context/PlayerContext";
import { getWikipediaBiography } from "../services/biographyFallback";
import { canStreamPreview, findItunesPreview } from "../utils/previewPlayback";

jest.mock("../utils/previewPlayback", () => ({
  ...jest.requireActual("../utils/previewPlayback"),
  canStreamPreview: jest.fn(),
  findItunesPreview: jest.fn(),
}));

// Mirrors App.js, which provides the shared artist-overview query client.
function render(ui, options) {
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={artistOverviewQueryClient}>{children}</QueryClientProvider>
    ),
    ...options,
  });
}

jest.mock("../api/musicdeck", () => ({
  getAlbum: jest.fn(),
  getLikedAlbums: jest.fn(async () => []),
  getAlbums: jest.fn(async () => []),
  getArtist: jest.fn(),
  getArtistPortrait: jest.fn(async () => null),
  getMusicBrainzArtistPortrait: jest.fn(async () => null),
  getArtistOverview: jest.fn(),
  getArtistDiscography: jest.fn(),
  getArtistTopTracks: jest.fn(),
  getArtistTracks: jest.fn(async () => []),
  getTrackArtistBiography: jest.fn(async () => null),
  getCoverUrl: jest.fn((id) => (id ? typeof id === "object" ? id.url : `/artwork/${id}` : null)),
  getExternalCharts: jest.fn(),
  hydrateExternalPreviews: jest.fn(),
  getExplore: jest.fn(),
  getRecommendations: jest.fn(async () => ({ sections: [], degraded: false })),
  getPersonalizedDiscovery: jest.fn(),
  searchNavidrome: jest.fn(),
  matchLibraryItems: jest.fn(async () => []),
  setMediaFavorite: jest.fn(),
}));

jest.mock("../services/biographyFallback", () => ({
  getCachedWikipediaBiography: jest.fn(() => null),
  getWikipediaBiography: jest.fn(async () => null),
}));

jest.mock("../api/playlists", () => ({
  getPlaylists: jest.fn(async () => []),
  addSongToPlaylist: jest.fn(),
}));

jest.mock("../context/PlayerContext", () => ({
  usePlayer: jest.fn(),
}));

const playSong = jest.fn();
const playQueue = jest.fn();
const playContext = jest.fn();
const playSongFromSource = jest.fn();
const chartArtwork = "https://cdn-images.dzcdn.net/images/cover/chart/1000x1000.jpg";
const chartArtistArtwork = "https://cdn-images.dzcdn.net/images/artist/chart/1000x1000.jpg";
const chartData = {
  albums: [{ id: "deezer_album_201", title: "Chart Album", artist: "Chart Artist", coverArt: { url: chartArtwork }, external: true }],
  artists: [{ id: "deezer_artist_101", name: "Chart Artist", coverArt: { url: chartArtistArtwork }, external: true }],
  tracks: [{ id: "deezer_track_301", title: "Chart Song", artist: "Chart Artist", duration: 209, durationLabel: "3:29", coverArt: { url: chartArtwork }, external: true }],
};

beforeEach(() => {
  artistOverviewQueryClient.clear();
  jest.clearAllMocks();
  canStreamPreview.mockImplementation(async url => Boolean(url));
  findItunesPreview.mockResolvedValue(null);
  getCoverUrl.mockImplementation((id) => (id ? typeof id === "object" ? id.url : `/artwork/${id}` : null));
  getAlbums.mockResolvedValue([]);
  getArtist.mockResolvedValue({ album: [] });
  getArtistTracks.mockResolvedValue([]);
  getArtistPortrait.mockResolvedValue(null);
  getMusicBrainzArtistPortrait.mockResolvedValue(null);
  getTrackArtistBiography.mockResolvedValue(null);
  getWikipediaBiography.mockResolvedValue(null);
  matchLibraryItems.mockResolvedValue([]);
  getArtistOverview.mockImplementation(async (id) => {
    const [artist, tracks] = await Promise.all([getArtist(id), getArtistTracks(id)]);
    const ownAlbums = (artist.album || []).filter((album) => !album.artistId || album.artistId === id);
    const ownTracks = tracks.filter((track) => !track.artistId || track.artistId === id);
    return {
      artist,
      tracks,
      topTracks: ownTracks.slice().sort((left, right) => (right.playCount || 0) - (left.playCount || 0)).slice(0, 10),
      localAlbumCount: ownAlbums.length,
      localSongCount: ownTracks.length,
    };
  });
  getExternalCharts.mockResolvedValue(chartData);
  getArtistDiscography.mockResolvedValue({ missingAlbums: [], missingTracks: [] });
  getArtistTopTracks.mockResolvedValue([]);
  hydrateExternalPreviews.mockResolvedValue([]);
  getRecommendations.mockResolvedValue({ sections: [], degraded: false });
  getPersonalizedDiscovery.mockResolvedValue({ tracks: [], artists: [], albums: [], personalized: true, degraded: false, message: null });
  usePlayer.mockReturnValue({
    playSong,
    playQueue,
    playContext,
    playSongFromSource,
  });
});

test("renders an external album in the shared album page", async () => {
  getAlbum.mockResolvedValue({
    id: "external_itunes_album_10",
    name: "External Album",
    artist: "External Artist",
    artistId: "external_itunes_artist_20",
    year: 2025,
    genre: "Alternative",
    label: "Example Label",
    coverArt: "extart_album",
    song: [{
      id: "external_itunes_30",
      type: "track",
      title: "External Song",
      artist: "External Artist",
      album: "External Album",
      duration: 180,
      coverArt: "extart_track",
      source: { kind: "external", count: 0 },
      provider: "external",
      metadata: {},
    }],
  });

  render(
    <MemoryRouter initialEntries={["/album/external_itunes_album_10"]}>
      <Routes>
        <Route path="/album/:id" element={<Album />} />
      </Routes>
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "External Album" })).toBeInTheDocument();
  expect(screen.getByText(/Alternative/)).toBeInTheDocument();
  expect(screen.getByText(/Example Label/)).toBeInTheDocument();
  expect(screen.getByText("External Song")).toBeInTheDocument();
  expect(screen.getByLabelText(/available externally/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /play preview of external song/i })).toBeInTheDocument();
});

test("clicking an undownloaded discovery album opens its complete album page rather than search", async () => {
  getAlbum.mockResolvedValue({ id: "external_deezer_album_201", name: "Chart Album", artist: "Chart Artist",
    trackCount: 2, localTrackCount: 0, source: { kind: "external", count: 0 }, coverArt: { url: chartArtwork },
    song: [
      { id: "external_deezer_track_1", title: "First Discovery Track", artist: "Chart Artist", duration: 180,
        provider: "deezer", source: { kind: "external", count: 0 }, previewUrl: "https://cdns-preview-a.dzcdn.net/first.mp3" },
      { id: "external_deezer_track_2", title: "Second Discovery Track", artist: "Chart Artist", duration: 200,
        provider: "deezer", source: { kind: "external", count: 0 }, previewUrl: "https://cdns-preview-a.dzcdn.net/second.mp3" },
    ] });
  render(<MemoryRouter initialEntries={["/explore"]}><Routes>
    <Route path="/explore" element={<Explore />} />
    <Route path="/album/:id" element={<Album />} />
    <Route path="/search" element={<p>Unexpected search page</p>} />
  </Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole("link", { name: "Open Chart Album" }));
  expect(await screen.findByRole("heading", { name: "Chart Album" })).toBeInTheDocument();
  expect(screen.queryByText("Unexpected search page")).not.toBeInTheDocument();
  expect(getAlbum).toHaveBeenCalledWith("external_deezer_album_201");
  expect(screen.getByText("0 / 2 in library")).toBeInTheDocument();
  expect(screen.getByText("First Discovery Track")).toBeInTheDocument();
  expect(screen.getByText("Second Discovery Track")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Play preview of First Discovery Track" }));
  expect(playContext).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ title: "First Discovery Track" })]), 0, expect.objectContaining({ type: "album" }));
});

test("renders an external artist in the shared artist page and links albums", async () => {
  getArtistTracks.mockResolvedValue([{
    id: "external_itunes_30",
    title: "External Song",
    artist: "External Artist",
    duration: 180,
    source: { kind: "external", count: 0 },
    metadata: { albumId: "external_itunes_album_10" },
  }]);
  getArtist.mockResolvedValue({
    id: "external_itunes_artist_20",
    name: "External Artist",
    coverArt: null,
    albumCount: 1,
    album: [{
      id: "external_itunes_album_10",
      name: "External Album",
      year: 2025,
      coverArt: "extart_album",
      source: { kind: "external", count: 0 },
      provider: "external",
    }],
    tracks: [{
      id: "external_itunes_30",
      type: "track",
      title: "External Song",
      artist: "External Artist",
      album: "External Album",
      duration: 180,
      source: { kind: "external", count: 0 },
      provider: "external",
      metadata: { albumId: "external_itunes_album_10" },
    }],
  });

  render(
    <MemoryRouter initialEntries={["/artist/external_itunes_artist_20"]}>
      <Routes>
        <Route path="/artist/:id" element={<Artist />} />
      </Routes>
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "External Artist" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /external album/i })).toHaveAttribute(
    "href",
    "/artist/external_itunes_artist_20/album/external_itunes_album_10"
  );
  expect(screen.getByText("External Song")).toBeInTheDocument();
});

test("shows the complete catalog tracklist for an album with only some tracks downloaded", async () => {
  getAlbum.mockResolvedValue({
    id: "album-1",
    name: "A Night at the Opera",
    artist: "Queen",
    artistId: "artist-1",
    year: 1975,
    coverArt: null,
    trackCount: 4,
    localTrackCount: 2,
    song: [
      {
        id: "local-1",
        type: "track",
        title: "Death on Two Legs",
        artist: "Queen",
        source: { kind: "library", count: 1 },
        availability: { libraryAvailable: true, state: "available" },
        metadata: {},
      },
      {
        id: "local-2",
        type: "track",
        title: "Bohemian Rhapsody",
        artist: "Queen",
        source: { kind: "library", count: 1 },
        availability: { libraryAvailable: true, state: "available" },
        metadata: {},
      },
      {
        id: "cat-3",
        type: "track",
        title: "I'm in Love with My Car",
        artist: "Queen",
        source: { kind: "external", count: 0 },
        availability: null,
        provider: "external",
        metadata: {},
      },
      {
        id: "cat-4",
        type: "track",
        title: "You're My Best Friend",
        artist: "Queen",
        source: { kind: "external", count: 0 },
        availability: null,
        provider: "external",
        metadata: {},
      },
    ],
  });

  render(
    <MemoryRouter initialEntries={["/album/album-1"]}>
      <Routes>
        <Route path="/album/:id" element={<Album />} />
      </Routes>
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "A Night at the Opera" })).toBeInTheDocument();

  // All four known tracks remain visible, downloaded and undownloaded alike.
  expect(screen.getByText("Death on Two Legs")).toBeInTheDocument();
  expect(screen.getByText("Bohemian Rhapsody")).toBeInTheDocument();
  expect(screen.getByText("I'm in Love with My Car")).toBeInTheDocument();
  expect(screen.getByText("You're My Best Friend")).toBeInTheDocument();

  // Completion summary is shown.
  expect(screen.getByText(/2 \/ 4 in library/i)).toBeInTheDocument();

  // Undownloaded tracks stay playable: pressing play resolves an external preview.
  expect(
    screen.getByRole("button", { name: "Play preview of I'm in Love with My Car" })
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Play Death on Two Legs" })
  ).toBeEnabled();
});

test("keeps an artist's zero-download album visible alongside downloaded albums", async () => {
  getArtist.mockResolvedValue({
    id: "artist-1",
    name: "Queen",
    coverArt: null,
    albumCount: 2,
    album: [
      { id: "album-downloaded", name: "Album A", year: 2000, source: { kind: "library", count: 1 } },
      { id: "album-catalog-only", name: "Album B", year: 2001, source: { kind: "external", count: 0 } },
    ],
    tracks: [],
  });

  render(
    <MemoryRouter initialEntries={["/artist/artist-1"]}>
      <Routes>
        <Route path="/artist/:id" element={<Artist />} />
      </Routes>
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "Queen" })).toBeInTheDocument();
  expect(screen.getByText("Album A")).toBeInTheDocument();
  expect(screen.getByText("Album B")).toBeInTheDocument();
  expect(screen.getByText(/not downloaded/i)).toBeInTheDocument();
});

test("artist page album cover art resolves through the same getCoverUrl call as the album detail page", async () => {
  getCoverUrl.mockImplementation((id) => (id ? `/artwork/${id}` : null));

  // Album detail page.
  getAlbum.mockResolvedValue({
    id: "album-legacy",
    name: "Legacy Album",
    artist: "Queen",
    artistId: "artist-1",
    year: 1975,
    coverArt: "artwork-legacy-1",
    song: [],
  });

  const { unmount } = render(
    <MemoryRouter initialEntries={["/album/album-legacy"]}>
      <Routes>
        <Route path="/album/:id" element={<Album />} />
      </Routes>
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "Legacy Album" })).toBeInTheDocument();
  expect(screen.getByAltText("Legacy Album cover")).toHaveAttribute(
    "src",
    "/artwork/artwork-legacy-1"
  );
  unmount();

  // Artist page: same coverArt id, same getCoverUrl call, same resulting src.
  getArtist.mockResolvedValue({
    id: "artist-1",
    name: "Queen",
    coverArt: null,
    albumCount: 1,
    album: [
      {
        id: "album-legacy",
        name: "Legacy Album",
        year: 1975,
        coverArt: "artwork-legacy-1",
        source: { kind: "library", count: 1 },
      },
    ],
    tracks: [],
  });

  render(
    <MemoryRouter initialEntries={["/artist/artist-1"]}>
      <Routes>
        <Route path="/artist/:id" element={<Artist />} />
      </Routes>
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "Queen" })).toBeInTheDocument();
  expect(screen.getByAltText("Legacy Album cover")).toHaveAttribute(
    "src",
    "/artwork/artwork-legacy-1"
  );
  expect(getCoverUrl).toHaveBeenCalledWith("artwork-legacy-1", 300);
});

test("artist page waits for ID-scoped tracks, uses an artist portrait, and renders only the ten most played", async () => {
  let resolveTracks;
  getArtistTracks.mockReturnValue(new Promise((resolve) => { resolveTracks = resolve; }));
  getArtist.mockResolvedValue({
    id: "queen-id",
    name: "Queen",
    coverArt: "album-cover-not-an-avatar",
    imageUrl: "https://images.example.test/stale-unverified-image.jpg",
    album: [
      { id: "queen-album", artistId: "queen-id", name: "Queen Album" },
      { id: "other-album", artistId: "queen-naija-id", name: "Other Album" },
    ],
  });
  getArtistPortrait.mockResolvedValue("/api/artwork/external/verified-queen");

  render(
    <MemoryRouter initialEntries={["/artist/queen-id"]}>
      <Routes><Route path="/artist/:id" element={<Artist />} /></Routes>
    </MemoryRouter>
  );

  expect(screen.getByLabelText("Loading artist")).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByText(/0 songs/)).not.toBeInTheDocument();
  resolveTracks([
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `queen-track-${index}`,
      artistId: "queen-id",
      title: `Queen Track ${index}`,
      artist: "Queen",
      album: "Queen Album",
      playCount: index,
    })),
    { id: "other-track", artistId: "queen-naija-id", title: "Wrong Artist Track", playCount: 100 },
  ]);

  expect(await screen.findByRole("heading", { name: "Queen" })).toBeInTheDocument();
  expect(screen.getByText("1 album · 12 songs in library")).toBeInTheDocument();
  await waitFor(() => expect(document.querySelector(".artist-page-cover img"))
    .toHaveAttribute("src", "/api/artwork/external/verified-queen"));
  expect(screen.getByRole("link", { name: /Queen Album/ })).toHaveAttribute("href", "/album/queen-album");
  expect(screen.queryByText("Other Album")).not.toBeInTheDocument();
  const rows = within(screen.getByRole("table", { name: "Artist tracks" })).getAllByRole("row");
  expect(rows).toHaveLength(11); // header plus ten tracks
  expect(rows[1]).toHaveAttribute("aria-label", "Queen Track 11 by Queen");
  expect(screen.queryByText("Queen Track 0")).not.toBeInTheDocument();
  expect(screen.queryByText("Wrong Artist Track")).not.toBeInTheDocument();
  expect(getArtistTracks).toHaveBeenCalledWith("queen-id");
});

test("artist page keeps a centered empty-track state without borrowing album cover art for the avatar", async () => {
  getArtist.mockResolvedValue({
    id: "artist-without-tracks",
    name: "Quiet Artist",
    coverArt: "album-cover-only",
    album: [],
  });
  getArtistTracks.mockResolvedValue([]);

  render(
    <MemoryRouter initialEntries={["/artist/artist-without-tracks"]}>
      <Routes><Route path="/artist/:id" element={<Artist />} /></Routes>
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "Quiet Artist" })).toBeInTheDocument();
  expect(document.querySelector(".artist-page-cover img")).not.toBeInTheDocument();
  expect(document.querySelector(".artist-page-cover svg text")).toHaveTextContent("QA");
  expect(screen.getByText("No tracks yet.").closest(".artist-tracks-empty")).toBeInTheDocument();
  expect(screen.getByText("0 albums · 0 songs in library")).toBeInTheDocument();
});

test("artist page shows a Wikipedia About section without waiting for catalog enrichment", async () => {
  getArtist.mockResolvedValue({ id: "michael-id", name: "Michael Jackson", album: [] });
  getArtistTracks.mockResolvedValue([{ id: "local-song", artistId: "michael-id", title: "Local Song", artist: "Michael Jackson" }]);
  getWikipediaBiography.mockResolvedValue({
    text: "Michael Jackson was an American singer and songwriter.",
    source: "wikipedia", url: "https://en.wikipedia.org/wiki/Michael_Jackson",
  });
  render(
    <MemoryRouter initialEntries={["/artist/michael-id"]}>
      <Routes><Route path="/artist/:id" element={<Artist />} /></Routes>
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "About Michael Jackson" })).toBeInTheDocument();
  expect(await screen.findByText("Michael Jackson was an American singer and songwriter.")).toBeInTheDocument();
  expect(getTrackArtistBiography).toHaveBeenCalledWith("local-song");
  expect(getWikipediaBiography).toHaveBeenCalledWith("michael-id", "Michael Jackson");
  expect(screen.getByRole("link", { name: "Source: Wikipedia" })).toHaveAttribute("href", "https://en.wikipedia.org/wiki/Michael_Jackson");
});

test("artist page shows keyless catalog albums and popular tracks without inflating library counts", async () => {
  getArtistPortrait.mockResolvedValue("/api/artwork/external/portrait-token");
  getArtistOverview.mockResolvedValue({
    artist: {
      id: "queen-id", name: "Queen", imageUrl: "/api/artwork/external/portrait-token",
      album: [
        { id: "local-album", name: "Local Album", artistId: "queen-id", coverArt: "local-cover" },
        { id: "external_deezer_album_42", name: "Another Queen Album", artistId: "queen-id", coverArt: "external-cover", source: { kind: "external", count: 0 } },
      ],
    },
    tracks: [{ id: "local-track", title: "Local Song", artistId: "queen-id", artist: "Queen" }],
    topTracks: [
      { id: "external_deezer_track_43", title: "Popular Queen Song", artistId: "queen-id", artist: "Queen", source: { kind: "external", count: 0 } },
      { id: "local-track", title: "Local Song", artistId: "queen-id", artist: "Queen", source: { kind: "library", count: 1 },
        metadata: { audioMetadata: { codec: "flac" } } },
    ],
    localAlbumCount: 1,
    localSongCount: 1,
  });

  render(
    <MemoryRouter initialEntries={["/artist/queen-id"]}>
      <Routes><Route path="/artist/:id" element={<Artist />} /></Routes>
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "Queen" })).toBeInTheDocument();
  await waitFor(() => expect(document.querySelector(".artist-page-cover img"))
    .toHaveAttribute("src", "/api/artwork/external/portrait-token"));
  expect(screen.getByText("1 album · 1 song in library")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Another Queen Album/ })).toHaveAttribute("href", "/artist/queen-id/album/external_deezer_album_42");
  expect(screen.getByText("Not downloaded")).toBeInTheDocument();
  expect(getCoverUrl).toHaveBeenCalledWith("local-cover", 300);
  expect(getCoverUrl).toHaveBeenCalledWith("external-cover", 300);
  const rows = within(screen.getByRole("table", { name: "Artist tracks" })).getAllByRole("row");
  expect(rows[1]).toHaveAttribute("aria-label", "Popular Queen Song by Queen");
  expect(rows[2]).toHaveAttribute("aria-label", "Local Song by Queen");
  expect(within(rows[1]).queryByLabelText("In your library")).not.toBeInTheDocument();
  expect(within(rows[2]).queryByLabelText("In your library")).not.toBeInTheDocument();
  expect(within(rows[2]).getByText("FLAC")).toBeInTheDocument();
});

test("artist page shows local music before slower external enrichment finishes", async () => {
  let finishEnrichment;
  const enriched = new Promise((resolve) => { finishEnrichment = resolve; });
  const local = {
    artist: { id: "queen-id", name: "Queen", album: [
      { id: "local-album", name: "Local Album", artistId: "queen-id" },
    ] },
    tracks: [{ id: "local-track", title: "Local Song", artistId: "queen-id", artist: "Queen" }],
    topTracks: [{ id: "local-track", title: "Local Song", artistId: "queen-id", artist: "Queen" }],
    localAlbumCount: 1,
    localSongCount: 1,
    externalEnrichmentAvailable: true,
  };
  getArtistOverview.mockResolvedValue(local);
  getArtistDiscography.mockReturnValue(enriched);

  render(
    <MemoryRouter initialEntries={["/artist/queen-id"]}>
      <Routes><Route path="/artist/:id" element={<Artist />} /></Routes>
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "Queen" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Local Album/ })).toBeInTheDocument();
  expect(screen.getByText("1 album · 1 song in library")).toBeInTheDocument();
  expect((await screen.findByText("Finding more releases…")).closest('[role="status"]')).toBeInTheDocument();
  expect(screen.queryByText("External Album")).not.toBeInTheDocument();
  expect(getArtistOverview).toHaveBeenCalledWith("queen-id", { scope: "local" });

  await act(async () => {
    finishEnrichment({
      missingAlbums: [
        { id: "external_deezer_album_42", name: "External Album", artistId: "queen-id", discographySource: "external", source: { kind: "external", count: 0 } },
      ],
      missingTracks: [],
    });
  });

  expect(await screen.findByRole("link", { name: /External Album/ })).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText("Finding more releases…")).not.toBeInTheDocument());
  expect(screen.getByText("1 album · 1 song in library")).toBeInTheDocument();
});

test("renders personalized Explore songs alongside Deezer charts", async () => {
  getExplore.mockResolvedValue({ albums: [], artists: [], songs: [], degraded: false });
  getPersonalizedDiscovery.mockResolvedValue({
      tracks: [{
        id: "external_deezer_track_1",
        type: "track",
        title: "Recommended Song",
        artist: "Artist One",
        coverArt: "art-1",
        external: true,
        previewUrl: "https://cdns-preview-a.dzcdn.net/recommended.mp3",
        metadata: { recommendationReason: "Because you listen to Artist One" },
      }],
    artists: [], albums: [], personalized: true,
    degraded: false,
  });

  render(
    <MemoryRouter>
      <Explore />
    </MemoryRouter>
  );

  const headings = [
    "Trending Now / Featured",
    "Artists Popular Externally",
    "Albums Popular Externally",
    "Discover Songs",
    "Songs Popular Externally",
    "Discover Artists",
    "Discover Albums",
    "Browse by Genre & Mood",
  ];
  expect(await screen.findByRole("button", { name: "Play Recommended Song" })).toBeInTheDocument();
  expect([...document.querySelectorAll(".explore-page section h2")].map((heading) => heading.textContent)).toEqual(headings);
  const artists = screen.getByRole("heading", { name: "Artists Popular Externally" }).closest("section");
  expect(within(artists).getByRole("link", { name: "Chart Artist" })).toBeInTheDocument();
  expect(artists.querySelector(".artist-avatar-fallback text")).toHaveTextContent("CA");
  // External chart artists supply their own photo, which fades in over the initials.
  await waitFor(() => expect(artists.querySelector("img.artist-avatar-photo")).toHaveAttribute("src", chartArtistArtwork));
  const albums = screen.getByRole("heading", { name: "Albums Popular Externally" }).closest("section");
  expect(albums.querySelector("img")).toHaveAttribute("src", chartArtwork);
  expect(screen.getByRole("button", { name: "Play Chart Song" })).toBeInTheDocument();
  expect(screen.getByText("3:29")).toBeInTheDocument();
  expect(getExternalCharts).toHaveBeenCalledTimes(1);
});

test("hydrates missing Explore chart previews after rendering the initial rows", async () => {
  let finishHydration;
  const tracks = [chartData.tracks[0]];
  getExternalCharts.mockResolvedValue({ ...chartData, tracks });
  hydrateExternalPreviews.mockImplementation(() => new Promise((resolve) => { finishHydration = resolve; }));

  render(<MemoryRouter><Explore /></MemoryRouter>);

  expect(await screen.findByRole("button", { name: "Play Chart Song" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download Chart Song with spotDL" })).toBeInTheDocument();
  expect(hydrateExternalPreviews).toHaveBeenCalledWith([expect.objectContaining({
    id: tracks[0].id,
    title: "Chart Song",
    artist: "Chart Artist",
  })]);
  await act(async () => {
    finishHydration([{ id: tracks[0].id, previewUrl: "https://cdns-preview-a.dzcdn.net/hydrated-song.mp3" }]);
  });
  fireEvent.click(screen.getByRole("button", { name: "Play Chart Song" }));
  await waitFor(() => expect(playSong).toHaveBeenCalledWith(expect.objectContaining({
    previewUrl: "https://cdns-preview-a.dzcdn.net/hydrated-song.mp3",
  })));
});

test("renders Explore discovery using neutral results", async () => {
  getPersonalizedDiscovery.mockResolvedValue({
    albums: [{
      id: "external_itunes_album_10",
      title: "External Album",
      artist: "External Artist",
      coverArt: "extart_album",
      source: { kind: "external", count: 0 },
    }],
    artists: [{
      id: "external_itunes_artist_20",
      title: "External Artist",
      coverArt: null,
      source: { kind: "external", count: 0 },
    }],
    tracks: [{
      id: "external_itunes_30",
      title: "External Song",
      artist: "External Artist",
      coverArt: "extart_track",
      source: { kind: "external", count: 0 },
      metadata: {},
    }],
    degraded: false,
  });

  render(
    <MemoryRouter>
      <Explore />
    </MemoryRouter>
  );

  const albumSection = screen.getByRole("heading", { name: "Discover Albums" }).closest("section");
  const artistSection = screen.getByRole("heading", { name: "Discover Artists" }).closest("section");
  await waitFor(() => {
    expect(albumSection?.querySelector('a[href="/album/external_itunes_album_10"]')).not.toBeNull();
    expect(artistSection?.querySelector('a[href="/artist/ext%3Aitunes%3A20"]')).not.toBeNull();
  });
});

test("previews a Deezer featured album through its detail route without requiring a local copy", async () => {
  getExplore.mockResolvedValue({ albums: [], artists: [], songs: [], degraded: false });
  getRecommendations.mockResolvedValue({ sections: [], degraded: false });
  searchNavidrome.mockResolvedValue({
    results: { album: [{ id: "catalog-chart-album", title: "Chart Album", artist: "Chart Artist" }] },
  });
  const stale = "https://cdns-preview-a.dzcdn.net/stale.mp3";
  canStreamPreview.mockImplementation(async url => Boolean(url && url !== stale));
  getAlbum.mockResolvedValue({ song: [
    { id: "stale-track", external: true, previewUrl: stale },
    { id: "resolved-track", external: true, previewUrl: "https://cdns-preview-a.dzcdn.net/album.mp3" },
  ] });
  setMediaFavorite.mockResolvedValue({ ok: true });

  render(<MemoryRouter><Explore /></MemoryRouter>);
  const featured = (await screen.findByRole("heading", { name: "Chart Album" })).closest("article");
  fireEvent.click(within(featured).getByRole("button", { name: /play/i }));
  await waitFor(() => expect(playQueue).toHaveBeenCalledWith([expect.objectContaining({ id: "resolved-track" })], 0,
    expect.objectContaining({ type: "album", id: "external_deezer_album_201", name: "Chart Album" })));
  expect(getAlbum).toHaveBeenCalledWith("external_deezer_album_201");
  expect(searchNavidrome).not.toHaveBeenCalled();

  expect(within(featured).getByRole("link", { name: "View album" })).toHaveAttribute("href", "/album/external_deezer_album_201");
  expect(screen.queryByRole("button", { name: /Save for later|Save to Library|Add to Library/i })).not.toBeInTheDocument();
  expect(setMediaFavorite).not.toHaveBeenCalled();
});

test("falls back to iTunes when a Deezer chart track has no playable preview", async () => {
  const fallback = "https://audio-ssl.itunes.apple.com/chart-song.m4a";
  findItunesPreview.mockResolvedValue(fallback);
  render(<MemoryRouter><Explore /></MemoryRouter>);

  fireEvent.click(await screen.findByRole("button", { name: "Play Chart Song" }));
  await waitFor(() => expect(playSong).toHaveBeenCalledWith(expect.objectContaining({
    title: "Chart Song", previewUrl: fallback, source: { kind: "external", count: 0 },
  })));
  expect(searchNavidrome).not.toHaveBeenCalled();
});

test("all Discover shelves use external favourites and adjacent picks instead of library recommendations", async () => {
  const source = { kind: "external", count: 0 };
  const track = { id: "external_deezer_track_901", title: "Fresh Favourite Song", artist: "Favourite Artist", external: true, source,
    previewUrl: "https://cdns-preview-a.dzcdn.net/fresh.mp3", discoveryGroup: "favourite", recommendationReason: "More from Favourite Artist" };
  getExplore.mockResolvedValue({ songs: [{ id: "owned-track", title: "Owned track" }], artists: [], albums: [] });
  getRecommendations.mockResolvedValue({ sections: [{ id: "discover", items: [{ id: "owned-track", title: "Owned track" }] }] });
  getPersonalizedDiscovery.mockResolvedValue({
    tracks: [track, { ...track, id: "external_deezer_track_902", title: "Adjacent Song", artist: "Adjacent Artist", discoveryGroup: "adjacent" }],
    artists: [{ id: "external_deezer_artist_91", name: "Favourite Artist", external: true, source,
      recommendationReason: "More from Favourite Artist" }, { id: "external_deezer_artist_92", name: "Adjacent Artist", external: true, source }],
    albums: [{ id: "external_deezer_album_91", title: "Fresh Favourite Album", artist: "Favourite Artist", external: true, source },
      { id: "external_deezer_album_92", title: "Adjacent Album", artist: "Adjacent Artist", external: true, source }],
    personalized: true, degraded: false,
  });
  render(<MemoryRouter><Explore /></MemoryRouter>);
  const songs = within(screen.getByRole("region", { name: "Discover Songs" }));
  fireEvent.click(await songs.findByRole("button", { name: /Play.*Fresh Favourite Song/ }));
  await waitFor(() => expect(playSong).toHaveBeenCalledWith(expect.objectContaining({ id: track.id, previewUrl: track.previewUrl, external: true })));
  expect(songs.getByText("Adjacent Song")).toBeInTheDocument();
  const artists = within(screen.getByRole("region", { name: "Discover Artists" }));
  expect(artists.getByText("New artists connected to your favourites")).toBeInTheDocument();
  expect(artists.getByRole("link", { name: "Favourite Artist" })).toHaveAttribute("href", "/artist/ext%3Adeezer%3A91");
  expect(artists.getByRole("link", { name: "Adjacent Artist" })).toHaveAttribute("href", "/artist/ext%3Adeezer%3A92");
  const albums = within(screen.getByRole("region", { name: "Discover Albums" }));
  expect(albums.getByRole("link", { name: "Open Fresh Favourite Album" })).toHaveAttribute("href", "/album/external_deezer_album_91");
  expect(albums.getByRole("link", { name: "Open Adjacent Album" })).toHaveAttribute("href", "/album/external_deezer_album_92");
  expect(screen.queryByText("Owned track")).not.toBeInTheDocument();
  expect(getExplore).not.toHaveBeenCalled();
  expect(getRecommendations).not.toHaveBeenCalled();
  expect(getPersonalizedDiscovery).toHaveBeenCalledTimes(1);
});

test("charts render while personalised discovery loads and a discovery failure never falls back to owned music", async () => {
  let rejectDiscovery;
  getPersonalizedDiscovery.mockImplementation(() => new Promise((_resolve, reject) => { rejectDiscovery = reject; }));
  getExplore.mockResolvedValue({ songs: [{ id: "owned", title: "Owned fallback" }], artists: [], albums: [] });
  render(<MemoryRouter><Explore /></MemoryRouter>);
  expect(await screen.findByRole("button", { name: "Play Chart Song" })).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Discover Songs" })).getByLabelText("Loading section")).toBeInTheDocument();
  await act(async () => rejectDiscovery(new Error("Discovery unavailable")));
  expect(within(screen.getByRole("region", { name: "Discover Songs" })).getByRole("status")).toHaveTextContent("Discovery unavailable");
  expect(screen.queryByText("Owned fallback")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Play Chart Song" })).toBeInTheDocument();
});

test("missing albums preview their first available song without searching the library", async () => {
  getPersonalizedDiscovery.mockResolvedValue({ tracks: [], artists: [], albums: [
    { id: "external_deezer_album_777", title: "Missing Album", artist: "Artist", external: true }], personalized: true });
  const preview = { id: "preview", previewUrl: "https://cdns-preview-a.dzcdn.net/album-preview.mp3" };
  getAlbum.mockResolvedValue({ name: "Missing Album", song: [{ id: "no-preview" }, preview] });
  render(<MemoryRouter><Explore /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "Play Missing Album" }));
  await waitFor(() => expect(playQueue).toHaveBeenCalledWith([expect.objectContaining({ ...preview, source: { kind: "external", count: 0 } })], 0,
    expect.objectContaining({ type: "album", id: "external_deezer_album_777" })));
  expect(searchNavidrome).not.toHaveBeenCalled();
});
