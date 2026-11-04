import { createHash } from "node:crypto";
import { ScrobbleError, httpFailure, protocolRequest, retryDelay, validateListen, type ScrobbleListen, type ScrobbleFetch } from "./protocol.js";

const ENDPOINT = "https://ws.audioscrobbler.com/2.0/";
/** Sign raw UTF-8 names and values, before form encoding. format/callback/api_sig are not signed. */
export function lastFmSignature(parameters: Readonly<Record<string, string>>, secret: string): string {
  const keys = Object.keys(parameters).filter((key) => !["format", "callback", "api_sig"].includes(key))
    .sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  return createHash("md5").update(keys.map((key) => key + parameters[key]).join("") + secret, "utf8").digest("hex");
}
const errors: Record<number, [string, "transient" | "auth" | "configuration" | "permanent"]> = {
  4: ["Authentication failed. Reconnect Last.fm.", "auth"],
  6: ["Last.fm rejected a request parameter. Check the track metadata.", "permanent"],
  9: ["The Last.fm session is invalid or revoked. Reconnect Last.fm.", "auth"],
  10: ["The Last.fm application API key is invalid. Contact your administrator.", "configuration"],
  11: ["Last.fm is temporarily offline.", "transient"],
  13: ["Last.fm rejected the request signature. Check the application's API key and shared secret.", "configuration"],
  14: ["The authorization token has expired or was already used. Start authorization again.", "auth"],
  15: ["The Last.fm token has not been authorized. Start authorization again.", "auth"],
  16: ["Last.fm is temporarily unavailable.", "transient"],
  26: ["The Last.fm API key is suspended. Contact your administrator.", "configuration"],
  29: ["Last.fm's rate limit was reached. MusicDeck will retry later.", "transient"],
};
export class LastFmScrobbler {
  constructor(private readonly credentials: { apiKey: string; apiSecret: string; sessionKey?: string },
    private readonly fetchImpl: ScrobbleFetch = fetch) {
    if (!credentials.apiKey || !credentials.apiSecret) throw new ScrobbleError("APPLICATION_NOT_CONFIGURED", "Configure the Last.fm API key and shared secret in server plugins.", "configuration");
  }
  private async request(method: string, parameters: Record<string, string>, authenticated: boolean, signal?: AbortSignal) {
    if (authenticated && !this.credentials.sessionKey) throw new ScrobbleError("NOT_CONNECTED", "Connect a Last.fm account first.", "auth");
    const values = { ...parameters, method, api_key: this.credentials.apiKey,
      ...(authenticated ? { sk: this.credentials.sessionKey! } : {}) };
    const form = new URLSearchParams({ ...values, api_sig: lastFmSignature(values, this.credentials.apiSecret), format: "json" });
    // Read/auth methods use GET; track.scrobble must use POST. Never log the request URL.
    const write = method === "track.scrobble";
    const { response, body, text } = await protocolRequest(this.fetchImpl, write ? ENDPOINT : `${ENDPOINT}?${form}`, write
      ? { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, body: form }
      : { method: "GET" }, signal);
    const xmlCode = /<lfm\b[^>]*\bstatus=["']failed["']/i.test(text) ? text.match(/<error\b[^>]*\bcode=["'](\d+)["']/i)?.[1] : undefined;
    const code = body && typeof body === "object" && "error" in body ? Number(body.error) : xmlCode ? Number(xmlCode) : null;
    if (code !== null) {
      const [message, kind] = errors[code] || ["Last.fm rejected this request. Check your account and track metadata.", "permanent"];
      throw new ScrobbleError(`LASTFM_${Number.isFinite(code) ? code : "UNKNOWN"}`, message, kind, response.status, retryDelay(response));
    }
    if (!response.ok) throw httpFailure(response);
    if (!body || typeof body !== "object") throw new ScrobbleError("INVALID_RESPONSE", "Last.fm returned an unreadable response.", "transient", response.status);
    return body;
  }
  async scrobble(listen: ScrobbleListen, signal?: AbortSignal): Promise<void> {
    validateListen(listen);
    const body = await this.request("track.scrobble", { artist: listen.artist, track: listen.track, timestamp: String(listen.listenedAt),
      ...(listen.album ? { album: listen.album } : {}), ...(listen.duration ? { duration: String(Math.floor(listen.duration)) } : {}) }, true, signal);
    const result = body.scrobbles;
    const item = Array.isArray(result?.scrobble) ? result.scrobble[0] : result?.scrobble;
    const ignored = Number(item?.ignoredMessage?.code);
    if (Number.isInteger(ignored) && ignored !== 0) {
      const messages: Record<number, string> = { 1: "Last.fm ignored the artist name.", 2: "Last.fm ignored the track name.",
        3: "The original listening timestamp is too old for Last.fm.", 4: "The original listening timestamp is in the future.", 5: "Last.fm's daily scrobble limit was reached." };
      throw new ScrobbleError(`LASTFM_IGNORED_${ignored}`, messages[ignored] || "Last.fm ignored this listen.",
        ignored === 4 || ignored === 5 ? "transient" : "ignored", 200, ignored === 5 ? 86_400_000 : ignored === 4 ? 60_000 : 0);
    }
    if (String(result?.["@attr"]?.accepted) !== "1" || String(result?.["@attr"]?.ignored) !== "0" || ignored !== 0) {
      throw new ScrobbleError("INVALID_RESPONSE", "Last.fm did not confirm acceptance of this listen.", "transient", 200);
    }
  }
  async validateSession(signal?: AbortSignal): Promise<string> {
    const body = await this.request("user.getInfo", {}, true, signal);
    if (typeof body.user?.name !== "string" || !body.user.name.trim()) throw new ScrobbleError("INVALID_RESPONSE", "Last.fm did not confirm the connected account.", "transient");
    return body.user.name;
  }
  async exchangeToken(token: string, signal?: AbortSignal): Promise<{ username: string; sessionKey: string }> {
    const body = await this.request("auth.getSession", { token }, false, signal);
    if (typeof body.session?.name !== "string" || !body.session.name.trim() || typeof body.session?.key !== "string" || !body.session.key) {
      throw new ScrobbleError("INVALID_RESPONSE", "Last.fm did not return a valid session.", "transient");
    }
    return { username: body.session.name, sessionKey: body.session.key };
  }
  async validateApplication(signal?: AbortSignal): Promise<void> {
    const body = await this.request("auth.getToken", {}, false, signal);
    if (typeof body.token !== "string" || !body.token) throw new ScrobbleError("INVALID_RESPONSE", "Last.fm did not validate the application credentials.", "transient");
  }
}
