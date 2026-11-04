import { useEffect, useRef, useState } from "react";
import { downloadKey, downloadTransaction, readDownload } from "../services/storage/offlineDatabase";
import { parseLrc } from "../utils/lrc";

export const LYRICS_STEP_MS = 250;
export const MAX_LYRICS_OFFSET_MS = 5000;
export const MAX_REPLACEMENT_LENGTH = 100_000;
export type LyricLine = { timestampMs: number; text: string };
type Preference = { offsetMs: number; replacement: string | null };
type StoredPreference = Preference & { key: string; owner: string };
const defaults: Preference = { offsetMs: 0, replacement: null };

export function normalizeLyricLines(input: unknown): LyricLine[] {
  const lines: unknown[] = typeof input === "string" ? parseLrc(input) : Array.isArray(input) ? input : [];
  return lines.flatMap(line => {
    if (!line || typeof line !== "object") return [];
    const { time, timestampMs, text } = line as { time?: number; timestampMs?: number; text?: string };
    const milliseconds = timestampMs ?? (typeof time === "number" ? Math.round(time * 1000) : NaN);
    return Number.isSafeInteger(milliseconds) && milliseconds >= 0 && typeof text === "string"
      ? [{ timestampMs: milliseconds, text }] : [];
  }).sort((left, right) => left.timestampMs - right.timestampMs);
}

export function activeLyricIndex(lines: readonly LyricLine[], playbackMs: number, offsetMs: number): number {
  if (!Number.isFinite(playbackMs)) return -1;
  const position = Math.round(playbackMs);
  let start = 0;
  let end = lines.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (lines[middle].timestampMs + offsetMs <= position) start = middle + 1;
    else end = middle;
  }
  return start - 1;
}

function clampOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_LYRICS_OFFSET_MS, Math.min(MAX_LYRICS_OFFSET_MS,
    Math.round(value / LYRICS_STEP_MS) * LYRICS_STEP_MS));
}

function preference(record?: Partial<StoredPreference>): Preference {
  return {
    offsetMs: clampOffset(record?.offsetMs ?? 0),
    replacement: typeof record?.replacement === "string" ? record.replacement.slice(0, MAX_REPLACEMENT_LENGTH) : null,
  };
}

/** Positive offsets display the line later and shift its seek target by the same amount. */
export function useLyricsOffset(owner: string | null, trackId: string, enabled = true) {
  const key = enabled && owner && trackId ? downloadKey(owner, `lyrics:${trackId}`) : null;
  const [record, setRecord] = useState<{ key: string; value: Preference }>();
  const [error, setError] = useState<{ key: string; message: string }>();
  const [pending, setPending] = useState<string | null>(null);
  const currentKey = useRef(key);
  currentKey.current = key;
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void readDownload<StoredPreference>("settings", key).then(saved => {
      if (!cancelled) {
        setError(undefined);
        setRecord({ key, value: preference(saved) });
      }
    }).catch(() => {
      if (!cancelled) setError({ key, message: "Lyrics storage is unavailable on this device." });
    });
    return () => { cancelled = true; };
  }, [key]);

  async function write(update: (value: Preference) => Preference) {
    if (!key || !owner || record?.key !== key || inFlight.current.has(key)) return false;
    inFlight.current.add(key);
    setPending(key);
    setError(undefined);
    try {
      const next = await downloadTransaction<Preference>(["settings"], "readwrite", (tx, done) => {
        const store = tx.objectStore("settings");
        const request = store.get(key);
        request.onsuccess = () => {
          const next = update(preference(request.result));
          if (next.offsetMs === 0 && next.replacement === null) store.delete(key);
          else store.put({ ...next, key, owner });
          done(next);
        };
      });
      if (currentKey.current === key) setRecord({ key, value: next });
      return true;
    } catch {
      if (currentKey.current === key) setError({ key, message: "Could not save lyrics preferences on this device." });
      return false;
    } finally {
      inFlight.current.delete(key);
      setPending(current => current === key ? null : current);
    }
  }

  return {
    ...(record && record.key === key ? record.value : defaults),
    ready: Boolean(key && record?.key === key),
    busy: Boolean(key && pending === key),
    error: error?.key === key ? error.message : "",
    nudge: (direction: -1 | 1) => write(value => ({ ...value, offsetMs: clampOffset(value.offsetMs + direction * LYRICS_STEP_MS) })),
    reset: () => write(value => ({ ...value, offsetMs: 0 })),
    replace: (replacement: string | null) => write(value => ({ ...value, replacement, offsetMs: 0 })),
  };
}
