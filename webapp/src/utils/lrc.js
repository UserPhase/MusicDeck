/** Parse standard two/three-decimal LRC timestamps, including repeated tags. */
export function parseLrc(input) {
  if (typeof input !== "string") return [];
  const lines = [];
  input.split(/\r?\n/).forEach((raw) => {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):([0-5]\d)\.(\d{2,3})\]/g)];
    if (!stamps.length) return;
    const text = raw.slice(stamps[stamps.length - 1].index + stamps[stamps.length - 1][0].length).trim();
    stamps.forEach((stamp) => {
      const fraction = Number(stamp[3]) / (stamp[3].length === 2 ? 100 : 1000);
      lines.push({ time: Number(stamp[1]) * 60 + Number(stamp[2]) + fraction, text });
    });
  });
  return lines.sort((left, right) => left.time - right.time);
}

/** Last line whose timestamp has passed; -1 before the first lyric. */
export function activeLrcIndex(lines, currentTime) {
  if (!Array.isArray(lines) || !lines.length || !Number.isFinite(currentTime)) return -1;
  let low = 0;
  let high = lines.length - 1;
  let active = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].time <= currentTime) {
      active = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return active;
}
