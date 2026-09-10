import type { Db } from "../db/database.js";

/**
 * Shared Spotify Web API client-credentials auth helper. Used by the
 * Spotify search/catalog providers to obtain short-lived access tokens
 * using only Spotify's officially supported client-credentials flow
 * (https://accounts.spotify.com/api/token). No scraping or private
 * endpoints are used.
 */

export type SpotifyCredentials = {
  clientId?: string;
  clientSecret?: string;
};

type CachedToken = {
  token: string;
  expiresAt: number;
};

export function hasSpotifyCredentials(config: SpotifyCredentials): boolean {
  return Boolean(config.clientId && config.clientSecret);
}

/**
 * Resolves the effective Spotify API credentials to use for catalog search.
 * Prefers credentials explicitly configured on the Spotify search provider;
 * if none are set, falls back to the Spotify app credentials already
 * configured on the "spotdl-downloader" plugin (used for acquisition), so
 * users who already set up spotDL don't need to enter the same client
 * ID/secret twice.
 */
export function resolveSpotifyCredentials(explicit: SpotifyCredentials, db?: Db): SpotifyCredentials {
  if (hasSpotifyCredentials(explicit)) {
    return explicit;
  }

  if (!db) {
    return explicit;
  }

  try {
    const row = db.prepare(
      "SELECT config_json FROM plugin_configs WHERE plugin_id = 'spotdl-downloader'"
    ).get() as { config_json?: string } | undefined;

    if (!row?.config_json) {
      return explicit;
    }

    const config = JSON.parse(row.config_json) as Record<string, unknown>;
    const clientId = typeof config.clientId === "string" ? config.clientId : undefined;
    const clientSecret = typeof config.clientSecret === "string" ? config.clientSecret : undefined;

    if (clientId && clientSecret) {
      return { clientId, clientSecret };
    }
  } catch {
    // Fall through to explicit (possibly empty) credentials below.
  }

  return explicit;
}

/**
 * Distinguishes where in the Spotify request pipeline a failure occurred so
 * admin diagnostics can tell "we couldn't get a token" apart from "we got a
 * token but the catalog request itself failed" (e.g. a 403 from
 * api.spotify.com is almost always a catalog-request problem — a bad/expired
 * app authorization, restricted scope, or malformed request — not a
 * client-id/secret typo, which normally fails at the token stage instead).
 */
export type SpotifyAuthStage = "token" | "catalog";

export class SpotifyAuthError extends Error {
  readonly stage: SpotifyAuthStage;
  readonly status?: number;
  readonly detail?: string;

  constructor(stage: SpotifyAuthStage, message: string, status?: number, detail?: string) {
    super(message);
    this.name = "SpotifyAuthError";
    this.stage = stage;
    this.status = status;
    this.detail = detail;
  }
}

/** Extracts a human-readable reason from a Spotify JSON error body, if present. */
function describeSpotifyErrorBody(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { status?: number; message?: string };
      error_description?: string;
    };
    if (typeof parsed.error === "string") {
      // Token endpoint errors: { error: "invalid_client", error_description: "..." }
      return parsed.error_description ? `${parsed.error}: ${parsed.error_description}` : parsed.error;
    }
    if (parsed.error && typeof parsed.error === "object" && parsed.error.message) {
      // Catalog endpoint errors: { error: { status, message } }
      return parsed.error.message;
    }
  } catch {
    // Not JSON (e.g. an HTML error page from a proxy/CDN) — fall back to a
    // truncated raw snippet so it's still visible in diagnostics.
    return body.slice(0, 200);
  }
  return undefined;
}

/**
 * Small per-instance token cache so repeated searches don't request a new
 * token from Spotify on every call.
 */
export class SpotifyAuthClient {
  private cached: CachedToken | null = null;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /**
   * Requests (or reuses a cached) client-credentials access token. Throws a
   * `SpotifyAuthError` with `stage: "token"` on failure instead of silently
   * returning null, so callers can report a specific, stage-labeled reason
   * (e.g. "invalid_client: Invalid client secret") instead of a generic
   * "authentication failed" message.
   */
  async getAccessToken(config: SpotifyCredentials): Promise<string | null> {
    if (!hasSpotifyCredentials(config)) {
      return null;
    }

    if (this.cached && this.cached.expiresAt > Date.now() + 5_000) {
      return this.cached.token;
    }

    let response: Response;
    try {
      const body = new URLSearchParams({ grant_type: "client_credentials" });
      response = await this.fetchImpl("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        },
        body: body.toString(),
      });
    } catch (error) {
      throw new SpotifyAuthError(
        "token",
        `Could not reach accounts.spotify.com: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const detail = describeSpotifyErrorBody(bodyText);
      throw new SpotifyAuthError(
        "token",
        `Spotify token request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
        response.status,
        detail
      );
    }

    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new SpotifyAuthError("token", "Spotify token response did not include an access_token");
    }

    this.cached = {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(30, Number(data.expires_in) || 3600) * 1000,
    };
    return this.cached.token;
  }
}

export { describeSpotifyErrorBody };
