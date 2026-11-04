import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import PlaylistShareModal from "./PlaylistShareModal";
import { getPlaylistSharing, searchSharingUsers, savePlaylistSharing, createPlaylistInvitation, revokePlaylistInvitation } from "../../api/playlistCollaboration";
let mockOwner = "owner";
jest.mock("../../context/AuthContext", () => ({ useAuth: () => ({ session: { id: mockOwner } }) }));
jest.mock("../../api/playlistCollaboration", () => ({ getPlaylistSharing: jest.fn(), searchSharingUsers: jest.fn(), savePlaylistSharing: jest.fn(), createPlaylistInvitation: jest.fn(), revokePlaylistInvitation: jest.fn() }));
const member = { id: "editor", username: "riley", displayName: "Riley", avatarUrl: null };
const initial = { playlistId: "list", mode: "PRIVATE", revision: 3, ownerUserId: "owner", grants: [], links: [] };
beforeEach(() => { jest.clearAllMocks(); mockOwner = "owner"; (getPlaylistSharing as jest.Mock).mockResolvedValue(initial);
  (searchSharingUsers as jest.Mock).mockResolvedValue({ users: [member] }); (savePlaylistSharing as jest.Mock).mockImplementation(async (_id, _owner, _revision, mode, grants) => ({ ...initial, mode, grants: grants.map((grant: object) => ({ ...member, ...grant })), revision: 4 })); });
const show = (close = jest.fn()) => render(<PlaylistShareModal playlistId="list" playlistName="Household" onClose={close} />);
test("named collaboration sends only server user IDs and roles with the account and revision", async () => {
  show(); fireEvent.click(await screen.findByRole("radio", { name: /^Collaborative/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Riley.*riley/ }));
  fireEvent.change(screen.getByRole("combobox", { name: "Role for Riley" }), { target: { value: "COLLABORATOR" } });
  fireEvent.click(screen.getByRole("button", { name: "Save sharing" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Sharing updated");
  expect(savePlaylistSharing).toHaveBeenCalledWith("list", "owner", 3, "COLLABORATIVE", [{ userId: "editor", role: "COLLABORATOR" }], expect.any(AbortSignal));
});
test("viewer mode downgrades roles and public-server mode clears named edits", async () => {
  (getPlaylistSharing as jest.Mock).mockResolvedValue({ ...initial, mode: "COLLABORATIVE", grants: [{ ...member, userId: member.id, role: "COLLABORATOR" }] });
  show(); fireEvent.click(await screen.findByRole("radio", { name: /^Shared with viewers/ }));
  expect(screen.getByRole("combobox", { name: "Role for Riley" })).toHaveValue("VIEWER");
  expect(screen.getByRole("combobox", { name: "Role for Riley" })).toBeDisabled();
  fireEvent.click(screen.getByRole("radio", { name: /^Everyone on this server/ })); fireEvent.click(screen.getByRole("button", { name: "Save sharing" }));
  await waitFor(() => expect(savePlaylistSharing).toHaveBeenCalledWith("list", "owner", 3, "PUBLIC_SERVER", [], expect.any(AbortSignal)));
});
test("stale sharing errors preserve the draft and offer an explicit reload", async () => {
  (savePlaylistSharing as jest.Mock).mockRejectedValueOnce(new Error("Sharing changed elsewhere. Reload before saving."));
  show(); fireEvent.click(await screen.findByRole("radio", { name: /^Everyone on this server/ })); fireEvent.click(screen.getByRole("button", { name: "Save sharing" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere"); expect(screen.getByRole("radio", { name: /^Everyone on this server/ })).toBeChecked();
});
test("invitations are recipient-bound and token fragments stay outside server URLs", async () => {
  const shared = { ...initial, mode: "SHARED_READ", grants: [{ ...member, userId: member.id, role: "VIEWER" }], links: [{ id: "link", recipientUserId: "editor", recipientName: "Riley", expiresAt: Date.now() + 100000 }] };
  (getPlaylistSharing as jest.Mock).mockResolvedValue(shared); (createPlaylistInvitation as jest.Mock).mockResolvedValue({ id: "new", token: "a".repeat(64), expiresAt: Date.now() + 100000 });
  show(); await screen.findByRole("combobox", { name: "Invitation recipient" });
  fireEvent.change(screen.getByRole("combobox", { name: "Invitation recipient" }), { target: { value: "editor" } });
  fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
  const input = await screen.findByRole("textbox", { name: "Invitation link" }); expect(input).toHaveValue(`http://localhost/playlist-share#token=${"a".repeat(64)}`);
  expect(createPlaylistInvitation).toHaveBeenCalledWith("list", "owner", "editor", expect.any(AbortSignal));
  fireEvent.click(screen.getByRole("button", { name: "Revoke invitation for Riley" }));
  await waitFor(() => expect(revokePlaylistInvitation).toHaveBeenCalledWith("list", "owner", "link", expect.any(AbortSignal)));
});
test("account changes abort and discard in-flight sharing data", async () => {
  let finish!: (value: unknown) => void; (getPlaylistSharing as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = show(), signal = (getPlaylistSharing as jest.Mock).mock.calls[0][1]; mockOwner = "different";
  (getPlaylistSharing as jest.Mock).mockRejectedValue(new Error("Permission denied"));
  view.rerender(<PlaylistShareModal playlistId="list" playlistName="Household" onClose={jest.fn()} />);
  await act(async () => { finish({ ...initial, links: [{ id: "private-link", recipientName: "Secret", expiresAt: 1 }] }); });
  expect(signal.aborted).toBe(true); expect(screen.queryByText("Secret")).not.toBeInTheDocument();
});
test("dialog traps keyboard focus, closes with Escape and restores the trigger", async () => {
  const close = jest.fn(), trigger = document.createElement("button"); document.body.appendChild(trigger); trigger.focus();
  const view = show(close); const dialog = await screen.findByRole("dialog", { name: "Share Household" });
  const buttons = within(dialog).getAllByRole("button"); buttons[0].focus(); fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  fireEvent.keyDown(document, { key: "Escape" }); expect(close).toHaveBeenCalledTimes(1); view.unmount(); expect(trigger).toHaveFocus(); trigger.remove();
});
