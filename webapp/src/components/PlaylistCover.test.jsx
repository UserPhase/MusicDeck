import {
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import PlaylistCover from "./PlaylistCover";

import {
  getCoverUrl,
} from "../api/musicdeck";


jest.mock("../api/musicdeck", () => ({
  getCoverUrl: jest.fn(),
}));


beforeEach(() => {
  jest.clearAllMocks();
  getCoverUrl.mockImplementation(
    (id) => (id ? `/api/artwork/${id}` : null)
  );
});


test("renders the resolved playlist artwork reference", () => {
  render(
    <PlaylistCover
      playlist={{
        name: "Road trip",
        coverArt: "mdplart_abc123_mdpl_1",
        coverMode: "collage",
      }}
    />
  );

  const image = screen.getByAltText("Road trip cover");

  expect(image).toHaveAttribute(
    "src",
    "/api/artwork/mdplart_abc123_mdpl_1"
  );
});


test("custom and automatic artwork use the same opaque reference", () => {
  const { rerender } = render(
    <PlaylistCover
      playlist={{
        name: "Road trip",
        coverArt: "mdplart_collage1_mdpl_1",
        coverMode: "collage",
      }}
    />
  );

  rerender(
    <PlaylistCover
      playlist={{
        name: "Road trip",
        coverArt: "mdplart_custom1_mdpl_1",
        coverMode: "custom",
      }}
    />
  );

  expect(screen.getByAltText("Road trip cover")).toHaveAttribute(
    "src",
    "/api/artwork/mdplart_custom1_mdpl_1"
  );
});


test("falls back to the placeholder without artwork or on a failed load", () => {
  const { container, rerender } = render(
    <PlaylistCover playlist={{ name: "Empty", coverArt: null }} />
  );

  expect(
    container.querySelector(".playlist-cover-icon")
  ).toBeInTheDocument();

  rerender(
    <PlaylistCover
      playlist={{ name: "Broken", coverArt: "mdplart_abc123_mdpl_2" }}
    />
  );

  fireEvent.error(screen.getByAltText("Broken cover"));

  expect(
    container.querySelector(".playlist-cover-icon")
  ).toBeInTheDocument();
});
