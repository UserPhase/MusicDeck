import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration suites build full servers, hash passwords with scrypt and
    // spawn tagging subprocesses. Using every core starved them into
    // load-only timeouts, so leave headroom and allow slower runs.
    maxWorkers: "50%",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
