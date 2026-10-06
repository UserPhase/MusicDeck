import { expect, test, vi } from "vitest";
import { AlbumArtworkService } from "../src/services/media/albumService.js";

test("rejects an opaque local default before returning genuine external child artwork", async () => {
  const validate = vi.fn(async () => false);
  const lookup = vi.fn(async () => null);
  const service = new AlbumArtworkService(validate, lookup, vi.fn());
  const result = await service.resolve({
    name: "Demos", artistName: "Dominic Fike", artworkId: "mdart_default", artworkUrl: "/api/artwork/mdart_default",
  }, [{ artworkId: "al-0" }, { artwork: { id: "deezer", url: "https://cdn.test/real.jpg" } }]);
  expect(result.coverUrl).toBe("https://cdn.test/real.jpg");
  expect(result.unavailableArtworkIds).toEqual(["mdart_default"]);
  expect(lookup).not.toHaveBeenCalled();
});

test("hydrates matching external metadata only when every local candidate is missing", async () => {
  const lookup = vi.fn(async () => "https://cdn.test/real.jpg");
  const service = new AlbumArtworkService(async () => false, lookup, vi.fn());
  const result = await service.resolve({ name: "Demos", artistName: "Dominic Fike", artworkId: "al-0" }, []);
  expect(lookup).toHaveBeenCalledWith("Dominic Fike", "Demos");
  expect(result.coverUrl).toBe("/api/metadata/album-artwork?artist=Dominic+Fike&album=Demos");
  expect(result.artworkId).toBeNull();
});

test("genuine root artwork wins and repeated validations are coalesced and cached", async () => {
  const validate = vi.fn(async () => true);
  const lookup = vi.fn(async () => null);
  const service = new AlbumArtworkService(validate, lookup, vi.fn());
  const album = { artworkId: "mdart_real", artworkUrl: "/api/artwork/mdart_real" };
  const results = await Promise.all([service.resolve(album, []), service.resolve(album, [])]);
  expect(results[0].coverUrl).toBe(album.artworkUrl);
  await service.resolve(album, []);
  expect(validate).toHaveBeenCalledTimes(1);
  expect(lookup).not.toHaveBeenCalled();
});

test("validation errors are reported without hiding the album or being cached as misses", async () => {
  const validate = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(false);
  const reportFailure = vi.fn();
  const service = new AlbumArtworkService(validate, async () => null, reportFailure);
  const album = { name: "Demos", artistName: "Artist", artworkId: "mdart_bad" };
  expect(await service.resolve(album, [])).toMatchObject({ name: "Demos", artworkResolutionFailed: true, coverUrl: null });
  expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "offline" }));
  expect((await service.resolve(album, [])).coverUrl).toBeNull();
  expect(validate).toHaveBeenCalledTimes(2);
});

test("preflight validation is limited to five concurrent requests across album loads", async () => {
  let active = 0;
  let maximum = 0;
  const service = new AlbumArtworkService(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return true;
  }, async () => null, vi.fn());
  await Promise.all(Array.from({ length: 12 }, (_, index) => service.resolve({ artworkId: `cover-${index}` }, [])));
  expect(maximum).toBe(5);
  expect(active).toBe(0);
});

test("external metadata outages are explicitly reported without discarding album data", async () => {
  const report = vi.fn();
  const lookup = vi.fn(async () => { throw new Error("iTunes unavailable"); });
  const service = new AlbumArtworkService(async () => false, lookup, report);
  const result = await service.resolve({ name: "Demos", artistName: "Artist", artworkId: "al-0" }, []);
  expect(result).toMatchObject({ name: "Demos", coverUrl: null, artworkResolutionFailed: true });
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "iTunes unavailable" }));
});

test("cached Spotify import artwork hydrates missing covers without a network metadata lookup", async () => {
  const lookup = vi.fn(async () => null);
  const imported = { find: vi.fn(() => "https://i.scdn.co/image/importcover") };
  const service = new AlbumArtworkService(async () => false, lookup, vi.fn(), imported);
  const result = await service.resolve({
    name: "Don't Forget About Me, Demos", artistName: "Dominic Fike", artworkId: "al-0",
  }, [{ artworkId: "al-0" }]);
  expect(result.coverUrl).toBe("https://i.scdn.co/image/importcover");
  expect(imported.find).toHaveBeenCalledWith("Dominic Fike", "Don't Forget About Me, Demos");
  expect(lookup).not.toHaveBeenCalled();
});

test("genuine local artwork retains priority over cached Spotify artwork", async () => {
  const imported = { find: vi.fn(() => "https://i.scdn.co/image/importcover") };
  const service = new AlbumArtworkService(async () => true, async () => null, vi.fn(), imported);
  const result = await service.resolve({ name: "Album", artistName: "Artist", artworkId: "mdart_real" }, []);
  expect(result.coverUrl).toBe("/api/artwork/mdart_real");
  expect(imported.find).not.toHaveBeenCalled();
});
