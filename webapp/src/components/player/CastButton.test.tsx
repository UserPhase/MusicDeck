import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CastButton from "./CastButton";
import { CastContext } from "../../context/CastContext";
import type { CastControl } from "../../context/CastContext";

function setup(patch: Partial<CastControl> = {}) {
  const cast: CastControl = { available: false, connected: false, device: "", loading: false, error: "", volume: null,
    supported: true, allowed: true, connect: jest.fn(async () => {}), disconnect: jest.fn(async () => {}), ...patch };
  render(<CastContext.Provider value={cast}><CastButton /></CastContext.Provider>);
  return cast;
}
afterEach(() => { jest.restoreAllMocks(); });
test("requires consent before loading the external SDK and connects from a user action", async () => {
  const confirm = jest.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  const cast = setup();
  fireEvent.click(screen.getByRole("button", { name: "Cast to a speaker" }));
  expect(cast.connect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cast to a speaker" }));
  await waitFor(() => expect(cast.connect).toHaveBeenCalledTimes(1));
  expect(confirm).toHaveBeenCalledTimes(2);
});
test("unsupported and privacy-blocked browsers expose a disabled control with an explanation", () => {
  setup({ supported: false });
  expect(screen.getByRole("button")).toBeDisabled();
  expect(screen.getByRole("button")).toHaveAttribute("title", expect.stringContaining("Chromium"));
});
test("stopping Cast needs no new SDK consent and surfaces failures", async () => {
  const cast = setup({ connected: true, device: "Living Room", disconnect: jest.fn(async () => { throw new Error("Receiver lost"); }) });
  fireEvent.click(screen.getByRole("button", { name: "Stop casting to Living Room" }));
  await waitFor(() => expect(cast.disconnect).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole("alert")).toHaveTextContent("Receiver lost");
});
