import { render, screen } from "@testing-library/react";

import AvailabilityHint from "./AvailabilityHint";


const multi = { state: "available", connectionId: "c1", sourceCount: 2, availableSourceCount: 2, libraryAvailable: true };
const degraded = { state: "degraded", connectionId: "c1", sourceCount: 2, availableSourceCount: 1, libraryAvailable: true };
const single = { state: "available", connectionId: "c1", sourceCount: 1, availableSourceCount: 1, libraryAvailable: true };


describe("AvailabilityHint", () => {
  test("shows a multi-source hint with accessible text", () => {
    render(<AvailabilityHint availability={multi} />);

    expect(screen.getByLabelText("Availability: 2 sources")).toBeInTheDocument();
  });

  test("shows a degraded hint without provider or connection details", () => {
    render(<AvailabilityHint availability={degraded} />);

    const hint = screen.getByLabelText("Availability: Partially available");
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).not.toMatch(/navidrome|jellyfin|conn|c1/i);
  });

  test("renders nothing for a normal single-source item", () => {
    const { container } = render(<AvailabilityHint availability={single} />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByLabelText(/Availability:/)).toBeNull();
  });

  test("renders nothing when availability is missing", () => {
    const { container } = render(<AvailabilityHint availability={null} />);

    expect(container.firstChild).toBeNull();
  });
});
