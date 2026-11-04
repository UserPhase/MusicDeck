import { describe, expect, test } from "vitest";
import { LoginRateLimiter, type LoginRateLimitConfig } from "../src/auth/login-rate-limiter.js";

const limits: LoginRateLimitConfig = {
  windowMs: 1000, ipMax: 3, accountMax: 2, maxConcurrent: 2, maxEntries: 6,
};

function attempt(limiter: LoginRateLimiter, ip: string, username: string) {
  const admission = limiter.admit(ip, username);
  if (admission.allowed) admission.release();
  return admission;
}

describe("login limiter", () => {
  test("normalizes account keys across IPs and expires without real waits", () => {
    let now = 0;
    const limiter = new LoginRateLimiter(limits, () => now);
    expect(attempt(limiter, "1", " Alice ").allowed).toBe(true);
    expect(attempt(limiter, "2", "ＡＬＩＣＥ").allowed).toBe(true);
    expect(attempt(limiter, "3", "alice")).toEqual({ allowed: false, retryAfter: 1 });
    now = 1000;
    expect(attempt(limiter, "3", "alice").allowed).toBe(true);
    limiter.cleanup();
    expect(limiter.entryCount).toBe(2);
    now = 2000;
    limiter.cleanup();
    expect(limiter.entryCount).toBe(0);
  });

  test("limits an IP independently of rotating usernames", () => {
    const limiter = new LoginRateLimiter({ ...limits, maxEntries: 20 }, () => 0);
    for (const username of ["a", "b", "c"]) expect(attempt(limiter, "1", username).allowed).toBe(true);
    expect(attempt(limiter, "1", "d")).toEqual({ allowed: false, retryAfter: 1 });
    expect(attempt(limiter, "2", "d").allowed).toBe(true);
  });

  test("bounds concurrent work and release is idempotent", () => {
    const limiter = new LoginRateLimiter(limits, () => 0);
    const first = limiter.admit("1", "a");
    const second = limiter.admit("2", "b");
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(limiter.admit("3", "c")).toEqual({ allowed: false, retryAfter: 1 });
    if (!first.allowed || !second.allowed) throw new Error("Expected admitted requests");
    first.release();
    first.release();
    const third = limiter.admit("3", "c");
    expect(third.allowed).toBe(true);
    expect(limiter.admit("4", "d").allowed).toBe(false);
    second.release();
    if (third.allowed) third.release();
  });

  test("fails closed at storage capacity without evicting active buckets", () => {
    let now = 0;
    const limiter = new LoginRateLimiter({ ...limits, maxEntries: 2 }, () => now);
    expect(attempt(limiter, "1", "a".repeat(100_000)).allowed).toBe(true);
    for (let i = 0; i < 100; i++) {
      expect(attempt(limiter, String(i + 2), `name-${i}`).allowed).toBe(false);
      expect(limiter.entryCount).toBe(2);
    }
    expect(attempt(limiter, "1", "a".repeat(100_000)).allowed).toBe(true);
    expect(attempt(limiter, "1", "a".repeat(100_000)).allowed).toBe(false);
    now = 1000;
    expect(attempt(limiter, "2", "new").allowed).toBe(true);
    expect(limiter.entryCount).toBe(2);
  });

  test.each([0, -1, 1.5, Infinity, NaN])("rejects invalid settings %s", (value) => {
    expect(() => new LoginRateLimiter({ ...limits, ipMax: value })).toThrow("positive safe integer");
  });

  test("requires space for both identifiers", () => {
    expect(() => new LoginRateLimiter({ ...limits, maxEntries: 1 })).toThrow("at least 2");
  });

  test("keeps admission and cleanup on one clock snapshot", () => {
    let now = 0;
    const limiter = new LoginRateLimiter({ ...limits, windowMs: 2, maxEntries: 2 }, () => now++);
    for (let i = 0; i < 50; i++) {
      attempt(limiter, "1", i % 2 ? "a" : "b");
      expect(limiter.entryCount).toBeLessThanOrEqual(2);
    }
  });
});
