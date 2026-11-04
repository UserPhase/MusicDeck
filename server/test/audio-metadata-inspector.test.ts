import { describe, expect, test, vi } from "vitest";
import { AudioMetadataInspector, inspectAudioHeader, sourceProperties } from "../src/services/AudioMetadataInspector.js";
import type { StreamResult } from "../src/backends/stream-provider.js";
import type { Track } from "../src/types.js";
import { mapTrack } from "../src/backends/navidrome/mappers.js";
import { mapJellyfinTrack } from "../src/backends/jellyfin/jellyfin-mapper.js";

const metadata = (properties: Partial<NonNullable<Track["audioMetadata"]>>) => ({
  codec: null, container: null, bitrateKbps: null, sampleRateHz: null, bitDepth: null, channels: null, ...properties,
});

function flac(rate = 96000, depth = 24) {
  const bytes = Buffer.alloc(42);
  bytes.write("fLaC"); bytes.writeUIntBE(34, 5, 3);
  bytes.writeBigUInt64BE((BigInt(rate) << 44n) | (1n << 41n) | (BigInt(depth - 1) << 36n), 18);
  return bytes;
}
const mp3 = Buffer.from([255, 251, 144, 0, 0, 0, 0, 0, 0]);
function stream(bytes: Buffer, audioStream: Partial<NonNullable<StreamResult["audioStream"]>> = {}): StreamResult {
  return { body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    status: 200, headers: new Headers(), audioStream: { direct: true, requestedBitrateKbps: null, ...audioStream } };
}
async function consume(result: StreamResult) {
  return Buffer.from(await new Response(result.body).arrayBuffer());
}
function atom(type: string, payload: Buffer) {
  const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(type, 4);
  return Buffer.concat([header, payload]);
}
describe("actual delivered audio headers", () => {
  test("normalizes provider metadata with correct bitrate units and audio stream selection", () => {
    const expected = { codec: "FLAC", container: "FLAC", bitrateKbps: 850, sampleRateHz: 96000, bitDepth: 24, channels: 2, lossless: true };
    expect(sourceProperties(mapTrack({ id: "n", contentType: "audio/flac", suffix: "flac", bitRate: 850, samplingRate: 96000, bitDepth: 24, channelCount: 2 }).audioMetadata ?? null)).toEqual(expected);
    expect(sourceProperties(mapJellyfinTrack({ Id: "j", Container: "flac", MediaStreams: [
      { Type: "Video", Codec: "png" }, { Type: "Audio", Codec: "flac", BitRate: 850000, SampleRate: 96000, BitDepth: 24, Channels: 2 },
    ] }).audioMetadata ?? null)).toEqual(expected);
  });
  test("reads FLAC STREAMINFO without mistaking PCM data rate for compressed bitrate", () => {
    expect(inspectAudioHeader(flac())).toMatchObject({ codec: "FLAC", bitDepth: 24, sampleRateHz: 96000, channels: 2, bitrateKbps: null, lossless: true });
    expect(inspectAudioHeader(flac(44100, 16))).toMatchObject({ sampleRateHz: 44100, bitDepth: 16 });
  });
  test("reads MP3/AAC without inventing a VBR average from a single frame", () => {
    expect(inspectAudioHeader(mp3)).toMatchObject({ codec: "MP3", sampleRateHz: 44100, lossless: false, bitrateKbps: null });
    expect(inspectAudioHeader(Buffer.from([255, 241, 80, 128, 1, 63, 252, 0, 0]))).toMatchObject({ codec: "AAC", sampleRateHz: 44100, channels: 2 });
  });
  test("reads PCM WAV and Ogg Opus", () => {
    const wav = Buffer.alloc(44);
    wav.write("RIFF"); wav.write("WAVE", 8); wav.write("fmt ", 12); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28); wav.writeUInt16LE(16, 34);
    expect(inspectAudioHeader(wav)).toMatchObject({ codec: "PCM", sampleRateHz: 48000, bitrateKbps: 1536 });
    const ogg = Buffer.alloc(60); ogg.write("OggS"); ogg.write("OpusHead", 28); ogg[37] = 2;
    expect(inspectAudioHeader(ogg)).toMatchObject({ codec: "OPUS", sampleRateHz: 48000, channels: 2 });
  });
  test("reads ALAC configuration inside MP4 instead of assuming MP4 means AAC", () => {
    const config = Buffer.alloc(28); config[9] = 24; config[13] = 2; config.writeUInt32BE(850000, 20); config.writeUInt32BE(96000, 24);
    const entry = Buffer.alloc(28); entry.writeUInt16BE(2, 16); entry.writeUInt16BE(16, 18); entry.writeUInt32BE(44100 * 65536, 24);
    const stsd = Buffer.concat([Buffer.alloc(8), atom("alac", Buffer.concat([entry, atom("alac", config)]))]);
    const file = Buffer.concat([atom("ftyp", Buffer.from("M4A ")), atom("moov", atom("trak", atom("mdia", atom("minf", atom("stbl", atom("stsd", stsd))))))]);
    expect(inspectAudioHeader(file)).toMatchObject({ codec: "ALAC", sampleRateHz: 96000, channels: 2, bitDepth: 24, bitrateKbps: 850, lossless: true });
    expect(sourceProperties(metadata({ codec: "mp4" })).codec).toBeNull();
  });
  test("rejects incomplete, malformed and oversized ID3 prefixes", () => {
    for (const buffer of [Buffer.alloc(0), Buffer.alloc(100), flac().subarray(0, 20), Buffer.from("ID3\x04\x00\x00\x7f\x7f\x7f\x7f")]) expect(inspectAudioHeader(buffer)).toBeNull();
  });
});
describe("bounded authenticated stream observations", () => {
  test("forwards bytes unchanged and observes direct FLAC rather than MIME", async () => {
    const fetchMetadata = vi.fn(async () => metadata({ codec: "flac", bitrateKbps: 850 }));
    const inspector = new AudioMetadataInspector(fetchMetadata, vi.fn());
    expect(await consume(inspector.observe("u", "t", "id", stream(flac(), { direct: true, sourceConnectionId: "secondary" })))).toEqual(flac());
    expect(await inspector.inspect("u", "t", "id")).toMatchObject({
      source: { sampleRateHz: 96000, bitrateKbps: 850 },
      output: { mode: "DIRECT_STREAM", codec: "FLAC", bitDepth: 24, evidence: "provider-direct", observed: true },
      delivery: { bytes: 42, state: "finished" },
    });
    expect(fetchMetadata).toHaveBeenCalledWith("t", "secondary");
    expect((await inspector.inspect("other", "t", "id")).output.mode).toBe("UNKNOWN");
    expect((await inspector.inspect("u", "t", "different")).source.codec).toBeNull();
  });
  test("reports observed conversion but never infers conversion just from a cap", async () => {
    const inspector = new AudioMetadataInspector(async () => metadata({ codec: "flac", sampleRateHz: 96000 }), vi.fn());
    await consume(inspector.observe("u", "t", "cap", stream(mp3, { direct: false, requestedBitrateKbps: 128 })));
    expect((await inspector.inspect("u", "t", "cap")).output).toMatchObject({ codec: "MP3", mode: "TRANSCODED", downsampled: true, lossless: false });
    await consume(inspector.observe("u", "t", "same", stream(flac(), { direct: false, requestedBitrateKbps: 320 })));
    expect((await inspector.inspect("u", "t", "same")).output.mode).toBe("UNKNOWN");
  });
  test("rejects stale header reuse after policy/source changes and does not parse mid-file ranges", async () => {
    const inspector = new AudioMetadataInspector(async () => null, vi.fn());
    await consume(inspector.observe("u", "t", "id", stream(flac(), { direct: true, sourceConnectionId: "one" })));
    const recovered = { ...stream(mp3, { direct: true, sourceConnectionId: "one" }), status: 206 };
    await consume(inspector.observe("u", "t", "id", recovered, "bytes=1000-"));
    expect((await inspector.inspect("u", "t", "id")).output.codec).toBe("FLAC");
    await consume(inspector.observe("u", "t", "id", { ...recovered, body: stream(mp3).body, audioStream: { direct: false, requestedBitrateKbps: 128 } }, "bytes=1000-"));
    expect((await inspector.inspect("u", "t", "id")).output.codec).toBeNull();
  });
  test("computes burst throughput with the actual sample window and ages idle rates", async () => {
    let now = 1000;
    const inspector = new AudioMetadataInspector(async () => null, vi.fn(), () => now);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const input = { ...stream(Buffer.alloc(0)), body: new ReadableStream<Uint8Array>({ start(c) { controller = c; } }) };
    const reader = inspector.observe("u", "t", "id", input).body!.getReader();
    controller.enqueue(Buffer.alloc(1000)); await reader.read();
    now += 1000;
    expect((await inspector.inspect("u", "t", "id")).delivery).toMatchObject({ bytes: 1000, bitrateKbps: 8, windowSeconds: 1 });
    now += 6000;
    expect((await inspector.inspect("u", "t", "id")).delivery.bitrateKbps).toBeNull();
    await reader.cancel();
  });
  test("propagates cancellation and upstream failures; metadata failure is visible", async () => {
    const log = vi.fn(), cancel = vi.fn();
    const inspector = new AudioMetadataInspector(async () => { throw new Error("offline"); }, log);
    const body = new ReadableStream<Uint8Array>({ cancel });
    const observed = inspector.observe("u", "t", "cancel", { ...stream(mp3), body });
    await observed.body!.cancel("user");
    expect(cancel).toHaveBeenCalledWith("user");
    expect((await inspector.inspect("u", "t", "cancel"))).toMatchObject({ sourceError: expect.stringContaining("could not"), delivery: { state: "cancelled" } });
    const failure = new Error("upstream");
    const broken = inspector.observe("u", "t", "bad", { ...stream(mp3), body: new ReadableStream({ start(c) { c.error(failure); } }) });
    await expect(consume(broken)).rejects.toThrow("upstream");
    expect(log).toHaveBeenCalledWith(failure, "Audio inspection stream failed");
  });
  test("retains 500 records when inspected and prunes oldest / expired observations", async () => {
    let now = 0;
    const inspector = new AudioMetadataInspector(async () => null, vi.fn(), () => now);
    for (let index = 0; index < 500; index++) await consume(inspector.observe("u", "t", String(index), stream(mp3)));
    expect((await inspector.inspect("u", "t", "0")).output.codec).toBe("MP3");
    await consume(inspector.observe("u", "t", "501", stream(mp3)));
    expect((await inspector.inspect("u", "t", "0")).delivery.state).toBe("waiting");
    now += 30 * 60000 + 1;
    expect((await inspector.inspect("u", "t", "501")).delivery.state).toBe("waiting");
  });
});
