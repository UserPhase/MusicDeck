import { fireEvent, render, screen } from "@testing-library/react";
import TrackLikeButton from "./TrackLikeButton";

const mockToggleLikeSong = jest.fn();

jest.mock("../context/PlayerContext", () => ({
  usePlayer: () => ({
    likedSongIds: new Set(),
    toggleLikeSong: mockToggleLikeSong,
  }),
}));

describe("TrackLikeButton", () => {
  beforeEach(() => mockToggleLikeSong.mockClear());

  test("likes its own row without bubbling into playback", () => {
    const parentClick = jest.fn();
    const song = { id: "row-song", title: "Row song" };

    render(
      <div onClick={parentClick}>
        <TrackLikeButton song={song} />
      </div>
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Row song to liked songs" }));

    expect(mockToggleLikeSong).toHaveBeenCalledWith(song);
    expect(parentClick).not.toHaveBeenCalled();
  });
});
