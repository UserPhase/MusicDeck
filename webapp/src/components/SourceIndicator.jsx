/*
 * Provider-neutral source context for normalized catalog/search results.
 * Library items rely on AvailabilityHint; external items need a small textual
 * distinction because they are discoverable but not yet playable in MusicDeck.
 */
function SourceIndicator({ source }) {
  if (source?.kind !== "external" && !source?.externalAvailable) {
    return null;
  }

  return (
    <span
      className="source-indicator"
      aria-label="Available externally"
      title="Available externally"
    >
      Available externally
    </span>
  );
}

export default SourceIndicator;
