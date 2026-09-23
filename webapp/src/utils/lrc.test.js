import { activeLrcIndex, parseLrc } from "./lrc";

test("parses centiseconds, milliseconds, repeated timestamps, and instrumental markers", () => {
  expect(parseLrc("[ar:Queen]\n[00:00.00] ♪\n[00:15.22] Caught in a landslide\n[00:17.203][00:18.203] Again"))
    .toEqual([
      { time: 0, text: "♪" },
      { time: 15.22, text: "Caught in a landslide" },
      { time: 17.203, text: "Again" },
      { time: 18.203, text: "Again" },
    ]);
});

test("finds the sung line on playback and seeks without scanning the whole file", () => {
  const lines = parseLrc("[00:10.00] One\n[00:20.00] Two\n[00:30.00] Three");
  expect(activeLrcIndex(lines, 0)).toBe(-1);
  expect(activeLrcIndex(lines, 10)).toBe(0);
  expect(activeLrcIndex(lines, 24)).toBe(1);
  expect(activeLrcIndex(lines, 90)).toBe(2);
  expect(activeLrcIndex(lines, Number.NaN)).toBe(-1);
});
