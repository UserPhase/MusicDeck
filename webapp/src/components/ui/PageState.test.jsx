import { render, screen } from "@testing-library/react";

import { EmptyState, ErrorState, LoadingState } from "./PageState";


test("page state primitives render existing state class names", () => {
  render(
    <>
      <LoadingState>Loading library...</LoadingState>
      <ErrorState>Could not load.</ErrorState>
      <EmptyState>No songs yet.</EmptyState>
    </>
  );

  expect(screen.getByText("Loading library...")).toHaveClass("loading");
  expect(screen.getByText("Could not load.")).toHaveClass("error");
  expect(screen.getByText("No songs yet.")).toHaveClass("library-empty");
});
