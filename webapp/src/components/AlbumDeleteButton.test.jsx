import { fireEvent, render, screen } from "@testing-library/react";
import AlbumDeleteButton from "./AlbumDeleteButton";
import { useServerDeletion } from "../context/ServerDeletionContext";

jest.mock("../context/ServerDeletionContext", () => ({ useServerDeletion: jest.fn() }));

test("album options use the glass portal without changing server deletion actions", () => {
  const album = { id: "md_album", name: "Album" };
  const openAlbum = jest.fn();
  useServerDeletion.mockReturnValue({ canDelete: true, openAlbum });
  render(<AlbumDeleteButton album={album} />);
  fireEvent.click(screen.getByRole("button", { name: "More options for Album" }));
  const menu = screen.getByRole("menu");
  expect(menu.parentElement).toBe(document.body);
  expect(menu).toHaveClass("glass-dropdown");
  fireEvent.click(screen.getByRole("menuitem", { name: /Delete from Server/ }));
  expect(openAlbum).toHaveBeenCalledWith(album);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
