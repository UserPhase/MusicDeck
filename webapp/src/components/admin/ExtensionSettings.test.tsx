import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ExtensionSettings from "./ExtensionSettings";
import { discoverExtensions, getExtensions, setExtensionEnabled, type ServerExtension } from "../../api/extensions";

jest.mock("../../api/extensions", () => ({
  getExtensions: jest.fn(), discoverExtensions: jest.fn(), setExtensionEnabled: jest.fn(),
}));
const get = jest.mocked(getExtensions), discover = jest.mocked(discoverExtensions), update = jest.mocked(setExtensionEnabled);
const extension: ServerExtension = { apiVersion: 1, id: "sonic", name: "Sonic Recommendations", version: "1.0.0",
  description: "Optional sonic analysis", entry: "index.mjs", enabled: false, status: "disabled", error: null };
beforeEach(() => {
  jest.clearAllMocks();
  get.mockResolvedValue({ extensions: [extension], issues: [] });
  discover.mockResolvedValue({ extensions: [extension], issues: [] });
  jest.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => jest.restoreAllMocks());
test("loads trusted-module inventory, confirms enablement, and disables without restarting", async () => {
  render(<ExtensionSettings />);
  const toggle = await screen.findByRole("checkbox", { name: "Enable server extension Sonic Recommendations" });
  expect(toggle).not.toBeChecked();
  expect(screen.getByText(/these modules execute on your server/i)).toBeInTheDocument();
  update.mockResolvedValueOnce({ ...extension, enabled: true, status: "enabled" });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(window.confirm).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith("sonic", true);
  expect(screen.getByRole("status")).toHaveTextContent("No container restart required");
  update.mockResolvedValueOnce(extension);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(update).toHaveBeenLastCalledWith("sonic", false);
  expect(window.confirm).toHaveBeenCalledTimes(1);
});
test("cancelled consent never executes enable; scan reports invalid installations separately", async () => {
  jest.mocked(window.confirm).mockReturnValue(false);
  discover.mockResolvedValue({ extensions: [extension], issues: ["Could not discover extension broken. Review its manifest."] });
  render(<ExtensionSettings />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /Enable server extension/ }));
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Scan extensions" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not discover extension broken");
  expect(discover).toHaveBeenCalledTimes(1);
});
test("failed activation stays disabled and provides explicit cleanup/retry state", async () => {
  const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
  render(<ExtensionSettings />);
  const toggle = await screen.findByRole("checkbox", { name: /Enable server extension/ });
  update.mockRejectedValueOnce(new Error("Extension activation failed"));
  get.mockResolvedValueOnce({ extensions: [{ ...extension, status: "error", error: "Review server logs, then disable to finish cleanup." }], issues: [] });
  fireEvent.click(toggle);
  const cleanup = await screen.findByRole("button", { name: "Finish cleanup" });
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeDisabled();
  expect(screen.getAllByRole("alert").map((node) => node.textContent).join(" ")).toMatch(/activation failed/);
  update.mockResolvedValueOnce(extension);
  fireEvent.click(cleanup);
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(update).toHaveBeenLastCalledWith("sonic", false);
  expect(errorLog).toHaveBeenCalled();
});
test("in-flight changes lock controls and duplicate clicks cannot queue another activation", async () => {
  let finish: ((value: ServerExtension) => void) | undefined;
  update.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<ExtensionSettings />);
  const toggle = await screen.findByRole("checkbox", { name: /Enable server extension/ });
  fireEvent.click(toggle); fireEvent.click(toggle);
  expect(update).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Scan extensions" })).toBeDisabled();
  expect(screen.getByText(/waits for cooperative tasks/i)).toBeInTheDocument();
  finish?.({ ...extension, enabled: true, status: "enabled" });
  await waitFor(() => expect(toggle).toBeChecked());
});
test("an unavailable inventory is an error, not an empty installation list; refresh can recover", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  get.mockRejectedValueOnce(new Error("Authentication required"));
  render(<ExtensionSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Authentication required");
  expect(screen.queryByText(/No server extensions installed/)).not.toBeInTheDocument();
  get.mockResolvedValueOnce({ extensions: [], issues: [] });
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  expect(await screen.findByText(/No server extensions installed/)).toBeInTheDocument();
});
