import path from "node:path";

export const SUPPORTED_AUDIO_CONTAINERS = ["mp3", "flac", "m4a", "opus", "ogg", "wav"] as const;
export type SupportedAudioContainer = typeof SUPPORTED_AUDIO_CONTAINERS[number];
export const SUPPORTED_AUDIO_EXTENSIONS: readonly string[] = Object.freeze(SUPPORTED_AUDIO_CONTAINERS.map(format => `.${format}`));
const extensions = new Set(SUPPORTED_AUDIO_EXTENSIONS);

export function isSupportedAudioContainer(value: unknown): value is SupportedAudioContainer {
  return typeof value === "string" && (SUPPORTED_AUDIO_CONTAINERS as readonly string[]).includes(value);
}

export function isSupportedAudioFile(filePath: string): boolean {
  return extensions.has(path.extname(filePath).toLowerCase());
}
