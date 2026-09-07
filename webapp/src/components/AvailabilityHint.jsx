/*
 * Subtle, provider-neutral availability hint.
 *
 * Surfaces state only when it is meaningful to the listener: reduced
 * availability (some sources currently unreachable) or multiple available
 * sources. Fully available single-source items and items without
 * availability data render nothing, to avoid clutter.
 *
 * Never renders provider names, connection IDs, or provider IDs.
 */
function AvailabilityHint({ availability }) {

  const hint =
    availability && availability.state === "degraded"
      ? "Partially available"
      : availability && availability.availableSourceCount > 1
        ? `${availability.availableSourceCount} sources`
        : null;

  if (!hint) {
    return null;
  }

  return (
    <span
      className="availability-hint"
      aria-label={`Availability: ${hint}`}
      title={hint}
    >
      {hint}
    </span>
  );
}

export default AvailabilityHint;
