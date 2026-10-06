/*
 * Provider-neutral source context for normalized catalog/search results.
 * A compact label keeps external availability visible without extending the
 * track title line.
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
      External
    </span>
  );
}

export default SourceIndicator;
