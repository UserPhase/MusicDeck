import {
  configToCron,
  formatScheduleSummary,
  formatTime12h,
  parseCronSchedule,
  parseCronToConfig,
} from "./cronUtils";

describe("parseCronSchedule", () => {
  test.each([
    ["0 3 * * *", { frequency: "daily", dayOfWeek: 0, time: "03:00" }],
    ["30 22 * * *", { frequency: "daily", dayOfWeek: 0, time: "22:30" }],
    ["0 3 * * 0", { frequency: "weekly", dayOfWeek: 0, time: "03:00" }],
    ["15 4 * * 7", { frequency: "weekly", dayOfWeek: 0, time: "04:15" }],
    ["5 1 * * FRI", { frequency: "weekly", dayOfWeek: 5, time: "01:05" }],
    ["  0   3 * * 6 ", { frequency: "weekly", dayOfWeek: 6, time: "03:00" }],
  ])("recognizes %s", (cron, config) => {
    expect(parseCronSchedule(cron)).toMatchObject({ status: "recognized", config });
  });

  test.each(["", "disabled", "Not scheduled", null, undefined])("treats %s as disabled", (cron) => {
    expect(parseCronSchedule(cron)).toMatchObject({ status: "empty", config: { frequency: "disabled" } });
  });

  test.each(["*/15 * * * *", "0 3 1 * *", "0 3 * * 1-5", "0 0 3 * * *", "nightly", "0 25 * * *"])(
    "falls back to daily 03:00 for unsupported %s",
    (cron) => {
      expect(parseCronSchedule(cron)).toMatchObject({
        status: "unsupported",
        config: { frequency: "daily", time: "03:00" },
      });
      expect(parseCronToConfig(cron)).toEqual({ frequency: "daily", dayOfWeek: 0, time: "03:00" });
    }
  );
});

describe("configToCron", () => {
  test("serializes each frequency", () => {
    expect(configToCron({ frequency: "disabled", dayOfWeek: 0, time: "03:00" })).toBe("");
    expect(configToCron({ frequency: "daily", dayOfWeek: 4, time: "03:00" })).toBe("0 3 * * *");
    expect(configToCron({ frequency: "weekly", dayOfWeek: 0, time: "03:00" })).toBe("0 3 * * 0");
    expect(configToCron({ frequency: "weekly", dayOfWeek: 3, time: "23:45" })).toBe("45 23 * * 3");
  });

  test("round-trips through the parser", () => {
    for (const cron of ["0 3 * * *", "30 14 * * 2", "0 0 * * 6"]) {
      expect(configToCron(parseCronToConfig(cron))).toBe(cron);
    }
  });

  test("repairs a malformed time", () => {
    expect(configToCron({ frequency: "daily", time: "" })).toBe("0 3 * * *");
  });
});

describe("formatScheduleSummary", () => {
  test("describes each frequency with a padded 12-hour time", () => {
    expect(formatScheduleSummary({ frequency: "disabled" })).toBe("Automatic scans are disabled");
    expect(formatScheduleSummary({ frequency: "daily", time: "03:00" })).toBe("Scans automatically every day at 03:00 AM");
    expect(formatScheduleSummary({ frequency: "weekly", dayOfWeek: 0, time: "03:00" })).toBe(
      "Scans automatically every Sunday at 03:00 AM"
    );
  });

  test("handles noon and midnight", () => {
    expect(formatTime12h("00:00")).toBe("12:00 AM");
    expect(formatTime12h("12:30")).toBe("12:30 PM");
    expect(formatTime12h("15:05")).toBe("03:05 PM");
  });
});
