import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ArtistFollowButton from "./ArtistFollowButton";
import { followArtist, unfollowArtist, getArtistFollows, followsChanged } from "../api/artistFollows";
let mockOwner = "alice";
jest.mock("../context/AuthContext", () => ({ useAuth: () => ({ session: { id: mockOwner } }) }));
jest.mock("../context/PrivacyContext", () => ({ usePrivacy: () => ({ canMetadata: true }) }));
jest.mock("../api/artistFollows", () => ({ followArtist: jest.fn(), unfollowArtist: jest.fn(), getArtistFollows: jest.fn(), followsChanged: jest.fn() }));
const artist = { key: "key", artistId: "external_deezer_artist_17", artistName: "Night Pilot", provider: "deezer" };
beforeEach(() => { jest.clearAllMocks(); mockOwner = "alice"; (getArtistFollows as jest.Mock).mockResolvedValue({ artists: [] });
  (followArtist as jest.Mock).mockResolvedValue({ artist }); (unfollowArtist as jest.Mock).mockResolvedValue(null); });
test("follows and unfollows the provider identity with the signed-in account", async () => {
  render(<ArtistFollowButton artistId={artist.artistId} artistName={artist.artistName} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Follow artist" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Follow artist" }));
  expect(await screen.findByRole("button", { name: "Following" })).toHaveAttribute("aria-pressed", "true");
  expect(followArtist).toHaveBeenCalledWith("alice", artist.artistId, artist.artistName, "deezer", expect.any(AbortSignal));
  fireEvent.click(screen.getByRole("button", { name: "Following" }));
  await screen.findByRole("button", { name: "Follow artist" }); expect(unfollowArtist).toHaveBeenCalledWith("alice", "key", expect.any(AbortSignal));
});
test("failed follow gives a retry without showing false success", async () => {
  (followArtist as jest.Mock).mockRejectedValueOnce(new Error("Metadata unavailable"));
  render(<ArtistFollowButton artistId={artist.artistId} artistName={artist.artistName} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Follow artist" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Follow artist" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Metadata unavailable");
  expect(screen.queryByRole("button", { name: "Following" })).not.toBeInTheDocument();
});
test("refreshing listeners after a successful follow does not leave the mutation button stuck", async () => {
  (followsChanged as jest.Mock).mockImplementation(() => window.dispatchEvent(new Event("musicdeck:artist-follows-changed")));
  render(<ArtistFollowButton artistId={artist.artistId} artistName={artist.artistName} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Follow artist" })).toBeEnabled());
  (getArtistFollows as jest.Mock).mockResolvedValue({ artists: [artist] });
  fireEvent.click(screen.getByRole("button", { name: "Follow artist" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Following" })).toBeEnabled());
  expect(screen.queryByRole("button", { name: "Updating…" })).not.toBeInTheDocument();
});
test("account switch cancels and discards the prior account's follow lookup", async () => {
  let resolve!: (value: unknown) => void;
  (getArtistFollows as jest.Mock).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<ArtistFollowButton artistId={artist.artistId} artistName={artist.artistName} />);
  const signal = (getArtistFollows as jest.Mock).mock.calls[0][0]; mockOwner = "bob";
  view.rerender(<ArtistFollowButton artistId={artist.artistId} artistName={artist.artistName} />);
  await act(async () => { resolve({ artists: [artist] }); });
  expect(signal.aborted).toBe(true); expect(screen.queryByRole("button", { name: "Following" })).not.toBeInTheDocument();
});
