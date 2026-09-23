import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  getArtistTracks,
  getTrackArtistBiography,
  getCoverUrl,
  getExternalCharts,
  getExplore,
  getRecommendations,
  searchNavidrome,
  setMediaFavorite,
} from "../api/musicdeck";
import { usePlayer } from "../context/PlayerContext";
import { getWikipediaBiography } from "../services/biographyFallback";

jest.mock("../api/musicdeck", () => ({
  getAlbum: jest.fn(),
  getAlbums: jest.fn(async () => []),
  getArtist: jest.fn(),
  getArtistPortrait: jest.fn(async () => null),
  getMusicBrainzArtistPortrait: jest.fn(async () => null),
  getArtistOverview: jest.fn(),
  getArtistTracks: jest.fn(async () => []),
  getTrackArtistBiography: jest.fn(async () => null),
  getCoverUrl: jest.fn((id) => (id ? typeof id === "object" ? id.url : `/artwork/${id}` : null)),
  getExternalCharts: jest.fn(),
  getExplore: jest.fn(),
  getRecommendations: jest.fn(async () => ({ sections: [], degraded: false })),
  searchNavidrome: jest.fn(),
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
  getCoverUrl.mockImplementation((id) => (id ? typeof id === "object" ? id.url : `/artwork/${id}` : null));
  getAlbums.mockResolvedValue([]);
  getArtistTracks.mockResolvedValue([]);
  getArtistPortrait.mockResolvedValue(null);
  getMusicBrainzArtistPortrait.mockResolvedValue(null);
  getTrackArtistBiography.mockResolvedValue(null);
  getWikipediaBiography.mockResolvedValue(null);
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
  getRecommendations.mockResolvedValue({ sections: [], degraded: false });
  usePlayer.mockReturnValue({
    playSong,
    playQueue,
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
    "/album/external_itunes_album_10"
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
  expect(getCoverUrl).toHaveBeenCalledWith("artwork-legacy-1");
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
      { id: "local-track", title: "Local Song", artistId: "queen-id", artist: "Queen" },
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
  expect(screen.getByRole("link", { name: /Another Queen Album/ })).toHaveAttribute("href", "/album/external_deezer_album_42");
  expect(screen.getByText("Not downloaded")).toBeInTheDocument();
  expect(getCoverUrl).toHaveBeenCalledWith("local-cover", 300);
  expect(getCoverUrl).toHaveBeenCalledWith("external-cover", 300);
  const rows = within(screen.getByRole("table", { name: "Artist tracks" })).getAllByRole("row");
  expect(rows[1]).toHaveAttribute("aria-label", "Popular Queen Song by Queen");
  expect(rows[2]).toHaveAttribute("aria-label", "Local Song by Queen");
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
  getArtistOverview.mockImplementation((artistId, options) =>
    options?.scope === "local" ? Promise.resolve(local) : enriched
  );

  render(
    <MemoryRouter initialEntries={["/artist/queen-id"]}>
      <Routes><Route path="/artist/:id" element={<Artist />} /></Routes>
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "Queen" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Local Album/ })).toBeInTheDocument();
  expect(screen.getByText("1 album · 1 song in library")).toBeInTheDocument();
  expect(screen.getByText("Finding more releases…").closest('[role="status"]')).toBeInTheDocument();
  expect(screen.queryByText("External Album")).not.toBeInTheDocument();
  expect(getArtistOverview).toHaveBeenCalledWith("queen-id", { scope: "local" });

  await act(async () => {
    finishEnrichment({
      ...local,
      artist: { ...local.artist, album: [
        ...local.artist.album,
        { id: "external_deezer_album_42", name: "External Album", artistId: "queen-id", source: { kind: "external", count: 0 } },
      ] },
      externalEnrichmentAvailable: false,
    });
  });

  expect(screen.getByRole("link", { name: /External Album/ })).toBeInTheDocument();
  expect(screen.queryByText("Finding more releases…")).not.toBeInTheDocument();
  expect(screen.getByText("1 album · 1 song in library")).toBeInTheDocument();
});

test("renders personalized Explore songs alongside Deezer charts", async () => {
  getExplore.mockResolvedValue({ albums: [], artists: [], songs: [], degraded: false });
  getRecommendations.mockResolvedValue({
    sections: [{
      id: "discover",
      title: "Discover something new",
      items: [{
        id: "md_track_1",
        type: "track",
        title: "Recommended Song",
        artist: "Artist One",
        coverArt: "art-1",
        metadata: { recommendationReason: "Because you listen to Artist One" },
      }],
    }],
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
  expect(artists.querySelector("img")).not.toBeInTheDocument();
  expect(artists.querySelector(".artist-avatar-fallback text")).toHaveTextContent("CA");
  const albums = screen.getByRole("heading", { name: "Albums Popular Externally" }).closest("section");
  expect(albums.querySelector("img")).toHaveAttribute("src", chartArtwork);
  expect(screen.getByRole("button", { name: "Play Chart Song" })).toBeInTheDocument();
  expect(screen.getByText("3:29")).toBeInTheDocument();
  expect(getExternalCharts).toHaveBeenCalledTimes(1);
});

test("renders Explore discovery using neutral results", async () => {
  getExplore.mockResolvedValue({
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
    songs: [{
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
    expect(artistSection?.querySelector('a[href="/artist/external_itunes_artist_20"]')).not.toBeNull();
  });
});

test("resolves a Deezer featured album locally before playing or saving it", async () => {
  getExplore.mockResolvedValue({ albums: [], artists: [], songs: [], degraded: false });
  getRecommendations.mockResolvedValue({ sections: [], degraded: false });
  searchNavidrome.mockResolvedValue({
    results: { album: [{ id: "catalog-chart-album", title: "Chart Album", artist: "Chart Artist" }] },
  });
  getAlbum.mockResolvedValue({ song: [{ id: "resolved-track" }] });
  setMediaFavorite.mockResolvedValue({ ok: true });

  render(<MemoryRouter><Explore /></MemoryRouter>);
  const featured = (await screen.findByRole("heading", { name: "Chart Album" })).closest("article");
  fireEvent.click(within(featured).getByRole("button", { name: /play/i }));
  await waitFor(() => expect(playQueue).toHaveBeenCalledWith([{ id: "resolved-track" }], 0));
  expect(searchNavidrome).toHaveBeenCalledWith("Chart Album", { mode: "library" });

  fireEvent.click(within(featured).getByRole("button", { name: "Save to Library" }));
  await waitFor(() => expect(setMediaFavorite).toHaveBeenCalledWith("album", "catalog-chart-album", true));
});

test("shows a local availability message when a Deezer track cannot be matched", async () => {
  getExplore.mockResolvedValue({ albums: [], artists: [], songs: [], degraded: false });
  searchNavidrome.mockResolvedValue({ results: { track: [] } });
  render(<MemoryRouter><Explore /></MemoryRouter>);

  fireEvent.click(await screen.findByRole("button", { name: "Play Chart Song" }));
  expect(await screen.findByRole("status")).toHaveTextContent("not available in your local library");
  expect(playSong).not.toHaveBeenCalled();
});
