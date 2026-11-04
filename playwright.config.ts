import { defineConfig } from "@playwright/test";
import fs from "node:fs";

const edge = process.platform === "win32" && fs.existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
export default defineConfig({
  testDir: "./tests/acceptance",
  testMatch: "e2e-user-journeys.test.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  outputDir: "./test-results/acceptance",
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL || (edge ? "msedge" : undefined),
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
});
