import { render, screen } from "@testing-library/react";

import AlbumCard from "./AlbumCard";


describe("AlbumCard availability", () => {
  const base = {
    title: "Discovery",
    artist: "Daft Punk",
    cover: null,
    onClick: () => {},
  };

  test("shows a subtle multi-source hint when multiple sources are available", () => {
    render(
      <AlbumCard
        {...base}
        availability={{ state: "available", connectionId: "x", sourceCount: 2, availableSourceCount: 2, libraryAvailable: true }}
      />
    );

    expect(screen.getByLabelText("Availability: 2 sources")).toBeInTheDocument();
  });

  test("shows a partially-available hint for degraded items without provider details", () => {
    render(
      <AlbumCard
        {...base}
        availability={{ state: "degraded", connectionId: "x", sourceCount: 2, availableSourceCount: 1, libraryAvailable: true }}
      />
    );

    const hint = screen.getByLabelText("Availability: Partially available");
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).not.toMatch(/navidrome|jellyfin|conn/i);
  });

  test("renders no hint for a fully available single-source item", () => {
    render(
      <AlbumCard
        {...base}
        availability={{ state: "available", connectionId: "x", sourceCount: 1, availableSourceCount: 1, libraryAvailable: true }}
      />
    );

    expect(screen.queryByLabelText(/Availability:/)).toBeNull();
  });

  test("renders no hint when availability is absent", () => {
    render(<AlbumCard {...base} />);

    expect(screen.queryByLabelText(/Availability:/)).toBeNull();
  });
});
