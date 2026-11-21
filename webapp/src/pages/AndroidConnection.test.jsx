import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import AndroidConnection from "./AndroidConnection";

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }));

const settingsKey = "musicdeck:android:connection";
const gateway = "http://192.168.1.50:8080";

function submitWith(name) {
  const button = screen.getByRole("button", { name });
  const event = createEvent.submit(button.form);
  Object.defineProperty(event, "submitter", { value: button });
  fireEvent(button.form, event);
}

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
});

test("tests the entered gateway without changing the saved server, then saves it on Connect", async () => {
  invoke.mockResolvedValue(`${gateway}/`);
  render(<AndroidConnection />);
  const url = screen.getByLabelText("Server URL");
  expect(url).toHaveValue("");
  fireEvent.change(url, { target: { value: gateway } });
  fireEvent.click(screen.getByRole("checkbox"));

  submitWith("Test connection");
  expect(await screen.findByRole("status")).toHaveTextContent(gateway);
  expect(invoke).toHaveBeenLastCalledWith("connect_musicdeck_server", {
    serverUrl: gateway, localNetwork: true, open: false,
  });
  expect(localStorage.getItem(settingsKey)).toBeNull();

  submitWith("Connect");
  expect(await screen.findByDisplayValue(`${gateway}/`)).toBeInTheDocument();
  expect(invoke).toHaveBeenLastCalledWith("connect_musicdeck_server", {
    serverUrl: gateway, localNetwork: true, open: true,
  });
  expect(JSON.parse(localStorage.getItem(settingsKey))).toEqual({ serverUrl: `${gateway}/`, localNetwork: true });
});

test("reports a native connection failure and opens releases through Android", async () => {
  const error = "The API responded, but the web app was unavailable.";
  invoke.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
  render(<AndroidConnection />);
  fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: gateway } });
  submitWith("Connect");
  expect(await screen.findByRole("alert")).toHaveTextContent(error);
  expect(localStorage.getItem(settingsKey)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Android APK releases" }));
  expect(invoke).toHaveBeenLastCalledWith("open_musicdeck_android_releases");
  expect(await screen.findByRole("button", { name: "Connect", enabled: true })).toBeEnabled();
});
