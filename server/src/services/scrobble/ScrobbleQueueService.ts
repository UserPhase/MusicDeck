import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../../db/database.js";
import type { PlaybackEvent } from "../../domain/listening-activity.js";
import { registerLogSecret } from "../../utils/logger.js";
import type { PrivacyManager } from "../PrivacyManager.js";
import { LastFmScrobbler } from "./LastFmScrobbler.js";
import { ListenBrainzScrobbler } from "./ListenBrainzScrobbler.js";
import { ScrobbleError, validateListen, type ScrobbleListen, type ScrobbleProvider } from "./protocol.js";

export const SCROBBLE_PROVIDERS: ScrobbleProvider[] = ["lastfm", "listenbrainz"];
type Connection = {
  user_id: string; provider: ScrobbleProvider; enabled: number; credentials_json: string; username: string; account_key: string;
  generation: string; connected_at: number; status: string; last_success_at: number | null; last_listened_at: number | null;
  last_error_code: string | null; last_error_message: string | null; last_http_status: number | null;
  last_checked_at: number | null; pause_until: number; updated_at: number;
};
type Job = { id: string; user_id: string; provider: ScrobbleProvider; account_name: string; payload_json: string;
  listened_at: number; attempts: number; lease_token: string; generation: string };
export interface ScrobbleConnectionStatus {
  provider: ScrobbleProvider; available: boolean; unavailableReason: string | null; enabled: boolean;
  username: string | null; status: string; lastSuccessfulScrobble: string | null; lastListenedAt: string | null;
  lastCheckedAt: string | null; nextRetryAt: string | null; pending: number; failed: number;
  error: { code: string; message: string; httpStatus: number | null } | null;
  diagnostics: Array<{ id: string; track: string; artist: string; listenedAt: string; state: string; attempts: number;
    code: string | null; message: string | null; httpStatus: number | null; nextRetryAt: string | null }>;
}
const iso = (value: number | null | undefined) => value ? new Date(value).toISOString() : null;
export function qualifiesForScrobble(provider: ScrobbleProvider, seconds: number, duration: number | null): boolean {
  if (provider === "lastfm" && (!duration || duration <= 30)) return false;
  return seconds >= (duration ? Math.min(duration / 2, 240) : 240);
}
/** A transactional outbox. Network I/O happens only after the playback transaction commits. */
export class ScrobbleQueueService {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly transport: typeof fetch;
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly shutdown = new AbortController();
  private readonly active = new Map<string, { userId: string; provider: ScrobbleProvider; controller: AbortController }>();
  private readonly changing = new Set<string>();
  constructor(private readonly db: Db, private readonly privacy: PrivacyManager,
    options: { fetchImpl?: typeof fetch; now?: () => number; random?: () => number; onError?: (error: unknown) => void } = {}) {
    this.now = options.now || Date.now; this.random = options.random || Math.random;
    const rawFetch = options.fetchImpl || globalThis.fetch;
    this.transport = (input, init) => privacy.fetch(input, init, rawFetch, "external");
    this.onError = options.onError || (() => {});
  }
  private readonly onError: (error: unknown) => void;
  private connection(userId: string, provider: ScrobbleProvider): Connection | undefined {
    return this.db.prepare("SELECT * FROM scrobble_connections WHERE user_id=? AND provider=?").get(userId, provider) as Connection | undefined;
  }
  private plugin(provider: ScrobbleProvider): Record<string, string> {
    const row = this.db.prepare("SELECT enabled,config_json,permissions_json FROM plugin_configs WHERE plugin_id=?").get(provider) as
      { enabled: number; config_json: string; permissions_json: string } | undefined;
    if (!row?.enabled) throw new ScrobbleError("PLUGIN_DISABLED", "Ask your administrator to enable this integration in Plugins.", "configuration");
    let permissions: unknown, config: Record<string, string>;
    try {
      permissions = JSON.parse(row.permissions_json);
      const parsed: unknown = JSON.parse(row.config_json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid plugin configuration");
      config = parsed as Record<string, string>;
    } catch {
      throw new ScrobbleError("APPLICATION_NOT_CONFIGURED", "The administrator must repair this integration's stored configuration.", "configuration");
    }
    if (!Array.isArray(permissions) || !["history.read", "network.request"].every((p) => permissions.includes(p))) {
      throw new ScrobbleError("PERMISSION_REQUIRED", "The administrator must approve listening history and network permissions.", "configuration");
    }
    if (provider === "lastfm" && (typeof config.apiKey !== "string" || !config.apiKey || typeof config.apiSecret !== "string" || !config.apiSecret)) throw new ScrobbleError("APPLICATION_NOT_CONFIGURED", "Ask your administrator to configure the Last.fm API key and shared secret.", "configuration");
    if (provider === "lastfm") { registerLogSecret(config.apiKey); registerLogSecret(config.apiSecret); }
    return config;
  }
  private available(provider: ScrobbleProvider): string | null {
    if (!this.privacy.isExternalAllowed()) return "External integrations are paused by the server's privacy settings.";
    try { this.plugin(provider); return null; } catch (error) {
      if (error instanceof ScrobbleError) return error.message;
      throw error;
    }
  }
  private assertAvailable(provider: ScrobbleProvider) {
    if (this.stopped) throw new ScrobbleError("QUEUE_CLOSED", "Scrobble processing is stopping. Try again after the server restarts.", "paused");
    if (!this.privacy.isExternalAllowed()) throw new ScrobbleError("PRIVACY_BLOCKED", "External integrations are paused by privacy settings.", "paused");
    return this.plugin(provider);
  }
  private lastfm(sessionKey?: string) {
    const config = this.assertAvailable("lastfm");
    return new LastFmScrobbler({ apiKey: config.apiKey, apiSecret: config.apiSecret, sessionKey }, this.transport);
  }
  applicationKey(): string { return this.assertAvailable("lastfm").apiKey; }
  private credential(connection: Connection): { token?: string; sessionKey?: string } {
    const credentials = JSON.parse(connection.credentials_json);
    registerLogSecret(credentials.token); registerLogSecret(credentials.sessionKey);
    return credentials;
  }
  private cancelActive(userId: string, provider: ScrobbleProvider) {
    for (const operation of this.active.values()) if (operation.userId === userId && operation.provider === provider) operation.controller.abort();
  }
  private saveConnection(userId: string, provider: ScrobbleProvider, username: string, credentials: object) {
    this.assertAvailable(provider);
    const now = this.now();
    this.cancelActive(userId, provider);
    this.db.transaction(() => {
      const previous = this.connection(userId, provider);
      const accountKey = username.toLowerCase();
      const sameAccount = previous?.enabled && previous.account_key === accountKey;
      // A different remote account must never receive listens queued for the old one.
      if (!sameAccount) this.db.prepare("UPDATE scrobble_queue SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE user_id=? AND provider=? AND state IN ('pending','sending','blocked','failed')").run(userId, provider);
      else this.db.prepare("UPDATE scrobble_queue SET state='pending',next_attempt_at=?,lease_token=NULL,lease_until=NULL WHERE user_id=? AND provider=? AND state IN ('blocked','sending')").run(now, userId, provider);
      this.db.prepare(`INSERT INTO scrobble_connections(user_id,provider,credentials_json,username,account_key,generation,connected_at,updated_at,last_checked_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET enabled=1,credentials_json=excluded.credentials_json,
        username=excluded.username,account_key=excluded.account_key,generation=excluded.generation,connected_at=excluded.connected_at,status='connected',
        last_success_at=CASE WHEN ? THEN last_success_at ELSE NULL END,last_listened_at=CASE WHEN ? THEN last_listened_at ELSE NULL END,
        last_error_code=NULL,last_error_message=NULL,last_http_status=NULL,pause_until=0,updated_at=excluded.updated_at,last_checked_at=excluded.last_checked_at`)
        .run(userId, provider, JSON.stringify(credentials), username, accountKey, randomUUID(), sameAccount ? previous!.connected_at : now, now, now, Number(Boolean(sameAccount)), Number(Boolean(sameAccount)));
    })();
    this.kick();
  }
  private async change<T>(userId: string, provider: ScrobbleProvider, action: () => Promise<T>) {
    if (this.stopped) throw new ScrobbleError("QUEUE_CLOSED", "Scrobble processing is stopping. Try again after the server restarts.", "paused");
    const key = `${userId}:${provider}`;
    if (this.changing.has(key)) throw new ScrobbleError("CONNECTION_BUSY", "A connection update is already in progress.", "paused");
    this.changing.add(key);
    try { return await action(); } finally { this.changing.delete(key); }
  }
  async connectListenBrainz(userId: string, token: string): Promise<void> {
    registerLogSecret(token);
    await this.change(userId, "listenbrainz", async () => {
      this.assertAvailable("listenbrainz");
      const username = await new ListenBrainzScrobbler(token, this.transport).validateToken(this.shutdown.signal);
      this.saveConnection(userId, "listenbrainz", username, { token });
    });
  }
  async connectLastFm(userId: string, value: { sessionKey: string } | { token: string }): Promise<void> {
    registerLogSecret("token" in value ? value.token : value.sessionKey);
    await this.change(userId, "lastfm", async () => {
      let sessionKey: string, username: string;
      if ("token" in value) ({ sessionKey, username } = await this.lastfm().exchangeToken(value.token, this.shutdown.signal));
      else { sessionKey = value.sessionKey; username = await this.lastfm(sessionKey).validateSession(this.shutdown.signal); }
      registerLogSecret(sessionKey);
      this.saveConnection(userId, "lastfm", username, { sessionKey });
    });
  }
  async disconnect(userId: string, provider: ScrobbleProvider): Promise<void> {
    await this.change(userId, provider, async () => {
      this.cancelActive(userId, provider);
      this.db.transaction(() => {
        this.db.prepare(`UPDATE scrobble_connections SET enabled=0,credentials_json='{}',status='disconnected',generation=?,
          last_error_code=NULL,last_error_message=NULL,last_http_status=NULL,pause_until=0,updated_at=? WHERE user_id=? AND provider=?`)
          .run(randomUUID(), this.now(), userId, provider);
        this.db.prepare("UPDATE scrobble_queue SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE user_id=? AND provider=? AND state IN ('pending','sending','blocked','failed')").run(userId, provider);
        if (provider === "lastfm") this.db.prepare("DELETE FROM scrobble_auth_states WHERE user_id=?").run(userId);
      })();
    });
  }
  async testConnection(userId: string, provider: ScrobbleProvider): Promise<void> {
    await this.change(userId, provider, async () => {
      this.assertAvailable(provider);
      const connection = this.connection(userId, provider);
      if (!connection?.enabled) throw new ScrobbleError("NOT_CONNECTED", "Connect this account before testing it.", "auth");
      try {
        const credentials = this.credential(connection);
        const username = provider === "lastfm" ? await this.lastfm(credentials.sessionKey).validateSession(this.shutdown.signal)
          : await new ListenBrainzScrobbler(credentials.token!, this.transport).validateToken(this.shutdown.signal);
        if (username.toLowerCase() !== connection.username.toLowerCase()) throw new ScrobbleError("ACCOUNT_CHANGED", "This credential now identifies another account. Disconnect and connect it again.", "auth");
        this.db.prepare(`UPDATE scrobble_connections SET status='connected',last_error_code=NULL,last_error_message=NULL,
          last_http_status=NULL,last_checked_at=?,pause_until=0 WHERE user_id=? AND provider=? AND generation=?`)
          .run(this.now(), userId, provider, connection.generation);
        this.db.prepare("UPDATE scrobble_queue SET state='pending',next_attempt_at=? WHERE user_id=? AND provider=? AND state='blocked'").run(this.now(), userId, provider);
      } catch (error) {
        if (error instanceof ScrobbleError) this.recordError(connection, error);
        throw error;
      }
    });
    this.kick();
  }
  /** Call inside recordPlayback's SQLite transaction; safe on repeated cumulative reports. */
  enqueuePlayback(userId: string, eventId: string, event: PlaybackEvent, listenedSeconds: number, duration: number | null): void {
    if (this.stopped || !this.privacy.isExternalAllowed()) return;
    // A delayed client report must not publish listening that predates a privacy-policy change.
    // Previously consented jobs already in the outbox can still resume after sharing is enabled.
    const policy = this.db.prepare("SELECT updated_at FROM server_settings WHERE key='privacy.policy'").get() as { updated_at: string } | undefined;
    if (policy && Date.parse(event.startedAt) < Date.parse(policy.updated_at)) return;
    const artist = event.track.artist.trim(), track = event.track.title.trim();
    if (!artist || !track || /^unknown artist$/i.test(artist) || /^unknown (title|track)$/i.test(track)) return;
    const listen: ScrobbleListen = { artist, track, ...(event.track.album.trim() ? { album: event.track.album.trim() } : {}),
      listenedAt: Math.floor(Date.parse(event.startedAt) / 1000), ...(duration ? { duration } : {}) };
    try { validateListen(listen); } catch (error) { if (error instanceof ScrobbleError) return; throw error; }
    const dedupe = createHash("sha256").update(JSON.stringify([listen.listenedAt, artist, track])).digest("hex");
    for (const provider of SCROBBLE_PROVIDERS) {
      if (!qualifiesForScrobble(provider, listenedSeconds, duration) || this.available(provider)) continue;
      const connection = this.connection(userId, provider);
      if (!connection?.enabled || Date.parse(event.startedAt) < connection.connected_at) continue;
      this.db.prepare(`INSERT OR IGNORE INTO scrobble_queue
        (id,user_id,provider,listening_event_id,dedupe_key,account_name,payload_json,listened_at,next_attempt_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), userId, provider, eventId, dedupe, connection.account_key,
          JSON.stringify(listen), listen.listenedAt, this.now(), this.now());
    }
  }
  retry(userId: string, provider: ScrobbleProvider): void {
    this.assertAvailable(provider);
    const connection = this.connection(userId, provider);
    if (!connection?.enabled) throw new ScrobbleError("NOT_CONNECTED", "Connect an account before retrying queued listens.", "auth");
    if (connection.status === "auth-error" || connection.status === "configuration-error") throw new ScrobbleError("RECONNECT_REQUIRED", "Reconnect or successfully test the connection before retrying.", "auth");
    // Respect provider backoff even when a user repeatedly presses Retry.
    this.db.prepare(`UPDATE scrobble_queue SET state='pending',attempts=0,next_attempt_at=MAX(next_attempt_at,?)
      WHERE user_id=? AND provider=? AND account_name=? AND state='failed'`)
      .run(this.now(), userId, provider, connection.account_key);
    this.kick();
  }
  statuses(userId: string): ScrobbleConnectionStatus[] {
    return SCROBBLE_PROVIDERS.map((provider) => {
      const c = this.connection(userId, provider), unavailableReason = this.available(provider);
      const counts = this.db.prepare(`SELECT SUM(state IN ('pending','sending','blocked')) AS pending,
        SUM(state='failed') AS failed,MIN(CASE WHEN state='pending' THEN next_attempt_at END) AS next
        FROM scrobble_queue WHERE user_id=? AND provider=?`).get(userId, provider) as { pending: number; failed: number; next: number | null };
      const diagnostics = this.db.prepare(`SELECT id,payload_json,listened_at,state,attempts,error_code,error_message,http_status,next_attempt_at
        FROM scrobble_queue WHERE user_id=? AND provider=? AND state IN ('pending','blocked','failed','ignored') AND error_code IS NOT NULL
        ORDER BY created_at DESC,id DESC LIMIT 20`).all(userId, provider) as any[];
      return { provider, available: !unavailableReason, unavailableReason, enabled: Boolean(c?.enabled), username: c?.enabled ? c.username : null,
        status: unavailableReason ? "paused" : c?.status || "disconnected", lastSuccessfulScrobble: iso(c?.last_success_at),
        lastListenedAt: iso(c?.last_listened_at ? c.last_listened_at * 1000 : null), lastCheckedAt: iso(c?.last_checked_at),
        nextRetryAt: counts.next ? iso(Math.max(counts.next, c?.pause_until || 0)) : null,
        pending: counts.pending || 0, failed: counts.failed || 0,
        error: c?.last_error_code ? { code: c.last_error_code, message: c.last_error_message!, httpStatus: c.last_http_status } : null,
        diagnostics: diagnostics.map((row) => { const listen: ScrobbleListen = JSON.parse(row.payload_json);
          return { id: row.id, track: listen.track, artist: listen.artist, listenedAt: new Date(row.listened_at * 1000).toISOString(),
            state: row.state, attempts: row.attempts, code: row.error_code, message: row.error_message, httpStatus: row.http_status,
            nextRetryAt: row.state === "pending" ? iso(Math.max(row.next_attempt_at, c?.pause_until || 0)) : null }; }) };
    });
  }
  private recordError(c: Connection, error: ScrobbleError, pauseUntil = 0): void {
    this.db.prepare(`UPDATE scrobble_connections SET status=?,last_error_code=?,last_error_message=?,last_http_status=?,last_checked_at=?,pause_until=?
      WHERE user_id=? AND provider=? AND generation=?`).run(error.kind === "auth" ? "auth-error" : error.kind === "configuration" ? "configuration-error" : "error",
        error.code, error.message, error.httpStatus ?? null, this.now(), pauseUntil, c.user_id, c.provider, c.generation);
  }
  private claim(): Job | undefined {
    const now = this.now();
    return this.db.transaction(() => {
      const providers = SCROBBLE_PROVIDERS.filter((provider) => !this.available(provider));
      if (!providers.length) return undefined;
      this.db.prepare("UPDATE scrobble_queue SET state='pending',lease_token=NULL,lease_until=NULL WHERE state='sending' AND lease_until<=?").run(now);
      const job = this.db.prepare(`SELECT q.*,c.generation FROM scrobble_queue q
        JOIN scrobble_connections c ON c.user_id=q.user_id AND c.provider=q.provider
        JOIN users u ON u.id=q.user_id
        JOIN plugin_configs p ON p.plugin_id=q.provider AND p.enabled=1
        WHERE q.state='pending' AND q.next_attempt_at<=? AND c.enabled=1 AND c.pause_until<=?
          AND q.provider IN (${providers.map(() => "?").join(",")})
          AND c.account_key=q.account_name AND u.disabled=0
          AND c.status NOT IN ('auth-error','configuration-error')
          AND NOT EXISTS (SELECT 1 FROM scrobble_queue older WHERE older.user_id=q.user_id AND older.provider=q.provider
            AND older.account_name=q.account_name AND older.state IN ('pending','sending','blocked') AND
            (older.listened_at,older.created_at,older.id)<(q.listened_at,q.created_at,q.id))
        ORDER BY q.listened_at,q.created_at,q.id LIMIT 1`).get(now, now, ...providers) as Job | undefined;
      if (!job) return undefined;
      const lease = randomUUID();
      this.db.prepare("UPDATE scrobble_queue SET state='sending',lease_token=?,lease_until=? WHERE id=? AND state='pending'").run(lease, now + 60_000, job.id);
      return { ...job, lease_token: lease };
    })();
  }
  private async deliver(job: Job): Promise<void> {
    const c = this.connection(job.user_id, job.provider);
    const controller = new AbortController();
    this.active.set(job.id, { userId: job.user_id, provider: job.provider, controller });
    const signal = AbortSignal.any([this.shutdown.signal, controller.signal]);
    let error: ScrobbleError | null = null;
    try {
      if (!c?.enabled || c.generation !== job.generation || c.account_key !== job.account_name) throw new ScrobbleError("PAUSED", "The account connection changed.", "paused");
      this.assertAvailable(job.provider);
      const credentials = this.credential(c), listen: ScrobbleListen = JSON.parse(job.payload_json);
      if (job.provider === "lastfm") await this.lastfm(credentials.sessionKey).scrobble(listen, signal);
      else await new ListenBrainzScrobbler(credentials.token!, this.transport).scrobble(listen, signal);
    } catch (failure) {
      error = failure instanceof ScrobbleError ? failure : new ScrobbleError("INTERNAL_ERROR", "The queued listen could not be processed. Check server configuration.", "configuration");
    } finally { this.active.delete(job.id); }
    const current = this.connection(job.user_id, job.provider);
    if (!current || current.generation !== job.generation) return;
    if (this.stopped || signal.aborted || !this.privacy.isExternalAllowed()) error = new ScrobbleError("PAUSED", "Submission paused; the original listen remains queued.", "paused");
    // Compare-and-swap the lease and update the status in one transaction.
    this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM scrobble_queue WHERE id=? AND lease_token=? AND state='sending'").get(job.id, job.lease_token)) return;
      const now = this.now();
      if (!error) {
        this.db.prepare("UPDATE scrobble_queue SET state='sent',delivered_at=?,lease_token=NULL,lease_until=NULL,error_code=NULL,error_message=NULL,http_status=NULL WHERE id=? AND lease_token=?").run(now, job.id, job.lease_token);
        this.db.prepare(`UPDATE scrobble_connections SET status='connected',last_success_at=?,last_listened_at=?,last_error_code=NULL,
          last_error_message=NULL,last_http_status=NULL,pause_until=0 WHERE user_id=? AND provider=? AND generation=?`)
          .run(now, job.listened_at, job.user_id, job.provider, job.generation);
        return;
      }
      const attempts = job.attempts + (error.kind === "paused" ? 0 : 1);
      const delay = Math.max(error.retryAfterMs, Math.min(6 * 3600_000, 30_000 * 2 ** Math.min(12, attempts - 1) * (1 + this.random() * 0.25)));
      const state = error.kind === "paused" ? "pending" : ["auth", "configuration"].includes(error.kind) ? "blocked"
        : error.kind === "ignored" ? "ignored" : error.kind === "permanent" || attempts >= 12 ? "failed" : "pending";
      const next = now + (error.kind === "paused" ? 15_000 : Math.ceil(delay));
      this.db.prepare(`UPDATE scrobble_queue SET state=?,attempts=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,
        error_code=?,error_message=?,http_status=? WHERE id=? AND lease_token=?`).run(state, attempts, next, error.code, error.message, error.httpStatus ?? null, job.id, job.lease_token);
      if (error.kind !== "paused") this.recordError(current, error, error.kind === "transient" ? next : 0);
    })();
  }
  /** Public for deterministic diagnostics/tests; only one drain runs per process. Leases also protect multiple processes. */
  drain(): Promise<void> {
    if (this.stopped || !this.privacy.isExternalAllowed()) return Promise.resolve();
    if (this.running) return this.running;
    this.running = (async () => {
      for (let count = 0; count < 100 && !this.stopped && this.privacy.isExternalAllowed(); count++) {
        const job = this.claim(); if (!job) break;
        await this.deliver(job);
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }
  kick(): void { if (!this.stopped) setImmediate(() => { void this.drain().catch(this.onError); }); }
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.kick(), 15_000); this.timer.unref(); this.kick();
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.shutdown.abort();
    await this.running;
    // Credential validation also uses shutdown.signal; no new worker can start after this point.
  }
}
