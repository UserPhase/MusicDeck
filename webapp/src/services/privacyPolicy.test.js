import { setBrowserPrivacy } from "./privacyPolicy";
import { findItunesPreview } from "../utils/previewPlayback";
import { artworkCandidates } from "../utils/resolveArtworkUrl";
import { getCoverUrl } from "../api/musicdeck";
import { extractArtworkColor } from "../utils/extractArtworkColor";

const allowed = { effective: { metadata: true, artwork: true, imports: true, external: true } };
afterEach(() => setBrowserPrivacy(undefined));
test("does not attempt a preview lookup when the policy is unavailable or metadata is denied", async () => {
  const transport = jest.fn();
  for (const policy of [null, { effective: { metadata: false } }]) {
    setBrowserPrivacy(policy);
    expect(await findItunesPreview({ artist: "Artist", title: "Track" }, transport)).toBeNull();
  }
  expect(transport).not.toHaveBeenCalled();
});
test("routes permitted iTunes lookups through the same-origin gateway", async () => {
  setBrowserPrivacy(allowed);
  const transport = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
  await findItunesPreview({ artist: "Artist", title: "Track" }, transport);
  const target = new URL(String(transport.mock.calls[0][0]), window.location.origin);
  expect(target.origin).toBe(window.location.origin);
  expect(target.pathname).toBe("/api/discovery/itunes-preview");
});
test("blocks cached third-party artwork while retaining native artwork", () => {
  setBrowserPrivacy({ effective: { artwork: false } });
  expect(getCoverUrl("https://image.example/cover.jpg", 80)).toBeFalsy();
  expect(getCoverUrl("extart_token", 80)).toBeFalsy();
  const candidates = artworkCandidates({ coverUrl: "https://image.example/cover.jpg", coverArt: "native-cover",
    tracks: [{ coverUrl: "/api/artwork/external/token" }] }, 80);
  expect(candidates).toEqual([getCoverUrl("native-cover", 80)]);
  expect(candidates[0]).toMatch(/^\/api\/artwork\//);
});
test("does not preload a remote image just to sample its colors while restricted", async () => {
  setBrowserPrivacy({ effective: { artwork: false } });
  const images = jest.spyOn(window, "Image");
  try {
    expect(await extractArtworkColor("https://image.example/cover.jpg")).toBeNull();
    expect(images).not.toHaveBeenCalled();
  } finally { images.mockRestore(); }
});
