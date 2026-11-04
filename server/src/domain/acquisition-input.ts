import { z } from "zod";
import type { AcquisitionCreateOptions } from "./acquisition.js";

const text = z.string().max(2000);
const id = z.string().min(1).max(2048);
// Discovery providers describe provenance; acquisitions use the canonical source kind.
const resultProvider = z.enum(["library", "musicdeck", "plugin", "external", "deezer", "itunes", "spotify"])
  .transform((value) => value === "deezer" || value === "itunes" || value === "spotify" ? "external" : value);
const identity = z.object({
  id, strength: z.enum(["musicbrainz", "isrc", "upc", "normalized", "provider"]),
}).strict();
const metadata = z.object({
  acquisitionUrl: id.optional(), downloadUrl: id.optional(), fileUrl: id.optional(),
  spotifyTrackUrl: id.nullish().transform((value) => value ?? undefined), spotifyUrl: id.optional(),
  spotifyTrackId: id.optional(), spotifyId: id.optional(),
  acquisitionInputs: z.object({
    spotifyTrackUrl: id.optional(), spotifyTrackId: id.optional(),
    inputMode: z.enum(["text", "spotify-url", "either"]).optional(),
  }).strict().optional(),
  preview: z.boolean().optional(), durationSeconds: z.number().nonnegative().nullable().optional(),
  normalizationGainDb: z.number().min(-60).max(12).optional(),
  loudness: z.object({ integratedLufs: z.number().min(-100).max(20), truePeakDb: z.number().min(-100).max(20) }).strict().optional(),
  year: z.number().nullable().optional(), songCount: z.number().nonnegative().optional(),
  artistId: id.nullable().optional(), albumId: id.nullable().optional(),
  recommendationReason: text.optional(), deezerTrackId: z.number().optional(),
  deezerTrackUrl: id.nullish().transform((value) => value ?? undefined), itunesTrackId: z.number().optional(),
  isrc: z.string().max(32).nullable().optional(),
  source: text.optional(), archiveIdentifier: id.optional(), fileName: text.optional(),
  representation: text.optional(),
}).strict();
const candidate = z.object({
  id, provider: id,
  kind: z.enum(["track", "album-container", "release-container", "item", "file", "detail-link"]).optional(),
  title: text.optional(), artist: text.optional(), album: text.optional(),
  container: z.object({ id, name: text.optional(), title: text.optional(), artist: text.optional(), album: text.optional() }).strict().optional(),
  detailUrl: id.optional(), metadata: metadata.optional(),
  durationSeconds: z.number().nonnegative().optional(), fileSize: z.number().nonnegative().optional(),
  quality: z.object({
    codec: text.optional(), bitrate: z.number().optional(), sampleRate: z.number().optional(),
    bitDepth: z.number().optional(), durationSeconds: z.number().optional(),
    fileSize: z.number().optional(), lossless: z.boolean().optional(),
  }).strict().optional(),
  identity: identity.optional(),
}).strict();
const result = z.object({
  id, type: z.enum(["track", "album", "artist", "playlist"]), title: text,
  subtitle: text.nullable().optional(), artist: text.nullable().optional(), album: text.nullable().optional(),
  artwork: z.object({ id, url: id }).strict().nullable().optional(),
  previewUrl: id.nullable().optional(),
  provider: resultProvider,
  source: z.object({
    kind: z.enum(["library", "musicdeck", "external"]), count: z.number().nonnegative(),
    externalAvailable: z.boolean().optional(),
    options: z.array(z.object({ id, name: text }).strict()).max(20).optional(),
  }).strict(),
  availability: z.object({
    state: z.enum(["available", "degraded", "unavailable"]), connectionId: id,
    sourceCount: z.number(), availableSourceCount: z.number(), libraryAvailable: z.boolean(),
  }).strict().nullable().optional(),
  metadata: metadata.optional(), identity: identity.optional(),
  providers: z.array(resultProvider).max(20).optional(),
  inLibrary: z.boolean().optional(), localTrackId: id.optional(), localAlbumId: id.optional(),
}).strict().transform((value) => ({
  ...value, subtitle: value.subtitle ?? null, artist: value.artist ?? null, album: value.album ?? null,
  artwork: value.artwork ?? null, availability: value.availability ?? null, metadata: value.metadata ?? {},
}));

export const acquisitionRequestSchema = z.object({
  candidate: candidate.optional(), candidateId: id.optional(), result: result.optional(),
  sourceProvider: id.optional(), providerId: id.optional(), containerId: id.optional(),
  trackId: id.optional(), albumId: id.optional(), spotifyTrackUrl: id.optional(), spotifyUrl: id.optional(),
  autoPlay: z.boolean().optional(),
}).strict().refine((value) => Boolean(value.candidate || value.candidateId || value.result || value.trackId || value.albumId))
  .transform((value): AcquisitionCreateOptions => ({
    ...value, sourceProvider: value.sourceProvider || value.providerId,
  }));
