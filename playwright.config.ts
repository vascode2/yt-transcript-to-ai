import { defineConfig } from "@playwright/test";

/**
 * E2E loads the unpacked MV3 extension via launchPersistentContext in e2e/extension.spec.ts.
 * Browsers are only required for e2e:chromium (Playwright’s Chromium). Brave uses your install.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 120_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
});
