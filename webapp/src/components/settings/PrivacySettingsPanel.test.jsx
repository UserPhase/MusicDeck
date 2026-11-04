import { act, fireEvent, render, screen } from "@testing-library/react";
import PrivacySettingsPanel from "./PrivacySettingsPanel";

let mockRole = "admin";
let mockPrivacy;
jest.mock("../../context/AuthContext", () => ({ useAuth: () => ({ session: { role: mockRole } }) }));
jest.mock("../../context/PrivacyContext", () => ({ usePrivacy: () => mockPrivacy }));
beforeEach(() => {
  mockRole = "admin";
  mockPrivacy = { policy: { localOnly: false, allowMetadata: true, allowImports: true, allowArtwork: true,
    enforcedByEnvironment: false }, busy: false, error: "", save: jest.fn().mockResolvedValue(), refresh: jest.fn() };
});
afterEach(() => jest.restoreAllMocks());
test("saves the complete policy without optimistically changing a switch", async () => {
  render(<PrivacySettingsPanel />);
  const control = screen.getByRole("checkbox", { name: "Enable Local-Only Mode" });
  await act(async () => { fireEvent.click(control); });
  expect(mockPrivacy.save).toHaveBeenCalledWith({ localOnly: true, allowMetadata: true, allowImports: true, allowArtwork: true });
  expect(control).not.toBeChecked();
  expect(screen.getByRole("status")).toHaveTextContent("Server privacy policy saved");
});
test("master mode keeps stored permissions but disables their controls", () => {
  mockPrivacy.policy.localOnly = true;
  render(<PrivacySettingsPanel />);
  expect(screen.getByRole("checkbox", { name: "Enable Local-Only Mode" })).toBeEnabled();
  for (const checkbox of screen.getAllByRole("checkbox").slice(1)) {
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
  }
});
test.each(["user", "guest"])("non-admin %s cannot change global policy", (role) => {
  mockRole = role;
  render(<PrivacySettingsPanel />);
  for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).toBeDisabled();
});
test("an environment lock cannot be overridden", () => {
  mockPrivacy.policy.enforcedByEnvironment = true;
  render(<PrivacySettingsPanel />);
  expect(screen.getByRole("status")).toHaveTextContent("enforced by the server environment");
  for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).toBeDisabled();
});
test("a failed save reports the error rather than a success message", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockPrivacy.save.mockRejectedValue(new Error("Permission denied"));
  render(<PrivacySettingsPanel />);
  await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "Enable Local-Only Mode" })); });
  expect(screen.getByRole("alert")).toHaveTextContent("Permission denied");
  expect(screen.queryByText(/Server privacy policy saved/)).not.toBeInTheDocument();
});
