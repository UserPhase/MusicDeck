export const ACCENT_COLORS = [
  { id: "command-amber", label: "Command Amber", value: "#F59E0B" },
  { id: "electric-cyan", label: "Electric Cyan", value: "#06B6D4" },
  { id: "pro-violet", label: "Pro Violet", value: "#A855F7" },
  { id: "signal-crimson", label: "Signal Crimson", value: "#F43F5E" },
  { id: "vinyl-mint", label: "Vinyl Mint", value: "#10B981" },
];

export const DEFAULT_ACCENT_COLOR = "#A855F7";

export function normalizeAccentColor(value) {
  return ACCENT_COLORS.some((accent) => accent.value === value)
    ? value
    : DEFAULT_ACCENT_COLOR;
}
