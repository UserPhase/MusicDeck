import { artistOverviewQueryClient, fetchArtistOverview } from "./artistOverviewQuery";
import { getArtistOverview } from "./musicdeck";

jest.mock("./musicdeck", () => ({ getArtistOverview: jest.fn() }));

beforeEach(() => {
  artistOverviewQueryClient.clear();
  getArtistOverview.mockReset();
});

test("coalesces concurrent artist requests and reuses the result on navigation", async () => {
  const overview = { artist: { id: "artist-1" } };
  getArtistOverview.mockResolvedValue(overview);
  const [first, second] = await Promise.all([
    fetchArtistOverview("artist-1", "local", "user-1"),
    fetchArtistOverview("artist-1", "local", "user-1"),
  ]);
  expect(first).toBe(overview);
  expect(second).toBe(overview);
  expect(await fetchArtistOverview("artist-1", "local", "user-1")).toBe(overview);
  expect(getArtistOverview).toHaveBeenCalledTimes(1);
  await fetchArtistOverview("artist-1", "local", "user-2");
  expect(getArtistOverview).toHaveBeenCalledTimes(2);
});
