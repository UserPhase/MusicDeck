import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PlaylistFolderTree from "./PlaylistFolderTree";
import { playlistCommands } from "../../services/playlists/PlaylistCommandStore";

let mockOwner = "alice";
jest.mock("../../context/AuthContext", () => ({ useAuth: () => ({ session: { id: mockOwner, role: "user" } }) }));
jest.mock("../PlaylistCover", () => () => <span>♫</span>);
const initial = { revision: 0, folders: [
  { id: "parent", name: "Road trips", parent_folder_id: null, user_id: "alice", pinned: false, position: 0 },
  { id: "child", name: "Night drives", parent_folder_id: "parent", user_id: "alice", pinned: false, position: 0 },
], playlists: [{ id: "one", name: "Evening Drive", ownerUserId: "alice", folderId: null, position: 0, pinned: false }] };
const reply = (value: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => value } as Response);
beforeEach(() => { mockOwner = "alice"; localStorage.clear(); HTMLElement.prototype.scrollIntoView = jest.fn(); global.fetch = jest.fn(() => reply(initial)); });
afterEach(() => { jest.restoreAllMocks(); });
const renderTree = () => render(<MemoryRouter><PlaylistFolderTree /></MemoryRouter>);

test("sorts playlists by visit, creation, title and creator while keeping pinned entries first", async () => {
  const playlists = [
    { ...initial.playlists[0], name: "Evening Drive", createdAt: "2026-01-01", creator: "Zoe" },
    { ...initial.playlists[0], id: "two", name: "After Hours", createdAt: "2026-03-01", creator: "Mia" },
    { ...initial.playlists[0], id: "three", name: "Morning", createdAt: "2026-02-01", creator: "Ada" },
    { ...initial.playlists[0], id: "pinned", name: "Weekend", folderId: "parent", pinned: true },
  ];
  (fetch as jest.Mock).mockImplementation(() => reply({ ...initial, playlists }));
  render(<MemoryRouter initialEntries={["/playlist/one"]}><PlaylistFolderTree /></MemoryRouter>);
  await screen.findByRole("link", { name: "Weekend" });
  fireEvent.click(screen.getByRole("button", { name: "Expand Road trips" }));
  const names = () => within(screen.getByRole("tree")).getAllByRole("link").map(link => link.getAttribute("aria-label"));
  const sortBy = (label: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Playlist collection options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sort by" }));
    expect(screen.getByRole("menuitemradio", { checked: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: label }));
  };
  expect(screen.queryByRole("button", { name: /^Sort playlists:/ })).not.toBeInTheDocument();
  expect(names()).toEqual(["Weekend", "Evening Drive", "After Hours", "Morning"]);
  sortBy("Recently added");
  expect(names()).toEqual(["Weekend", "After Hours", "Morning", "Evening Drive"]);
  sortBy("Alphabetical");
  expect(names()).toEqual(["Weekend", "After Hours", "Evening Drive", "Morning"]);
  sortBy("Creator");
  expect(names()).toEqual(["Weekend", "Morning", "After Hours", "Evening Drive"]);
  expect(localStorage.getItem("musicdeck:playlist-sort:alice")).toBe('"creator"');
});

test("pins a playlist through its row actions and keeps its artwork row", async () => {
  renderTree();
  const link = await screen.findByRole("link", { name: "Evening Drive" });
  expect(screen.queryByRole("button", { name: "Actions for Evening Drive" })).not.toBeInTheDocument();
  const pinned = { ...initial, revision: 1, playlists: [{ ...initial.playlists[0], pinned: true }] };
  (fetch as jest.Mock).mockImplementation(() => reply(pinned));
  fireEvent.contextMenu(link);
  fireEvent.click(screen.getByRole("menuitem", { name: /^Pin$/ }));
  await screen.findByRole("img", { name: "Pinned playlist" });
  expect(screen.getAllByRole("link", { name: "Evening Drive" })).toHaveLength(1);
  expect(fetch).toHaveBeenCalledWith("/api/v1/playlist-organization", expect.objectContaining({
    method: "POST", body: JSON.stringify({ ownerId: "alice", revision: 0, operation: { kind: "playlist", id: "one", pinned: true } }),
  }));
});

