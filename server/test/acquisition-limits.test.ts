import path from "node:path";
import fs from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AcquisitionService, type AcquisitionContext } from "../src/domain/acquisition.js";
import type { SourceCandidate } from "../src/domain/source-discovery.js";
import { AcquisitionCapacityError, DEFAULT_ACQUISITION_LIMITS, type AcquisitionLimits } from "../src/domain/acquisition-limits.js";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";

let fixture: Awaited<ReturnType<typeof createTestServer>> | undefined;
let service: AcquisitionService | undefined;
afterEach(async () => {
  await service?.shutdown();
  if (fixture) await closeTestServer(fixture.app, fixture.db);
  fixture = undefined;
  service = undefined;
});

async function setup(limits: Partial<AcquisitionLimits> = {}) {
  fixture = await createTestServer(createFakeBackend());
  await fixture.acquisition.shutdown();
  let now = Date.now();
  const seen: string[] = [];
  const acquire = vi.fn(async (candidate: SourceCandidate, context: AcquisitionContext) => {
    seen.push(candidate.title || "");
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) resolve();
      else context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("aborted");
  });
  fixture.acquisitionProviders.register({ id: "fixture", name: "Fixture", canAcquire: (c) => c.provider === "fixture", acquire });
  service = new AcquisitionService(fixture.db, fixture.acquisitionProviders, fixture.library, fixture.catalog, fixture.plugins, {
    musicRoot: path.join(fixture.directory, "bounded-music"),
    tmpDir: path.join(fixture.directory, "bounded-tmp"), maxConcurrentDownloads: 1,
    now: () => now, limits,
  });
  const user = fixture.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
  const other = await createUser(fixture.db, { username: "other", password: "other-password" });
  if (!other) throw new Error("Missing fixture user");
  const submit = (userId = user.id, title = "Original title") => service!.createJob(userId, {
    candidate: { id: "candidate", provider: "fixture", title },
  });
  return { ...fixture, user, other, submit, acquire, seen, advance: (ms: number) => { now += ms; } };
}

