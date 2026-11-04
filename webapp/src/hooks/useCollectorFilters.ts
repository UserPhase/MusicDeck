import { useMemo } from "react";

export type CollectorItem = {
  id: string | number;
  title?: string;
  name?: string;
  album?: string;
  year?: number | null;
  audioMetadata?: unknown;
  metadata?: Record<string, unknown>;
};
export type CollectorFilters = {
  from: string;
  to: string;
  genre: string;
  format: string;
  source: string;
};
export const emptyCollectorFilters: CollectorFilters = { from: "", to: "", genre: "", format: "", source: "" };
export const hasCollectorFilters = (filters: CollectorFilters) => Object.values(filters).some(Boolean);
export const collectorFormats = ["FLAC", "24-bit Hi-Res", "MP3", "AAC", "ALAC", "WAV", "AIFF", "Opus", "Vorbis", "WMA"];
export const collectorSources = ["Navidrome", "Jellyfin"];
const audioFormats: Record<string, string> = {
  flac: "FLAC", mp3: "MP3", mpeg: "MP3", aac: "AAC", aacp: "AAC", "aac-latm": "AAC", aac_latm: "AAC", "mp4a-latm": "AAC",
  alac: "ALAC", wav: "WAV", wave: "WAV", "vnd.wave": "WAV", aif: "AIFF", aiff: "AIFF",
  opus: "Opus", vorbis: "Vorbis", wma: "WMA", "ms-wma": "WMA", wmav1: "WMA", wmav2: "WMA",
  wavpack: "WavPack", wv: "WavPack",
};
const unknownFormats = new Set(["unknown", "none", "null", "undefined", "octet-stream"]);

function formatToken(value: unknown) {
  if (typeof value !== "string") return "";
  const token = value.split(";", 1)[0].trim().toLowerCase().replace(/^(?:audio|application)\//, "").replace(/^(?:x-|\.)/, "");
  return /^[a-z0-9][a-z0-9._+-]{0,31}$/.test(token) && !unknownFormats.has(token) ? token : "";
}

export function collectorMetadata(item: CollectorItem) {
  const meta = item.metadata ?? {};
  const audio = (meta.audioMetadata ?? item.audioMetadata) as { codec?: string; container?: string; bitDepth?: number; sampleRateHz?: number; bitrateKbps?: number } | undefined;
  const formats = new Set(Array.isArray(meta.formats) ? meta.formats.filter((value): value is string =>
    typeof value === "string" && collectorFormats.includes(value)) : []);
  const codec = formatToken(audio?.codec);
  const container = formatToken(audio?.container);
  const format = (Object.hasOwn(audioFormats, codec) ? audioFormats[codec] : undefined)
    ?? (Object.hasOwn(audioFormats, container) ? audioFormats[container] : undefined)
    ?? ((codec || container).toUpperCase() || [...formats].find((label) => label !== "24-bit Hi-Res"));
  if (format) formats.add(format);
  if (Number(audio?.bitDepth) >= 24 && Number(audio?.sampleRateHz) > 48000) formats.add("24-bit Hi-Res");
  const source = collectorSources.find(value => value.toLowerCase() === meta.sourceServer);
  return {
    year: Number(item.year ?? meta.year) || 0,
    genres: Array.isArray(meta.genres) ? meta.genres.filter((genre): genre is string => typeof genre === "string").map(genre => genre.trim()).filter(Boolean) : [],
    formats: [...formats],
    format,
    bitrateKbps: Number.isFinite(audio?.bitrateKbps) && Number(audio?.bitrateKbps) > 0 ? Math.round(Number(audio?.bitrateKbps)) : null,
    source,
    remaster: Boolean(meta.remaster) || /\bremaster(?:ed)?\b/i.test([item.title, item.name, item.album].join(" ")),
  };
}

export function createCollectorIndex<T extends CollectorItem>(items: readonly T[]) {
  const words = Math.ceil(items.length / 32);
  const genres = new Map<string, string>();
  const genrePositions = new Map<string, number[]>();
  const facets = new Map<string, Uint32Array>();
  const years = new Map<number, Uint32Array>();
  function add<K>(map: Map<K, Uint32Array>, key: K, position: number) {
    let bits = map.get(key);
    if (!bits) {
      bits = new Uint32Array(words);
      map.set(key, bits);
    }
    bits[position >>> 5] |= 1 << (position & 31);
  }
  items.forEach((item, position) => {
    const metadata = collectorMetadata(item);
    if (metadata.year) add(years, metadata.year, position);
    if (metadata.source) add(facets, `source:${metadata.source}`, position);
    for (const format of metadata.formats) add(facets, `format:${format}`, position);
    for (const genre of metadata.genres) {
      const key = genre.toLowerCase();
      if (!genres.has(key)) {
        genres.set(key, genre);
        genrePositions.set(key, []);
      }
      genrePositions.get(key)!.push(position);
    }
  });
  return {
    genres: [...genres].sort((left, right) => left[1].localeCompare(right[1])),
    filter(filters: CollectorFilters): readonly T[] {
      if (!hasCollectorFilters(filters)) return items;
      const masks: (Uint32Array | undefined)[] = [];
      for (const key of ["format", "source"] as const) {
        if (filters[key]) masks.push(facets.get(`${key}:${filters[key]}`));
      }
      if (filters.genre) {
        const positions = genrePositions.get(filters.genre);
        if (!positions) return [];
        const genreMask = new Uint32Array(words);
        for (const position of positions) genreMask[position >>> 5] |= 1 << (position & 31);
        masks.push(genreMask);
      }
      if (filters.from || filters.to) {
        const range = new Uint32Array(words);
        for (const [year, bits] of years) {
          if (year < Number(filters.from || 1950) || year > Number(filters.to || 2026)) continue;
          for (let word = 0; word < words; word++) range[word] |= bits[word];
        }
        masks.push(range);
      }
      if (masks.some(mask => !mask)) return [];
      const result: T[] = [];
      for (let word = 0; word < words; word++) {
        let bits = -1;
        for (const mask of masks) bits &= mask![word];
        while (bits) {
          const position = word * 32 + 31 - Math.clz32(bits & -bits);
          if (position < items.length) result.push(items[position]);
          bits &= bits - 1;
        }
      }
      return result;
    },
  };
}

export function useCollectorFilters<T extends CollectorItem>(
  items: readonly T[], filters: CollectorFilters,
) {
  const index = useMemo(() => createCollectorIndex(items), [items]);
  return { genres: index.genres, items: useMemo(() => index.filter(filters), [index, filters]) };
}
