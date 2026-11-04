import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { usePlayer } from "../../context/PlayerContext";
import type { StreamQualityDetails } from "../../hooks/useStreamQualityDetails";
import AudioQualityBadge from "./AudioQualityBadge";
import { audioQualityLabel } from "./AudioQualityInspector";

jest.mock("../../context/PlayerContext", () => ({ usePlayer: () => mockedPlayer() }));
const mockedPlayer = jest.fn<Pick<NonNullable<ReturnType<typeof usePlayer>>, "currentSong" | "streamQuality" | "streamQualityDetails" | "applyStreamQuality">, []>();
const properties = { codec: "FLAC", container: "FLAC", bitrateKbps: 850, bitDepth: 24, sampleRateHz: 96000, channels: 2, lossless: true };
const details: StreamQualityDetails = {
  source: properties, output: { ...properties, observed: true, mode: "DIRECT_STREAM", evidence: "provider-direct", transcodeReason: null, downsampled: false, requestedBitrateKbps: null },
  pipeline: { path: "Web Audio", sampleRateHz: 48000, outputChannels: 2, outputDeviceType: "Not exposed by browser", gainDb: -6 },
  delivery: { bytes: 1000, bitrateKbps: 8000, state: "streaming", windowSeconds: 1 },
  loading: false, error: "", note: "Delivery rate is not encoded bitrate.", preview: false, serverNormalized: false,
};
const apply = jest.fn();
beforeEach(() => {
  apply.mockReset().mockResolvedValue(undefined);
  mockedPlayer.mockReturnValue({ currentSong: { id: "song", title: "Studio master" }, streamQuality: "original",
    streamQualityDetails: details, applyStreamQuality: apply });
});
test("uses delivered output, never the lossless source or selected bitrate, for the badge", () => {
  expect(audioQualityLabel(details)).toBe("24-BIT");
  expect(audioQualityLabel({ ...details, output: { ...details.output!, codec: "MP3", bitDepth: null, lossless: false, bitrateKbps: null, mode: "TRANSCODED" } })).toBe("TRANSCODED");
  expect(audioQualityLabel({ ...details, output: null })).toBe("AUDIO");
  expect(audioQualityLabel({ ...details, preview: true })).toBe("PREVIEW");
  expect(audioQualityLabel({ ...details, serverNormalized: true })).toBe("PROCESSED");
});
test("opens an accessible signal-chain inspector, traps focus, closes on Escape and restores focus", () => {
  render(<AudioQualityBadge />);
  const badge = screen.getByRole("button", { name: /Open audio inspector/ });
  badge.focus(); fireEvent.click(badge);
  const close = screen.getByRole("button", { name: "Close audio inspector" });
  expect(screen.getByRole("dialog", { name: "Audio Inspector" })).toBeInTheDocument();
  expect(close).toHaveFocus();
  expect(screen.getAllByText("96 kHz", { selector: "dd" })).toHaveLength(2);
  expect(screen.getByText("-6.00 dB")).toBeInTheDocument();
  expect(screen.getByText("8,000 kbps")).toBeInTheDocument();
  expect(screen.getByText(/not encoded bitrate/)).toBeInTheDocument();
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(screen.getByRole("button", { name: "Apply to current track" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(badge).toHaveFocus();
});
test("applies direct/256 to the playing track and surfaces failed account saves", async () => {
  render(<AudioQualityBadge />);
  fireEvent.click(screen.getByRole("button", { name: /Open audio inspector/ }));
  fireEvent.change(screen.getByLabelText("Maximum quality / bitrate"), { target: { value: "direct" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply to current track" }));
  await waitFor(() => expect(apply).toHaveBeenCalledWith("direct"));
  await screen.findByRole("status");
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  apply.mockRejectedValueOnce(new Error("Account settings unavailable"));
  fireEvent.change(screen.getByLabelText("Maximum quality / bitrate"), { target: { value: "256" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply to current track" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Account settings unavailable");
  expect(apply).toHaveBeenLastCalledWith("256");
  consoleError.mockRestore();
});