describe("bounded acquisition scheduling", () => {
  test("personal downloads list job names and stays account-scoped for administrators", async () => {
    const env = await setup();
    const own = await env.submit(env.user.id, "My download");
    const other = await env.submit(env.other.id, "Other download");
    const { cookie } = await login(env.app);
    const personal = await env.app.inject({ url: "/api/acquisitions?scope=mine", headers: { cookie } });
    expect(personal.statusCode).toBe(200);
    expect(personal.json().jobs).toMatchObject([{ id: own.id, requestedTitle: "My download" }]);
    const all = await env.app.inject({ url: "/api/acquisitions", headers: { cookie } });
    expect(all.json().jobs.map((job: { id: string }) => job.id)).toContain(other.id);
  });

  test("per-user and global pending caps preserve FIFO and cancellation releases pending capacity", async () => {
    const env = await setup({ maxPending: 2, maxPendingPerUser: 1 });
    const active = await env.submit();
    await vi.waitFor(() => expect(env.acquire).toHaveBeenCalledOnce());
    const first = await env.submit();
    await expect(env.submit()).rejects.toBeInstanceOf(AcquisitionCapacityError);
    const second = await env.submit(env.other.id, "Second");
    await expect(env.submit(env.other.id)).rejects.toBeInstanceOf(AcquisitionCapacityError);
    expect(service!.listJobs()).toHaveLength(3);
    await service!.cancelJob(first.id);
    const replacement = await env.submit(env.user.id, "Replacement");
    expect(service!.getJob(first.id)?.status).toBe("cancelled");
    await service!.cancelJob(active.id);
    await vi.waitFor(() => expect(env.seen).toEqual(["Original title", "Second"]));
    await service!.cancelJob(second.id);
    await vi.waitFor(() => expect(env.seen).toEqual(["Original title", "Second", "Replacement"]));
    expect(service!.getJob(replacement.id)?.status).toBe("downloading");
  });

  test("simultaneous preflight submissions cannot bypass capacity and rejected input is not retained", async () => {
    const env = await setup({ maxPending: 3, maxPendingPerUser: 2, submissionsPerUser: 100 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    env.backend.search = vi.fn(async () => { await gate; return { tracks: [], artists: [], albums: [], playlists: [] }; });
    // Catalog keeps the same backend object; all submissions wait inside deduplication.
    const result = {
      id: "external", type: "track" as const, title: "Song", subtitle: null, artist: "Artist", album: null,
      artwork: null, availability: null, provider: "external" as const,
      source: { kind: "external" as const, count: 1 }, metadata: {},
    };
    const attempts = Array.from({ length: 20 }, (_, index) => service!.createJob(index % 2 ? env.user.id : env.other.id,
      { result: { ...result, id: `external-${index}` } }));
    const settledPromise = Promise.allSettled(attempts);
    release();
    const settled = await settledPromise;
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(3);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(17);
    const count = env.db.prepare("SELECT COUNT(*) AS count FROM acquisition_job_inputs").get() as { count: number };
    expect(count.count).toBeLessThanOrEqual(3);
    expect(service!.listJobs()).toHaveLength(3);
  });

  test("submission windows expire and account rate storage fails closed at its cap", async () => {
    const env = await setup({ submissionsPerUser: 1, maxRateEntries: 1, submissionWindowMs: 1000 });
    const job = await env.submit();
    await expect(env.submit()).rejects.toMatchObject({ retryAfter: 1 });
    await expect(env.submit(env.other.id)).rejects.toBeInstanceOf(AcquisitionCapacityError);
    await service!.cancelJob(job.id);
    env.advance(1001);
    await expect(env.submit(env.other.id)).resolves.toBeDefined();
  });

  test("global submission rate is enforced across accounts", async () => {
    const env = await setup({ submissionsGlobal: 1 });
    await env.submit();
    await expect(env.submit(env.other.id)).rejects.toBeInstanceOf(AcquisitionCapacityError);
  });

  test("retries preserve candidate input, are throttled, and cannot duplicate active workers", async () => {
    const env = await setup({ submissionsPerUser: 2, submissionWindowMs: 1000 });
    const job = await env.submit();
    await vi.waitFor(() => expect(env.acquire).toHaveBeenCalledOnce());
    await expect(service!.retryJob(job.id)).rejects.toThrow("settled");
    await service!.cancelJob(job.id);
    await vi.waitFor(() => expect(service!.getJob(job.id)?.errorCode).toBe("CANCELLED"));
    await service!.retryJob(job.id);
    await vi.waitFor(() => expect(env.seen).toEqual(["Original title", "Original title"]));
    await service!.cancelJob(job.id);
    await vi.waitFor(() => expect(service!.getJob(job.id)?.errorCode).toBe("CANCELLED"));
    await expect(service!.retryJob(job.id)).rejects.toBeInstanceOf(AcquisitionCapacityError);
    env.advance(1001);
    await expect(service!.retryJob(job.id)).resolves.toMatchObject({ id: job.id, status: "queued" });
  });

  test("a failed download can retry to completion and terminal worker bookkeeping is released", async () => {
    const env = await setup();
    let attempt = 0;
    env.acquisitionProviders.register({
      id: "fixture", name: "Fixture", canAcquire: (candidate) => candidate.provider === "fixture",
      acquire: async (candidate, context) => {
        if (++attempt === 1) throw new Error("Fixture failure");
        const file = path.join(context.tmpDir, "retry.mp3");
        fs.writeFileSync(file, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(256)]));
        return { files: [{ path: file, name: "retry.mp3", title: candidate.title, artist: "Artist", size: 259 }] };
      },
    });
    const job = await env.submit();
    await vi.waitFor(() => expect(service!.getJob(job.id)?.status).toBe("failed"));
    await service!.retryJob(job.id);
    await vi.waitFor(() => expect(service!.getJob(job.id)?.status).toBe("completed"));
    expect(attempt).toBe(2);
    expect(service!.getJob(job.id)?.files?.[0]?.title).toBe("Original title");
    expect(service!.getJob(job.id)?.errorCode).toBeUndefined();
    await expect(service!.retryJob(job.id)).rejects.toThrow("settled");
  });

  test("administrator retries cannot bypass another owner's pending limit", async () => {
    const env = await setup({ maxPendingPerUser: 1 });
    await env.submit();
    await vi.waitFor(() => expect(env.acquire).toHaveBeenCalledOnce());
    const cancelled = await env.submit(env.other.id);
    await service!.cancelJob(cancelled.id);
    await env.submit(env.other.id);
    await expect(service!.retryJob(cancelled.id, env.user.id, true)).rejects.toBeInstanceOf(AcquisitionCapacityError);
    expect(service!.getJob(cancelled.id)?.status).toBe("cancelled");
  });

  test("a retry removed by admission-time retention does not enqueue a nonexistent job", async () => {
    const env = await setup({ retentionMs: 1000 });
    const active = await env.submit();
    await vi.waitFor(() => expect(env.acquire).toHaveBeenCalledOnce());
    const expired = await env.submit(env.other.id);
    await service!.cancelJob(expired.id);
    env.advance(1001);
    await expect(service!.retryJob(expired.id)).rejects.toThrow("Job not found");
    expect(service!.getJob(expired.id)).toBeNull();
    expect(service!.listJobs().map((job) => job.id)).toEqual([active.id]);
    const replacement = await env.submit(env.other.id);
    await service!.cancelJob(active.id);
    await vi.waitFor(() => expect(service!.getJob(replacement.id)?.status).toBe("downloading"));
    expect(env.acquire).toHaveBeenCalledTimes(2);
  });

  test("count and age retention delete terminal inputs/cache but never pending or active jobs", async () => {
    const env = await setup({ maxRetainedJobs: 2, retentionMs: 1000 });
    const active = await env.submit();
    await vi.waitFor(() => expect(env.acquire).toHaveBeenCalledOnce());
    const pending = await env.submit();
    const insert = env.db.prepare(`INSERT INTO acquisition_jobs
      (id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
    for (const [index, status] of ["completed", "failed", "cancelled"].entries()) {
      const id = `terminal-${index}`;
      const date = new Date(Date.parse(active.createdAt) + index).toISOString();
      insert.run(id, env.user.id, status, date, date);
      env.db.prepare("INSERT INTO acquisition_job_inputs VALUES (?, ?)").run(id, "{}");
      env.db.prepare(`INSERT INTO acquisition_containers
        (container_key, provider_id, job_id, status, created_at, updated_at) VALUES (?, 'fixture', ?, 'ready', ?, ?)`).run(id, id, date, date);
    }
    service!.cleanupHistory();
    expect(service!.getJob("terminal-0")).toBeNull();
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM acquisition_containers").get()).toEqual({ n: 2 });
    env.advance(2000);
    service!.cleanupHistory();
    expect(service!.listJobs().map((job) => job.id).sort()).toEqual([active.id, pending.id].sort());
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM acquisition_job_inputs").get()).toEqual({ n: 2 });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM acquisition_containers").get()).toEqual({ n: 0 });
  });

  test("HTTP queue and retry throttling return 429 and Retry-After", async () => {
    fixture = await createTestServer(createFakeBackend(), {
      acquisitionLimits: { ...DEFAULT_ACQUISITION_LIMITS, submissionsPerUser: 1 },
    });
    const { cookie } = await login(fixture.app);
    const response = await fixture.app.inject({ method: "POST", url: "/api/acquisitions", headers: { cookie },
      payload: { candidate: { id: "candidate", provider: "missing" } } });
    expect(response.statusCode).toBe(202);
    const jobId = response.json().jobId;
    await vi.waitFor(() => expect(fixture!.acquisition.getJob(jobId)?.status).toBe("failed"));
    for (const url of ["/api/acquisitions", `/api/acquisitions/${jobId}/retry`]) {
      const rejected = await fixture.app.inject({ method: "POST", url, headers: { cookie },
        payload: url.endsWith("retry") ? {} : { trackId: "another" } });
      expect(rejected.statusCode).toBe(429);
      expect(Number(rejected.headers["retry-after"])).toBeGreaterThan(0);
    }
    expect(fixture.acquisition.listJobs()).toHaveLength(1);
  });

  test("an unfinished job for the same requested item is reused instead of duplicated", async () => {
    const env = await setup({ submissionsPerUser: 10, maxPendingPerUser: 5 });
    const request = { candidate: { id: "candidate", provider: "fixture", title: "Song" }, trackId: "deezer-track-1" };
    const albumRequest = { candidate: { id: "album-candidate", provider: "fixture", title: "Record" }, albumId: "deezer-album-1" };
    const [first, concurrent] = await Promise.all([
      service!.createJob(env.user.id, request),
      service!.createJob(env.user.id, request),
    ]);
    expect(concurrent.id).toBe(first.id);
    await vi.waitFor(() => expect(env.acquire).toHaveBeenCalledOnce());
    expect((await service!.createJob(env.user.id, request)).id).toBe(first.id);

    const album = await service!.createJob(env.user.id, albumRequest);
    expect((await service!.createJob(env.user.id, albumRequest)).id).toBe(album.id);
    expect(album.id).not.toBe(first.id);

    // Other accounts never receive another user's job.
    const other = await service!.createJob(env.other.id, request);
    expect(other.id).not.toBe(first.id);
    expect(service!.listJobs()).toHaveLength(3);

    await service!.cancelJob(first.id);
    const fresh = await service!.createJob(env.user.id, request);
    expect(fresh.id).not.toBe(first.id);
  });
});
