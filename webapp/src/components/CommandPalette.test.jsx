import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CommandPalette from "./CommandPalette";

const mockPlaySong = jest.fn();
const mockSetActiveSidebar = jest.fn();
const mockSearchNavidrome = jest.fn();

jest.mock("../context/PlayerContext", () => ({
  usePlayer: () => ({ playSong: mockPlaySong, setActiveSidebar: mockSetActiveSidebar }),
}));

jest.mock("../api/musicdeck", () => ({
  searchNavidrome: (...args) => mockSearchNavidrome(...args),
}));

function renderPalette(props = {}) {
  return render(
    <MemoryRouter>
      <CommandPalette isOpen onClose={jest.fn()} onToggleTheme={jest.fn()} {...props} />
    </MemoryRouter>
  );
}

describe("CommandPalette", () => {
  beforeEach(() => {
    mockPlaySong.mockClear();
    mockSetActiveSidebar.mockClear();
    mockSearchNavidrome.mockReset();
  });

  test("opens with a focused search field and runs a queue command", () => {
    renderPalette();
    const input = screen.getByRole("textbox", { name: "Command palette search" });
    expect(input).toHaveFocus();

    fireEvent.click(screen.getByRole("option", { name: /Open Queue/i }));
    expect(mockSetActiveSidebar).toHaveBeenCalledWith("queue");
  });

  test("finds and plays track results with Enter", async () => {
    const song = { id: "track-1", title: "Moonlight", artist: "Nova" };
    mockSearchNavidrome.mockResolvedValue({ songs: [song], artists: [], playlists: [] });
    renderPalette();
    const input = screen.getByRole("textbox", { name: "Command palette search" });

    fireEvent.change(input, { target: { value: "moon" } });
    await screen.findByRole("option", { name: /Moonlight/i });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockPlaySong).toHaveBeenCalledWith(song);
  });
});
