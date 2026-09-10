import { describe, expect, test, vi } from "vitest";

import {
  SpotifyAuthClient,
  SpotifyAuthError,
  describeSpotifyErrorBody,
  hasSpotifyCredentials,
  resolveSpotifyCredentials,
} from "../src/domain/spotify-auth.js";

const CREDENTIALS = { clientId: "id", clientSecret: "secret" };

describe("SpotifyAuthClient", () => {
  test("returns null when credentials are absent (not an error)", async () => {
    const fetchImpl = vi.fn();
    const client = new SpotifyAuthClient(fetchImpl as unknown as typeof fetch);

    const token = await client.getAccessToken({});

    expect(token).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("returns the access token on a successful client-credentials exchange", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ access_token: "abc123", expires_in: 3600 }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const client = new SpotifyAuthClient(fetchImpl as unknown as typeof fetch);

    const token = await client.getAccessToken(CREDENTIALS);

    expect(token).toBe("abc123");
  });

  test("throws a stage='token' SpotifyAuthError with the Spotify error body surfaced when the token request fails", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: "invalid_client", error_description: "Invalid client secret" }),
      { status: 400, headers: { "content-type": "application/json" } }
    ));
    const client = new SpotifyAuthClient(fetchImpl as unknown as typeof fetch);

    await expect(client.getAccessToken(CREDENTIALS)).rejects.toMatchObject({
      stage: "token",
      status: 400,
      message: expect.stringContaining("invalid_client"),
    });
  });

  test("throws a stage='token' SpotifyAuthError when the token endpoint is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = new SpotifyAuthClient(fetchImpl as unknown as typeof fetch);

    await expect(client.getAccessToken(CREDENTIALS)).rejects.toMatchObject({
      stage: "token",
      message: expect.stringContaining("Could not reach accounts.spotify.com"),
    });
  });

  test("throws when the token response is missing an access_token", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({}),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const client = new SpotifyAuthClient(fetchImpl as unknown as typeof fetch);

    await expect(client.getAccessToken(CREDENTIALS)).rejects.toBeInstanceOf(SpotifyAuthError);
  });

  test("caches a valid token instead of requesting a new one for every call", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ access_token: "cached-token", expires_in: 3600 }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const client = new SpotifyAuthClient(fetchImpl as unknown as typeof fetch);

    await client.getAccessToken(CREDENTIALS);
    await client.getAccessToken(CREDENTIALS);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("describeSpotifyErrorBody", () => {
  test("extracts message from a token-endpoint style error body", () => {
    const body = JSON.stringify({ error: "invalid_client", error_description: "Invalid client secret" });
    expect(describeSpotifyErrorBody(body)).toBe("invalid_client: Invalid client secret");
  });

  test("extracts message from a catalog-endpoint style error body", () => {
    const body = JSON.stringify({ error: { status: 403, message: "Insufficient client scope" } });
    expect(describeSpotifyErrorBody(body)).toBe("Insufficient client scope");
  });

  test("falls back to a truncated raw snippet for non-JSON bodies", () => {
    expect(describeSpotifyErrorBody("<html>Forbidden</html>")).toContain("Forbidden");
  });

  test("returns undefined for an empty body", () => {
    expect(describeSpotifyErrorBody("")).toBeUndefined();
  });
});

describe("hasSpotifyCredentials / resolveSpotifyCredentials", () => {
  test("hasSpotifyCredentials requires both clientId and clientSecret", () => {
    expect(hasSpotifyCredentials({})).toBe(false);
    expect(hasSpotifyCredentials({ clientId: "id" })).toBe(false);
    expect(hasSpotifyCredentials({ clientId: "id", clientSecret: "secret" })).toBe(true);
  });

  test("resolveSpotifyCredentials returns explicit credentials unchanged when present", () => {
    expect(resolveSpotifyCredentials(CREDENTIALS)).toEqual(CREDENTIALS);
  });

  test("resolveSpotifyCredentials returns explicit (empty) credentials when no db is provided", () => {
    expect(resolveSpotifyCredentials({})).toEqual({});
  });
});
