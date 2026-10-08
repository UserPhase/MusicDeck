/**
 * Bridges the admin scan-schedule picker and the 5-field cron expressions the
 * server stores in `library.scanSchedule`. Only the shapes the picker can
 * produce are "recognized"; anything else is reported as unsupported so the UI
 * can show the raw value instead of silently rewriting it.
 */

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const DEFAULT_SCHEDULE = Object.freeze({ frequency: "daily", dayOfWeek: 0, time: "03:00" });

const DISABLED_ALIASES = new Set(["", "disabled", "manual", "none", "off", "never", "not scheduled"]);
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseIntField(field, min, max) {
  if (!/^\d{1,2}$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

function parseDayField(field) {
  const numeric = parseIntField(field, 0, 7);
  if (numeric !== null) return numeric % 7; // cron allows 7 for Sunday
  const index = DAY_NAMES.indexOf(field.toLowerCase());
  return index === -1 ? null : index;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function normalizeTime(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || "").trim());
  if (!match) return DEFAULT_SCHEDULE.time;
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${pad(hour)}:${pad(minute)}`;
}

/**
 * @returns {{ config: {frequency: "disabled"|"daily"|"weekly", dayOfWeek: number, time: string},
 *             status: "empty"|"recognized"|"unsupported", raw: string }}
 */
export function parseCronSchedule(cronString) {
  const raw = typeof cronString === "string" ? cronString.trim().replace(/\s+/g, " ") : "";

  if (DISABLED_ALIASES.has(raw.toLowerCase())) {
    return { config: { ...DEFAULT_SCHEDULE, frequency: "disabled" }, status: "empty", raw };
  }

  const fields = raw.split(" ");
  if (fields.length === 5) {
    const [minuteField, hourField, dayOfMonth, month, dayOfWeekField] = fields;
    const minute = parseIntField(minuteField, 0, 59);
    const hour = parseIntField(hourField, 0, 23);

    if (minute !== null && hour !== null && dayOfMonth === "*" && month === "*") {
      const time = `${pad(hour)}:${pad(minute)}`;
      if (dayOfWeekField === "*") {
        return { config: { frequency: "daily", dayOfWeek: 0, time }, status: "recognized", raw };
      }
      const dayOfWeek = parseDayField(dayOfWeekField);
      if (dayOfWeek !== null) {
        return { config: { frequency: "weekly", dayOfWeek, time }, status: "recognized", raw };
      }
    }
  }

  return { config: { ...DEFAULT_SCHEDULE }, status: "unsupported", raw };
}

/** Unsupported/legacy expressions fall back to Daily at 03:00. */
export function parseCronToConfig(cronString) {
  return parseCronSchedule(cronString).config;
}

/** Disabled schedules serialize to an empty string, which the server treats as "off". */
export function configToCron(config) {
  if (!config || config.frequency === "disabled") return "";
  const [hour, minute] = normalizeTime(config.time).split(":").map(Number);
  if (config.frequency === "weekly") {
    const day = Number.isInteger(config.dayOfWeek) && config.dayOfWeek >= 0 && config.dayOfWeek <= 6 ? config.dayOfWeek : 0;
    return `${minute} ${hour} * * ${day}`;
  }
  return `${minute} ${hour} * * *`;
}

/** "03:00" → "03:00 AM", "15:30" → "03:30 PM". */
export function formatTime12h(time) {
  const [hour, minute] = normalizeTime(time).split(":").map(Number);
  const suffix = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${pad(hour12)}:${pad(minute)} ${suffix}`;
}

export function formatScheduleSummary(config) {
  if (!config || config.frequency === "disabled") return "Automatic scans are disabled";
  const time = formatTime12h(config.time);
  if (config.frequency === "weekly") {
    return `Scans automatically every ${WEEKDAYS[config.dayOfWeek] ?? WEEKDAYS[0]} at ${time}`;
  }
  return `Scans automatically every day at ${time}`;
}
