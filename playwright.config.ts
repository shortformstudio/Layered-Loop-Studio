import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for LoopLayer Aesthetic — mobile web E2E.
 *
 * Targets http://localhost:8086 (Expo web build served by Metro).
 * Uses fake media streams so getUserMedia resolves automatically in
 * headless Chromium without real hardware.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,           // sequential — phases depend on each other
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,                     // one browser instance
  reporter: [
    ["html", { open: "never" }],
    ["list"],
  ],
  timeout: 60_000,                // 60s per test
  expect: { timeout: 15_000 },    // 15s per assertion

  use: {
    baseURL: "http://localhost:8086",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",

    // Fake camera + mic — Chromium flags for synthetic media streams
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-web-security",
        "--allow-file-access",
      ],
    },
  },

  projects: [
    {
      name: "mobile-iPhone14",
      use: {
        ...devices["iPhone 14"],
        // Override to chromium — Playwright can only automate Chromium/FF/WebKit
        browserName: "chromium",
        viewport: devices["iPhone 14"].viewport,
        userAgent: devices["iPhone 14"].userAgent,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "mobile-Pixel7",
      use: {
        ...devices["Pixel 7"],
        browserName: "chromium",
        viewport: devices["Pixel 7"].viewport,
        userAgent: devices["Pixel 7"].userAgent,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
