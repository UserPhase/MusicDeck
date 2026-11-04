import { z } from "zod";

export type SmartPlaylistField = "similar_to" | "title" | "artist" | "album" | "genre" | "year" | "era_year" | "bpm" |
  "play_count" | "skip_count" | "is_favorite" | "last_played";
export type SmartPlaylistOperator = "equals" | "not_equals" | "contains" | "greater_than" |
  "less_than" | "in_last_days" | "not_in_last_days" | "matches";
export type SmartPlaylistRule =
  | { field: SmartPlaylistField; operator: SmartPlaylistOperator; value: string | number | boolean }
  | { operator: "AND" | "OR"; rules: SmartPlaylistRule[] };

const text = z.object({
  field: z.enum(["title", "artist", "album", "genre"]),
  operator: z.enum(["equals", "not_equals", "contains"]),
  value: z.string().trim().min(1).max(300),
}).strict().refine((rule) => rule.field !== "genre" || !rule.value.includes("\u001f"), "Genre values cannot contain control separators");
const numeric = z.object({
  field: z.enum(["year", "era_year", "bpm", "play_count", "skip_count"]),
  operator: z.enum(["equals", "not_equals", "greater_than", "less_than"]),
  value: z.number().finite().nonnegative().max(1_000_000_000),
}).strict().refine((rule) => rule.field === "bpm" || Number.isInteger(rule.value), "This field requires an integer");
const favorite = z.object({
  field: z.literal("is_favorite"), operator: z.enum(["equals", "not_equals"]), value: z.boolean(),
}).strict();
const date = z.object({
  field: z.literal("last_played"),
  operator: z.enum(["equals", "not_equals", "greater_than", "less_than"]),
  value: z.string().datetime({ offset: true }),
}).strict();
const relative = z.object({
  field: z.literal("last_played"), operator: z.enum(["in_last_days", "not_in_last_days"]),
  value: z.number().int().min(1).max(36500),
}).strict();
const similar = z.object({
  field: z.literal("similar_to"), operator: z.literal("matches"), value: z.string().trim().min(1).max(500),
}).strict();

export const smartPlaylistRuleSchema: z.ZodType<SmartPlaylistRule> = z.lazy(() => z.union([
  text, numeric, favorite, date, relative, similar,
  z.object({ operator: z.enum(["AND", "OR"]), rules: z.array(smartPlaylistRuleSchema).min(1).max(100) }).strict(),
]));

export class InvalidSmartPlaylistRule extends Error {}

export const mixOptionsSchema = z.object({
  size: z.number().int().min(10).max(200),
  order: z.enum(["variety", "similar", "rediscover"]),
  seed: z.number().int().min(0).max(2_147_483_647),
}).strict();
export type MixOptions = z.infer<typeof mixOptionsSchema>;

/** Bound traversal before recursive validation/compiler work, including malicious trees. */
export function parseSmartPlaylistRule(input: unknown): SmartPlaylistRule {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 100 || depth > 6) throw new InvalidSmartPlaylistRule("Rules may contain at most 100 nodes and 6 nested levels.");
    if (value && typeof value === "object" && "rules" in value && Array.isArray(value.rules)) {
      if (value.rules.length > 100) throw new InvalidSmartPlaylistRule("A group may contain at most 100 rules.");
      for (const child of value.rules) pending.push({ value: child, depth: depth + 1 });
    }
  }
  const parsed = smartPlaylistRuleSchema.safeParse(input);
  if (!parsed.success) throw new InvalidSmartPlaylistRule("Invalid rules. Check field/operator compatibility, values, and non-empty groups.");
  return parsed.data;
}
