import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    /**
     * Trace recording is opt-in with `TAA_TRACE=1`.
     *
     * With Playwright 1.64.1 on this machine, `retain-on-failure` deletes a
     * worker's `.playwright-artifacts-<n>` directory while a later context is
     * still writing its trace, so `browserContext.close` fails with ENOENT and
     * a green run turns red for no product reason. Recording on demand keeps
     * the trace for a debugging session and the default run deterministic.
     */
    trace: process.env.TAA_TRACE === "1" ? "retain-on-failure" : "off",
    serviceWorkers: "block",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
