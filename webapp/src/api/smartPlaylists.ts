export type SmartField = "similar_to" | "title" | "artist" | "album" | "genre" | "year" | "era_year" | "bpm" |
  "play_count" | "skip_count" | "is_favorite" | "last_played";
export type SmartOperator = "equals" | "not_equals" | "contains" | "greater_than" |
  "less_than" | "in_last_days" | "not_in_last_days" | "matches";
export type SmartRule = { field: SmartField; operator: SmartOperator; value: string | number | boolean };
export type SmartGroup = { operator: "AND" | "OR"; rules: SmartNode[] };
export type SmartNode = SmartRule | SmartGroup;
export type MixOptions = { size: number; order: "variety" | "similar" | "rediscover"; seed: number };
export type SmartPlaylist = { id: string; name: string; rules: SmartNode; options?: MixOptions; createdAt: string; updatedAt: string };
export type SmartTrack = { id: string; title: string; artist: string; album: string; [key: string]: unknown };
export type SmartPreview = { total: number; available?: number; selectionToken?: string; tracks: SmartTrack[]; refreshedAt: string | null; warning: string | null };

type FieldOption = { id: SmartField; label: string; kind: "text" | "number" | "boolean" | "date" | "song" };
export const SMART_FIELDS: ReadonlyArray<FieldOption> = [
  { id: "similar_to", label: "Similar songs", kind: "song" }, { id: "artist", label: "Artist", kind: "text" },
  { id: "album", label: "Album", kind: "text" }, { id: "genre", label: "Genre", kind: "text" },
  { id: "year", label: "Release year", kind: "number" }, { id: "bpm", label: "Tempo (BPM)", kind: "number" },
  { id: "play_count", label: "Times played", kind: "number" },
  { id: "is_favorite", label: "Liked songs", kind: "boolean" }, { id: "last_played", label: "Last listened", kind: "date" },
];
// Existing saved rules remain editable without offering confusing fields in new lists.
export const LEGACY_SMART_FIELDS: ReadonlyArray<FieldOption> = [
  { id: "era_year", label: "Release era", kind: "number" },
  { id: "title", label: "Song title (existing rule)", kind: "text" },
  { id: "skip_count", label: "Skip count (existing rule)", kind: "number" },
];
export const smartFieldInfo = (id: SmartField) => [...SMART_FIELDS, ...LEGACY_SMART_FIELDS].find((field) => field.id === id)!;
export const SMART_OPERATORS: Record<SmartOperator, string> = {
  equals: "is", not_equals: "is not", contains: "contains", greater_than: "is greater than",
  less_than: "is less than", in_last_days: "within the last", not_in_last_days: "not within the last", matches: "like",
};
export function operatorsFor(field: SmartField): SmartOperator[] {
  if (field === "similar_to") return ["matches"];
  if (field === "is_favorite") return ["equals", "not_equals"];
  if (field === "last_played") return ["in_last_days", "not_in_last_days"];
  return ["title", "artist", "album", "genre"].includes(field)
    ? ["contains", "equals", "not_equals"] : ["equals", "not_equals", "greater_than", "less_than"];
}
