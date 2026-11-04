import { describe, expect, test, vi } from "vitest";
import { closeTestServer, createTestServer, login } from "./helpers.js";
import { LogBuffer, serverLogs } from "../src/utils/logger.js";
import { AcquisitionCapacityError } from "../src/domain/acquisition-limits.js";
import { AcquisitionValidationError } from "../src/domain/acquisition-url-policy.js";
import { AcquisitionJobError } from "../src/domain/acquisition.js";

describe("safe acquisition errors", () => {
  test("database, filesystem, and provider exceptions stay in redacted server diagnostics", async () => {
    const logs = new LogBuffer();
    const env = await createTestServer(undefined, {}, undefined, undefined, undefined, undefined, { logger: true, logBuffer: logs });
    try {
      const { cookie } = await login(env.app);
      for (const message of [
        "SQLITE_BUSY SELECT secret FROM provider_configs password=db-password-fixture",
        "EACCES D:\\private\\music\\provider.json token=filesystem-secret-fixture",
        "Provider failed https://user:pass@provider.test/api?apiKey=provider-secret-fixture",
      ]) {
        const create = vi.spyOn(env.acquisition, "createJob").mockRejectedValueOnce(new Error(message));
        const response = await env.app.inject({ method: "POST", url: "/api/acquisitions", headers: { cookie }, payload: { trackId: "fixture" } });
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ error: { code: "ACQUISITION_CREATE_FAILED", message: "Failed to create acquisition job" } });
        create.mockRestore();
        const retry = vi.spyOn(env.acquisition, "retryJob").mockRejectedValueOnce(new Error(message));
        const retried = await env.app.inject({ method: "POST", url: "/api/acquisitions/job/retry", headers: { cookie } });
        expect(retried.statusCode).toBe(500);
        expect(retried.json()).toEqual({ error: { code: "ACQUISITION_RETRY_FAILED", message: "Failed to retry acquisition job" } });
        retry.mockRestore();
      }
      const logged = JSON.stringify(logs.list());
      for (const secret of ["db-password-fixture", "filesystem-secret-fixture", "provider-secret-fixture", "user:pass@"]) {
        expect(logged).not.toContain(secret);
      }
      expect(logged).toContain("SQLITE_BUSY");
      expect(logged).toContain("EACCES");
      expect(logged).toContain("Provider failed");
      expect(logged).toContain("[REDACTED]");
      expect(logged).toContain("acquisition.retry");
    } finally { await closeTestServer(env.app, env.db); }
  });

  test("safe typed errors retain useful statuses and rate-limit headers", async () => {
    const env = await createTestServer();
    try {
      const { cookie } = await login(env.app);
      for (const [error, status, code] of [
        [new AcquisitionJobError("ACQUISITION_NOT_FOUND"), 404, "ACQUISITION_NOT_FOUND"],
        [new AcquisitionJobError("ACQUISITION_NOT_RETRYABLE"), 409, "ACQUISITION_NOT_RETRYABLE"],
        [new AcquisitionValidationError(), 400, "VALIDATION_ERROR"],
        [new AcquisitionCapacityError(17), 429, "ACQUISITION_CAPACITY"],
      ] as const) {
        const retry = vi.spyOn(env.acquisition, "retryJob").mockRejectedValueOnce(error);
        const response = await env.app.inject({ method: "POST", url: "/api/acquisitions/job/retry", headers: { cookie } });
        expect(response.statusCode).toBe(status);
        expect(response.json().error.code).toBe(code);
        if (status === 429) expect(response.headers["retry-after"]).toBe("17");
        retry.mockRestore();
      }
      const invalid = await env.app.inject({ method: "POST", url: "/api/acquisitions", headers: { cookie }, payload: { autoPlay: "yes" } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.message).toBe("Invalid acquisition request payload");
    } finally { await closeTestServer(env.app, env.db); }
  });

  test("old raw persisted job failures are not returned through detail or list APIs", async () => {
    const env = await createTestServer();
    try {
      const { cookie, response } = await login(env.app);
      const now = new Date().toISOString();
      env.db.prepare(`INSERT INTO acquisition_jobs (id,user_id,status,error_code,error_message,created_at,updated_at)
        VALUES ('old-error',?,'failed','ACQUISITION_FAILED',?,?,?)`).run(response.json().user.id, "EACCES /private/path password=old-secret", now, now);
      for (const url of ["/api/acquisitions", "/api/acquisitions/old-error"]) {
        const result = await env.app.inject({ url, headers: { cookie } });
        expect(result.statusCode).toBe(200);
        expect(result.body).not.toContain("/private/path");
        expect(result.body).not.toContain("old-secret");
        expect(result.body).toContain("Acquisition failed.");
      }
    } finally { await closeTestServer(env.app, env.db); }
  });

  test("real worker failures persist and publish only safe messages", async () => {
    const env = await createTestServer();
    let unsubscribe: (() => void) | undefined;
    try {
      const diagnostic = "EACCES /private/provider-cache token=worker-secret-fixture";
      const acquire = vi.fn(async () => { throw new Error(diagnostic); });
      env.acquisitionProviders.register({
        id: "failure-fixture", name: "Failure fixture",
        canAcquire: (candidate) => candidate.provider === "failure-fixture",
        acquire,
      });
      const { cookie, response } = await login(env.app);
      const events: Array<Record<string, unknown>> = [];
      unsubscribe = env.acquisition.subscribe((event, payload) => {
        if (event === "acquisition.failed") events.push(payload);
      });
      const job = await env.acquisition.createJob(response.json().user.id, {
        candidate: { id: "worker-failure", provider: "failure-fixture", title: "Fixture" },
      });
      await vi.waitFor(() => expect(env.acquisition.getJob(job.id)?.status).toBe("failed"));
      expect(acquire).toHaveBeenCalled();
      const stored = env.db.prepare("SELECT error_message FROM acquisition_jobs WHERE id = ?").get(job.id);
      expect(stored).toEqual({ error_message: "Acquisition failed. Please retry or contact an administrator." });
      expect(events).toContainEqual(expect.objectContaining({
        jobId: job.id, errorMessage: "Acquisition failed. Please retry or contact an administrator.",
      }));
      const detail = await env.app.inject({ url: `/api/acquisitions/${job.id}`, headers: { cookie } });
      for (const output of [JSON.stringify(events), detail.body]) {
        expect(output).not.toContain("/private/provider-cache");
        expect(output).not.toContain("worker-secret-fixture");
      }
      const diagnostics = serverLogs.list().filter((entry) => entry.meta?.jobId === job.id);
      expect(JSON.stringify(diagnostics)).toContain("EACCES");
      expect(JSON.stringify(diagnostics)).not.toContain("worker-secret-fixture");
    } finally {
      unsubscribe?.();
      await closeTestServer(env.app, env.db);
      serverLogs.clear();
    }
  });
});
