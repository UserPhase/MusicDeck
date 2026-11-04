import type { StreamResult } from "../backends/stream-provider.js";
import type { Track } from "../types.js";

export interface AudioProperties {
  codec: string | null;
  container: string | null;
  bitrateKbps: number | null;
  sampleRateHz: number | null;
  bitDepth: number | null;
  channels: number | null;
  lossless: boolean | null;
}
export interface StreamInspection {
  trackId: string;
  inspectionId: string;
  source: AudioProperties;
  sourceError: string | null;
  output: AudioProperties & {
    mode: "DIRECT_STREAM" | "TRANSCODED" | "UNKNOWN";
    evidence: "provider-direct" | "observed-conversion" | "unverified";
    transcodeReason: string | null;
    downsampled: boolean | null;
    requestedBitrateKbps: number | null;
    observed: boolean;
  };
  delivery: { bytes: number; bitrateKbps: number | null; windowSeconds: number; state: "waiting" | "streaming" | "finished" | "cancelled" | "error" };
}
const EMPTY: AudioProperties = { codec: null, container: null, bitrateKbps: null, sampleRateHz: null, bitDepth: null, channels: null, lossless: null };
const LOSSLESS = new Set(["FLAC", "ALAC", "PCM", "WAV", "AIFF"]);
export function codecName(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value) return null;
  const name = value.toUpperCase().replace(/^X-/, "");
  if (["MPEG", "MP3", "MPEG3"].includes(name)) return "MP3";
  if (["MP4A", "AAC", "AACP", "MP4"].includes(name)) return name === "MP4" ? null : "AAC";
  if (name.startsWith("PCM_") || ["WAVE", "WAV", "LPCM"].includes(name)) return "PCM";
  return ["FLAC", "ALAC", "OPUS", "VORBIS", "AAC", "AIFF", "PCM"].includes(name) ? name : null;
}
function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
export function sourceProperties(metadata: Track["audioMetadata"] | null): AudioProperties {
  const codec = codecName(metadata?.codec);
  return { codec, container: typeof metadata?.container === "string" ? metadata.container.slice(0, 30).toUpperCase() : null,
    bitrateKbps: positive(metadata?.bitrateKbps), sampleRateHz: positive(metadata?.sampleRateHz),
    bitDepth: positive(metadata?.bitDepth), channels: positive(metadata?.channels),
    lossless: codec ? LOSSLESS.has(codec) : null };
}

/** Parse only a bounded prefix of the actual delivery. A Range response beginning
 * mid-file cannot establish container properties; unknown stays unknown. */
