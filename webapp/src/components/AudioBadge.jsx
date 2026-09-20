const LOSSLESS_TYPES = new Set(["flac", "lossless", "alac", "wav", "aiff"]);
const PREVIEW_TYPES = new Set(["preview", "sample", "clip"]);

function badgeDetails(type, bitrate) {
  const normalizedType = String(type || "").trim().toLowerCase();
  const numericBitrate = Number(bitrate);

  if (PREVIEW_TYPES.has(normalizedType)) {
    return { label: "Preview", tone: "preview" };
  }

  if (LOSSLESS_TYPES.has(normalizedType)) {
    return { label: "Lossless", tone: "lossless" };
  }

  if (Number.isFinite(numericBitrate) && numericBitrate >= 320) {
    return { label: `${Math.round(numericBitrate)}K`, tone: "high" };
  }

  if (normalizedType === "high" || normalizedType === "hq" || normalizedType === "320") {
    return { label: "320K", tone: "high" };
  }

  if (Number.isFinite(numericBitrate) && numericBitrate > 0) {
    return { label: `${Math.round(numericBitrate)}K`, tone: "standard" };
  }

  return { label: "Standard", tone: "standard" };
}

function AudioBadge({ type, bitrate, className = "", title }) {
  const { label, tone } = badgeDetails(type, bitrate);

  return (
    <span
      className={`audio-badge audio-badge-${tone} ${className}`.trim()}
      title={title || `${label} audio`}
    >
      {label}
    </span>
  );
}

export default AudioBadge;
