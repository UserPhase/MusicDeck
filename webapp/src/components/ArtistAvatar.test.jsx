import { act, fireEvent, render, waitFor } from "@testing-library/react";
import ArtistAvatar, { artistInitials } from "./ArtistAvatar";
import { getArtistPortrait, getCoverUrl, getMusicBrainzArtistPortrait } from "../api/musicdeck";

jest.mock("../api/musicdeck", () => ({
  getArtistPortrait: jest.fn(),
  getMusicBrainzArtistPortrait: jest.fn(),
  getCoverUrl: jest.fn((art) => typeof art === "string" && art.startsWith("extart_")
    ? `/api/artwork/external/${art}` : art),
}));

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  getArtistPortrait.mockResolvedValue(null);
  getMusicBrainzArtistPortrait.mockResolvedValue(null);
  getCoverUrl.mockImplementation((art) => typeof art === "string" && art.startsWith("extart_")
    ? `/api/artwork/external/${art}` : art);
});

test("uses deterministic initials without ever loading album coverArt", async () => {
  const artist = { id: "local-queen", name: "Queen", coverArt: "album-art-only" };
  const { container } = render(<ArtistAvatar artist={artist} />);
  expect(container.querySelector("svg text")).toHaveTextContent("Q");
  expect(container.querySelector("img")).not.toBeInTheDocument();
  await waitFor(() => expect(getArtistPortrait).toHaveBeenCalledWith("local-queen", {}));
  expect(container.querySelector("img")).not.toBeInTheDocument();
  expect(artistInitials("A$AP Rocky")).toBe("AR");
});

test("cross-fades only a verified portrait after the fallback appears", async () => {
  let complete;
  getArtistPortrait.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  const { container } = render(<ArtistAvatar artist={{ id: "local-gems", name: "GEMS", coverArt: "wrong-cover" }} />);
  expect(container.querySelector("svg text")).toHaveTextContent("G");
  expect(container.querySelector("img")).not.toBeInTheDocument();
  complete("/api/artwork/external/verified");
  const photo = await waitFor(() => {
    const image = container.querySelector("img");
    expect(image).toHaveAttribute("src", "/api/artwork/external/verified");
    return image;
  });
  expect(photo).not.toHaveClass("is-loaded");
  fireEvent.load(photo);
  expect(photo).toHaveClass("is-loaded");
});

test("uses artwork supplied by an external artist entity without querying a local ID", async () => {
  const { container } = render(<ArtistAvatar artist={{ id: "deezer_artist_7", name: "Queen", external: true,
    coverArt: "extart_artist_7" }} />);
  expect(getCoverUrl).toHaveBeenCalledWith("extart_artist_7", 500);
  expect(getCoverUrl.mock.results.at(-1).value).toBe("/api/artwork/external/extart_artist_7");
  await waitFor(() => expect(container.querySelector("img"))
    .toHaveAttribute("src", "/api/artwork/external/extart_artist_7"));
  fireEvent.error(container.querySelector("img"));
  expect(container.querySelector("img")).not.toBeInTheDocument();
  expect(container.querySelector("svg text")).toHaveTextContent("Q");
  expect(getArtistPortrait).not.toHaveBeenCalled();
});

test("caches a successfully loaded portrait by artist ID for the next mount", async () => {
  getArtistPortrait.mockResolvedValue({ url: "/api/artwork/external/verified", source: "deezer", kind: "artist" });
  const artist = { id: "local-queen", name: "Queen" };
  const first = render(<ArtistAvatar artist={artist} />);
  const image = await waitFor(() => {
    const element = first.container.querySelector("img");
    expect(element).toHaveAttribute("src", "/api/artwork/external/verified");
    return element;
  });
  fireEvent.load(image);
  expect(JSON.parse(localStorage.getItem("artist_avatar:local-queen")).portrait.source).toBe("deezer");
  first.unmount();

  const second = render(<ArtistAvatar artist={artist} />);
  expect(second.container.querySelector("img")).toHaveAttribute("src", "/api/artwork/external/verified");
  expect(getArtistPortrait).toHaveBeenCalledTimes(1);
});