export function inspectAudioHeader(data: Buffer): AudioProperties | null {
  if (data.length >= 42 && data.toString("ascii", 0, 4) === "fLaC" && (data[4] & 127) === 0 && data.readUIntBE(5, 3) === 34) {
    const packed = data.readBigUInt64BE(18);
    const sampleRateHz = Number(packed >> 44n);
    const channels = Number((packed >> 41n) & 7n) + 1;
    const bitDepth = Number((packed >> 36n) & 31n) + 1;
    return { ...EMPTY, codec: "FLAC", container: "FLAC", sampleRateHz: positive(sampleRateHz), channels, bitDepth, lossless: true };
  }
  if (data.length >= 36 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WAVE") {
    let offset = 12;
    while (offset + 24 <= data.length) {
      const size = data.readUInt32LE(offset + 4);
      if (data.toString("ascii", offset, offset + 4) === "fmt " && size >= 16) {
        const code = data.readUInt16LE(offset + 8);
        const pcm = code === 1 || code === 3 || (code === 65534 && size >= 40 && offset + 48 <= data.length &&
          [1, 3].includes(data.readUInt16LE(offset + 32)));
        return { ...EMPTY, codec: pcm ? "PCM" : null, container: "WAV", lossless: pcm ? true : null,
          channels: positive(data.readUInt16LE(offset + 10)), sampleRateHz: positive(data.readUInt32LE(offset + 12)),
          bitrateKbps: positive(data.readUInt32LE(offset + 16) * 8 / 1000), bitDepth: pcm ? positive(data.readUInt16LE(offset + 22)) : null };
      }
      offset += 8 + size + (size % 2);
    }
  }
  if (data.length >= 36 && data.toString("ascii", 0, 4) === "OggS") {
    const offset = data.indexOf("OpusHead");
    if (offset >= 0 && data.length >= offset + 19) return { ...EMPTY, codec: "OPUS", container: "OGG",
      channels: positive(data[offset + 9]), sampleRateHz: 48000, lossless: false };
    const vorbis = data.indexOf(Buffer.from([1, 118, 111, 114, 98, 105, 115]));
    if (vorbis >= 0 && data.length >= vorbis + 28) return { ...EMPTY, codec: "VORBIS", container: "OGG",
      channels: positive(data[vorbis + 11]), sampleRateHz: positive(data.readUInt32LE(vorbis + 12)),
      bitrateKbps: positive(data.readInt32LE(vorbis + 20) / 1000), lossless: false };
  }
  if (data.length >= 12 && data.toString("ascii", 4, 8) === "ftyp") {
    const walk = (start: number, end: number, depth: number): AudioProperties | null => {
      if (depth > 10) return null;
      for (let offset = start; offset + 8 <= end;) {
        const size = data.readUInt32BE(offset);
        if (size < 8 || offset + size > end) break;
        const type = data.toString("ascii", offset + 4, offset + 8);
        if (["moov", "trak", "mdia", "minf", "stbl"].includes(type)) {
          const found = walk(offset + 8, offset + size, depth + 1);
          if (found) return found;
        }
        if (type === "stsd" && size >= 16) {
          const found = walk(offset + 16, offset + size, depth + 1);
          if (found) return found;
        }
        if (["alac", "mp4a"].includes(type) && size >= 36) {
          const version = data.readUInt16BE(offset + 16);
          if (version !== 0) return null;
          const props: AudioProperties = { ...EMPTY, codec: type === "alac" ? "ALAC" : null, container: "MP4",
            sampleRateHz: positive(data.readUInt32BE(offset + 32) >>> 16), channels: positive(data.readUInt16BE(offset + 24)),
            bitDepth: type === "alac" ? positive(data.readUInt16BE(offset + 26)) : null,
            lossless: type === "alac" ? true : null };
          // The ALAC config, not the generic MP4 sample size, is authoritative.
          for (let child = offset + 36; child + 8 <= offset + size;) {
            const length = data.readUInt32BE(child);
            if (length < 8 || child + length > offset + size) break;
            if (type === "alac" && data.toString("ascii", child + 4, child + 8) === "alac" && length >= 36) {
              props.bitDepth = positive(data[child + 17]);
              props.channels = positive(data[child + 21]);
              props.sampleRateHz = positive(data.readUInt32BE(child + 32));
              props.bitrateKbps = positive(data.readUInt32BE(child + 28) / 1000);
            }
            child += length;
          }
          return props;
        }
        offset += size;
      }
      return null;
    };
    const found = walk(0, data.length, 0);
    if (found) return found;
  }
  let start = 0;
  if (data.length >= 10 && data.toString("ascii", 0, 3) === "ID3") {
    start = 10 + ((data[6] & 127) * 2097152 + (data[7] & 127) * 16384 + (data[8] & 127) * 128 + (data[9] & 127));
    if (data[5] & 16) start += 10;
  }
  for (let index = start; index < Math.min(data.length - 7, start + 4096); index++) {
    if (data[index] !== 255) continue;
    const second = data[index + 1];
    if ((second & 246) === 240) {
      const rate = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][(data[index + 2] >> 2) & 15];
      const channels = ((data[index + 2] & 1) << 2) | (data[index + 3] >> 6);
      const frameSize = ((data[index + 3] & 3) << 11) | (data[index + 4] << 3) | (data[index + 5] >> 5);
      if (rate && channels && frameSize >= 7) return { ...EMPTY, codec: "AAC", container: "ADTS", sampleRateHz: rate,
        channels: channels === 7 ? 8 : channels, lossless: false };
    }
    const version = (second >> 3) & 3, layer = (second >> 1) & 3;
    const rateIndex = (data[index + 2] >> 2) & 3, bitIndex = data[index + 2] >> 4;
    if ((second & 224) === 224 && version !== 1 && layer === 1 && rateIndex !== 3 && bitIndex > 0 && bitIndex < 15) {
      const rate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
      // A frame bitrate is not a track-average bitrate for VBR; don't label it 320k.
      return { ...EMPTY, codec: "MP3", container: "MP3", sampleRateHz: rate,
        channels: (data[index + 3] >> 6) === 3 ? 1 : 2, lossless: false };
    }
  }
  return null;
}

