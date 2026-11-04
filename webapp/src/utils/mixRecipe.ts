import type { SmartGroup, SmartNode, SmartPlaylist, SmartRule } from "../api/smartPlaylists";

export type MixMode = "similar" | "era" | "rediscover";
export type MixRecipe = { mode: MixMode | null; songId: string; from: string; to: string; days: string; genre: string; artist: string; likedOnly: boolean };
export const newMixRecipe = (mode: MixMode | null = null): MixRecipe => ({
  mode, songId: "", from: mode === "era" ? "1980" : "", to: mode === "era" ? "1989" : "",
  days: "30", genre: "", artist: "", likedOnly: mode === "rediscover",
});
export function mixIssue(recipe: MixRecipe): string | null {
  if (!recipe.mode) return "Choose a starting point for your mix.";
  if (recipe.mode === "similar" && !recipe.songId) return "Choose a song to build your mix around.";
  const maxYear = new Date().getFullYear() + 1;
  if ((recipe.mode === "era" || recipe.from || recipe.to) && (!/^\d{4}$/.test(recipe.from) || !/^\d{4}$/.test(recipe.to)
    || Number(recipe.from) < 1900 || Number(recipe.to) > maxYear || Number(recipe.from) > Number(recipe.to))) return `Choose a valid year range between 1900 and ${maxYear}.`;
  if (recipe.mode === "rediscover" && (!/^\d+$/.test(recipe.days) || Number(recipe.days) < 1 || Number(recipe.days) > 36500)) return "Choose a listening period.";
  return null;
}
export function mixRules(recipe: MixRecipe): SmartGroup {
  const rules: SmartRule[] = [];
  if (recipe.mode === "similar") rules.push({ field: "similar_to", operator: "matches", value: recipe.songId });
  if (recipe.from && recipe.to) rules.push({ field: "era_year", operator: "greater_than", value: Number(recipe.from) - 1 },
    { field: "era_year", operator: "less_than", value: Number(recipe.to) + 1 });
  if (recipe.mode === "rediscover") rules.push({ field: "play_count", operator: "greater_than", value: 0 },
    { field: "last_played", operator: "not_in_last_days", value: Number(recipe.days) });
  if (recipe.genre.trim()) rules.push({ field: "genre", operator: "contains", value: recipe.genre.trim() });
  if (recipe.artist.trim()) rules.push({ field: "artist", operator: "contains", value: recipe.artist.trim() });
  if (recipe.likedOnly) rules.push({ field: "is_favorite", operator: "equals", value: true });
  return { operator: "AND", rules };
}

/** Switch to the guided UI only when every existing condition round-trips exactly. */
export function readMixRecipe(playlist: SmartPlaylist): MixRecipe | null {
  const root = playlist.rules;
  const nodes: SmartNode[] = "rules" in root ? root.operator === "AND" ? root.rules : [] : [root];
  if (!nodes.length || nodes.some((node) => "rules" in node)) return null;
  const rules = nodes as SmartRule[];
  const recipe = newMixRecipe();
  for (const rule of rules) {
    if (rule.field === "similar_to" && rule.operator === "matches") { recipe.mode = "similar"; recipe.songId = String(rule.value); }
    else if (rule.field === "era_year" && rule.operator === "greater_than") recipe.from = String(Number(rule.value) + 1);
    else if (rule.field === "era_year" && rule.operator === "less_than") recipe.to = String(Number(rule.value) - 1);
    else if (rule.field === "last_played" && rule.operator === "not_in_last_days") { recipe.mode = "rediscover"; recipe.days = String(rule.value); }
    else if (rule.field === "genre" && rule.operator === "contains") recipe.genre = String(rule.value);
    else if (rule.field === "artist" && rule.operator === "contains") recipe.artist = String(rule.value);
    else if (rule.field === "is_favorite" && rule.operator === "equals" && rule.value === true) recipe.likedOnly = true;
  }
  if (!recipe.mode && recipe.from && recipe.to) recipe.mode = "era";
  if (mixIssue(recipe)) return null;
  const canonical = (values: SmartRule[]) => values.map((rule) => JSON.stringify([rule.field, rule.operator, rule.value])).sort().join("\n");
  return canonical(mixRules(recipe).rules as SmartRule[]) === canonical(rules) ? recipe : null;
}
