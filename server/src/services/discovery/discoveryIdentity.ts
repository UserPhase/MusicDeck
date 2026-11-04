/** Featuring markers must be whole words: the "ft" in "Daft Punk" or
 * "Soft Landing" is part of the name, not the start of a featured artist. */
export function normalizeDiscoveryText(value: string | null | undefined): string {
  return (value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/\s+(?:[-,]\s*)?(?:feat(?:uring)?|ft)\.?\s+.+$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ").toLowerCase();
}
