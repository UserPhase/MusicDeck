import { fireEvent, render, screen } from "@testing-library/react";
import FullHero from "./FullHero";

test("FullHero entity artwork falls back from a broken root to child tracks", () => {
  render(<FullHero title="Album" entity={{
    name: "Album", coverUrl: "https://example.test/root.jpg",
    tracks: [{ coverUrl: "https://example.test/child.jpg" }],
  }} />);
  const image = screen.getByAltText("Album cover");
  expect(image).toHaveAttribute("src", "https://example.test/root.jpg");
  fireEvent.error(image);
  expect(image).toHaveAttribute("src", "https://example.test/child.jpg");
});

test("preserves caller-supplied artwork such as artist avatars", () => {
  render(<FullHero title="Artist" artwork={<span>Custom avatar</span>} entity={{ coverArt: "unused" }} />);
  expect(screen.getByText("Custom avatar")).toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});