test("retries the next source on image errors and keeps initials visible after all failures", async () => {
  getArtistPortrait.mockImplementation(async (_artistId, options) => {
    if (options.skipDeezer) return null;
    if (options.skipNative) return { url: "/api/artwork/external/deezer", source: "deezer", kind: "artist" };
    return { url: "https://images.example.test/artists/queen.jpg", source: "native", kind: "artist" };
  });
  const { container } = render(<ArtistAvatar artist={{ id: "local-queen", name: "Queen" }} />);
  const native = await waitFor(() => {
    const image = container.querySelector("img");
    expect(image).toHaveAttribute("src", "https://images.example.test/artists/queen.jpg");
    return image;
  });
  fireEvent.error(native);
  const deezer = await waitFor(() => {
    const image = container.querySelector("img");
    expect(image).toHaveAttribute("src", "/api/artwork/external/deezer");
    return image;
  });
  fireEvent.error(deezer);
  await waitFor(() => expect(getArtistPortrait).toHaveBeenCalledWith("local-queen",
    { skipNative: true, skipDeezer: true }));
  expect(container.querySelector("img")).not.toBeInTheDocument();
  expect(container.querySelector("svg text")).toHaveTextContent("Q");
});

test("uses iTunes album artwork only when the avatar is explicitly an artist tile", async () => {
  getArtistPortrait.mockResolvedValue({ url: "/api/artwork/external/itunes", source: "itunes",
    kind: "artist-tile-fallback" });
  const artist = { id: "local-queen", name: "Queen" };
  const header = render(<ArtistAvatar artist={artist} />);
  await waitFor(() => expect(getArtistPortrait).toHaveBeenCalled());
  expect(header.container.querySelector("img")).not.toBeInTheDocument();
  header.unmount();

  const tile = render(<ArtistAvatar artist={artist} allowAlbumTileFallback />);
  await waitFor(() => expect(tile.container.querySelector("img"))
    .toHaveAttribute("src", "/api/artwork/external/itunes"));
});

test("loads MusicBrainz only after the fast lookup misses, preloads it, then fades over initials", async () => {
  const originalImage = global.Image;
  const preloads = [];
  global.Image = class {
    set src(value) { this.url = value; preloads.push(this); }
  };
  try {
    let finishFast;
    getArtistPortrait.mockReturnValue(new Promise((resolve) => { finishFast = resolve; }));
    getMusicBrainzArtistPortrait.mockResolvedValue({
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Queen.jpg/500px-Queen.jpg",
      source: "musicbrainz", kind: "artist",
    });
    const { container } = render(<ArtistAvatar artist={{ id: "local-queen", name: "Queen" }}
      enableMusicBrainzFallback />);
    expect(container.querySelector("svg text")).toHaveTextContent("Q");
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(getMusicBrainzArtistPortrait).not.toHaveBeenCalled();
    await act(async () => { finishFast(null); });
    await waitFor(() => expect(preloads).toHaveLength(1));
    expect(container.querySelector("img")).not.toBeInTheDocument();
    act(() => { preloads[0].onload(); });
    const photo = container.querySelector("img");
    expect(photo).toHaveAttribute("src", preloads[0].url);
    expect(photo).not.toHaveClass("is-loaded");
    fireEvent.load(photo);
    expect(photo).toHaveClass("is-loaded");
    expect(JSON.parse(localStorage.getItem("artist_avatar_mb:local-queen")).url).toBe(preloads[0].url);
  } finally { global.Image = originalImage; }
});

test("uses a persisted MusicBrainz portrait on the first render without another lookup", () => {
  const url = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Queen.jpg";
  localStorage.setItem("artist_avatar_mb:local-queen", JSON.stringify({ name: "Queen", url }));
  const { container } = render(<ArtistAvatar artist={{ id: "local-queen", name: "Queen" }}
    enableMusicBrainzFallback />);
  expect(container.querySelector("img")).toHaveAttribute("src", url);
  expect(getArtistPortrait).not.toHaveBeenCalled();
  expect(getMusicBrainzArtistPortrait).not.toHaveBeenCalled();
});

test("does not start MusicBrainz when a fast artist portrait is available", async () => {
  getArtistPortrait.mockResolvedValue({ url: "https://images.example.test/artists/queen.jpg",
    source: "native", kind: "artist" });
  const { container } = render(<ArtistAvatar artist={{ id: "local-queen", name: "Queen" }}
    enableMusicBrainzFallback />);
  await waitFor(() => expect(container.querySelector("img"))
    .toHaveAttribute("src", "https://images.example.test/artists/queen.jpg"));
  expect(getMusicBrainzArtistPortrait).not.toHaveBeenCalled();
});
