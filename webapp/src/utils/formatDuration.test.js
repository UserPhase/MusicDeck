import { formatDuration } from "./formatDuration";


test("formats seconds as minutes:seconds", () => {
  expect(formatDuration(65)).toBe("1:05");
  expect(formatDuration(600)).toBe("10:00");
});


test("returns 0:00 for zero, undefined, or null", () => {
  expect(formatDuration(0)).toBe("0:00");
  expect(formatDuration(undefined)).toBe("0:00");
  expect(formatDuration(null)).toBe("0:00");
});