interface Observation {
  userId: string; trackId: string; inspectionId: string; updatedAt: number; startedAt: number;
  bytes: number; state: StreamInspection["delivery"]["state"];
  samples: { time: number; bytes: number }[]; header: Buffer; properties: AudioProperties | null;
  pipe: StreamResult["audioStream"]; source: AudioProperties | null;
  sourcePromise?: Promise<void>; sourceFailed: boolean;
}

export class AudioMetadataInspector {
  private readonly observations = new Map<string, Observation>();
  constructor(
    private readonly metadata: (trackId: string, connectionId?: string) => Promise<Track["audioMetadata"] | null>,
    private readonly log: (error: unknown, message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}
  private key(userId: string, trackId: string, id: string) { return JSON.stringify([userId, trackId, id]); }
  private prune() {
    for (const [key, value] of this.observations) if (this.now() - value.updatedAt > 30 * 60_000) this.observations.delete(key);
    while (this.observations.size > 500) this.observations.delete(this.observations.keys().next().value!);
  }

  observe(userId: string, trackId: string, inspectionId: string, result: StreamResult, range?: string): StreamResult {
    if (!result.body || ![200, 206].includes(result.status)) return result;
    this.prune();
    const key = this.key(userId, trackId, inspectionId);
    const old = this.observations.get(key);
    const samePipe = result.status === 206 && Boolean(old?.pipe && result.audioStream) &&
      old?.pipe?.sourceConnectionId === result.audioStream?.sourceConnectionId &&
      old?.pipe?.direct === result.audioStream?.direct && old?.pipe?.requestedBitrateKbps === result.audioStream?.requestedBitrateKbps;
    const time = this.now();
    const observation: Observation = {
      userId, trackId, inspectionId, updatedAt: time, startedAt: time, bytes: 0, state: "streaming",
      samples: [{ time, bytes: 0 }], header: Buffer.alloc(0),
      properties: samePipe ? old?.properties ?? null : null,
      pipe: result.audioStream, source: old?.pipe?.sourceConnectionId === result.audioStream?.sourceConnectionId ? old?.source ?? null : null,
      sourceFailed: false,
    };
    this.observations.set(key, observation);
    this.prune();
    const reader = result.body.getReader();
    const fromStart = (!range || /^bytes=0-/i.test(range)) && !/^bytes [1-9]\d*-/i.test(result.headers.get("content-range") ?? "");
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const next = await reader.read();
          if (cancelled) return;
          observation.updatedAt = this.now();
          if (next.done) {
            observation.state = "finished"; controller.close(); reader.releaseLock(); return;
          }
          observation.bytes += next.value.byteLength;
          const samples = observation.samples;
          const last = samples[samples.length - 1];
          if (observation.updatedAt - last.time < 100 && samples.length > 1) {
            last.bytes = observation.bytes;
          } else samples.push({ time: observation.updatedAt, bytes: observation.bytes });
          while (samples.length > 2 && samples[1].time < observation.updatedAt - 5000) samples.shift();
          if (fromStart && !observation.properties && observation.header.length < 65536) {
            const bytes = Buffer.from(next.value.subarray(0, 65536 - observation.header.length));
            observation.header = Buffer.concat([observation.header, bytes]);
            observation.properties = inspectAudioHeader(observation.header);
            if (observation.properties) observation.header = Buffer.alloc(0);
          }
          controller.enqueue(next.value);
        } catch (error) {
          if (cancelled) return;
          observation.state = "error";
          observation.updatedAt = this.now();
          this.log(error, "Audio inspection stream failed");
          controller.error(error);
          reader.releaseLock();
        }
      },
      cancel: async (reason) => {
        cancelled = true;
        observation.state = "cancelled"; observation.updatedAt = this.now();
        try { await reader.cancel(reason); } finally { reader.releaseLock(); }
      },
    });
    return { ...result, body };
  }

  async inspect(userId: string, trackId: string, inspectionId: string): Promise<StreamInspection> {
    this.prune();
    const observation = this.observations.get(this.key(userId, trackId, inspectionId));
    if (observation && !observation.source && !observation.sourcePromise && !observation.sourceFailed) {
      observation.sourcePromise = this.metadata(trackId, observation.pipe?.sourceConnectionId).then((metadata) => {
        observation.source = sourceProperties(metadata);
      }).catch((error: unknown) => {
        observation.sourceFailed = true;
        this.log(error, "Could not inspect source audio metadata");
      }).finally(() => { observation.sourcePromise = undefined; });
    }
    await observation?.sourcePromise;
    let source = observation?.source ?? { ...EMPTY };
    const observed = observation?.properties;
    const pipe = observation?.pipe;
    const converted = Boolean(observed && source.codec && observed.codec && source.codec !== observed.codec) ||
      Boolean(observed?.sampleRateHz && source.sampleRateHz && observed.sampleRateHz !== source.sampleRateHz) ||
      Boolean(observed?.bitDepth && source.bitDepth && observed.bitDepth !== source.bitDepth) ||
      Boolean(observed?.channels && source.channels && observed.channels !== source.channels);
    const direct = pipe?.direct === true && !converted;
    if (direct && observed) source = { ...source, ...Object.fromEntries(Object.entries(observed)
      .filter(([key, value]) => source[key as keyof AudioProperties] === null && value !== null)) };
    const mode = converted ? "TRANSCODED" : direct ? "DIRECT_STREAM" : "UNKNOWN";
    const output = direct ? { ...source, ...Object.fromEntries(Object.entries(observed ?? {}).filter(([, value]) => value !== null)) } : observed ?? { ...EMPTY };
    const samples = observation?.samples ?? [];
    const first = samples[0];
    const elapsed = first && observation ? Math.max(0, (this.now() - first.time) / 1000) : 0;
    const recent = samples.filter((sample) => sample.time >= this.now() - 5000);
    const bitrate = observation && first && elapsed >= .1 && recent.length > 0
      ? (observation.bytes - first.bytes) * 8 / elapsed / 1000 : null;
    return {
      trackId, inspectionId, source,
      sourceError: observation?.sourceFailed ? "Source metadata could not be loaded. Delivered header inspection remains available." : null,
      output: { ...output, mode, evidence: converted ? "observed-conversion" : direct ? "provider-direct" : "unverified",
        transcodeReason: converted ? (pipe?.requestedBitrateKbps ? `Bitrate cap requested: ${pipe.requestedBitrateKbps} kbps` : "Delivered audio differs from source metadata")
          : pipe?.requestedBitrateKbps ? "Bitrate cap requested; server conversion is not verified" : null,
        downsampled: output.sampleRateHz && source.sampleRateHz ? output.sampleRateHz < source.sampleRateHz : null,
        requestedBitrateKbps: pipe?.requestedBitrateKbps ?? null, observed: Boolean(observed) },
      delivery: { bytes: observation?.bytes ?? 0, bitrateKbps: bitrate, windowSeconds: elapsed, state: observation?.state ?? "waiting" },
    };
  }
}
