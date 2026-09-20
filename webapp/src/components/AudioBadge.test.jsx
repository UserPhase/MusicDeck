import { render, screen } from "@testing-library/react";
import AudioBadge from "./AudioBadge";

describe("AudioBadge", () => {
  test.each([
    ["preview", undefined, "Preview", "audio-badge-preview"],
    ["flac", undefined, "Lossless", "audio-badge-lossless"],
    [undefined, 320, "320K", "audio-badge-high"],
    [undefined, 128, "128K", "audio-badge-standard"],
  ])("renders %s / %s with the expected fidelity treatment", (type, bitrate, label, tone) => {
    render(<AudioBadge type={type} bitrate={bitrate} />);

    expect(screen.getByText(label)).toHaveClass(tone);
  });
});