test("switching accounts immediately removes private folders and stale fallback playlists", async () => {
  const props = { playlists: initial.playlists };
  const view = render(<MemoryRouter><PlaylistFolderTree {...props} /></MemoryRouter>);
  await screen.findByRole("button", { name: "Expand Road trips" });
  mockOwner = "bob";
  (fetch as jest.Mock).mockImplementation(() => reply({ revision: 0, folders: [], playlists: [] }));
  view.rerender(<MemoryRouter><PlaylistFolderTree {...props} /></MemoryRouter>);
  expect(screen.queryByRole("button", { name: "Expand Road trips" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Evening Drive" })).not.toBeInTheDocument();
  await act(async () => {});
});

test("folders collapse, inline filtering exposes matching descendants and arrow keys navigate", async () => {
  renderTree();
  expect(await screen.findByRole("button", { name: "Expand Road trips" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Expand Night drives" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Expand Road trips" }));
  expect(screen.getByRole("button", { name: "Expand Night drives" })).toBeInTheDocument();
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  const options = screen.getByRole("button", { name: "Playlist collection options" });
  fireEvent.click(options);
  fireEvent.click(screen.getByRole("menuitem", { name: "Find a playlist" }));
  expect(screen.getByRole("searchbox")).toHaveFocus();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Night" } });
  expect(screen.getByRole("button", { name: "Collapse Night drives" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Evening Drive" })).not.toBeInTheDocument();
  const tree = screen.getByRole("tree");
  fireEvent.keyDown(tree, { key: "Home" });
  expect(document.getElementById(tree.getAttribute("aria-activedescendant")!)).toHaveTextContent("Road trips");
  fireEvent.keyDown(tree, { key: "Escape" });
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  expect(options).toHaveFocus();
  fireEvent.click(options);
  fireEvent.click(screen.getByRole("menuitem", { name: "Find a playlist" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Evening" } });
  fireEvent.click(screen.getByRole("link", { name: "Evening Drive" }));
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
});

test("native drag/drop sends a revision-checked move and expands the target folder", async () => {
  const { container } = renderTree();
  await screen.findByRole("link", { name: "Evening Drive" });
  const moved = { ...initial, revision: 1, playlists: [{ ...initial.playlists[0], folderId: "parent" }] };
  (fetch as jest.Mock).mockImplementation((_url, options) => reply(options?.method === "POST" ? moved : moved));
  const payload: Record<string, string> = {};
  const transfer = { types: ["application/x-musicdeck-playlist-tree"], setData: (type: string, value: string) => { payload[type] = value; }, getData: (type: string) => payload[type], effectAllowed: "", dropEffect: "" };
  const playlist = container.querySelector('.folder-playlist .folder-tree-row')!;
  const folder = screen.getByRole("button", { name: "Expand Road trips" }).closest('[role="treeitem"]')!;
  fireEvent.dragStart(playlist, { dataTransfer: transfer }); fireEvent.drop(folder, { dataTransfer: transfer, clientY: 50 });
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/playlist-organization", expect.objectContaining({ method: "POST", body: JSON.stringify({ ownerId: "alice", revision: 0, operation: { kind: "playlist", id: "one", folderId: "parent" } }) })));
  await screen.findByRole("button", { name: "Collapse Road trips" });
  expect(screen.getByRole("link", { name: "Evening Drive" })).toBeInTheDocument();
});

test("pinned playlist dragging ignores regular rows and uses the separate pin order", async () => {
  const pinA = { ...initial.playlists[0], id: "a", name: "Alpha", pinned: true, folderId: "parent" };
  const pinB = { ...initial.playlists[0], id: "b", name: "Beta", pinned: true };
  const before = { ...initial, playlists: [pinA, pinB, ...initial.playlists] };
  (fetch as jest.Mock).mockImplementation(() => reply(before));
  const { container } = renderTree();
  await screen.findByRole("link", { name: "Beta" });
  const data: Record<string, string> = {};
  const transfer = { types: ["application/x-musicdeck-playlist-tree"],
    setData: (key: string, value: string) => { data[key] = value; }, getData: (key: string) => data[key] };
  const source = container.querySelector('[data-tree-key="playlist:b"] .folder-tree-row')!;
  fireEvent.dragStart(source, { dataTransfer: transfer });
  fireEvent.dragOver(container.querySelector('[data-tree-key="playlist:one"]')!, { dataTransfer: transfer });
  expect(container.querySelector("[data-sidebar-drop]")).toBeNull();
  fireEvent.drop(container.querySelector('[data-tree-key="playlist:one"]')!, { dataTransfer: transfer });
  expect((fetch as jest.Mock).mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  (fetch as jest.Mock).mockImplementation(() => reply({ ...before, revision: 1,
    playlists: [{ ...pinA, pinPosition: 1 }, { ...pinB, pinPosition: 0 }, ...initial.playlists] }));
  fireEvent.dragStart(source, { dataTransfer: transfer });
  fireEvent.dragOver(container.querySelector('[data-tree-key="playlist:a"]')!, { dataTransfer: transfer });
  expect(container.querySelector('[data-tree-key="playlist:a"] .folder-tree-row')).toHaveAttribute("data-sidebar-drop", "before");
  fireEvent.drop(container.querySelector('[data-tree-key="playlist:a"]')!, { dataTransfer: transfer });
  await waitFor(() => expect(within(screen.getByRole("tree")).getAllByRole("link")[0]).toHaveAccessibleName("Beta"));
  expect(fetch).toHaveBeenCalledWith("/api/v1/playlist-organization", expect.objectContaining({
    method: "POST", body: JSON.stringify({ ownerId: "alice", revision: 0, operation: { kind: "pinOrder", id: "b", position: 0 } }),
  }));
});

test("Trash exposes a recovery action and an actionable failure without deleting a collection", async () => {
  renderTree(); await screen.findByRole("link", { name: "Evening Drive" });
  (fetch as jest.Mock).mockImplementation((url: string) => url.endsWith("/trash") ? reply({ playlists: [{ id: "deleted", name: "Old mix", deletedAt: new Date().toISOString(), trackCount: 8, revision: 1 }] }) : reply(initial));
  const restore = jest.spyOn(playlistCommands, "execute").mockRejectedValue(new Error("Recovery period expired"));
  fireEvent.click(screen.getByRole("button", { name: "Playlist collection options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Trash" }));
  const dialog = await screen.findByRole("dialog", { name: "Playlist Trash" });
  fireEvent.click(await within(dialog).findByRole("button", { name: "Restore Old mix" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Recovery period expired");
  expect(restore).toHaveBeenCalledWith("deleted", { kind: "restore" });
});
