import { isAudioRequest, isArtworkPath, isCatalogPath, isStaleWebCache } from "./cachePolicy";

test.each([
  "/api/tracks/track-1/stream", "/api/tracks/track-1/download", "/api/playback/preview",
  "/api/playback/normalize", "/anything/song.flac", "/stream/album.m3u8",
])("excludes media %s from automatic caching", (path) => {
  expect(isAudioRequest({ url: `https://music.test${path}`, destination: "", headers: { has: () => false } })).toBe(true);
});
test("excludes every Range request and media destination even if the URL looks static", () => {
  expect(isAudioRequest({ url: "https://music.test/a.js", destination: "", headers: { has: () => true } })).toBe(true);
  expect(isAudioRequest({ url: "https://music.test/item", destination: "audio", headers: { has: () => false } })).toBe(true);
});
test("limits artwork routing to the native authenticated proxy, not arbitrary image URLs", () => {
  expect(isArtworkPath("/api/artwork/native-1")).toBe(true);
  expect(isArtworkPath("/api/artwork/external/token")).toBe(true);
  expect(isArtworkPath("/api/users/admin/avatar")).toBe(false);
  expect(isArtworkPath("/image.jpg")).toBe(false);
  expect(isArtworkPath("/api/artwork/mdplart_signature_playlist")).toBe(false);
  expect(isArtworkPath("/api/artwork/%6ddplart_signature_playlist")).toBe(false);
});
test("only caches native catalog metadata, not search, external entities or authorization decisions", () => {
  for (const path of ["/api/albums", "/api/tracks/local-id", "/api/artists/native"]) expect(isCatalogPath(path)).toBe(true);
  for (const path of ["/api/search", "/api/v1/privacy", "/api/auth/session", "/api/albums/external_deezer_album_1",
    "/api/albums/%65xternal_deezer_album_1", "/api/artists/native/portrait"]) expect(isCatalogPath(path)).toBe(false);
});
test("does not purge an installing build's fingerprinted caches as if they were stale", () => {
  expect(isStaleWebCache("musicdeck-pwa-shell-v1-installinghash")).toBe(false);
  expect(isStaleWebCache("musicdeck-pwa-static-v1-installinghash")).toBe(false);
  expect(isStaleWebCache("musicdeck-pwa-shell-v0-old")).toBe(true);
});
