import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import AlbumImportButton from "./AlbumImportButton";
import { createExternalActions } from "../services/externalActions";

jest.mock("../hooks/useAlbumArtwork", () => ({
  useAlbumArtwork: () => ({ url: null, onError: () => {} }),
}));

const album = { id: "external_deezer_album_7", title: "Night Drive", artist: "Neon", provider: "deezer", external: true };

function setup(deps = {}) {
  const pollers = [];
  const actions = createExternalActions({
    create: jest.fn(),
    get: jest.fn(),
    list: jest.fn().mockResolvedValue([]),
    isOnline: () => true,
    schedule: (callback) => { pollers.push(callback); return callback; },
    cancel: (handle) => { const index = pollers.indexOf(handle); if (index >= 0) pollers.splice(index, 1); },
    ...deps,
  });
  render(<MemoryRouter><AlbumImportButton album={album} actions={actions} /></MemoryRouter>);
  return { actions, pollers };
}

test("shows each lifecycle step on the import button", async () => {
  const create = jest.fn().mockResolvedValue({ job: { id: "job-1", status: "queued" } });
  const get = jest.fn()
    .mockResolvedValueOnce({ id: "job-1", status: "downloading", progress: { percent: 50 } })
    .mockResolvedValueOnce({ id: "job-1", status: "completed" });
  const { pollers } = setup({ create, get });

  const button = screen.getByRole("button", { name: "Add to Library" });
  await act(async () => { fireEvent.click(button); });
  expect(button).toHaveTextContent("Queued");
  expect(button).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Night Drive is queued for import.");

  await act(async () => { pollers.shift()(); });
  expect(button).toHaveTextContent("Importing 50%");

  await act(async () => { pollers.shift()(); });
  expect(screen.getByRole("button", { name: "In Library" })).toHaveTextContent("In Library");
  expect(create).toHaveBeenCalledTimes(1);
});

test("double clicks never queue a second import", async () => {
  const create = jest.fn(() => new Promise(() => {}));
  setup({ create });
  const button = screen.getByRole("button", { name: "Add to Library" });
  await act(async () => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(create).toHaveBeenCalledTimes(1);
});

test("a failed import shows an alert and a retry action", async () => {
  const create = jest.fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce({ job: { id: "job-2", status: "queued" } });
  setup({ create });

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to Library" })); });
  expect(screen.getByRole("alert")).toHaveTextContent("Can't reach MusicDeck. Check your connection and try again.");

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry Import" })); });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Queued/ })).toBeDisabled();
});

test("restores an import that is already running on the server", async () => {
  const list = jest.fn().mockResolvedValue([{ id: "job-9", status: "importing", requestedAlbumId: album.id }]);
  const create = jest.fn();
  await act(async () => { setup({ list, create }); });
  expect(screen.getByRole("button", { name: /Importing/ })).toBeDisabled();
  expect(create).not.toHaveBeenCalled();
});
