import { collectorMetadata, type CollectorItem } from "../../hooks/useCollectorFilters";
import "../../styles/collector.css";
import "../../styles/audio-inspector.css";

const losslessFormats = new Set(["FLAC", "ALAC", "WAV", "AIFF", "Hi-Res"]);
export function EditionBadges({ item, showFormats = true, formatOnly = false }: { item: CollectorItem; showFormats?: boolean; formatOnly?: boolean }) {
  const { format, formats, bitrateKbps, remaster } = collectorMetadata(item);
  const formatLabels = formats.map(format => format === "24-bit Hi-Res" ? "Hi-Res" : format);
  const labels = formatOnly ? (showFormats && format ? [format] : []) : [
    ...(showFormats ? formatLabels : []),
    ...(showFormats && bitrateKbps && !formatLabels.some(label => losslessFormats.has(label)) ? [`${bitrateKbps}k`] : []),
    ...(remaster ? ["Remaster"] : []),
  ];
  if (!labels.length) return null;
  return <span className="collector-editions">{labels.map(label => <span key={label}
    className={`audio-quality-badge${losslessFormats.has(label) ? " is-lossless" : ""}`}>{label}</span>)}</span>;
}
