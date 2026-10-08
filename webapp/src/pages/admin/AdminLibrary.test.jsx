import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import AdminLibrary from "./AdminLibrary";
import { getLibraryStatistics } from "../../api/musicdeck";

jest.mock("../../api/musicdeck", () => ({
  getLibraryStatistics: jest.fn(),
}));

beforeEach(() => jest.clearAllMocks());

function renderLibrary() {
  render(<MemoryRouter><AdminLibrary /></MemoryRouter>);
}

test("renders collection statistics from the library API", async () => {
  getLibraryStatistics.mockResolvedValue({
    collection: { tracks: 120, albums: 12, artists: 8, totalDurationSeconds: 7200 },
  });
  renderLibrary();
  await screen.findByRole("heading", { name: "Overview" });
  for (const [label, value] of [["Tracks", "120"], ["Albums", "12"], ["Artists", "8"], ["Total duration", "2 h"]]) {
    expect(within(screen.getByText(label, { selector: ".admin-card span" }).parentElement)
      .getByText(value)).toBeInTheDocument();
  }
});

test("preserves zero counts for an empty library", async () => {
  getLibraryStatistics.mockResolvedValue({
    collection: { tracks: 0, albums: 0, artists: 0, totalDurationSeconds: 0 },
  });
  renderLibrary();
  await screen.findByRole("heading", { name: "Overview" });
  expect(screen.getAllByText("0", { selector: ".admin-card strong" })).toHaveLength(3);
  expect(screen.getByText("0 h")).toBeInTheDocument();
});

test("shows library statistics failures instead of silently hiding them", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    getLibraryStatistics.mockRejectedValue(new Error("Backend unavailable"));
    renderLibrary();
    expect(await screen.findByText("statistics: Backend unavailable")).toBeInTheDocument();
    expect(log).toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
