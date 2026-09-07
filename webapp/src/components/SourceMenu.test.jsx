import { fireEvent, render, screen } from "@testing-library/react";

import SourceMenu from "./SourceMenu";
import { getPlayableSources } from "../api/musicdeck";

jest.mock("../api/musicdeck", () => ({
  getPlayableSources: jest.fn(),
}));


const song = { id: "md_track-1", title: "Digital Love" };
const sources = [
  { id: "conn-a", name: "Home Server" },
  { id: "conn-b", name: "Second Library" },
];

const playableSources = [
  { id: "playable_a", provider: "library", type: "library", mediaType: "audio", label: "Home Server", availability: "available" },
  { id: "playable_b", provider: "external", type: "external", mediaType: "audio", label: "External source", availability: "available", quality: { codec: "AAC", bitrate: 256 } },
];


describe("SourceMenu", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPlayableSources.mockResolvedValue({ sources: playableSources, degraded: false });
  });

  test("renders nothing for a single-source or sourceless track", () => {
    const { container, rerender } = render(
      <SourceMenu song={song} sources={[{ id: "conn-a", name: "Only" }]} onSelect={() => {}} />
    );
    expect(container.firstChild).toBeNull();

    rerender(<SourceMenu song={song} sources={[]} onSelect={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  test("shows the source action for a multi-source track with an accessible name", () => {
    render(<SourceMenu song={song} sources={sources} onSelect={() => {}} />);

    expect(
      screen.getByRole("button", { name: "Play Digital Love from another source" })
    ).toBeInTheDocument();
  });

  test("shows the source action for an external-only result that can resolve playback", () => {
    render(
      <SourceMenu
        song={{ ...song, provider: "external", source: { kind: "external", count: 0 } }}
        sources={[]}
        onSelect={() => {}}
      />
    );

    expect(
      screen.getByRole("button", { name: "Play Digital Love from another source" })
    ).toBeInTheDocument();
  });

  test("lists friendly normalized source labels and never internal IDs or credentials", async () => {
    render(<SourceMenu song={song} sources={sources} onSelect={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /from another source/ }));

    expect(await screen.findByRole("menuitem", { name: "Home Server" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /external source.*aac.*256 kbps/i })).toBeInTheDocument();
    expect(screen.queryByText(/conn-a|conn-b|api[_-]?key|token|playable_a/i)).toBeNull();
  });

  test("selecting a source calls onSelect with the normalized source and closes the menu", async () => {
    const onSelect = jest.fn();
    render(<SourceMenu song={song} sources={sources} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /from another source/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /external source/i }));

    expect(onSelect).toHaveBeenCalledWith(song, playableSources[1]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("closes the menu on Escape", async () => {
    render(<SourceMenu song={song} sources={sources} onSelect={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /from another source/ }));
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("offers retry after source resolution failure", async () => {
    getPlayableSources
      .mockRejectedValueOnce(new Error("expired"))
      .mockResolvedValueOnce({ sources: playableSources, selectedSource: null, degraded: false });

    render(<SourceMenu song={song} sources={sources} onSelect={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /from another source/ }));
    fireEvent.click(await screen.findByRole("button", { name: /retry/i }));

    expect(await screen.findByRole("menuitem", { name: "Home Server" })).toBeInTheDocument();
  });

  test("shows the selected source from automatic preference resolution", async () => {
    getPlayableSources.mockResolvedValue({
      sources: playableSources,
      selectedSource: playableSources[1],
      degraded: false,
    });
    const onSelect = jest.fn();

    render(<SourceMenu song={song} sources={sources} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /from another source/ }));

    expect(await screen.findByRole("menuitem", { name: /✓ external source/i })).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith(song, playableSources[1]);
  });
});
