import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";

import PlayerSettings from "./PlayerSettings";

function renderSettings(props = {}) {
  const handlers = {
    onTransitionModeChange: jest.fn(),
    onCrossfadeDurationChange: jest.fn(),
  };
  render(
    <PlayerSettings
      transitionMode="gapless"
      crossfadeDuration={5}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

function ControlledSettings({ initialMode = "gapless", onModeChange = () => {} }) {
  const [mode, setMode] = useState(initialMode);
  const [seconds, setSeconds] = useState(5);
  return (
    <PlayerSettings
      transitionMode={mode}
      crossfadeDuration={seconds}
      onTransitionModeChange={(next) => { setMode(next); onModeChange(next); }}
      onCrossfadeDurationChange={setSeconds}
    />
  );
}

test("exposes the three transition modes as one labelled radio group", () => {
  renderSettings();
  const group = screen.getByRole("group", { name: "Track transitions" });
  const radios = within(group).getAllByRole("radio");
  expect(radios.map((radio) => radio.closest("label").textContent)).toEqual(["Off", "Gapless", "Crossfade"]);
  radios.forEach((radio) => expect(group).toContainElement(radio));
  expect(screen.getByRole("radio", { name: "Gapless" })).toBeChecked();
  expect(group).toHaveAccessibleDescription(/without silence between tracks/i);
});

test("shuffle modes have their own accessible control and don't alter transitions", () => {
  const onShuffleModeChange = jest.fn();
  const { onTransitionModeChange } = renderSettings({ shuffleMode: "smart", onShuffleModeChange });
  const group = screen.getByRole("group", { name: "Shuffle mode" });
  expect(within(group).getByRole("radio", { name: "Smart Shuffle" })).toBeChecked();
  fireEvent.click(within(group).getByRole("radio", { name: "Standard Shuffle" }));
  expect(onShuffleModeChange).toHaveBeenCalledWith("standard");
  expect(onTransitionModeChange).not.toHaveBeenCalled();
});

test("album policy is an independent accessible toggle", () => {
  const onAlbumAwareChange = jest.fn();
  const { onTransitionModeChange } = renderSettings({ isAlbumAware: true, onAlbumAwareChange });
  const toggle = screen.getByRole("checkbox", { name: "Album-aware playback" });
  expect(toggle).toBeChecked();
  expect(toggle).toHaveAccessibleDescription(/preserve recorded pauses/i);
  fireEvent.click(toggle);
  expect(onAlbumAwareChange).toHaveBeenCalledWith(false);
  expect(onTransitionModeChange).not.toHaveBeenCalled();
});

test("the crossfade slider is limited to 1-10 seconds and only enabled in crossfade mode", () => {
  const { onCrossfadeDurationChange } = renderSettings({ transitionMode: "crossfade", crossfadeDuration: 3 });
  const slider = screen.getByRole("slider", { name: "Crossfade duration" });
  expect(slider).toBeEnabled();
  expect(slider).toHaveAttribute("min", "1");
  expect(slider).toHaveAttribute("max", "10");
  expect(slider).toHaveAttribute("aria-valuetext", "3 seconds");
  expect(screen.getByText("3 s")).toBeInTheDocument();

  fireEvent.change(slider, { target: { value: "8" } });
  expect(onCrossfadeDurationChange).toHaveBeenCalledWith(8);
});

test("out-of-range durations are shown clamped", () => {
  renderSettings({ transitionMode: "crossfade", crossfadeDuration: 12 });
  expect(screen.getByRole("slider", { name: "Crossfade duration" })).toHaveValue("10");
  expect(screen.getByText("10 s")).toBeInTheDocument();
});

test("gapless and off keep the saved duration but disable the slider", () => {
  renderSettings({ transitionMode: "none", crossfadeDuration: 7 });
  const slider = screen.getByRole("slider", { name: "Crossfade duration" });
  expect(slider).toBeDisabled();
  expect(slider).toHaveValue("7");
  expect(slider).toHaveAccessibleDescription(/select crossfade above/i);
});

test("selecting a mode reports it and updates the controlled state", () => {
  const onModeChange = jest.fn();
  render(<ControlledSettings onModeChange={onModeChange} />);
  const slider = screen.getByRole("slider", { name: "Crossfade duration" });

  fireEvent.click(screen.getByRole("radio", { name: "Crossfade" }));
  expect(onModeChange).toHaveBeenLastCalledWith("crossfade");
  expect(screen.getByRole("radio", { name: "Crossfade" })).toBeChecked();
  expect(slider).toBeEnabled();

  fireEvent.click(screen.getByRole("radio", { name: "Off" }));
  expect(onModeChange).toHaveBeenLastCalledWith("none");
  expect(slider).toBeDisabled();
});
