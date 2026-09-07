import { render, screen } from "@testing-library/react";

import IconButton from "./IconButton";


test("icon button exposes an accessible label", () => {
  render(<IconButton label="Play track">▶</IconButton>);

  expect(screen.getByRole("button", { name: "Play track" })).toBeInTheDocument();
});

test("icon button supports disabled state", () => {
  render(<IconButton label="Play track" disabled>▶</IconButton>);

  expect(screen.getByRole("button", { name: "Play track" })).toBeDisabled();
});
