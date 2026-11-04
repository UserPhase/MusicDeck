import { fireEvent, render, screen } from "@testing-library/react";
import EqualizerSettings from "./EqualizerSettings";

test("recovers when a hot update retains parametric mode without its bands", () => {
  let settings = { bandCount: 5, preset: "Bass Boost", custom: [0, 0, 0, 0, 0], mode: "parametric", enabled: true };
  const engine = {
    equalizerAvailable: true,
    getEqualizerSettings: () => settings,
    setEqualizerSettings: jest.fn(next => { settings = next; return true; }),
  };
  render(<EqualizerSettings engine={engine} local />);

  const frequency = screen.getByRole("spinbutton", { name: "Band 1 Frequency (Hz)" });
  expect(frequency).toHaveValue(60);
  fireEvent.change(frequency, { target: { value: "3200" } });
  fireEvent.blur(frequency);
  expect(settings.parametric[0].frequency).toBe(3200);

  fireEvent.change(screen.getByRole("combobox", { name: "Equalizer mode" }), { target: { value: "graphic" } });
  expect(screen.getByRole("combobox", { name: "Equalizer preset" })).toHaveValue("Bass Boost");
});
