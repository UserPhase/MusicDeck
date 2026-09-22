import { getDeviceDownloadUrl, normalizeDownloadQuality } from "./downloadManager";

test("maps bitrate preferences to transcoded stream URLs", () => {
  expect(normalizeDownloadQuality("128")).toBe("128kbps");
  expect(normalizeDownloadQuality("320kbps")).toBe("320kbps");
  expect(getDeviceDownloadUrl("track-1", "320kbps"))
    .toBe("/api/tracks/track-1/stream?maxBitRate=320");
  expect(getDeviceDownloadUrl("track-1", "256kbps"))
    .toBe("/api/tracks/track-1/stream?maxBitRate=256");
  expect(getDeviceDownloadUrl("track-1", "192kbps"))
    .toBe("/api/tracks/track-1/stream?maxBitRate=192");
});

test("requests the raw stream for lossless downloads", () => {
  expect(normalizeDownloadQuality("original")).toBe("lossless");
  expect(getDeviceDownloadUrl("track-1", "lossless"))
    .toBe("/api/tracks/track-1/stream");
});
