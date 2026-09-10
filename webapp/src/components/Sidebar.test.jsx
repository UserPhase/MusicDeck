import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Sidebar from "./Sidebar";

import {
  getPlaylists,
} from "../api/playlists";

import {
  getCoverUrl,
} from "../api/musicdeck";


jest.mock("../api/playlists", () => ({
  getPlaylists: jest.fn(),
  createPlaylist: jest.fn(),
}));

jest.mock("../api/musicdeck", () => ({
  getCoverUrl: jest.fn(),
}));


function renderSidebar(playlists) {
  getCoverUrl.mockImplementation((id, size) =>
    id ? `/api/artwork/${id}${size ? `?size=${size}` : ""}` : null
  );
  getPlaylists.mockResolvedValue(playlists);

  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>
  );
}


test("sidebar playlist entries render the resolved playlist artwork", async () => {
  renderSidebar([
    {
      id: "mdpl_1",
      name: "Evening Drive",
      coverArt: "mdplart_sig1_mdpl_1",
      coverMode: "collage",
    },
    {
      id: "mdpl_2",
      name: "Focus",
      coverArt: "mdplart_sig2_mdpl_2",
      coverMode: "custom",
    },
  ]);

  expect(await screen.findByText("Evening Drive")).toBeInTheDocument();

  // Both artwork modes resolve through the same shared component and proxy,
  // requested at the small sidebar thumbnail size.
  expect(screen.getByAltText("Evening Drive cover")).toHaveAttribute(
    "src",
    "/api/artwork/mdplart_sig1_mdpl_1?size=64"
  );

  expect(screen.getByAltText("Focus cover")).toHaveAttribute(
    "src",
    "/api/artwork/mdplart_sig2_mdpl_2?size=64"
  );
});


test("sidebar falls back to the note placeholder for a playlist without artwork", async () => {
  const { container } = renderSidebar([
    { id: "mdpl_3", name: "Brand New", coverArt: null, coverMode: null },
  ]);

  expect(await screen.findByText("Brand New")).toBeInTheDocument();

  await waitFor(() => {
    expect(
      container.querySelector(".nav-icon-playlist-placeholder")
    ).toBeInTheDocument();
  });

  expect(screen.queryByAltText("Brand New cover")).toBeNull();
});
