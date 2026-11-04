import { render, screen } from "@testing-library/react";
import { EditionBadges } from "./EditionBadges";

test("shows a lossy codec and the original file bitrate without a server badge", () => {
  render(<EditionBadges item={{ id: 1, metadata: {
    sourceServer: "navidrome", audioMetadata: { codec: "mpeg", container: "mp3", bitrateKbps: 320 },
  } }} />);
  expect(screen.getByText("MP3")).toHaveClass("audio-quality-badge");
  expect(screen.getByText("320k")).toBeInTheDocument();
  expect(screen.queryByText("Navidrome")).not.toBeInTheDocument();
});

test("uses the codec instead of guessing from a shared container", () => {
  render(<EditionBadges item={{ id: 2, metadata: {
    audioMetadata: { codec: "alac", container: "m4a", bitDepth: 24, sampleRateHz: 96000, bitrateKbps: 2300 },
  } }} />);
  expect(screen.getByText("ALAC")).toHaveClass("is-lossless");
  expect(screen.getByText("Hi-Res")).toBeInTheDocument();
  expect(screen.queryByText("2300k")).not.toBeInTheDocument();
});

test.each([
  ["audio/mpeg", "mp3", "MP3"],
  ["audio/x-aac", "m4a", "AAC"],
  ["flac", "flac", "FLAC"],
  ["wavpack", "wv", "WavPack"],
  [undefined, "m4a", "M4A"],
  ["ac3", "mka", "AC3"],
])("shows one format badge for a track with codec %s and container %s", (codec, container, label) => {
  const { container: row } = render(<EditionBadges formatOnly item={{ id: 3, title: "Song (Remastered)", metadata: {
    audioMetadata: { codec, container, bitrateKbps: 320, bitDepth: 24, sampleRateHz: 96000 },
  } }} />);
  expect(row.querySelectorAll(".audio-quality-badge")).toHaveLength(1);
  expect(screen.getByText(label!)).toHaveClass("audio-quality-badge");
});
