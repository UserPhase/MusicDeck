import { useId } from "react";

import { WEEKDAYS, configToCron, formatScheduleSummary } from "../../utils/cronUtils";

const FREQUENCIES = [
  { value: "disabled", label: "Disabled / Manual only" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

/**
 * Controlled picker for the library scan schedule. `value` is a
 * `{ frequency, dayOfWeek, time }` config (see cronUtils). When the stored
 * expression could not be mapped onto the picker, pass it as
 * `legacyExpression` so the admin can see it and choose to reset.
 */
export default function ScanSchedulePicker({ value, onChange, legacyExpression = null, onReset, timezone, disabled = false }) {
  const id = useId();
  const enabled = value.frequency !== "disabled";
  const cron = configToCron(value);

  function update(patch) {
    onChange({ ...value, ...patch });
  }

  return (
    <fieldset className="scan-schedule" disabled={disabled}>
      <legend>Library scan schedule</legend>

      {legacyExpression && (
        <div className="scan-schedule__legacy" role="status">
          <p>
            The saved schedule <code>{legacyExpression}</code> can't be edited here and is kept as-is until you
            change it. The fields below show the suggested default.
          </p>
          {onReset && (
            <button type="button" className="scan-schedule__reset" onClick={onReset}>
              Reset to Daily at 03:00
            </button>
          )}
        </div>
      )}

      <div className="scan-schedule__fields">
        <label htmlFor={`${id}-frequency`}>
          <span>Frequency</span>
          <select
            id={`${id}-frequency`}
            value={value.frequency}
            onChange={(event) => update({ frequency: event.target.value })}
          >
            {FREQUENCIES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        {value.frequency === "weekly" && (
          <label htmlFor={`${id}-day`}>
            <span>Day of week</span>
            <select
              id={`${id}-day`}
              value={value.dayOfWeek}
              onChange={(event) => update({ dayOfWeek: Number(event.target.value) })}
            >
              {WEEKDAYS.map((day, index) => (
                <option key={day} value={index}>{day}</option>
              ))}
            </select>
          </label>
        )}

        {enabled && (
          <label htmlFor={`${id}-time`}>
            <span>Time</span>
            <input
              id={`${id}-time`}
              type="time"
              step="60"
              required
              value={value.time}
              onChange={(event) => update({ time: event.target.value })}
            />
          </label>
        )}
      </div>

      <div className={`scan-schedule__summary${enabled ? " is-active" : ""}`} aria-live="polite">
        <span className="scan-schedule__dot" aria-hidden="true" />
        <strong>{formatScheduleSummary(value)}</strong>
        {enabled && (
          <span className="scan-schedule__meta">
            {timezone ? `${timezone} · ` : ""}
            <code title="Stored cron expression">{cron}</code>
          </span>
        )}
      </div>
    </fieldset>
  );
}
