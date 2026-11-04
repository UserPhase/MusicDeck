import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { getPlaylists } from "../api/playlists";
import Playlists from "./Playlists";

jest.mock("../api/playlists", () => ({ getPlaylists: jest.fn() }));
jest.mock("../components/PlaylistCover", () => () => null);
jest.mock("../components/LikedAlbumsSection", () => () => null);
jest.mock("../hooks/useSmartPlaylists", () => ({
  useSmartPlaylists: () => ({ items: [
    { id: "smart-a", name: "Smart Alpha", createdAt: "2026-02-01" },
    { id: "smart-z", name: "Smart Zulu", createdAt: "2026-03-01" },
  ] }),
}));

test("sorts each playlist type independently of the visibility filter", async () => {
  getPlaylists.mockResolvedValue([
    { id: "a", name: "Alpha", createdAt: "2026-03-01" },
    { id: "z", name: "Zulu", createdAt: "2026-02-01" },
  ]);
  const { container } = render(<MemoryRouter><Playlists /></MemoryRouter>);
  await screen.findByText("Alpha");
  const names = () => Array.from(container.querySelectorAll(".playlist-title"), item => item.textContent);
  const choose = name => {
    fireEvent.click(screen.getByRole("button", { name: "Filter playlists" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name }));
  };
  expect(names()).toEqual(["Alpha", "Zulu", "Smart Alpha", "Smart Zulu"]);
  choose("Z–A");
  expect(names()).toEqual(["Zulu", "Alpha", "Smart Zulu", "Smart Alpha"]);
  choose("Newest");
  expect(names()).toEqual(["Alpha", "Zulu", "Smart Zulu", "Smart Alpha"]);
  choose("Oldest");
  expect(names()).toEqual(["Zulu", "Alpha", "Smart Alpha", "Smart Zulu"]);
  choose("Smart playlists");
  expect(names()).toEqual(["Smart Alpha", "Smart Zulu"]);
  choose("Regular playlists");
  expect(names()).toEqual(["Zulu", "Alpha"]);
});
