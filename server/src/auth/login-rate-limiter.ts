import { createHash } from "node:crypto";

export type LoginRateLimitConfig = {
  windowMs: number;
  ipMax: number;
  accountMax: number;
  maxConcurrent: number;
  maxEntries: number;
};

export const DEFAULT_LOGIN_RATE_LIMIT: Readonly<LoginRateLimitConfig> = {
  windowMs: 15 * 60 * 1000,
  ipMax: 20,
  accountMax: 10,
  maxConcurrent: 4,
  maxEntries: 10_000,
};

type Bucket = { attempts: number; expiresAt: number };
type Admission = { allowed: false; retryAfter: number } | { allowed: true; release: () => void };

export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private active = 0;
  private nextCleanup = 0;

  constructor(
    private readonly config: LoginRateLimitConfig = DEFAULT_LOGIN_RATE_LIMIT,
    private readonly now: () => number = () => Date.now(),
  ) {
    for (const [key, value] of Object.entries(config)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Login rate limit ${key} must be a positive safe integer`);
      }
    }
    if (config.maxEntries < 2) {
      throw new Error("Login rate limit maxEntries must be at least 2");
    }
  }

  get entryCount() {
    return this.buckets.size;
  }

  cleanup(now = this.now()) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) this.buckets.delete(key);
    }
    this.nextCleanup = now + Math.min(this.config.windowMs, 60_000);
  }

  admit(ip: string, username: string): Admission {
    const now = this.now();
    if (now >= this.nextCleanup) this.cleanup(now);

    // Hash identifiers so untrusted username length cannot inflate stored keys.
    const account = createHash("sha256").update(username.trim().normalize("NFKC").toLowerCase()).digest("hex");
    const keys = [`ip:${ip}`, `account:${account}`];
    const limits = [this.config.ipMax, this.config.accountMax];
    for (const key of keys) {
      if ((this.buckets.get(key)?.expiresAt ?? Infinity) <= now) this.buckets.delete(key);
    }
    const blockedUntil = keys.reduce((expiry, key, index) => {
      const bucket = this.buckets.get(key);
      return bucket && bucket.attempts >= limits[index] ? Math.max(expiry, bucket.expiresAt) : expiry;
    }, 0);
    if (blockedUntil > now) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((blockedUntil - now) / 1000)) };
    }
    if (this.active >= this.config.maxConcurrent) {
      return { allowed: false, retryAfter: 1 };
    }

    const missing = keys.filter((key) => !this.buckets.has(key)).length;
    if (this.buckets.size + missing > this.config.maxEntries) {
      this.cleanup(now);
      if (this.buckets.size + missing > this.config.maxEntries) {
        // Never evict live buckets: rotating usernames/IPs must not reset limits.
        let earliestExpiry = Infinity;
        for (const bucket of this.buckets.values()) earliestExpiry = Math.min(earliestExpiry, bucket.expiresAt);
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((earliestExpiry - now) / 1000)) };
      }
    }

    for (const key of keys) {
      const bucket = this.buckets.get(key) ?? { attempts: 0, expiresAt: now + this.config.windowMs };
      bucket.attempts += 1;
      this.buckets.set(key, bucket);
    }
    this.active += 1;
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (!released) {
          released = true;
          this.active -= 1;
        }
      },
    };
  }
}
