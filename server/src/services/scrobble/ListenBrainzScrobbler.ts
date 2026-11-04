import { ScrobbleError, httpFailure, protocolRequest, validateListen, type ScrobbleListen, type ScrobbleFetch } from "./protocol.js";

export function listenBrainzPayload(listen: ScrobbleListen) {
  validateListen(listen);
  return { listen_type: "single", payload: [{ listened_at: listen.listenedAt,
    track_metadata: { artist_name: listen.artist, track_name: listen.track, ...(listen.album ? { release_name: listen.album } : {}) } }] };
}
export class ListenBrainzScrobbler {
  constructor(private readonly token: string, private readonly fetchImpl: ScrobbleFetch = fetch) {
    if (!token || token.length > 4096 || /[\r\n\0]/.test(token)) throw new ScrobbleError("INVALID_TOKEN", "Enter a valid ListenBrainz user token.", "auth");
  }
  private async request(path: string, payload?: unknown, signal?: AbortSignal) {
    const { response, body } = await protocolRequest(this.fetchImpl, `https://api.listenbrainz.org/1/${path}`, {
      method: payload ? "POST" : "GET", headers: { authorization: `Token ${this.token}`, ...(payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    }, signal);
    if (!response.ok) throw httpFailure(response);
    if (!body || typeof body !== "object") throw new ScrobbleError("INVALID_RESPONSE", "ListenBrainz returned an unreadable response.", "transient", response.status);
    if (body.error || body.status === "error" || body.status === "failed" || (typeof body.code === "number" && body.code >= 400)) {
      const status = Number(body.code);
      throw new ScrobbleError(`LISTENBRAINZ_${Number.isInteger(status) && status >= 400 ? status : "ERROR"}`,
        "ListenBrainz rejected this request. Check the user token and track metadata.",
        status === 429 || status >= 500 ? "transient" : status === 401 || status === 403 ? "auth" : "permanent", response.status);
    }
    return body;
  }
  async scrobble(listen: ScrobbleListen, signal?: AbortSignal): Promise<void> {
    const payload = listenBrainzPayload(listen);
    if (Buffer.byteLength(JSON.stringify(payload.payload[0]), "utf8") > 10_240) throw new ScrobbleError("LISTEN_TOO_LARGE", "Track metadata exceeds ListenBrainz's size limit.", "permanent");
    const body = await this.request("submit-listens", payload, signal);
    if (body.status !== "ok") throw new ScrobbleError("INVALID_RESPONSE", "ListenBrainz did not confirm acceptance of this listen.", "transient");
  }
  async validateToken(signal?: AbortSignal): Promise<string> {
    const body = await this.request("validate-token", undefined, signal);
    if (body.valid === false) throw new ScrobbleError("INVALID_TOKEN", "ListenBrainz rejected this user token. Replace it in Settings.", "auth", 200);
    if (body.valid !== true || typeof body.user_name !== "string" || !body.user_name.trim()) throw new ScrobbleError("INVALID_RESPONSE", "ListenBrainz did not validate the account.", "transient");
    return body.user_name;
  }
}
