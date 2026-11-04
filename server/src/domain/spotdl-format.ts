import { SUPPORTED_AUDIO_CONTAINERS, isSupportedAudioContainer } from "./audio-containers.js";

/** spotDL accepts concrete containers, not `--format best`. Source-quality
 * M4A avoids a second lossy encode when the provider supplies matching audio. */
export const SPOTDL_FORMATS = SUPPORTED_AUDIO_CONTAINERS;
export type SpotDLFormat = typeof SPOTDL_FORMATS[number];
export type SpotDLOutputFormat = "best" | SpotDLFormat;
export const DEFAULT_SPOTDL_FORMAT: SpotDLOutputFormat = "best";

export function parseSpotDLOutputFormat(value: unknown): SpotDLOutputFormat {
  if (value === undefined) return DEFAULT_SPOTDL_FORMAT;
  if (value === "best" || isSupportedAudioContainer(value)) return value;
  throw new Error("Choose a supported spotDL audio format");
}

export function spotDLFormatArgs(value: SpotDLOutputFormat): string[] {
  const selected = parseSpotDLOutputFormat(value);
  const format = selected === "best" ? "m4a" : selected;
  const bitrate = format === "mp3" ? "320k" : format === "ogg" ? "auto" : "disable";
  return ["--format", format, "--bitrate", bitrate];
}

