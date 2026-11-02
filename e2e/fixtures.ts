import type { BrowserContext } from "@playwright/test";
import { test as base, expect } from "@playwright/test";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Browser tests may reach this machine only.
 *
 * Every request the page makes is checked here. A non-local http(s) request is
 * aborted before it leaves the browser, so a stray analytics call, a font CDN
 * or a real provider endpoint fails the test instead of reaching the network.
 */
export async function installNetworkGuard(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      await route.continue();
      return;
    }
    if (LOCAL_HOSTS.has(url.hostname)) {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await installNetworkGuard(context);
    await use(context);
  },
});

export { expect };
