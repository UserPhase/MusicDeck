import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RemoteSessionContext } from "../../context/RemoteSessionContext";
import type { RemoteSessionValue } from "../../types/remoteSession";
import DeviceSelectorButton from "./DeviceSelectorButton";
import { CastContext, type CastControl } from "../../context/CastContext";

function session(overrides: Partial<RemoteSessionValue> = {}): RemoteSessionValue {
  const devices = [
    { device_id: "this", device_name: "Desk", device_type: "computer" as const, can_receive: true, is_active_player: true,
      current_track: { id: "one", title: "Live set" }, position_ms: 102345, duration_ms: 600000, volume: .6, playing: true },
    { device_id: "phone", device_name: "Phone", device_type: "phone" as const, can_receive: true, is_active_player: false,
      current_track: null, position_ms: 0, duration_ms: 0, volume: .4, playing: false },
  ];
  return { devices, deviceId: "this", activeDevice: devices[0], isRemote: false, enabled: false, status: "connected", error: "", name: "Desk", busy: false,
    enable: jest.fn(async () => {}), rename: jest.fn(), command: jest.fn(async () => {}),
    transfer: jest.fn(async () => {}), clearError: jest.fn(), ...overrides };
}
test("shows live device status, traps focus, closes with Escape and restores the trigger", () => {
  render(<RemoteSessionContext.Provider value={session()}><DeviceSelectorButton /></RemoteSessionContext.Provider>);
  const trigger = screen.getByRole("button", { name: "Choose playback device" });
  trigger.focus(); fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Choose where it plays." })).toBeInTheDocument();
  const close = screen.getByRole("button", { name: "Close device selector" });
  expect(close).toHaveFocus();
  expect(screen.getByText("Live set / 1:42")).toBeInTheDocument();
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(screen.getByRole("button", { name: "Transfer playback to Phone" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
test("enables local reception, transfers to a ready target and supports pointer or assistive volume input", async () => {
  const value = session();
  render(<RemoteSessionContext.Provider value={value}><DeviceSelectorButton /></RemoteSessionContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Choose playback device" }));
  fireEvent.click(screen.getByRole("button", { name: "Enable playback on this device" }));
  await waitFor(() => expect(value.enable).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Transfer playback to Phone" }));
  await waitFor(() => expect(value.transfer).toHaveBeenCalledWith("phone"));
  const slider = screen.getByRole("slider", { name: "Volume on Phone" });
  fireEvent.pointerDown(slider); fireEvent.change(slider, { target: { value: ".8" } });
  expect(value.command).toHaveBeenCalledWith({ type: "SET_VOLUME", volume: .8 }, "phone");
  fireEvent.pointerUp(slider);
  fireEvent.change(slider, { target: { value: ".5" } });
  expect(value.command).toHaveBeenLastCalledWith({ type: "SET_VOLUME", volume: .5 }, "phone");
});
test("disconnected, busy and error states disable unsafe actions and remain explicit", () => {
  const value = session({ status: "reconnecting", busy: true, error: "Target disconnected. Resume manually." });
  render(<RemoteSessionContext.Provider value={value}><DeviceSelectorButton /></RemoteSessionContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Choose playback device" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Resume manually");
  expect(screen.getByRole("button", { name: "Transfer playback to Phone" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Enable playback on this device" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(value.clearError).toHaveBeenCalledTimes(1);
});

test("unlocks this phone from the Play here tap before requesting playback", async () => {
  const value = session({ deviceId: "phone", enabled: false, isRemote: true });
  value.devices[1].can_receive = false;
  render(<RemoteSessionContext.Provider value={value}><DeviceSelectorButton /></RemoteSessionContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Choose playback device" }));
  fireEvent.click(screen.getByRole("button", { name: "Transfer playback to Phone" }));
  await waitFor(() => expect(value.transfer).toHaveBeenCalledWith("phone"));
  expect(value.enable).toHaveBeenCalledTimes(1);
  expect(jest.mocked(value.enable).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(value.transfer).mock.invocationCallOrder[0]);
});

test("Google Cast is grouped in the same device dialog and starts only from an explicit user action", async () => {
  const cast: CastControl = { available: false, connected: false, device: "", loading: false, error: "", volume: null,
    supported: true, allowed: true, connect: jest.fn(async () => {}), disconnect: jest.fn(async () => {}) };
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
  render(<RemoteSessionContext.Provider value={session()}><CastContext.Provider value={cast}><DeviceSelectorButton /></CastContext.Provider></RemoteSessionContext.Provider>);
  const trigger = screen.getByRole("button", { name: "Choose playback device" });
  trigger.focus(); fireEvent.click(trigger);
  expect(screen.getByRole("region", { name: "Google Cast" })).toBeInTheDocument();
  expect(cast.connect).not.toHaveBeenCalled();
  const button = screen.getByRole("button", { name: "Cast to a speaker" });
  fireEvent.keyDown(screen.getByRole("button", { name: "Close device selector" }), { key: "Tab", shiftKey: true });
  expect(button).toHaveFocus();
  fireEvent.click(button);
  await waitFor(() => expect(cast.connect).toHaveBeenCalledTimes(1));
  expect(confirm).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(button, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  confirm.mockRestore();
});

test("an active Cast receiver is reflected in the device trigger and can disconnect inside the panel", async () => {
  const cast: CastControl = { available: true, connected: true, device: "Living Room", loading: false, error: "", volume: .5,
    supported: true, allowed: true, connect: jest.fn(async () => {}), disconnect: jest.fn(async () => {}) };
  render(<CastContext.Provider value={cast}><DeviceSelectorButton compact /></CastContext.Provider>);
  const trigger = screen.getByRole("button", { name: "Choose playback device" });
  expect(trigger).toHaveAttribute("title", "Playing on Living Room");
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "Stop casting to Living Room" }));
  await waitFor(() => expect(cast.disconnect).toHaveBeenCalledTimes(1));
});
