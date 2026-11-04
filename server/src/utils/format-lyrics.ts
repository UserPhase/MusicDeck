/** Keep the provider's timing in the LRC string returned by getLyrics. */
export function formatLyrics(lines: { text: string; startMs?: number }[], offsetMs = 0): string {
  if (!lines.some(({ text }) => text.trim())) return "";
  if (!lines.every(({ startMs }) => typeof startMs === "number" && Number.isFinite(startMs) && startMs >= 0)) {
    return lines.map(({ text }) => text).join("\n").trim();
  }
  const text = lines.map(({ text, startMs }) => {
    const time = Math.round(startMs!);
    const minutes = Math.floor(time / 60_000);
    const seconds = String(Math.floor(time / 1000) % 60).padStart(2, "0");
    const milliseconds = String(time % 1000).padStart(3, "0");
    return `[${minutes}:${seconds}.${milliseconds}]${text}`;
  }).join("\n");
  return text && Number.isSafeInteger(offsetMs) && offsetMs ? `[offset:${offsetMs}]\n${text}` : text;
}
