const EXTERNAL_PREFIX = "ext:";

function decodeExternalId(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseArtistId(rawId) {
  const value = String(rawId || "").trim();
  const prefixed = value.match(/^ext:(deezer|itunes):(.+)$/i);
  if (prefixed) return { type: prefixed[1].toLowerCase(), id: prefixed[2] };
  const legacy = value.match(/^external_(deezer|itunes)_artist_(.+)$/i);
  if (legacy) return { type: legacy[1].toLowerCase(), id: legacy[2] };
  // Charts released before provider IDs were unified used this shorter form.
  const legacyChart = value.match(/^deezer_artist_(.+)$/i);
  if (legacyChart) return { type: "deezer", id: legacyChart[1] };
  return { type: "local", id: value };
}

export function toArtistRouteId(provider, id) {
  if (provider === "deezer" || provider === "itunes") return `${EXTERNAL_PREFIX}${provider}:${encodeURIComponent(String(id))}`;
  return String(id);
}

/** Converts provider detail IDs returned by search/catalog APIs into route IDs. */
export function toArtistRouteIdFromApiId(rawId) {
  const parsed = parseArtistId(rawId);
  return parsed.type === "local" ? parsed.id : toArtistRouteId(parsed.type, parsed.id);
}

export function toArtistApiId(rawId) {
  const parsed = parseArtistId(rawId);
  if (parsed.type === "local") return parsed.id;
  return `external_${parsed.type}_artist_${decodeExternalId(parsed.id)}`;
}
