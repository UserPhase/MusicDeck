import { gainToPerceptualVolume, perceptualVolumeToGain } from "./volume";

test("uses exact mute and full output with a perceptual midpoint", () => {
  expect(perceptualVolumeToGain(0)).toBe(0);
  expect(perceptualVolumeToGain(1)).toBe(1);
  expect(perceptualVolumeToGain(0.5)).toBeCloseTo(10 ** (-10 / 20), 8);
  expect(perceptualVolumeToGain(0.25)).toBeCloseTo(0.1, 8);
});

test("receiver volume levels round-trip to the perceptual slider", () => {
  for (const value of [0, .1, .25, .5, .75, 1]) {
    expect(gainToPerceptualVolume(perceptualVolumeToGain(value))).toBeCloseTo(value, 10);
  }
  expect(gainToPerceptualVolume(-1)).toBe(0);
  expect(gainToPerceptualVolume(2)).toBe(1);
  expect(gainToPerceptualVolume(NaN)).toBe(0);
});

test("keeps gain bounded and increases smoothly across the slider", () => {
  expect(perceptualVolumeToGain(-1)).toBe(0);
  expect(perceptualVolumeToGain(2)).toBe(1);
  for (const invalid of [NaN, Infinity, undefined, "invalid"]) {
    expect(perceptualVolumeToGain(invalid)).toBe(0);
  }
  let previous = 0;
  for (let step = 1; step <= 100; step += 1) {
    const gain = perceptualVolumeToGain(step / 100);
    expect(gain).toBeGreaterThan(previous);
    previous = gain;
  }
});
