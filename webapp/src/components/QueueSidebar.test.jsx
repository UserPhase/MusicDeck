import { fireEvent, render, screen } from "@testing-library/react";

import QueueSidebar from "./QueueSidebar";
import { usePlayer } from "../context/PlayerContext";

jest.mock("../context/PlayerContext", () => ({
  usePlayer: jest.fn(),
}));

beforeEach(() => {
  usePlayer.mockReturnValue({
    playHistory: [
      { id: "history-1", title: "Already Played", artist: "Artist A", duration: 90 },
    ],
    queue: [
      { id: "queue-1", title: "Up Next", artist: "Artist B", duration: 180 },
    ],
  });
});

test("switches between the queue and play-history tabs", () => {
  render(<QueueSidebar isOpen onClose={jest.fn()} />);

  expect(screen.getByRole("heading", { name: "Up next" })).toBeInTheDocument();
  expect(screen.getByText("Up Next")).toBeInTheDocument();
  expect(screen.queryByText("Already Played")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("tab", { name: "Recently Played" }));

  expect(screen.getByRole("heading", { name: "Recently played" })).toBeInTheDocument();
  expect(screen.getByText("Already Played")).toBeInTheDocument();
  expect(screen.queryByText("Up Next")).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Recently Played" })).toHaveAttribute("aria-selected", "true");
});

test("closes through its dedicated close control", () => {
  const onClose = jest.fn();
  render(<QueueSidebar isOpen onClose={onClose} />);

  fireEvent.click(screen.getByRole("button", { name: "Close queue sidebar" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("does not render while closed", () => {
  const { container } = render(<QueueSidebar isOpen={false} onClose={jest.fn()} />);
  expect(container).toBeEmptyDOMElement();
});
